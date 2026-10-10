/**
 * Minecraft version parsing & comparison.
 *
 * Handles both the classic scheme (1.20.1, 1.21.11) and the year-based scheme
 * Mojang introduced in 2026 (26.1, 26.1.2, 26.3), plus pre-release suffixes
 * (1.21.5-pre1, 1.21-rc1, 26.4-snapshot-3). Weekly snapshots (25w14a) are not
 * orderable by number; callers must resolve them via the Mojang manifest.
 *
 * Nothing here knows about specific versions: ordering is purely numeric, so
 * future versions (1.99.0, 27.1, …) compare correctly.
 */

export interface ParsedMcVersion {
  raw: string;
  /** Numeric release components, e.g. [1, 20, 1] or [26, 3]. */
  release: number[];
  /** Pre-release qualifier ("pre", "rc", "snapshot") or undefined for a release. */
  preKind?: string;
  preNumber?: number;
}

const RELEASE_RE = /^(\d+(?:\.\d+){1,3})(?:[-_ ]?(pre|rc|snapshot|pre-release|release-candidate)[-_ ]?(\d+))?$/i;
const WEEKLY_SNAPSHOT_RE = /^\d{2}w\d{2}[a-z]$/i;

export function isWeeklySnapshot(v: string): boolean {
  return WEEKLY_SNAPSHOT_RE.test(v.trim());
}

export function parseMcVersion(v: string): ParsedMcVersion | null {
  const s = v.trim();
  const m = RELEASE_RE.exec(s);
  if (!m) return null;
  const release = m[1]!.split(".").map((x) => Number.parseInt(x, 10));
  let preKind = m[2]?.toLowerCase();
  if (preKind === "pre-release") preKind = "pre";
  if (preKind === "release-candidate") preKind = "rc";
  return { raw: s, release, preKind, preNumber: m[3] ? Number.parseInt(m[3], 10) : undefined };
}

export function isReleaseVersion(v: string): boolean {
  const p = parseMcVersion(v);
  return !!p && !p.preKind;
}

const PRE_ORDER: Record<string, number> = { snapshot: 0, pre: 1, rc: 2 };

/** Compare two MC versions. Throws for unparseable input (e.g. weekly snapshots). */
export function compareMcVersions(a: string, b: string): number {
  const pa = parseMcVersion(a);
  const pb = parseMcVersion(b);
  if (!pa || !pb) throw new Error(`Cannot compare non-numeric Minecraft versions: ${a} vs ${b}`);
  const len = Math.max(pa.release.length, pb.release.length);
  for (let i = 0; i < len; i++) {
    const x = pa.release[i] ?? 0;
    const y = pb.release[i] ?? 0;
    if (x !== y) return x - y;
  }
  // Same numeric release: a pre-release sorts before the release.
  if (!pa.preKind && !pb.preKind) return 0;
  if (!pa.preKind) return 1;
  if (!pb.preKind) return -1;
  const k = (PRE_ORDER[pa.preKind] ?? 0) - (PRE_ORDER[pb.preKind] ?? 0);
  if (k !== 0) return k;
  return (pa.preNumber ?? 0) - (pb.preNumber ?? 0);
}

/** Release a pre-release belongs to: "26.4-snapshot-3" -> "26.4". */
export function targetRelease(v: string): string | null {
  const p = parseMcVersion(v);
  return p ? p.release.join(".") : null;
}


/** Generic dotted-numeric comparison for loader/plugin versions ("0.92.12", "21.1.256", "2.0.148"). */
export function compareLooseVersions(a: string, b: string): number {
  const split = (s: string) => s.split(/[.+\-]/);
  const xa = split(a);
  const xb = split(b);
  const len = Math.max(xa.length, xb.length);
  for (let i = 0; i < len; i++) {
    const sa = xa[i];
    const sb = xb[i];
    if (sa === undefined) return sb !== undefined && /^\d+$/.test(sb) ? -1 : 1;
    if (sb === undefined) return /^\d+$/.test(sa) ? 1 : -1;
    const na = /^\d+$/.test(sa) ? Number(sa) : NaN;
    const nb = /^\d+$/.test(sb) ? Number(sb) : NaN;
    if (!Number.isNaN(na) && !Number.isNaN(nb)) {
      if (na !== nb) return na - nb;
    } else if (Number.isNaN(na) && Number.isNaN(nb)) {
      if (sa !== sb) return sa < sb ? -1 : 1;
    } else {
      // numeric > qualifier ("1.0.0" > "1.0.beta")
      return Number.isNaN(na) ? -1 : 1;
    }
  }
  return 0;
}

/** True for versions that look like pre-release builds of a library/plugin. */
export function isUnstableArtifactVersion(v: string): boolean {
  return /(snapshot|alpha|beta|rc|pre|-pr-)/i.test(v);
}
