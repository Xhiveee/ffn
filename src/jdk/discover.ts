import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { readdir, readFile, realpath } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const execFileP = promisify(execFile);
const exe = (name: string) => (process.platform === "win32" ? `${name}.exe` : name);

export interface JdkInfo {
  home: string;
  major: number;
  version: string;
  vendor?: string;
  /** Has javac → a full JDK (needed for compiling), not just a JRE. */
  isJdk: boolean;
  source: string;
}

/** Where JDKs commonly live. Users can add more with FFN_JDKS (path-separated homes or parent dirs). */
export function candidateRoots(env: NodeJS.ProcessEnv = process.env): { dir: string; source: string; parent: boolean }[] {
  const home = os.homedir();
  const out: { dir: string; source: string; parent: boolean }[] = [];
  for (const p of (env.FFN_JDKS ?? "").split(path.delimiter).filter(Boolean)) {
    out.push({ dir: p, source: "FFN_JDKS", parent: false }, { dir: p, source: "FFN_JDKS", parent: true });
  }
  if (env.JAVA_HOME) out.push({ dir: env.JAVA_HOME, source: "JAVA_HOME", parent: false });
  for (const [k, v] of Object.entries(env)) {
    // JAVA_HOME_17_X64 style (GitHub Actions, some installers)
    if (/^JAVA_HOME_\d+/.test(k) && v) out.push({ dir: v, source: k, parent: false });
  }
  const parents = [
    [path.join(home, "jdks"), "~/jdks"],
    [path.join(home, ".jdks"), "~/.jdks (IntelliJ)"],
    [path.join(home, ".gradle", "jdks"), "Gradle toolchains"],
    [path.join(home, ".sdkman", "candidates", "java"), "SDKMAN"],
    [path.join(home, ".asdf", "installs", "java"), "asdf"],
    ["/usr/lib/jvm", "/usr/lib/jvm"],
    ["/opt/java", "/opt/java"],
    ["/opt/jdks", "/opt/jdks"],
    ["/Library/Java/JavaVirtualMachines", "macOS"],
    [path.join(home, "Library", "Java", "JavaVirtualMachines"), "macOS (user)"],
    ["C:\\Program Files\\Java", "Windows"],
    ["C:\\Program Files\\Eclipse Adoptium", "Windows (Adoptium)"],
    ["C:\\Program Files\\Microsoft", "Windows (Microsoft)"],
    ["C:\\Program Files\\Zulu", "Windows (Zulu)"],
  ] as const;
  for (const [dir, source] of parents) out.push({ dir, source, parent: true });
  return out;
}

function normalizeHome(dir: string): string {
  const mac = path.join(dir, "Contents", "Home");
  return existsSync(path.join(mac, "bin", exe("java"))) ? mac : dir;
}

async function probe(dir: string, source: string): Promise<JdkInfo | null> {
  const home = normalizeHome(dir);
  const java = path.join(home, "bin", exe("java"));
  if (!existsSync(java)) return null;
  let version: string | undefined;
  let vendor: string | undefined;
  try {
    const release = await readFile(path.join(home, "release"), "utf8");
    version = /^JAVA_VERSION="([^"]+)"/m.exec(release)?.[1];
    vendor = /^IMPLEMENTOR="([^"]+)"/m.exec(release)?.[1];
  } catch {
    try {
      const { stderr } = await execFileP(java, ["-version"], { timeout: 10_000 });
      version = /version "([^"]+)"/.exec(stderr)?.[1];
    } catch {
      return null;
    }
  }
  if (!version) return null;
  const major = parseJavaMajor(version);
  if (!major) return null;
  return { home: await realpath(home).catch(() => home), major, version, vendor, isJdk: existsSync(path.join(home, "bin", exe("javac"))), source };
}

export function parseJavaMajor(version: string): number | undefined {
  const m = /^(?:1\.)?(\d+)/.exec(version);
  return m ? Number(m[1]) : undefined;
}

async function javaOnPath(): Promise<string | null> {
  try {
    const { stderr } = await execFileP(exe("java"), ["-XshowSettings:properties", "-version"], { timeout: 10_000 });
    return /java\.home = (.+)/.exec(stderr)?.[1]?.trim() ?? null;
  } catch {
    return null;
  }
}

/** Find installed JDKs (deduplicated by real path), sorted by major version. */
export async function discoverJdks(env: NodeJS.ProcessEnv = process.env): Promise<JdkInfo[]> {
  const found = new Map<string, JdkInfo>();
  const add = (j: JdkInfo | null) => {
    if (j && !found.has(j.home)) found.set(j.home, j);
  };
  for (const c of candidateRoots(env)) {
    if (!existsSync(c.dir)) continue;
    if (!c.parent) {
      add(await probe(c.dir, c.source));
      continue;
    }
    let entries: string[] = [];
    try {
      entries = await readdir(c.dir);
    } catch {
      continue;
    }
    for (const e of entries) add(await probe(path.join(c.dir, e), c.source));
  }
  const onPath = await javaOnPath();
  if (onPath) add(await probe(onPath, "PATH"));
  return [...found.values()].sort((a, b) => a.major - b.major || a.home.localeCompare(b.home));
}

export interface JdkChoice {
  jdk?: JdkInfo;
  required: number;
  reason: string;
  all: JdkInfo[];
  /** Human-readable fix when nothing suitable is installed. */
  missing?: string;
}

/**
 * Pick the JDK that runs Gradle: the smallest full JDK whose major >= required
 * (an exact match is preferred; newer JDKs can break older Gradle versions).
 */
export function pickJdk(all: JdkInfo[], required: number, reason: string, max?: number): JdkChoice {
  const jdks = all.filter((j) => j.isJdk);
  const exact = jdks.find((j) => j.major === required);
  const newers = jdks.filter((j) => j.major > required).sort((a, b) => a.major - b.major);
  // prefer a JDK the build's Gradle can still run on
  const newer = newers.find((j) => !max || j.major <= max) ?? newers[0];
  const jdk = exact ?? newer;
  if (jdk) return { jdk, required, reason, all };
  const have = jdks.map((j) => j.major).join(", ") || "none";
  return {
    required,
    reason,
    all,
    missing:
      `No JDK ${required}+ found (installed: ${have}). ${reason} ` +
      `Install one (e.g. Eclipse Temurin ${required}: https://adoptium.net/temurin/releases/?version=${required}) ` +
      `or point FFN_JDKS / javaHome at an existing installation.`,
  };
}
