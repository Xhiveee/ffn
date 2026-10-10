/**
 * check_profiles: compare FFN's version profiles with upstream references (official example mod / MDKs, Gradle,
 * plugin metadata) and with Minecraft releases newer than the profiles were tested against. Reports what is
 * outdated or unverified and suggests user-profile patches — nothing is applied.
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import YAML from "yaml";
import { z } from "zod";
import { LoaderSchema, type Loader } from "../profiles/schema.js";
import { lookupProfile, type Services } from "../services.js";
import { compareMcVersions, isReleaseVersion } from "../util/mcversion.js";
import { guard, ok } from "./result.js";

const RefSchema = z.object({
  loader: LoaderSchema,
  title: z.string(),
  versions: z.array(z.string()),
  pluginId: z.array(z.string()).default([]),
  files: z.array(z.object({ url: z.string(), extract: z.record(z.string(), z.string()) })),
});
const UpstreamSchema = z.object({ gradleCurrent: z.string().optional(), references: z.array(RefSchema) });

export interface Finding {
  loader: Loader;
  mcVersion?: string;
  item: "minecraft" | "gradle" | "plugin" | "verification";
  status: "ok" | "outdated" | "ahead" | "unverified" | "unavailable" | "info";
  profile?: string;
  upstream?: string;
  source?: string;
  message: string;
}

/** Compare dotted versions numerically ("9.10" > "9.8"); suffixes like -SNAPSHOT compare by their numeric prefix. */
export function compareDotted(a: string, b: string): number {
  const pa = a.split(/[^\d]+/).filter(Boolean).map(Number);
  const pb = b.split(/[^\d]+/).filter(Boolean).map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d) return d;
  }
  return 0;
}

/** Same plugin line? A "1.18-SNAPSHOT" reference is satisfied by any resolved 1.18.x. */
export function pluginBehind(resolved: string, upstream: string): boolean {
  const range = /^[[(]([\d.]+),/.exec(upstream);
  const up = range ? range[1]! : upstream;
  const n = up.split(/[^\d]+/).filter(Boolean).length;
  const res = resolved.split(/[^\d]+/).filter(Boolean).slice(0, /SNAPSHOT|\+/.test(up) || range ? Math.min(n, 2) : n).join(".");
  const upCut = up.split(/[^\d]+/).filter(Boolean).slice(0, /SNAPSHOT|\+/.test(up) || range ? Math.min(n, 2) : n).join(".");
  return compareDotted(res, upCut) < 0;
}

export async function checkProfiles(services: Services, a: { loaders?: Loader[]; network?: boolean }) {
  const userFile = path.join(services.config.userProfilesDir, "checks", "upstream.yaml");
  const file = existsSync(userFile) ? userFile : path.join(services.config.builtinProfilesDir, "checks", "upstream.yaml");
  const upstream = UpstreamSchema.parse(YAML.parse(await readFile(file, "utf8")));
  const profiles = await services.profiles();
  const loaders = (a.loaders?.length ? a.loaders : (["fabric", "forge", "neoforge"] as Loader[])).filter((l) => profiles[l]);
  const findings: Finding[] = [];
  const patches: Record<string, { testedUpTo?: string; rules: { since: string; description: string; set: Record<string, unknown> }[] }> = {};
  const patch = (l: Loader) => (patches[l] ??= { rules: [] });
  const today = new Date().toISOString().slice(0, 10);

  const manifest = await services.versions.mojangManifest();
  const latest = manifest.latest.release;
  const releases = manifest.versions.filter((v) => v.type === "release" && isReleaseVersion(v.id)).map((v) => v.id);
  let avail: Record<Loader, Set<string>> | undefined;
  try {
    avail = await services.versions.loaderAvailability();
  } catch {
    /* optional */
  }
  let gradleCurrent: string | undefined;
  if (upstream.gradleCurrent) {
    try {
      gradleCurrent = (JSON.parse((await services.versions.text(upstream.gradleCurrent)) ?? "{}") as { version?: string }).version;
    } catch {
      /* optional */
    }
  }

  // 1) Minecraft releases newer than testedUpTo
  for (const l of loaders) {
    const p = profiles[l]!;
    const newer = releases.filter((v) => compareMcVersions(v, p.testedUpTo) > 0).sort(compareMcVersions);
    const withBuilds = avail ? newer.filter((v) => avail![l].has(v)) : newer;
    if (!newer.length) findings.push({ loader: l, item: "minecraft", status: "ok", profile: p.testedUpTo, upstream: latest, message: `testedUpTo ${p.testedUpTo} covers the latest release ${latest}.` });
    else {
      findings.push({
        loader: l,
        item: "minecraft",
        status: "unverified",
        profile: p.testedUpTo,
        upstream: latest,
        message: `Minecraft ${newer.join(", ")} released after testedUpTo ${p.testedUpTo}; ${withBuilds.length ? `${l} has builds for ${withBuilds.join(", ")}` : `no ${l} builds yet`}. Profiles extrapolate (UNVERIFIED) until someone builds a project there.`,
      });
      if (withBuilds.length) patch(l).testedUpTo = withBuilds.at(-1);
    }
  }

  // 2) Upstream references
  for (const ref of upstream.references.filter((r) => loaders.includes(r.loader))) {
    const p = profiles[ref.loader]!;
    const extracted = new Map<string, Record<string, string>>();
    const mcs = new Set<string>();
    let refMinecraft: string | undefined;
    // the "latestReference" token needs the reference's own minecraft value
    const fetchFor = async (mc: string | undefined) => {
      const vals: Record<string, string> = {};
      for (const f of ref.files) {
        const url = mc ? f.url.replace(/\{mc\}/g, mc) : f.url;
        const text = await services.versions.text(url, undefined, 6 * 3600_000).catch(() => undefined);
        if (!text) continue;
        for (const [k, re] of Object.entries(f.extract)) {
          const m = new RegExp(re, "m").exec(text);
          if (m?.[1]) vals[k] = m[1].trim();
        }
      }
      return vals;
    };
    for (const tok of ref.versions) {
      if (tok === "latestReference") {
        const vals = await fetchFor(undefined);
        refMinecraft = vals.minecraft;
        if (refMinecraft) {
          mcs.add(refMinecraft);
          extracted.set(refMinecraft, vals);
        }
        continue;
      }
      const mc = tok === "latest" ? latest : tok === "testedUpTo" ? p.testedUpTo : tok === "minVersion" ? p.minVersion : tok;
      mcs.add(mc);
    }
    for (const mc of mcs) {
      const title = ref.title.replace(/\{mc\}/g, mc);
      const vals = extracted.get(mc) ?? (await fetchFor(mc));
      if (!Object.keys(vals).length) {
        findings.push({ loader: ref.loader, mcVersion: mc, item: "verification", status: "unavailable", source: title, message: `${title}: not published (or not reachable); nothing to compare.` });
        continue;
      }
      let prof;
      try {
        prof = (await lookupProfile(services, ref.loader, mc)).profile;
      } catch (e) {
        findings.push({ loader: ref.loader, mcVersion: mc, item: "verification", status: "unavailable", message: `No profile for ${mc}: ${(e as Error).message}` });
        continue;
      }
      if (vals.gradle && prof.gradle.version) {
        const c = compareDotted(prof.gradle.version, vals.gradle);
        const status = c === 0 ? "ok" : c < 0 ? "outdated" : "ahead";
        findings.push({
          loader: ref.loader, mcVersion: mc, item: "gradle", status, profile: prof.gradle.version, upstream: vals.gradle, source: title,
          message: c === 0 ? `Gradle ${prof.gradle.version} matches ${title}.` : c < 0 ? `Profile pins Gradle ${prof.gradle.version}; ${title} uses ${vals.gradle}.` : `Profile pins Gradle ${prof.gradle.version}, newer than ${title} (${vals.gradle}); fine if builds pass.`,
        });
        if (c < 0) patch(ref.loader).rules.push({ since: prof.basedOn, description: `check_profiles ${today}: Gradle as in ${title} (verify with gradle_build before relying on it)`, set: { gradle: { version: vals.gradle } } });
      }
      if (vals.plugin && (!ref.pluginId.length || ref.pluginId.includes(prof.plugin.id))) {
        let resolved = prof.plugin.version;
        if (resolved === "latest" && prof.plugin.metadataUrl) {
          resolved = (await services.versions.latestPluginVersion(prof.plugin.metadataUrl, { prefix: prof.plugin.versionPrefix, allowUnstable: prof.plugin.allowUnstable }).catch(() => undefined)) ?? "?";
        }
        const behind = resolved !== "?" && pluginBehind(resolved, vals.plugin);
        findings.push({
          loader: ref.loader, mcVersion: mc, item: "plugin", status: resolved === "?" ? "unavailable" : behind ? "outdated" : "ok", profile: `${prof.plugin.id} ${prof.plugin.version === "latest" ? `latest → ${resolved}` : resolved}`, upstream: vals.plugin, source: title,
          message: behind ? `${prof.plugin.id} resolves to ${resolved}, but ${title} uses ${vals.plugin}${prof.plugin.versionPrefix ? ` (profile restricts to prefix ${prof.plugin.versionPrefix})` : ""}.` : `${prof.plugin.id} ${resolved} is in line with ${title} (${vals.plugin}).`,
        });
        if (behind && prof.plugin.versionPrefix) patch(ref.loader).rules.push({ since: prof.basedOn, description: `check_profiles ${today}: plugin line as in ${title}`, set: { plugin: { versionPrefix: vals.plugin.replace(/-SNAPSHOT$/, "").replace(/^(\d+\.\d+).*$/, "$1") } } });
      } else if (vals.plugin) {
        findings.push({ loader: ref.loader, mcVersion: mc, item: "plugin", status: "info", profile: prof.plugin.id, upstream: vals.plugin, source: title, message: `FFN uses ${prof.plugin.id} for ${ref.loader} ${mc}; ${title} uses another plugin (${vals.plugin}). Intentional deviation — see the profile notes.` });
      }
      if (!prof.verified) findings.push({ loader: ref.loader, mcVersion: mc, item: "verification", status: "unverified", message: `${ref.loader} ${mc}: the matching profile rule (${prof.basedOn}+) lists no maintainer build for ${mc}${prof.extrapolated ? " and the version is newer than testedUpTo" : ""}.` });
    }
  }
  if (gradleCurrent) {
    for (const l of loaders) {
      const pins = new Set<string>();
      for (const r of profiles[l]!.rules) if (r.set.gradle?.version) pins.add(r.set.gradle.version);
      const old = [...pins].filter((v) => compareDotted(v, gradleCurrent!) < 0);
      if (old.length) findings.push({ loader: l, item: "gradle", status: "info", profile: [...pins].join(", "), upstream: gradleCurrent, message: `Gradle ${gradleCurrent} is the current release; profiles pin ${[...pins].join(", ")}. Only move when the loader plugin supports it (the references above are authoritative).` });
    }
  }

  const yaml = Object.entries(patches)
    .filter(([, p]) => p.rules.length || p.testedUpTo)
    .map(([l, p]) => {
      const seen = new Set<string>();
      const rules = p.rules.filter((r) => {
        const k = JSON.stringify([r.since, r.set]);
        if (seen.has(k)) return false;
        seen.add(k);
        return true;
      });
      const doc: Record<string, unknown> = { loader: l, ...(p.testedUpTo ? { testedUpTo: p.testedUpTo } : {}), rules: rules.length ? rules : [{ since: profiles[l as Loader]!.testedUpTo, description: `check_profiles ${today}: placeholder (testedUpTo bump only)`, set: {} }] };
      return `# ${path.join(services.config.userProfilesDir, `${l}-check-${today}.yaml`)}\n# Suggested by check_profiles — NOT applied. Bump testedUpTo only after a project builds on that version.\n${YAML.stringify(doc)}`;
    });
  const counts = Object.fromEntries(["outdated", "unverified", "unavailable", "ok"].map((s) => [s, findings.filter((f) => f.status === s).length]));
  return ok(
    `Profiles checked against ${upstream.references.filter((r) => loaders.includes(r.loader)).length} upstream reference(s) and Mojang releases (latest ${latest}): ${counts.outdated} outdated, ${counts.unverified} unverified, ${counts.unavailable} unavailable, ${counts.ok} ok.` +
      (yaml.length ? ` Suggested profile patches are included (not applied).` : " No patches needed."),
    { latestRelease: latest, gradleCurrent, referencesFile: file, findings, suggestedPatches: yaml },
  );
}

export function registerCheckProfiles(server: McpServer, services: Services): void {
  server.registerTool(
    "check_profiles",
    {
      title: "Check profiles",
      description:
        "Compare FFN's version profiles with upstream references (official Fabric example mod, NeoForge/Forge MDKs, Gradle, plugin maven metadata — declared in profiles/checks/upstream.yaml) and with Minecraft releases newer than the profiles' testedUpTo. Reports what is outdated or unverified and returns suggested user-profile YAML patches. Never modifies profiles.",
      inputSchema: { loaders: z.array(LoaderSchema).optional().describe("Loaders to check (default all)") },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    (a) => guard(() => checkProfiles(services, a)),
  );
}
