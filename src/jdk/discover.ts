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

/**
 * Where JDKs commonly live on this OS. Users can add more with FFN_JDKS (path-separated homes or parent dirs).
 * platform/home are injectable so the Windows/macOS lists are unit-tested on any OS.
 */
export function candidateRoots(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform, home = os.homedir()): { dir: string; source: string; parent: boolean }[] {
  const P = platform === "win32" ? path.win32 : path.posix;
  const out: { dir: string; source: string; parent: boolean }[] = [];
  for (const p of (env.FFN_JDKS ?? "").split(P.delimiter).filter(Boolean)) {
    out.push({ dir: p, source: "FFN_JDKS", parent: false }, { dir: p, source: "FFN_JDKS", parent: true });
  }
  if (env.JAVA_HOME) out.push({ dir: env.JAVA_HOME, source: "JAVA_HOME", parent: false });
  for (const [k, v] of Object.entries(env)) {
    // JAVA_HOME_17_X64 style (GitHub Actions, some installers)
    if (/^JAVA_HOME_\d+/.test(k) && v) out.push({ dir: v, source: k, parent: false });
  }
  const parents: [string, string][] = [
    [P.join(home, "jdks"), "~/jdks"],
    [P.join(home, ".jdks"), "~/.jdks (IntelliJ)"],
    [P.join(home, ".gradle", "jdks"), "Gradle toolchains"],
    [env.SDKMAN_DIR ? P.join(env.SDKMAN_DIR, "candidates", "java") : P.join(home, ".sdkman", "candidates", "java"), "SDKMAN"],
    [P.join(home, ".asdf", "installs", "java"), "asdf"],
  ];
  if (platform === "win32") {
    const pf = [env.ProgramFiles ?? "C:\\Program Files", env["ProgramFiles(x86)"], env.ProgramW6432].filter((x): x is string => !!x);
    for (const base of [...new Set(pf)]) {
      for (const vendor of ["Java", "Eclipse Adoptium", "Eclipse Foundation", "Microsoft", "Zulu", "Amazon Corretto", "BellSoft", "Semeru", "OpenJDK", "RedHat"]) parents.push([P.join(base, vendor), `Windows (${vendor})`]);
    }
    if (env.LOCALAPPDATA) parents.push([P.join(env.LOCALAPPDATA, "Programs", "Eclipse Adoptium"), "Windows (per-user Adoptium)"]);
    parents.push([P.join(home, "scoop", "apps"), "Scoop"]);
  } else if (platform === "darwin") {
    parents.push(["/Library/Java/JavaVirtualMachines", "macOS"], [P.join(home, "Library", "Java", "JavaVirtualMachines"), "macOS (user)"], ["/opt/homebrew/opt", "Homebrew"], ["/usr/local/opt", "Homebrew (Intel)"]);
  } else {
    parents.push(["/usr/lib/jvm", "/usr/lib/jvm"], ["/usr/java", "/usr/java"], ["/opt/java", "/opt/java"], ["/opt/jdks", "/opt/jdks"], ["/opt", "/opt"]);
  }
  for (const [dir, source] of parents) out.push({ dir, source, parent: true });
  return out;
}

/** JDK homes from `reg query <key> /s /v JavaHome|Path` output (Oracle, Adoptium, Microsoft, Zulu keys). */
export function parseRegQuery(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(/^\s+(?:JavaHome|Path|InstallationPath)\s+REG_(?:EXPAND_)?SZ\s+(.+?)\s*$/gim)) out.push(m[1]!.replace(/\\$/, ""));
  return [...new Set(out)];
}

/** JDK homes from macOS `/usr/libexec/java_home -V` (stderr) output. */
export function parseJavaHomeV(text: string): string[] {
  return [...new Set([...text.matchAll(/^\s+\d[^\n]*?\s(\/\S.*?)\s*$/gm)].map((m) => m[1]!))];
}

const REG_KEYS = ["HKLM\\SOFTWARE\\JavaSoft\\JDK", "HKLM\\SOFTWARE\\JavaSoft\\Java Development Kit", "HKLM\\SOFTWARE\\Eclipse Adoptium\\JDK", "HKLM\\SOFTWARE\\Eclipse Foundation\\JDK", "HKLM\\SOFTWARE\\Microsoft\\JDK", "HKLM\\SOFTWARE\\Azul Systems\\Zulu", "HKLM\\SOFTWARE\\Amazon Corretto", "HKLM\\SOFTWARE\\BellSoft\\Liberica"];

/** OS-registered JDKs: Windows registry, macOS java_home. */
async function osRegistered(): Promise<string[]> {
  if (process.platform === "win32") {
    const homes: string[] = [];
    for (const key of REG_KEYS) {
      try {
        const { stdout } = await execFileP("reg", ["query", key, "/s"], { timeout: 10_000, windowsHide: true });
        homes.push(...parseRegQuery(stdout));
      } catch {
        /* key absent */
      }
    }
    return homes;
  }
  if (process.platform === "darwin") {
    try {
      const { stderr, stdout } = await execFileP("/usr/libexec/java_home", ["-V"], { timeout: 10_000 });
      return parseJavaHomeV(`${stderr}\n${stdout}`);
    } catch {
      return [];
    }
  }
  return [];
}

function normalizeHome(dir: string): string {
  // macOS bundles (x.jdk/Contents/Home), Homebrew (openjdk@21/libexec/openjdk.jdk/...), Scoop (app/current)
  for (const sub of [["Contents", "Home"], ["libexec", "openjdk.jdk", "Contents", "Home"], ["current"]]) {
    const cand = path.join(dir, ...sub);
    if (existsSync(path.join(cand, "bin", exe("java")))) return cand;
  }
  return dir;
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
  for (const h of await osRegistered()) add(await probe(h, process.platform === "win32" ? "Windows registry" : "java_home"));
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
