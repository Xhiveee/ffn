import { existsSync, statSync } from "node:fs";
import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { diagnose, type Diagnosis } from "../diagnostics/parse.js";
import { runProcess, type RunResult } from "../exec/run.js";
import { discoverJdks, pickJdk, type JdkInfo } from "../jdk/discover.js";
import { readProjectInfo, type ProjectInfo } from "../project/info.js";
import { lookupProfile, type Services } from "../services.js";
import { clip, fail, ok } from "./result.js";
import { gradleBuildInput } from "./schemas.js";

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

/** Gradle version from the project's wrapper properties. */
export async function wrapperGradleVersion(root: string): Promise<string | undefined> {
  try {
    const t = await readFile(path.join(root, "gradle", "wrapper", "gradle-wrapper.properties"), "utf8");
    return /gradle-(\d+(?:\.\d+)+(?:-rc-\d+)?)-(?:bin|all)\.zip/.exec(t)?.[1];
  } catch {
    return undefined;
  }
}

/** Newest Java a Gradle version can run on (Gradle's compatibility matrix). */
export function gradleMaxJvm(v: string): number {
  const [maj = 0, min = 0] = v.split(".").map(Number);
  const n = maj * 100 + min;
  const table: [number, number][] = [[901, 25], [814, 24], [810, 23], [808, 22], [805, 21], [803, 20], [706, 19], [705, 18], [703, 17], [700, 16], [608, 15], [607, 15], [603, 14], [0, 11]];
  if (maj >= 10) return 99;
  return table.find(([g]) => n >= g)![1];
}

const versionGte = (a: string, b: string) => {
  const x = a.split(".").map(Number);
  const y = b.split(".").map(Number);
  for (let i = 0; i < Math.max(x.length, y.length); i++) if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) > (y[i] ?? 0);
  return true;
};

async function requiredJvm(services: Services, info: ProjectInfo, warnings: string[]): Promise<{ jvm: number; max?: number; why: string }> {
  const wrapper = await wrapperGradleVersion(info.rootDir ?? info.dir);
  const max = wrapper ? gradleMaxJvm(wrapper) : undefined;
  const cap = (jvm: number, why: string) => (max && jvm > max ? { jvm: max, max, why: `${why} Capped at JDK ${max}: the newest Gradle ${wrapper} runs on.` } : { jvm, max, why });
  try {
    const { profile } = await lookupProfile(services, info.loader, info.mcVersion);
    // minJvm belongs to the plugin version the profile pins; only enforce it when the project's Gradle is that new.
    const minJvm = profile.gradle.minJvm && (!wrapper || versionGte(wrapper, profile.gradle.version)) ? profile.gradle.minJvm : 0;
    const jvm = Math.max(profile.java, minJvm);
    return cap(jvm, `${info.loader} ${info.mcVersion} targets Java ${profile.java}${minJvm > profile.java ? ` and its Gradle plugin needs JDK ${minJvm} to run` : ""}.`);
  } catch (e) {
    if (info.gradleJvm) return cap(info.gradleJvm, `From .ffn/project.json (profile lookup failed: ${(e as Error).message}).`);
    warnings.push(`Could not resolve the profile (${(e as Error).message}); assuming JDK 21.`);
    return cap(21, "Fallback.");
  }
}

export async function runGradle(services: Services, o: GradleRunOptions): Promise<GradleRun | { error: string }> {
  const project = await readProjectInfo(o.projectDir);
  const warnings: string[] = [];
  const root = project.rootDir ?? project.dir;
  const wrapper = path.join(root, process.platform === "win32" ? "gradlew.bat" : "gradlew");
  if (!existsSync(wrapper)) return { error: `No Gradle wrapper (${path.basename(wrapper)}) in ${root}.` };
  // a subproject directory: run from the root and qualify bare task names (":fabric:build")
  const sub = project.gradlePath && project.gradlePath !== ":" ? project.gradlePath : undefined;
  const tasks = o.tasks.map((t) => (sub && !t.startsWith(":") && !t.startsWith("-") && t !== "ffnPrintClasspath" ? `${sub}:${t}` : t));
  const req = await requiredJvm(services, project, warnings);
  const all = await discoverJdks();
  let jdk: JdkInfo | undefined;
  if (o.javaHome) {
    jdk = all.find((j) => path.resolve(j.home) === path.resolve(o.javaHome!)) ?? { home: o.javaHome, major: 0, version: "?", isJdk: true, source: "javaHome" };
    if (jdk.major && jdk.major < req.jvm) warnings.push(`javaHome is JDK ${jdk.major} but ${req.jvm}+ is required: ${req.why}`);
  } else {
    const choice = pickJdk(all, req.jvm, req.why, req.max);
    if (!choice.jdk) return { error: choice.missing! };
    jdk = choice.jdk;
  }
  const ffnDir = path.join(root, ".ffn");
  await mkdir(ffnDir, { recursive: true });
  const toolchainPaths = all.filter((j) => j.isJdk).map((j) => j.home).join(",");
  const args = [
    ...tasks,
    "--console=plain",
    ...(o.daemon ? [] : ["--no-daemon"]),
    ...(toolchainPaths ? [`-Porg.gradle.java.installations.paths=${toolchainPaths}`] : []),
    ...(o.args ?? []),
  ];
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    JAVA_HOME: jdk.home,
    PATH: `${path.join(jdk.home, "bin")}${path.delimiter}${process.env.PATH ?? ""}`,
    ...o.env,
  };
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const logFile = path.join(ffnDir, "logs", `${o.logName}-${stamp}.log`);
  const result = await runProcess({
    command: wrapper,
    args,
    cwd: root,
    env,
    timeoutMs: o.timeoutSec * 1000,
    logFile,
    tailLines: 80,
    keepPatterns: KEEP,
    maxKept: 300,
  });
  const size = statSync(logFile).size;
  const text = size < 8_000_000 ? await readFile(logFile, "utf8") : [...result.kept, ...result.tail].join("\n");
  const diagnosis = diagnose(text);
  return { project, jdk, requiredJvm: req.jvm, command: `${path.basename(wrapper)} ${args.join(" ")}`, result, diagnosis, warnings };
}

function status(r: RunResult): string {
  if (r.timedOut) return "timed out (process tree killed)";
  return r.exitCode === 0 ? "succeeded" : `failed (exit ${r.exitCode ?? r.signal})`;
}

function report(run: GradleRun) {
  const r = run.result;
  const failed = r.exitCode !== 0 || r.timedOut;
  const errs = run.diagnosis.findings.filter((f) => f.severity === "error");
  const findings = [...errs, ...run.diagnosis.findings.filter((f) => f.severity !== "error")];
  return {
    jdk: `${run.jdk.major} (required ${run.requiredJvm}+)`,
    status: status(r),
    durationSec: Math.round(r.durationMs / 100) / 10,
    logFile: r.logFile,
    findings: findings.slice(0, 20).map((f) => ({ ...f, message: clip(f.message, 300), evidence: f.evidence && f.evidence !== f.message ? clip(f.evidence, 200) : undefined })),
    ...(findings.length > 20 ? { moreFindings: `${findings.length - 20} more in the log (analyze_crash path=<logFile> offset=20)` } : {}),
    culprit: run.diagnosis.culprit,
    warnings: run.warnings,
    // the log tail only when it can help: failures without recognised findings get more lines
    ...(failed ? { tail: r.tail.slice(errs.length ? -10 : -30).map((l) => clip(l, 200)) } : {}),
  };
}



type BuildArgs = z.infer<z.ZodObject<typeof gradleBuildInput>>;

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
