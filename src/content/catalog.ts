/**
 * Content catalog: declarative generators in profiles/content/*.yaml (built-in) and
 * <FFN_PROFILES_DIR>/content/*.yaml (user). Version differences are expressed as
 *  - rules (since/until/obfuscated → settings such as data folder names and recipe JSON format),
 *  - probes (symbol specs checked against the project's real classpath),
 *  - symbols (class aliases with candidates, first one present on the classpath wins),
 *  - variants (first variant whose `requires` all hold).
 * The engine (engine.ts) contains no version-specific branches.
 */
import { existsSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import YAML from "yaml";
import { z } from "zod";
import type { FfnConfig } from "../config.js";
import { compareMcVersions } from "../util/mcversion.js";

const Str = z.string();
const StrList = z.union([Str, z.array(Str)]).transform((v) => (Array.isArray(v) ? v : [v]));

export const OpSchema = z
  .object({
    id: Str.optional(),
    /** Splice in the ops of another kind of the same catalog (e.g. block_entity includes block_assets). */
    include: Str.optional(),
    if: Str.optional(),
    unless: Str.optional(),
    /** Symbol specs that must exist for this op (verified, reported as mismatches). */
    requires: z.array(Str).optional(),
    /** Create a file from `template` (refuses to overwrite unless force). */
    write: Str.optional(),
    template: Str.optional(),
    /** Insert snippets at `// ffn:<marker>` lines of a file, creating it from `container` if missing. */
    insert: Str.optional(),
    container: Str.optional(),
    at: z
      .array(
        z.object({
          if: Str.optional(),
          marker: Str,
          text: Str,
          /** Skip when this (rendered) text is already in the file. Defaults to the rendered text itself. */
          unlessPresent: Str.optional(),
          /** Error when this (rendered) text is already in the file (e.g. a field with the same name). */
          conflict: Str.optional(),
        }),
      )
      .optional(),
    /** Add a statement to the mod's init method (constructor / onInitialize). */
    hook: z.enum(["main"]).optional(),
    text: Str.optional(),
    /** Deep-merge a JSON object (rendered template) into a JSON file; arrays are unioned. */
    json: Str.optional(),
    merge: Str.optional(),
    /** Merge translation keys into the language file. */
    lang: z.record(Str, Str).optional(),
    /** Placeholder 16x16 texture. */
    texture: Str.optional(),
    color: Str.optional(),
    /** Add a snippet inside a Gradle block (e.g. runs { }) unless already present. */
    gradle: Str.optional(),
    block: Str.optional(),
    note: Str.optional(),
    warn: Str.optional(),
  })
  .strict();
export type ContentOp = z.infer<typeof OpSchema>;

const VariantSchema = z
  .object({
    requires: z.array(Str).optional(),
    if: Str.optional(),
  })
  .catchall(z.unknown());

export const KindSchema = z.object({
  description: Str.optional(),
  /** Ops are rendered with the kind's context; `variants` (if any) contribute fields to the context as `v`. */
  variants: z.array(VariantSchema).optional(),
  ops: z.array(OpSchema).default([]),
});
export type KindDef = z.infer<typeof KindSchema>;

const RuleSchema = z.object({
  since: Str.optional(),
  until: Str.optional(),
  when: z.object({ obfuscated: z.boolean().optional() }).optional(),
  description: Str.optional(),
  set: z.record(Str, z.unknown()),
});

const ModBusSchema = z.object({
  param: Str.optional(),
  expr: Str,
  requires: z.array(Str).optional(),
});

export const ContentFileSchema = z
  .object({
    loader: z.enum(["common", "fabric", "forge", "neoforge"]),
    rules: z.array(RuleSchema).default([]),
    symbols: z.record(Str, StrList).default({}),
    probes: z.record(Str, StrList).default({}),
    /** Use another loader's catalog when a condition holds (NeoForge 1.20.1 is a Forge fork). */
    delegate: z.array(z.object({ if: Str, to: z.enum(["fabric", "forge", "neoforge"]) })).default([]),
    main: z
      .object({
        /** "constructor" (of the @Mod class) or the name of the init method (onInitialize). */
        init: Str,
        modBus: z.array(ModBusSchema).default([]),
      })
      .optional(),
    /** Named reusable value tables (field types for payloads, config value types, events…). */
    tables: z.record(Str, z.record(Str, z.unknown())).default({}),
    kinds: z.record(Str, KindSchema).default({}),
  })
  .strict();
export type ContentFile = z.infer<typeof ContentFileSchema>;

export interface Catalog {
  rules: z.infer<typeof RuleSchema>[];
  symbols: Record<string, string[]>;
  probes: Record<string, string[]>;
  delegate: ContentFile["delegate"];
  main?: ContentFile["main"];
  tables: Record<string, Record<string, unknown>>;
  kinds: Record<string, KindDef>;
  files: string[];
}

async function loadDir(dir: string): Promise<ContentFile[] & { files?: string[] }> {
  if (!existsSync(dir)) return [];
  const out: ContentFile[] & { files?: string[] } = [];
  out.files = [];
  for (const f of (await readdir(dir)).filter((f) => /\.ya?ml$/.test(f)).sort()) {
    const file = path.join(dir, f);
    const parsed = ContentFileSchema.safeParse(YAML.parse(await readFile(file, "utf8")));
    if (!parsed.success) throw new Error(`Invalid content catalog ${file}: ${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`);
    out.push(parsed.data);
    out.files.push(file);
  }
  return out;
}

/** Built-in files first, then user files; for a loader: common + that loader. Later files win per key. */
export async function loadCatalog(config: FfnConfig, loader: string): Promise<Catalog> {
  const builtin = await loadDir(path.join(config.builtinProfilesDir, "content"));
  const user = await loadDir(path.join(config.userProfilesDir, "content"));
  const all = [...builtin, ...user];
  const files = [...(builtin.files ?? []), ...(user.files ?? [])];
  const cat: Catalog = { rules: [], symbols: {}, probes: {}, delegate: [], tables: {}, kinds: {}, files: [] };
  const common: Record<string, KindDef> = {};
  const own: Record<string, KindDef> = {};
  all.forEach((f, i) => {
    if (f.loader !== "common" && f.loader !== loader) return;
    cat.files.push(files[i]!);
    cat.rules.push(...f.rules);
    Object.assign(cat.symbols, f.symbols);
    Object.assign(cat.probes, f.probes);
    if (f.loader === loader) {
      if (f.delegate.length) cat.delegate = f.delegate;
      if (f.main) cat.main = f.main;
    }
    for (const [t, v] of Object.entries(f.tables)) cat.tables[t] = { ...(cat.tables[t] ?? {}), ...v };
    for (const [k, def] of Object.entries(f.kinds)) {
      if (f.loader === "common") {
        const prev = common[k];
        common[k] = { description: def.description ?? prev?.description, variants: def.variants ?? prev?.variants, ops: [...(prev?.ops ?? []), ...def.ops] };
      } else own[k] = def; // a later file for the same loader replaces the kind
    }
  });
  for (const k of new Set([...Object.keys(common), ...Object.keys(own)])) {
    const c = common[k];
    const o = own[k];
    cat.kinds[k] = { description: o?.description ?? c?.description, variants: o?.variants ?? c?.variants, ops: [...(c?.ops ?? []), ...(o?.ops ?? [])] };
  }
  return cat;
}

/** Resolve settings from rules for a Minecraft version. */
export function resolveSettings(rules: Catalog["rules"], mc: string, obfuscated: boolean | undefined): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const merge = (t: Record<string, unknown>, p: Record<string, unknown>) => {
    for (const [k, v] of Object.entries(p)) {
      if (v && typeof v === "object" && !Array.isArray(v) && t[k] && typeof t[k] === "object" && !Array.isArray(t[k])) {
        const inner = { ...(t[k] as Record<string, unknown>) };
        merge(inner, v as Record<string, unknown>);
        t[k] = inner;
      } else t[k] = structuredClone(v);
    }
  };
  for (const r of rules) {
    if (r.since && compareMcVersions(mc, r.since) < 0) continue;
    if (r.until && compareMcVersions(mc, r.until) > 0) continue;
    if (r.when?.obfuscated !== undefined && r.when.obfuscated !== obfuscated) continue;
    merge(out, r.set);
  }
  return out;
}
