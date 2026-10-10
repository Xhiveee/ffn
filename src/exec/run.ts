import { spawn } from "node:child_process";
import { createWriteStream } from "node:fs";
import { mkdir } from "node:fs/promises";
import path from "node:path";

export interface RunOptions {
  command: string;
  args: string[];
  cwd: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs: number;
  /** Full output is streamed here (never held entirely in memory). */
  logFile: string;
  /** Number of trailing lines kept in memory for the response. */
  tailLines?: number;
  /** Lines matching any of these are kept (up to maxKept) regardless of the tail window. */
  keepPatterns?: RegExp[];
  maxKept?: number;
  /** Called for each output line; return "stop" to terminate the process early. */
  onLine?: (line: string) => "stop" | void;
}

export interface RunResult {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  timedOut: boolean;
  stoppedEarly: boolean;
  durationMs: number;
  logFile: string;
  tail: string[];
  kept: string[];
  totalLines: number;
}

/** Kill a whole process group (Gradle forks daemons/game JVMs). */
function killTree(pid: number | undefined, signal: NodeJS.Signals): void {
  if (!pid) return;
  try {
    if (process.platform === "win32") {
      spawn("taskkill", ["/pid", String(pid), "/T", "/F"], { stdio: "ignore" });
    } else {
      process.kill(-pid, signal);
    }
  } catch {
    try {
      process.kill(pid, signal);
    } catch {
      /* already gone */
    }
  }
}

export async function runProcess(o: RunOptions): Promise<RunResult> {
  await mkdir(path.dirname(o.logFile), { recursive: true });
  const log = createWriteStream(o.logFile);
  const tailMax = o.tailLines ?? 120;
  const maxKept = o.maxKept ?? 400;
  const tail: string[] = [];
  const kept: string[] = [];
  let totalLines = 0;
  let stoppedEarly = false;
  let timedOut = false;
  const start = Date.now();

  const child = spawn(o.command, o.args, {
    cwd: o.cwd,
    env: o.env ?? process.env,
    detached: process.platform !== "win32",
    stdio: ["ignore", "pipe", "pipe"],
    shell: process.platform === "win32" && /\.(bat|cmd)$/i.test(o.command),
  });

  const stop = (why: "timeout" | "matcher") => {
    if (why === "timeout") timedOut = true;
    else stoppedEarly = true;
    killTree(child.pid, "SIGTERM");
    setTimeout(() => killTree(child.pid, "SIGKILL"), 10_000).unref();
  };

  const onData = (() => {
    const partial: Record<string, string> = { out: "", err: "" };
    return (key: "out" | "err") => (chunk: Buffer) => {
      log.write(chunk);
      const text = partial[key] + chunk.toString("utf8");
      const lines = text.split(/\r?\n/);
      partial[key] = lines.pop() ?? "";
      for (const line of lines) {
        totalLines++;
        tail.push(line);
        if (tail.length > tailMax) tail.shift();
        if (o.keepPatterns?.some((r) => r.test(line)) && kept.length < maxKept) kept.push(line);
        if (!stoppedEarly && !timedOut && o.onLine?.(line) === "stop") stop("matcher");
      }
    };
  })();
  child.stdout!.on("data", onData("out"));
  child.stderr!.on("data", onData("err"));

  const timer = setTimeout(() => stop("timeout"), o.timeoutMs);
  const result = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
    child.on("error", reject);
    child.on("close", (code, signal) => resolve({ code, signal }));
  }).finally(() => clearTimeout(timer));
  // Make sure forked children are gone too.
  if (stoppedEarly || timedOut) killTree(child.pid, "SIGKILL");
  await new Promise<void>((r) => log.end(r));
  return {
    exitCode: result.code,
    signal: result.signal,
    timedOut,
    stoppedEarly,
    durationMs: Date.now() - start,
    logFile: o.logFile,
    tail,
    kept,
    totalLines,
  };
}
