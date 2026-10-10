import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { existsSync, statSync } from "node:fs";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { diagnose, type Diagnosis } from "../diagnostics/parse.js";
import { acquireDisplay } from "../exec/display.js";
import { runProcess, type RunResult } from "../exec/run.js";
import { discoverJdks, pickJdk, type JdkInfo } from "../jdk/discover.js";
import { readProjectInfo, type ProjectInfo } from "../project/info.js";
import { lookupProfile, type Services } from "../services.js";
import { clip, fail, guard, ok } from "./result.js";

const INIT_SCRIPT = `// Written by FFN. Adds JVM/program arguments to run tasks from environment variables.
def ffnJvm = System.getenv("FFN_RUN_JVM_ARGS")
def ffnArgs = System.getenv("FFN_RUN_ARGS")
gradle.allprojects { p ->
    p.tasks.withType(JavaExec).configureEach { t ->
        if (ffnJvm) t.jvmArgs(ffnJvm.split("\\u001f").toList())
        if (ffnArgs) t.args(ffnArgs.split("\\u001f").toList())
    }
}
`;

const KEEP = [
  /\.(java|kt):\d+: (error|warning):/,
  /^\* What went wrong:|^FAILURE:|^BUILD (FAILED|SUCCESSFUL)/,
  /Could not (resolve|find|GET)|status code \d{3}/,
  /JVM runtime version|Unsupported class file|class file version|languageVersion=|Gradle requires JVM/,
  /Mixin|mixin|Injection|@Shadow/,
  /Exception|Error:|Caused by:/,
  /Crash report saved|Suspected Mod|Mod ID: '|which is missing|Incompatible mods/,
];

export interface GradleRunOptions {
  projectDir: string;
  tasks: string[];
  args?: string[];
  javaHome?: string;
  timeoutSec: number;
  daemon: boolean;
  env?: Record<string, string>;
  runJvmArgs?: string[];
  runArgs?: string[];
  onLine?: (line: string) => "stop" | void;
  logName: string;
}

export interface GradleRun {
  project: ProjectInfo;
  jdk: JdkInfo;
  requiredJvm: number;
  command: string;
  result: RunResult;
  diagnosis: Diagnosis;
  warnings: string[];
}

async function requiredJvm(services: Services, info: ProjectInfo, warnings: string[]): Promise<{ jvm: number; why: string }> {
  try {
    const { profile } = await lookupProfile(services, info.loader, info.mcVersion);
    const jvm = Math.max(profile.java, profile.gradle.minJvm ?? 17);
    return {
      jvm,
      why: `${info.loader} ${info.mcVersion} targets Java ${profile.java}${profile.gradle.minJvm && profile.gradle.minJvm > profile.java ? ` and its Gradle plugin needs JDK ${profile.gradle.minJvm} to run` : ""}.`,
    };
  } catch (e) {
    if (info.gradleJvm) return { jvm: info.gradleJvm, why: `From .ffn/project.json (profile lookup failed: ${(e as Error).message}).` };
    warnings.push(`Could not resolve the profile (${(e as Error).message}); assuming JDK 21.`);
    return { jvm: 21, why: "Fallback." };
  }
}

export async function runGradle(services: Services, o: GradleRunOptions): Promise<GradleRun | { error: string }> {
  const project = await readProjectInfo(o.projectDir);
  const warnings: string[] = [];
  const wrapper = path.join(project.dir, process.platform === "win32" ? "gradlew.bat" : "gradlew");
  if (!existsSync(wrapper)) return { error: `No Gradle wrapper (${path.basename(wrapper)}) in ${project.dir}.` };
  const req = await requiredJvm(services, project, warnings);
  const all = await discoverJdks();
  let jdk: JdkInfo | undefined;
  if (o.javaHome) {
    jdk = all.find((j) => path.resolve(j.home) === path.resolve(o.javaHome!)) ?? { home: o.javaHome, major: 0, version: "?", isJdk: true, source: "javaHome" };
    if (jdk.major && jdk.major < req.jvm) warnings.push(`javaHome is JDK ${jdk.major} but ${req.jvm}+ is required: ${req.why}`);
  } else {
    const choice = pickJdk(all, req.jvm, req.why);
    if (!choice.jdk) return { error: choice.missing! };
    jdk = choice.jdk;
  }
  const initDir = path.join(project.dir, ".ffn");
  await mkdir(initDir, { recursive: true });
  const initScript = path.join(initDir, "ffn-init.gradle");
  await writeFile(initScript, INIT_SCRIPT);
  const toolchainPaths = all.filter((j) => j.isJdk).map((j) => j.home).join(",");
  const args = [
    ...o.tasks,
    "--console=plain",
    "--init-script", initScript,
    ...(o.daemon ? [] : ["--no-daemon"]),
    ...(toolchainPaths ? [`-Porg.gradle.java.installations.paths=${toolchainPaths}`] : []),
    ...(o.args ?? []),
  ];
  const sep = String.fromCharCode(0x1f);
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    JAVA_HOME: jdk.home,
    PATH: `${path.join(jdk.home, "bin")}${path.delimiter}${process.env.PATH ?? ""}`,
    ...(o.runJvmArgs?.length ? { FFN_RUN_JVM_ARGS: o.runJvmArgs.join(sep) } : {}),
    ...(o.runArgs?.length ? { FFN_RUN_ARGS: o.runArgs.join(sep) } : {}),
    ...o.env,
  };
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const logFile = path.join(initDir, "logs", `${o.logName}-${stamp}.log`);
  const result = await runProcess({
    command: wrapper,
    args,
    cwd: project.dir,
    env,
    timeoutMs: o.timeoutSec * 1000,
    logFile,
    tailLines: 80,
    keepPatterns: KEEP,
    maxKept: 300,
    onLine: o.onLine,
  });
  const size = statSync(logFile).size;
  const text = size < 8_000_000 ? await readFile(logFile, "utf8") : [...result.kept, ...result.tail].join("\n");
  const diagnosis = diagnose(text);
  return { project, jdk, requiredJvm: req.jvm, command: `${path.basename(wrapper)} ${args.join(" ")}`, result, diagnosis, warnings };
}

function status(r: RunResult): string {
  if (r.stoppedEarly) return "stopped by FFN (condition met)";
  if (r.timedOut) return "timed out (process tree killed)";
  return r.exitCode === 0 ? "succeeded" : `failed (exit ${r.exitCode ?? r.signal})`;
}

function report(run: GradleRun, extra: Record<string, unknown> = {}) {
  const r = run.result;
  const failed = r.exitCode !== 0 || r.timedOut;
  const errs = run.diagnosis.findings.filter((f) => f.severity === "error");
  const findings = [...errs, ...run.diagnosis.findings.filter((f) => f.severity !== "error")];
  return {
    jdk: `${run.jdk.major} (required ${run.requiredJvm}+)`,
    status: status(r),
    durationSec: Math.round(r.durationMs / 100) / 10,
    logFile: r.logFile,
    ...extra,
    findings: findings.slice(0, 20).map((f) => ({ ...f, message: clip(f.message, 300), evidence: f.evidence && f.evidence !== f.message ? clip(f.evidence, 200) : undefined })),
    ...(findings.length > 20 ? { moreFindings: `${findings.length - 20} more in the log (analyze_crash path=<logFile> offset=20)` } : {}),
    culprit: run.diagnosis.culprit,
    warnings: run.warnings,
    // the log tail only when it can help: failures without recognised findings get more lines
    ...(failed ? { tail: r.tail.slice(errs.length ? -10 : -30).map((l) => clip(l, 200)) } : {}),
  };
}

/** Newest crash report written after `since`. */
async function newCrashReport(runDir: string, since: number): Promise<string | undefined> {
  const dir = path.join(runDir, "crash-reports");
  if (!existsSync(dir)) return undefined;
  const files = (await readdir(dir)).map((f) => path.join(dir, f)).filter((f) => statSync(f).mtimeMs >= since);
  return files.sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)[0];
}

const projectDir = z.string().describe("Path to the mod project (root with gradlew).");
const javaHome = z.string().optional().describe("Force a JDK home. Default: auto-pick an installed JDK matching the profile (Java target and the Gradle plugin's minimum).");

export const gradleBuildInput = {
  projectDir,
  tasks: z.array(z.string()).optional().describe('Gradle tasks, default ["build"].'),
  args: z.array(z.string()).optional().describe("Extra Gradle arguments, e.g. --offline, --refresh-dependencies."),
  javaHome,
  timeoutSec: z.number().int().positive().max(7200).optional().describe("Default 1200."),
  daemon: z.boolean().optional().describe("Use the Gradle daemon (default true; faster repeated builds)."),
};

export const runClientInput = {
  projectDir,
  mode: z.enum(["smoke", "run"]).optional().describe("smoke (default): start, wait until the mod and mixin configs are loaded and the game reached the main menu, then stop. run: keep running until timeout/exit."),
  timeoutSec: z.number().int().positive().max(7200).optional().describe("Default 600 (first run downloads assets)."),
  display: z.enum(["auto", "xvfb", "current"]).optional().describe("auto (default): current display, or a private Xvfb on headless Linux."),
  waitFor: z.array(z.string()).optional().describe("Extra regexes that must all appear in the log before a smoke test passes (e.g. your mixin's log line)."),
  env: z.record(z.string(), z.string()).optional().describe("Extra environment variables for the game process (e.g. SDL_VIDEO_DRIVER)."),
  task: z.string().optional().describe('Gradle task, default "runClient".'),
  jvmArgs: z.array(z.string()).optional(),
  programArgs: z.array(z.string()).optional(),
  mixinVerbose: z.boolean().optional().describe("Pass -Dmixin.debug.verbose=true so mixin application is logged (default true in smoke mode)."),
  runDir: z.string().optional().describe('Game directory relative to the project, default "run".'),
  javaHome,
};

export const runServerInput = {
  projectDir,
  acceptEula: z.boolean().optional().describe(
    "Set true ONLY if the user has read and agreed to the Minecraft EULA (https://aka.ms/MinecraftEULA). FFN never accepts it on its own; without this (or an existing eula.txt with eula=true) the server is not started.",
  ),
  mode: z.enum(["smoke", "run"]).optional().describe('smoke (default): stop once the server prints "Done (…)!". run: keep running until timeout.'),
  timeoutSec: z.number().int().positive().max(7200).optional().describe("Default 600."),
  waitFor: z.array(z.string()).optional(),
  task: z.string().optional().describe('Gradle task, default "runServer".'),
  jvmArgs: z.array(z.string()).optional(),
  runDir: z.string().optional().describe('Server directory relative to the project, default "run".'),
  javaHome,
};

type BuildArgs = z.infer<z.ZodObject<typeof gradleBuildInput>>;
type ClientArgs = z.infer<z.ZodObject<typeof runClientInput>>;
type ServerArgs = z.infer<z.ZodObject<typeof runServerInput>>;

export async function gradleBuild(services: Services, a: BuildArgs) {
  const run = await runGradle(services, {
    projectDir: a.projectDir,
    tasks: a.tasks?.length ? a.tasks : ["build"],
    args: a.args,
    javaHome: a.javaHome,
    timeoutSec: a.timeoutSec ?? 1200,
    daemon: a.daemon ?? true,
    logName: "build",
  });
  if ("error" in run) return fail(run.error);
  const data = report(run);
  const okRun = run.result.exitCode === 0 && !run.result.timedOut;
  return { ...ok(`Gradle ${(a.tasks ?? ["build"]).join(" ")} ${data.status} in ${data.durationSec}s with JDK ${run.jdk.major}. ${run.diagnosis.summary}`, data), isError: !okRun };
}

interface Marker {
  name: string;
  re: RegExp;
  required: boolean;
  hit?: string;
}

/** Lines after which the game cannot recover (some loaders then wait on a modal error dialog forever). */
const FATAL = [
  /Failed to initialize the mod loading system and display/,
  /Crash report saved to/,
  /#@!@# Game crashed!/,
  /Failed to create window|Couldn't find matching GLX visual/,
];

function onLineFor(mode: string, ev: (l: string) => "stop" | void, fatal: { line?: string }) {
  return (l: string): "stop" | void => {
    const r = ev(l);
    if (r === "stop" && (mode === "smoke" || fatal.line)) return "stop";
  };
}

/** Markers are only evaluated once Gradle starts the run task, so build output cannot satisfy them. */
function smokeEvaluator(markers: Marker[], task: string, fatal?: { line?: string }) {
  let started = false;
  const gate = new RegExp(`^> Task :(?:[\\w-]+:)*${escapeRe(task)}\\b`);
  return (line: string): "stop" | void => {
    if (!started) {
      started = gate.test(line);
      return;
    }
    if (fatal && FATAL.some((r) => r.test(line))) {
      fatal.line ??= line.trim();
      return "stop";
    }
    for (const m of markers) if (!m.hit && m.re.test(line)) m.hit = line.trim().slice(0, 300);
    if (markers.filter((m) => m.required).every((m) => m.hit)) return "stop";
  };
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

export async function runClient(services: Services, a: ClientArgs) {
  const info = await readProjectInfo(a.projectDir);
  const mode = a.mode ?? "smoke";
  const modId = info.modId ?? "";
  const configs = info.mixinConfigs.map((c) => path.basename(c));
  const markers: Marker[] = [
    { name: "mod loaded", re: new RegExp(`\\b${escapeRe(modId)}\\b`, "i"), required: !!modId },
    ...configs.map((c) => ({ name: `mixin config ${c} loaded`, re: new RegExp(`${escapeRe(c)}`), required: false })),
    { name: "client reached main menu (texture atlases built)", re: /Created: \d+x\d+x\d+ minecraft:textures\/atlas\//, required: true },
    { name: "sound engine started", re: /Sound engine started/, required: false },
    ...(a.waitFor ?? []).map((w, i) => ({ name: `waitFor[${i}]`, re: new RegExp(w), required: true })),
  ];
  let display;
  try {
    display = await acquireDisplay(a.display ?? "auto");
  } catch (e) {
    return fail((e as Error).message);
  }
  const started = Date.now();
  const fatal: { line?: string } = {};
  try {
    const verbose = a.mixinVerbose ?? mode === "smoke";
    const run = await runGradle(services, {
      projectDir: a.projectDir,
      tasks: [a.task ?? "runClient"],
      javaHome: a.javaHome,
      timeoutSec: a.timeoutSec ?? 600,
      daemon: false,
      env: { ...display.env, ...(a.env ?? {}) },
      runJvmArgs: [...(verbose ? ["-Dmixin.debug.verbose=true"] : []), ...(a.jvmArgs ?? [])],
      runArgs: a.programArgs,
      onLine: onLineFor(mode, smokeEvaluator(markers, a.task ?? "runClient", fatal), fatal),
      logName: "runClient",
    });
    if ("error" in run) return fail(run.error);
    return finishRun(run, markers, mode, path.join(info.dir, a.runDir ?? "run"), started, display.note, "client", fatal, [
      "The example mixin targets a server-side class (MinecraftServer), which is only loaded when a world starts; reaching the main menu proves the mod and its mixin config loaded, not that every injection applied. Add waitFor patterns for your own log lines to check more.",
    ]);
  } finally {
    display.stop();
  }
}

async function finishRun(run: GradleRun, markers: Marker[], mode: string, runDir: string, started: number, displayNote: string | undefined, side: string, fatal: { line?: string }, notes: string[]) {
  const crash = await newCrashReport(runDir, started);
  let crashDiag: Diagnosis | undefined;
  if (crash) crashDiag = diagnose(await readFile(crash, "utf8"));
  const passed = markers.filter((m) => m.required).every((m) => m.hit) && !crash && !fatal.line;
  const data = report(run, {
    mode,
    ...(displayNote ? { display: displayNote } : {}),
    smoke: mode === "smoke" ? { passed, markers: markers.map((m) => ({ name: m.name, required: m.required, found: !!m.hit, line: m.hit })) } : undefined,
    ...(fatal.line ? { fatal: `Stopped after a fatal log line: ${fatal.line}` } : {}),
    crashReport: crash ? { path: crash, summary: crashDiag!.summary, description: crashDiag!.description, culprit: crashDiag!.culprit, findings: crashDiag!.findings.slice(0, 20) } : undefined,
    notes,
  });
  const headline =
    mode === "smoke"
      ? passed
        ? `Smoke test PASSED: ${side} started, all required markers seen, then stopped (${data.durationSec}s).`
        : `Smoke test FAILED (${fatal.line ? `fatal: ${fatal.line.slice(0, 160)}` : data.status}). Missing: ${markers.filter((m) => m.required && !m.hit).map((m) => m.name).join(", ") || "none"}${crash ? `; crash report ${crash}` : ""}.`
      : `${side} run ${data.status} after ${data.durationSec}s.`;
  return { ...ok(`${headline} ${(crashDiag ?? run.diagnosis).summary}`, data), isError: mode === "smoke" ? !passed : !!crash };
}

export async function runServer(services: Services, a: ServerArgs) {
  const info = await readProjectInfo(a.projectDir);
  const runDir = path.join(info.dir, a.runDir ?? "run");
  const eulaFile = path.join(runDir, "eula.txt");
  const existing = existsSync(eulaFile) ? await readFile(eulaFile, "utf8") : "";
  const accepted = /^\s*eula\s*=\s*true\s*$/m.test(existing);
  if (!accepted && a.acceptEula !== true) {
    return fail(
      "Not started: the Minecraft dedicated server requires agreeing to the Minecraft EULA (https://aka.ms/MinecraftEULA). " +
        "FFN does not accept it automatically. Ask the user to read it; only if they agree, call run_server again with acceptEula=true " +
        `(FFN then writes eula=true to ${eulaFile}). run_client needs no EULA.`,
    );
  }
  if (!accepted) {
    await mkdir(runDir, { recursive: true });
    await writeFile(
      eulaFile,
      `#By changing the setting below to TRUE you are indicating your agreement to our EULA (https://aka.ms/MinecraftEULA).\n` +
        `#Set by FFN run_server(acceptEula=true) on ${new Date().toISOString()} because the user stated they agree to the EULA.\neula=true\n`,
    );
  }
  const mode = a.mode ?? "smoke";
  const markers: Marker[] = [
    { name: "mod loaded", re: new RegExp(`\\b${escapeRe(info.modId ?? "")}\\b`, "i"), required: !!info.modId },
    { name: "server started (Done)", re: /Done \([\d.,]+s\)!/, required: true },
    ...(a.waitFor ?? []).map((w, i) => ({ name: `waitFor[${i}]`, re: new RegExp(w), required: true })),
  ];
  const started = Date.now();
  const fatal: { line?: string } = {};
  const run = await runGradle(services, {
    projectDir: a.projectDir,
    tasks: [a.task ?? "runServer"],
    javaHome: a.javaHome,
    timeoutSec: a.timeoutSec ?? 600,
    daemon: false,
    runJvmArgs: ["-Djava.awt.headless=true", "-Dmixin.debug.verbose=true", ...(a.jvmArgs ?? [])],
    onLine: onLineFor(mode, smokeEvaluator(markers, a.task ?? "runServer", fatal), fatal),
    logName: "runServer",
  });
  if ("error" in run) return fail(run.error);
  return finishRun(run, markers, mode, runDir, started, undefined, "server", fatal, [
    accepted ? "eula.txt already contained eula=true." : "eula=true was written because the caller passed acceptEula=true on the user's behalf.",
  ]);
}

export function registerGradleTools(server: McpServer, services: Services): void {
  server.registerTool(
    "gradle_build",
    {
      title: "Gradle build",
      description:
        "Run Gradle tasks (default: build) in a mod project with an automatically chosen installed JDK (the profile's Java target and the Gradle plugin's minimum). Output is streamed to a log file; the result contains parsed findings: compiler errors with file:line, Mixin AP warnings, dependency-resolution failures, Gradle/JVM mismatches.",
      inputSchema: gradleBuildInput,
      annotations: { readOnlyHint: false, openWorldHint: true },
    },
    (a) => guard(() => gradleBuild(services, a)),
  );
  server.registerTool(
    "run_client",
    {
      title: "Run client",
      description:
        "Start the development client via Gradle (headless-capable: a private Xvfb display on Linux servers). smoke mode waits for the mod, its mixin config(s) and the main menu to load, then stops and reports; crashes are analysed (crash report + log). No EULA is involved for the client.",
      inputSchema: runClientInput,
      annotations: { readOnlyHint: false, openWorldHint: true },
    },
    (a) => guard(() => runClient(services, a)),
  );
  server.registerTool(
    "run_server",
    {
      title: "Run dedicated server",
      description:
        "Start the development dedicated server via Gradle and stop once it is up (smoke) or after a timeout. Requires the Minecraft EULA: pass acceptEula=true ONLY after the user explicitly agreed to https://aka.ms/MinecraftEULA — never on your own initiative.",
      inputSchema: runServerInput,
      annotations: { readOnlyHint: false, openWorldHint: true },
    },
    (a) => guard(() => runServer(services, a)),
  );
}
