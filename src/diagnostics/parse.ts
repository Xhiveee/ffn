/**
 * Structured diagnosis of Gradle output, Minecraft logs (latest.log / debug.log) and crash reports.
 * Pure text → findings; no version-specific knowledge beyond message formats of the tools involved
 * (javac, Gradle, Mixin, FML, Fabric Loader), which are stable across Minecraft versions.
 */

export type FindingKind =
  | "compile_error"
  | "compile_warning"
  | "mixin_error"
  | "mixin_warning"
  | "dependency_resolution"
  | "jvm_mismatch"
  | "toolchain_missing"
  | "missing_mod_dependency"
  | "duplicate_mod"
  | "class_not_found"
  | "linkage_error"
  | "crash"
  | "gradle_failure"
  | "out_of_memory"
  | "graphics"
  | "eula"
  | "network";

export interface Finding {
  kind: FindingKind;
  severity: "error" | "warning" | "info";
  message: string;
  file?: string;
  line?: number;
  mod?: string;
  /** The log line(s) this came from. */
  evidence?: string;
  suggestion?: string;
}

export interface Diagnosis {
  source: "crash-report" | "minecraft-log" | "gradle" | "unknown";
  summary: string;
  findings: Finding[];
  culprit?: { mod: string; confidence: "high" | "medium" | "low"; reasons: string[] };
  description?: string;
  rootException?: string;
}

const NOT_MODS = new Set([
  "minecraft", "forge", "neoforge", "fml", "fabric", "fabricloader", "fabric_api", "java", "mixinextras", "mixin",
  "client", "server", "net", "com", "org", "sun", "jdk", "javafml", "lowcodefml", "mcp", "loader", "securejarhandler",
  "modlauncher", "bootstraplauncher", "eventbus", "coremods", "fmlcore", "fmlloader", "mclanguage", "javafmllanguage",
]);

/** class file major → Java release (52 = Java 8). */
export const classMajorToJava = (major: number) => major - 44;

function push(list: Finding[], f: Finding): void {
  if (!list.some((x) => x.kind === f.kind && x.message === f.message && x.file === f.file && x.line === f.line)) list.push(f);
}

export function detectSource(text: string): Diagnosis["source"] {
  if (/---- Minecraft Crash Report ----/.test(text)) return "crash-report";
  if (/\* What went wrong:|> Task :|BUILD (FAILED|SUCCESSFUL)|Gradle \d/.test(text)) return "gradle";
  if (/\[(main|Render thread|Server thread)\/(INFO|WARN|ERROR|DEBUG)\]/.test(text) || /\[\d\d:\d\d:\d\d\]/.test(text)) return "minecraft-log";
  return "unknown";
}

export function diagnose(text: string): Diagnosis {
  const lines = text.split(/\r?\n/);
  const findings: Finding[] = [];
  const source = detectSource(text);

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    let m: RegExpExecArray | null;

    // ---- javac ----
    if ((m = /^(.*?\.(?:java|kt)):(\d+):(?:(\d+):)? (error|warning): (.+)$/.exec(line))) {
      const details: string[] = [];
      for (let j = i + 1; j < Math.min(lines.length, i + 6); j++) {
        const d = lines[j]!;
        if (/^\s*(symbol|location):/.test(d)) details.push(d.trim());
        if (/\.(java|kt):\d+:/.test(d)) break;
      }
      const isErr = m[4] === "error";
      push(findings, {
        kind: isErr ? "compile_error" : "compile_warning",
        severity: isErr ? "error" : "warning",
        file: m[1],
        line: Number(m[2]),
        message: m[5]! + (details.length ? ` (${details.join("; ")})` : ""),
        evidence: line,
        suggestion: /cannot find symbol|does not exist/.test(m[5]!)
          ? "The name may differ in this Minecraft version or mapping set. Use search_mc_source / get_class to find the current name."
          : undefined,
      });
      continue;
    }
    // Mixin annotation processor (compile time)
    if ((m = /(?:warning|error): (?:\[\w+\] )?Unable to locate obfuscation mapping for (@\w+) target (.+)$/.exec(line)) || (m = /Unable to locate obfuscation mapping for (@\w+) target (\S+)/.exec(line))) {
      push(findings, {
        kind: "mixin_warning",
        severity: "warning",
        message: `Mixin AP could not map ${m[1]} target ${m[2]} — the target probably does not exist under that name in this version.`,
        evidence: line.trim(),
        suggestion: "Check the target with mixin_targets / mixin_validate.",
      });
      continue;
    }

    // ---- Gradle / JVM ----
    if ((m = /Dependency requires at least JVM runtime version (\d+)\. This build uses a Java (\d+) JVM/.exec(line))) {
      push(findings, {
        kind: "jvm_mismatch",
        severity: "error",
        message: `A Gradle plugin needs Java ${m[1]} to run, but Gradle runs on Java ${m[2]}.`,
        evidence: line.trim(),
        suggestion: `Run Gradle with JDK ${m[1]}+ (set JAVA_HOME, or org.gradle.java.home in gradle.properties). gradle_build picks it automatically if installed.`,
      });
      continue;
    }
    if ((m = /Unsupported class file major version (\d+)/.exec(line))) {
      push(findings, {
        kind: "jvm_mismatch",
        severity: "error",
        message: `Something was compiled for Java ${classMajorToJava(Number(m[1]))}, but the running tool (often Gradle/Groovy) is too old for it.`,
        evidence: line.trim(),
        suggestion: "Use a Gradle version that supports that Java version, or run Gradle on an older JDK.",
      });
      continue;
    }
    if ((m = /has been compiled by a more recent version of the Java Runtime \(class file version (\d+)\.\d+\), this version of the Java Runtime only recognizes class file versions up to (\d+)\.\d+/.exec(line))) {
      const need = classMajorToJava(Number(m[1]));
      const have = classMajorToJava(Number(m[2]));
      push(findings, {
        kind: "jvm_mismatch",
        severity: "error",
        message: `Wrong Java: code requires Java ${need} but is running on Java ${have}.`,
        evidence: line.trim(),
        suggestion: `Run with Java ${need}+ (launcher/IDE run config/JAVA_HOME).`,
      });
      continue;
    }
    if ((m = /(?:No matching toolchains found for requested specification|Cannot find a Java installation on your machine matching).*?languageVersion=(\d+)/.exec(line))) {
      push(findings, {
        kind: "toolchain_missing",
        severity: "error",
        message: `Gradle toolchain JDK ${m[1]} not found and could not be provisioned.`,
        evidence: line.trim(),
        suggestion: `Install JDK ${m[1]}, enable the foojay toolchain resolver (settings.gradle) or pass -Porg.gradle.java.installations.paths=<jdk>.`,
      });
      continue;
    }
    if ((m = /Gradle requires JVM (\d+) or later to run/.exec(line))) {
      push(findings, { kind: "jvm_mismatch", severity: "error", message: `Gradle needs Java ${m[1]}+ to run.`, evidence: line.trim(), suggestion: `Run Gradle with JDK ${m[1]}+.` });
      continue;
    }
    if ((m = /Your build is currently configured to use (?:incompatible )?Java (\d+)(?:\.\S*)? and Gradle ([\d.]+)/.exec(line))) {
      push(findings, {
        kind: "jvm_mismatch",
        severity: "error",
        message: `Java ${m[1]} cannot run Gradle ${m[2]}.`,
        evidence: line.trim(),
        suggestion: "Run Gradle on an older JDK (the profile's Java version) or upgrade the Gradle wrapper.",
      });
      continue;
    }
    if ((m = /Could not (?:resolve|find) ((?:[\w.-]+:){2}[\w.+-]+)/.exec(line))) {
      const near = lines.slice(i, i + 8).join("\n");
      const status = /status code (\d{3})/.exec(near)?.[1];
      push(findings, {
        kind: "dependency_resolution",
        severity: "error",
        message: `Could not resolve ${m[1]}${status ? ` (HTTP ${status})` : ""}.`,
        evidence: line.trim(),
        suggestion:
          status && /^5/.test(status)
            ? "The repository returned a server error — usually temporary. Retry later (gradle_build again)."
            : /No cached version available for offline mode/.test(near)
              ? "Gradle is in offline mode without a cached copy. Run once online."
              : "Check the version exists for this Minecraft version (list_versions) and that the repository is declared.",
      });
      continue;
    }
    if (/Could not GET '.*'.*status code 5\d\d|Connection reset|Read timed out|UnknownHostException/.test(line)) {
      push(findings, { kind: "network", severity: "warning", message: "Network/repository error while downloading.", evidence: line.trim(), suggestion: "Retry; check internet access or proxy settings." });
      continue;
    }
    if (/^\* What went wrong:/.test(line)) {
      const block: string[] = [];
      for (let j = i + 1; j < lines.length && !/^\* (Try|Exception is):/.test(lines[j]!); j++) if (lines[j]!.trim()) block.push(lines[j]!.trim());
      push(findings, { kind: "gradle_failure", severity: "error", message: block.slice(0, 6).join(" ").slice(0, 600), evidence: block[0] });
      continue;
    }

    // ---- Mixin (runtime) ----
    if ((m = /Critical injection failure: (@\w+) annotation on (\S+) could not find any targets matching '(.+?)' in (?:the target class )?(\S+?)\.? (?:Using refmap (\S+))?/.exec(line)) || (m = /Critical injection failure: (@\w+) annotation on (\S+) could not find any targets matching '(.+?)' in (\S+?)\./.exec(line))) {
      push(findings, {
        kind: "mixin_error",
        severity: "error",
        message: `${m[1]} handler ${m[2]} found no target '${m[3]}' in ${m[4]}.`,
        mod: modFromMixinText(line),
        evidence: line.trim(),
        suggestion: "The target method/descriptor changed or the refmap is missing. Check with mixin_targets; for SRG-runtime versions make sure the refmap is generated and listed in the mixins.json.",
      });
      continue;
    }
    if ((m = /@Shadow (field|method) (\S+) was not located in the target class (\S+)/.exec(line))) {
      push(findings, { kind: "mixin_error", severity: "error", message: `@Shadow ${m[1]} ${m[2]} not found in ${m[3]}.`, mod: modFromMixinText(line), evidence: line.trim(), suggestion: "Rename the shadow to the member's name in this version (get_class)." });
      continue;
    }
    if ((m = /Method overwrite conflict for (\S+) in (\S+), previously written by (\S+)/.exec(line))) {
      push(findings, { kind: "mixin_error", severity: "error", message: `Two mixins @Overwrite ${m[1]} in ${m[2]} (previous: ${m[3]}).`, evidence: line.trim(), suggestion: "Avoid @Overwrite; use @Inject or MixinExtras @WrapMethod/@WrapOperation which compose with other mods." });
      continue;
    }
    if ((m = /(InvalidInjectionException|InvalidMixinException|InvalidAccessorException|InvalidInterfaceMixinException|MixinTargetAlreadyLoadedException|MixinApplyError|MixinTransformerError)[:\s]+(.+)/.exec(line))) {
      push(findings, {
        kind: "mixin_error",
        severity: "error",
        message: `${m[1]}: ${m[2]!.slice(0, 400)}`,
        mod: modFromMixinText(line),
        evidence: line.trim(),
        suggestion: mixinSuggestion(m[1]!, m[2]!),
      });
      continue;
    }
    if ((m = /Mixin apply (?:for mod (\S+) )?failed (\S+) -> (\S+): (.+)/.exec(line))) {
      push(findings, { kind: "mixin_error", severity: "error", message: `Mixin ${m[2]} failed on ${m[3]}: ${m[4]!.slice(0, 300)}`, mod: m[1] ?? modFromMixinText(line), evidence: line.trim() });
      continue;
    }
    if ((m = /No enum constant org\.spongepowered\.asm\.mixin\.MixinEnvironment\.CompatibilityLevel\.(\w+)/.exec(line)) || (m = /(?:Unrecognised|Unsupported) compatibility level (\w+)/i.exec(line))) {
      push(findings, { kind: "mixin_error", severity: "error", message: `Mixin compatibilityLevel ${m[1]} is not supported by the bundled Mixin.`, evidence: line.trim(), suggestion: "Lower compatibilityLevel in the mixins.json (get_profile shows the maximum for this loader/version)." });
      continue;
    }
    if ((m = /(?:The specified mixin|Mixin class) '?([\w.$]+)'? (?:was not found|could not be found)|ClassNotFoundException: The specified mixin '([\w.$]+)' was not found/.exec(line))) {
      push(findings, { kind: "mixin_error", severity: "error", message: `Mixin class ${m[1] ?? m[2]} listed in a mixins.json does not exist.`, evidence: line.trim(), suggestion: "Fix the package/class name in the mixins.json (mixin_validate checks this)." });
      continue;
    }

    // ---- Loader dependency problems ----
    if ((m = /Mod ID: '([\w-]+)', Requested by: '([\w-]+)', Expected range: '([^']*)', Actual version: '([^']*)'/.exec(line))) {
      push(findings, {
        kind: "missing_mod_dependency",
        severity: "error",
        message: `${m[2]} requires ${m[1]} ${m[3]} but found ${m[4]}.`,
        mod: m[2],
        evidence: line.trim(),
        suggestion: m[4] === "[MISSING]" ? `Install ${m[1]} (${m[3]}) or make the dependency optional in mods.toml.` : `Install a version of ${m[1]} within ${m[3]}.`,
      });
      continue;
    }
    if ((m = /Mod '([^']+)' \(([\w-]+)\) [\w.+-]+ requires (?:version|any version)( [^ ]+)? (?:of )?(?:mod )?'?([^',]+?)'?(?: \(([\w-]+)\))?, which is missing/.exec(line))) {
      push(findings, { kind: "missing_mod_dependency", severity: "error", message: `${m[1]} (${m[2]}) requires ${m[5] ?? m[4]}${m[3] ?? ""}, which is missing.`, mod: m[2], evidence: line.trim(), suggestion: `Install ${m[5] ?? m[4]}${m[3] ?? ""}.` });
      continue;
    }
    if ((m = /requires (?:version )?(\S+) of (?:mod )?'?([\w ._-]+)'? ?\(?([\w-]*)\)?, (?:but only the wrong version is present|which is missing)/.exec(line)) && !/Mod '/.test(line)) {
      push(findings, { kind: "missing_mod_dependency", severity: "error", message: line.trim().replace(/^\s*-\s*/, ""), mod: undefined, evidence: line.trim(), suggestion: `Install ${m[2]} ${m[1]}.` });
      continue;
    }
    if (/Duplicate mods? found|Found duplicate mods|DuplicateModsFoundException/.test(line)) {
      push(findings, { kind: "duplicate_mod", severity: "error", message: line.trim(), evidence: line.trim(), suggestion: "Remove one of the duplicate jars from the mods folder." });
      continue;
    }

    // ---- JVM linkage ----
    if ((m = /NoClassDefFoundError: Could not initialize class ([\w.$]+)/.exec(line))) {
      push(findings, {
        kind: "class_not_found",
        severity: "warning",
        message: `Static initialisation of ${m[1]} failed earlier (follow-up error).`,
        evidence: line.trim(),
        suggestion: "Look for the first exception in the log (often a Mixin failure); this one is a consequence.",
      });
      continue;
    }
    if ((m = /(ClassNotFoundException|NoClassDefFoundError):? ([\w.$/]+)/.exec(line))) {
      const cls = m[2]!.replace(/\//g, ".");
      push(findings, {
        kind: "class_not_found",
        severity: "error",
        message: `${m[1]}: ${cls}`,
        evidence: line.trim(),
        suggestion: cls.startsWith("net.minecraft.")
          ? "A Minecraft class that does not exist in this version/mapping (renamed or client-only code on a server). Check with search_mc_source; keep client classes out of common code."
          : "A dependency is missing at runtime or the class is client-only. Add the dependency (and jar-in-jar it if needed).",
      });
      continue;
    }
    if ((m = /(NoSuchMethodError|NoSuchFieldError|AbstractMethodError|IncompatibleClassChangeError):? '?(.+?)'?$/.exec(line))) {
      push(findings, { kind: "linkage_error", severity: "error", message: `${m[1]}: ${m[2]}`, evidence: line.trim(), suggestion: "The mod was compiled against a different version of Minecraft/the loader/a library than it runs on. Rebuild against the runtime versions." });
      continue;
    }
    if (/java\.lang\.OutOfMemoryError/.test(line)) {
      push(findings, { kind: "out_of_memory", severity: "error", message: line.trim(), evidence: line.trim(), suggestion: "Increase heap (-Xmx) for the game or org.gradle.jvmargs for Gradle." });
      continue;
    }
    if (/GLFW error|Failed to create (?:the )?window|No OpenGL context|WGL: The driver does not appear to support OpenGL|Pixel format not accelerated/.test(line)) {
      push(findings, { kind: "graphics", severity: "error", message: line.trim(), evidence: line.trim(), suggestion: "No usable OpenGL. Update GPU drivers; on headless Linux use Xvfb with Mesa (LIBGL_ALWAYS_SOFTWARE=1)." });
      continue;
    }
    if (/Failed to open OpenAL device|Error starting SoundSystem/.test(line)) {
      push(findings, { kind: "graphics", severity: "info", message: "No audio device (sound disabled) — harmless on headless machines.", evidence: line.trim() });
      continue;
    }
    if (/You need to agree to the EULA in order to run the server/.test(line)) {
      push(findings, { kind: "eula", severity: "error", message: "The Minecraft EULA has not been accepted.", evidence: line.trim(), suggestion: "The user must read https://aka.ms/MinecraftEULA and agree; then call run_server with acceptEula=true." });
    }
  }

  // ---- Crash report structure ----
  let description: string | undefined;
  let rootException: string | undefined;
  if (source === "crash-report") {
    const di = lines.findIndex((l) => l.startsWith("Description:"));
    if (di >= 0) {
      description = lines[di]!.slice("Description:".length).trim();
      rootException = lines.slice(di + 1, di + 6).find((l) => /^\S+(Exception|Error)\b|^[\w.$]+: /.test(l.trim()))?.trim();
      push(findings, { kind: "crash", severity: "error", message: `${description}${rootException ? ` — ${rootException}` : ""}`, evidence: rootException });
    }
  }
  if (!rootException) {
    const exc = lines.find((l) => /^(?:Caused by: )?[\w.$]+(?:Exception|Error)(?::|$)/.test(l.trim()));
    rootException = lines.filter((l) => /^Caused by: /.test(l.trim())).at(-1)?.trim() ?? exc?.trim();
  }

  const culprit = findCulprit(text, findings);
  const errors = findings.filter((f) => f.severity === "error");
  const summary =
    errors.length === 0
      ? findings.some((f) => f.severity === "warning")
        ? `${findings.filter((f) => f.severity === "warning").length} warning(s), no errors recognised.`
        : "No known error patterns recognised."
      : `${errors.length} error(s): ${[...new Set(errors.map((f) => f.kind))].join(", ")}${culprit ? `; likely culprit: ${culprit.mod}` : ""}.`;
  return { source, summary, findings, culprit, description, rootException };
}

function modFromMixinText(line: string): string | undefined {
  const cfg = /([\w-]+)\.mixins\.json/.exec(line)?.[1] ?? /mixins\.([\w-]+)\.json/.exec(line)?.[1];
  return cfg && !NOT_MODS.has(cfg) ? cfg : undefined;
}

function mixinSuggestion(kind: string, msg: string): string {
  if (/cannot overwrite method .* @Overwrite is required/i.test(msg)) return "A mixin method (often an @Accessor/@Invoker or handler) has the same name+descriptor as a method in the target. Rename it (e.g. prefix with <modid>$); mixin_validate detects this.";
  if (/Invalid descriptor|expected .* but found|signature/i.test(msg)) return "The handler signature does not match the target. Compare it with the real descriptor from mixin_targets / get_class.";
  if (/could not find any targets|No refMap|not located/i.test(msg)) return "Target not found: the method/field was renamed or its descriptor changed in this version. Check with mixin_targets.";
  if (kind === "MixinTargetAlreadyLoadedException") return "The target class was loaded before Mixin could transform it (often by another mod or a static reference in a mixin). Avoid touching the target class from mod init code.";
  return "Run mixin_validate on the project to locate the bad annotation.";
}

/** Score mod candidates from crash-report sections, mixin configs and stack frames. */
export function findCulprit(text: string, findings: Finding[]): Diagnosis["culprit"] {
  const score = new Map<string, { s: number; reasons: string[] }>();
  const add = (mod: string | undefined, s: number, reason: string) => {
    if (!mod) return;
    const id = mod.toLowerCase();
    if (NOT_MODS.has(id) || id.length < 2) return;
    const e = score.get(id) ?? { s: 0, reasons: [] };
    e.s += s;
    if (!e.reasons.includes(reason)) e.reasons.push(reason);
    score.set(id, e);
  };
  for (const m of text.matchAll(/Suspected Mods?:\s*(.+)/g)) {
    for (const part of m[1]!.split(/,\s*(?=[A-Za-z])/)) {
      const id = /\(([\w-]+)\)/.exec(part)?.[1];
      if (!/^(NONE|Unknown)/i.test(part.trim())) add(id ?? part.trim().split(/\s/)[0], 10, "listed under 'Suspected Mods'");
    }
  }
  for (const f of findings) if (f.mod) add(f.mod, f.kind === "mixin_error" ? 8 : 6, `named in a ${f.kind.replace(/_/g, " ")}`);
  const traceStart = text.search(/(?:Exception|Error)[:\s]/);
  const trace = traceStart >= 0 ? text.slice(traceStart, traceStart + 6000) : "";
  for (const m of trace.matchAll(/pl:mixin:APP:([\w-]+)\.mixins\.json/g)) add(m[1], 4, "its mixin is applied in the failing stack");
  for (const m of trace.matchAll(/\bhandler\$\w+\$([a-z][a-z0-9_]{1,63})\$/g)) add(m[1], 4, "its mixin handler is in the failing stack");
  for (const m of trace.matchAll(/~\[([a-z][\w.-]*?)-\d[\w.+-]*\.jar/g)) {
    const jar = m[1]!;
    if (!/^(forge|neoforge|minecraft|client|server|fmlcore|javafmllanguage|fabric-loader|mixin|sponge-mixin|guava|netty|datafixerupper|brigadier|authlib|lwjgl|slf4j|log4j|bootstraplauncher|modlauncher|securejarhandler)/.test(jar)) {
      add(jar, 2, "its jar appears in the failing stack");
    }
  }
  const best = [...score.entries()].sort((a, b) => b[1].s - a[1].s)[0];
  if (!best) return undefined;
  const [mod, { s, reasons }] = best;
  return { mod, confidence: s >= 8 ? "high" : s >= 4 ? "medium" : "low", reasons };
}
