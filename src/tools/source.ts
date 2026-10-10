import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { accessString, ACC, descToJava, methodToJava } from "../index/classfile.js";
import { INDEX_NAMESPACES, type IndexSpec } from "../index/service.js";
import type { McIndex } from "../index/store.js";
import { LoaderSchema } from "../profiles/schema.js";
import type { Services } from "../services.js";
import { fail, guard, ok } from "./result.js";

export const indexSpecShape = {
  mcVersion: z.string().optional().describe("Minecraft version (optional when projectDir is given)."),
  mappings: z.enum(INDEX_NAMESPACES).optional().describe("Names to use: mojmap (default) | parchment (= mojmap names) | yarn | intermediary | obf. Ignored for unobfuscated versions (26.1+), which only have Mojang names."),
  loader: LoaderSchema.optional(),
  projectDir: z.string().optional().describe("Use the Minecraft jar this project compiles against (includes Forge/NeoForge patches, project names)."),
  source: z.enum(["auto", "vanilla", "project"]).optional().describe("auto (default): project jar when projectDir is given, else vanilla Minecraft."),
};

type SpecArgs = { mcVersion?: string; mappings?: (typeof INDEX_NAMESPACES)[number]; loader?: string; projectDir?: string; source?: "auto" | "vanilla" | "project" };
export const toSpec = (a: SpecArgs): IndexSpec => ({ mcVersion: a.mcVersion, mappings: a.mappings, loader: a.loader, projectDir: a.projectDir, source: a.source });

const dotted = (n: string) => n.replace(/\//g, ".");

export function describeIndex(index: McIndex) {
  const m = index.meta;
  return { mcVersion: m.mcVersion, names: m.namespace, kind: m.kind, loader: m.loader, classes: m.classCount, jar: m.jar, sourcesJar: m.sourcesJar };
}

export function classMembers(index: McIndex, name: string, opts: { filter?: string; inherited?: boolean; includeSynthetic?: boolean } = {}) {
  const c = index.get(name)!;
  const f = opts.filter?.toLowerCase();
  const keep = (n: string, a: number) => (!f || n.toLowerCase().includes(f)) && (opts.includeSynthetic || !(a & ACC.SYNTHETIC));
  const owners = opts.inherited ? index.hierarchy(name) : [c];
  return {
    fields: owners.flatMap((o) =>
      o.f.filter(([n, , a]) => keep(n, a)).map(([n, d, a]) => ({
        name: n, descriptor: d, type: descToJava(d), access: accessString(a, false), ...(o.n !== name ? { declaredIn: dotted(o.n) } : {}),
      })),
    ),
    methods: owners.flatMap((o) =>
      o.m.filter(([n, , a]) => keep(n, a) && (o.n === name || n !== "<init>") && n !== "<clinit>").map(([n, d, a]) => ({
        name: n, descriptor: d, signature: methodToJava(n, d, o.n), access: accessString(a, true), mixinSelector: `${n}${d}`,
        ...(o.n !== name ? { declaredIn: dotted(o.n) } : {}),
      })),
    ),
  };
}

export const searchInput = {
  ...indexSpecShape,
  query: z.string().min(1).describe("Name or fragment (case-insensitive), /regex/, or for kind=text a regex over source lines."),
  kind: z.enum(["any", "class", "method", "field", "text"]).optional().describe("Default any (names). text greps sources (needs a -sources.jar or previously decompiled classes)."),
  limit: z.number().int().min(1).max(200).optional(),
};

export const getClassInput = {
  ...indexSpecShape,
  className: z.string().describe("Class name: net.minecraft.server.MinecraftServer, internal form, inner classes with . or $, or a simple name."),
  memberFilter: z.string().optional().describe("Only members whose name contains this text."),
  inherited: z.boolean().optional().describe("Include members of supertypes found in the index."),
  includeSource: z.boolean().optional().describe("Return (decompiled) source. Default false."),
  sourceOffset: z.number().int().min(0).optional().describe("First source line to return (0-based)."),
  sourceLines: z.number().int().min(1).max(4000).optional().describe("Max source lines (default 400)."),
};

export const translateInput = {
  mcVersion: z.string(),
  name: z.string().describe("Class (net.minecraft.server.MinecraftServer / class_1234 / C_1234_), member (Owner#name, name(desc)) or bare member name (m_1234_, method_5678, field_1234, loadLevel)."),
  from: z.enum(["mojmap", "parchment", "yarn", "intermediary", "srg", "obf"]),
  to: z.enum(["mojmap", "parchment", "yarn", "intermediary", "srg", "obf"]).optional().describe("Highlight this namespace (all available are returned)."),
  kind: z.enum(["class", "field", "method"]).optional(),
  limit: z.number().int().min(1).max(100).optional(),
};

type Search = z.infer<z.ZodObject<typeof searchInput>>;
type GetClass = z.infer<z.ZodObject<typeof getClassInput>>;
type Translate = z.infer<z.ZodObject<typeof translateInput>>;

export async function searchMcSource(services: Services, a: Search) {
  const { index, notes } = await services.indexes.open(toSpec(a));
  const limit = a.limit ?? 50;
  if (a.kind === "text") {
    const re = new RegExp(a.query.replace(/^\/(.*)\/$/, "$1"), "i");
    const hits = index.grepSources(re, limit);
    if (!hits) {
      return ok(
        "Full-text search needs Minecraft sources. None are available for this index: give projectDir after running the loader's source task (Loom genSources / ModDevGradle or ForgeGradle IDE sync), or search names (kind=any) and read classes with get_class includeSource=true (decompiled per class).",
        { index: describeIndex(index), hits: [], notes },
      );
    }
    return ok(`${hits.length} source line(s) matching ${re}.`, { index: describeIndex(index), hits: hits.map((h) => ({ ...h, class: dotted(h.file.replace(/\.java$/, "")) })), notes });
  }
  const hits = index.search(a.query, (a.kind as "any" | "class" | "method" | "field") ?? "any", limit);
  return ok(`${hits.length} match(es) for "${a.query}" in Minecraft ${index.meta.mcVersion} (${index.meta.namespace} names${index.meta.kind === "toolchain" ? ", project jar" : ""}).`, {
    index: describeIndex(index),
    hits: hits.map((h) =>
      h.kind === "class"
        ? { kind: "class", class: dotted(h.name), access: accessString(h.access, false) }
        : { kind: h.kind, class: dotted(h.owner), name: h.name, descriptor: h.desc, ...(h.kind === "method" ? { signature: methodToJava(h.name, h.desc!, h.owner) } : { type: descToJava(h.desc!) }), access: accessString(h.access, h.kind === "method") },
    ),
    notes,
  });
}

export async function getClass(services: Services, a: GetClass) {
  const { index, notes } = await services.indexes.open(toSpec(a));
  const found = index.resolve(a.className);
  if (found.length === 0) {
    const sugg = index.search(a.className.replace(/.*[./$]/, ""), "class", 10).map((h) => dotted(h.name));
    return fail(`Class ${a.className} not found in Minecraft ${index.meta.mcVersion} (${index.meta.namespace} names).${sugg.length ? ` Similar: ${sugg.join(", ")}` : ""}`);
  }
  if (found.length > 1) return fail(`"${a.className}" is ambiguous: ${found.map(dotted).join(", ")}. Use the full name.`);
  const name = found[0]!;
  const c = index.get(name)!;
  const members = classMembers(index, name, { filter: a.memberFilter, inherited: a.inherited });
  const kind = c.a & ACC.ANNOTATION ? "@interface" : c.a & ACC.INTERFACE ? "interface" : c.a & ACC.ENUM ? "enum" : c.s === "java/lang/Record" ? "record" : "class";
  let source: Record<string, unknown> | undefined;
  if (a.includeSource) {
    try {
      const src = await services.indexes.source(index, name);
      if (src) {
        const lines = src.text.split("\n");
        const off = a.sourceOffset ?? 0;
        const n = a.sourceLines ?? 400;
        source = { origin: src.origin, totalLines: lines.length, offset: off, text: lines.slice(off, off + n).join("\n"), truncated: off + n < lines.length };
      }
    } catch (e) {
      source = { error: (e as Error).message };
    }
  }
  const innerClasses = [...index.classes.keys()].filter((k) => k.startsWith(`${name}$`) && !/\$\d/.test(k.slice(name.length))).map(dotted);
  return ok(`${kind} ${dotted(name)} (Minecraft ${index.meta.mcVersion}, ${index.meta.namespace}): ${members.fields.length} field(s), ${members.methods.length} method(s).`, {
    index: describeIndex(index),
    class: dotted(name),
    internalName: name,
    kind,
    access: accessString(c.a, false),
    superClass: c.s ? dotted(c.s) : undefined,
    interfaces: c.i.map(dotted),
    supertypesInIndex: index.hierarchy(name).slice(1).map((h) => dotted(h.n)),
    innerClasses,
    ...members,
    source,
    notes,
  });
}

export async function translateMapping(services: Services, a: Translate) {
  const details = await services.versions.mojangVersion(a.mcVersion);
  if (!details) return fail(`Minecraft ${a.mcVersion} is not in Mojang's version manifest.`);
  if (!details.obfuscated) {
    return ok(`Minecraft ${a.mcVersion} is unobfuscated: there is only one set of names (Mojang's), used by Fabric, Forge and NeoForge alike — "${a.name}" translates to itself. Yarn, Intermediary and SRG do not exist for it.`, {
      mcVersion: a.mcVersion, identity: true, name: a.name,
    });
  }
  const from = a.from === "parchment" ? "mojmap" : a.from;
  const to = a.to === "parchment" ? "mojmap" : a.to;
  const { table, notes } = await services.indexes.table(a.mcVersion);
  if (!table.namespaces.includes(from)) return fail(`${a.from} names are not available for ${a.mcVersion}. Available: ${table.namespaces.join(", ")}. ${notes.join(" ")}`);
  const res = table.find(a.name, from, a.kind, a.limit ?? 25);
  const fmt = res.map((r) => ({
    kind: r.kind,
    ...(to ? { [to]: r.kind === "class" ? r.names[to]?.replace(/\//g, ".") : r.owner ? `${(r.owner[to] ?? r.owner.obf)!.replace(/\//g, ".")}#${r.names[to] ?? "?"}` : r.names[to] } : {}),
    names: Object.fromEntries(Object.entries(r.names).map(([ns, n]) => [ns, r.kind === "class" ? n.replace(/\//g, ".") : n])),
    ...(r.owner ? { owner: Object.fromEntries(Object.entries(r.owner).map(([ns, n]) => [ns, n.replace(/\//g, ".")])) } : {}),
    ...(r.desc ? { descriptor: r.desc } : {}),
  }));
  const extra = a.from === "parchment" || a.to === "parchment" ? ["Parchment uses Mojang names for classes, fields and methods (it adds parameter names/javadoc)."] : [];
  return ok(`${res.length} match(es) for ${a.name} (${a.from}) in ${a.mcVersion}. Namespaces: ${table.namespaces.join(", ")}.`, { mcVersion: a.mcVersion, matches: fmt, notes: [...notes, ...extra] });
}

export function registerSourceTools(server: McpServer, services: Services): void {
  server.registerTool(
    "search_mc_source",
    {
      title: "Search Minecraft classes/members",
      description:
        "Search the real Minecraft classes, methods (with JVM descriptors) and fields of an exact version in the chosen names, or grep the sources. The index is built on first use from official jars + official mappings (or the project's own Minecraft jar) and cached.",
      inputSchema: searchInput,
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    (a) => guard(() => searchMcSource(services, a)),
  );
  server.registerTool(
    "get_class",
    {
      title: "Get Minecraft class",
      description: "Members of a Minecraft class (fields/methods with JVM descriptors and ready-to-use mixin selectors), supertypes, inner classes and optionally the (decompiled) source, for an exact version and mappings.",
      inputSchema: getClassInput,
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    (a) => guard(() => getClass(services, a)),
  );
  server.registerTool(
    "translate_mapping",
    {
      title: "Translate mapping names",
      description: "Translate class/method/field names between obfuscated, Mojang (mojmap/Parchment), Fabric Intermediary, Yarn and Forge SRG names for a Minecraft version (all namespaces published for it). On unobfuscated versions (26.1+) names are identical everywhere.",
      inputSchema: translateInput,
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    (a) => guard(() => translateMapping(services, a)),
  );
}
