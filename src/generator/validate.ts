const JAVA_KEYWORDS = new Set(
  "abstract assert boolean break byte case catch char class const continue default do double else enum extends final finally float for goto if implements import instanceof int interface long native new package private protected public return short static strictfp super switch synchronized this throw throws transient try void volatile while true false null var record yield sealed permits".split(" "),
);

/** Forge/NeoForge rule (also valid for Fabric): ^[a-z][a-z0-9_]{1,63}$ */
export const MOD_ID_RE = /^[a-z][a-z0-9_]{1,63}$/;

export function validateModId(id: string): string | null {
  if (!MOD_ID_RE.test(id)) {
    return `Invalid modId "${id}": must match ^[a-z][a-z0-9_]{1,63}$ (2–64 chars, lowercase letters, digits, underscore, starting with a letter). This is the strictest rule across Forge, NeoForge and Fabric.`;
  }
  if (["minecraft", "forge", "neoforge", "fabric", "fabricloader", "java", "mixinextras"].includes(id)) {
    return `Invalid modId "${id}": reserved by Minecraft or a mod loader.`;
  }
  return null;
}

export function validatePackage(pkg: string): string | null {
  const parts = pkg.split(".");
  if (parts.length < 2) return `Invalid package "${pkg}": use a reverse-domain package with at least two segments, e.g. com.example.${pkg || "mymod"}.`;
  for (const p of parts) {
    if (!/^[a-z_][a-z0-9_]*$/.test(p)) return `Invalid package "${pkg}": segment "${p}" must be lowercase [a-z_][a-z0-9_]*.`;
    if (JAVA_KEYWORDS.has(p)) return `Invalid package "${pkg}": "${p}" is a Java keyword.`;
  }
  return null;
}

export function validateClassName(name: string): string | null {
  if (!/^[A-Z][A-Za-z0-9_]*$/.test(name) || JAVA_KEYWORDS.has(name)) return `Invalid main class name "${name}".`;
  return null;
}

export function deriveMainClass(modName: string, modId: string): string {
  const fromName = modName
    .normalize("NFKD")
    .replace(/[^A-Za-z0-9 _-]/g, "")
    .split(/[\s_-]+/)
    .filter(Boolean)
    .map((w) => w[0]!.toUpperCase() + w.slice(1))
    .join("");
  const base = /^[A-Za-z]/.test(fromName) ? fromName : modId.split("_").map((w) => w[0]!.toUpperCase() + w.slice(1)).join("");
  return /Mod$/.test(base) ? base : `${base}Mod`;
}

/** Escape for Java/Groovy string literals and TOML basic strings. */
export function esc(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n");
}

/**
 * Escape a value for a .properties file. Gradle reads gradle.properties as ISO-8859-1,
 * so everything outside printable ASCII (e.g. Cyrillic mod names) becomes \uXXXX.
 */
export function propEsc(s: string): string {
  return s
    .replace(/\\/g, "\\\\")
    .replace(/\n/g, "\\n")
    .replace(/^\s/, "\\ ")
    .replace(/[^\x20-\x7e]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`);
}
