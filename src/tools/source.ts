import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { accessString, ACC, descToJava, methodToJava } from "../index/classfile.js";
import { INDEX_NAMESPACES, type IndexSpec } from "../index/service.js";
import type { McIndex } from "../index/store.js";
import { LoaderSchema } from "../profiles/schema.js";
import type { Services } from "../services.js";
import { clip, fail, guard, ok, okText, page } from "./result.js";
import { extractMethods, paramsMatch } from "../index/javasrc.js";

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
  kind: z.enum(["any", "class", "method", "field", "text"]).optional().describe("Default any (names). text greps sources (needs a -sources.jar)."),
  limit: z.number().int().min(1).max(200).optional().describe("Results per page (default 30)."),
  offset: z.number().int().min(0).optional().describe("Skip this many results (paging)."),
};

export const getClassInput = {
  ...indexSpecShape,
  className: z.string().describe("Class name: net.minecraft.server.MinecraftServer, internal form, inner classes with . or $, or a simple name."),
  method: z.string().optional().describe('Return only this method\'s source: name ("tick", "<init>" for constructors) or name+descriptor ("hurt(Lnet/minecraft/world/damagesource/DamageSource;F)Z"). All overloads (max 5) without a descriptor.'),
  detail: z.enum(["outline", "full"]).optional().describe("outline (default): header + field/method signatures, no bodies. full: paged (decompiled) source — use only when the outline + method source are not enough."),
  members: z.array(z.enum(["fields", "methods", "inner"])).optional().describe("Outline sections to include (default all)."),
  memberFilter: z.string().optional().describe("Outline: only members whose name contains this text."),
  inherited: z.boolean().optional().describe("Outline: include members of supertypes found in the index."),
  descriptors: z.boolean().optional().describe("Outline: show methods as name(JVM descriptor) = mixin selector (default true); false = Java signatures with simple type names (shorter)."),
  offset: z.number().int().min(0).optional().describe("Paging: outline = first member, full = first source line (0-based)."),
  limit: z.number().int().min(1).max(2000).optional().describe("Paging: outline members (default 200), full source lines (default 300)."),
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

const ACCESS_SHORT = (a: number, isMethod: boolean) =>
  accessString(a, isMethod)
    .replace(/\b(synchronized|native|strictfp|volatile|transient)\b\s*/g, "")
    .trim();

function indexLine(index: McIndex): string {
  const m = index.meta;
  return `Minecraft ${m.mcVersion}, ${m.namespace} names, ${m.kind === "vanilla" ? "vanilla jar" : `${m.loader ?? "project"} jar`}`;
}

export async function searchMcSource(services: Services, a: Search) {
  const { index, notes } = await services.indexes.open(toSpec(a));
  const limit = a.limit ?? 30;
  const offset = a.offset ?? 0;
  if (a.kind === "text") {
    const re = new RegExp(a.query.replace(/^\/(.*)\/$/, "$1"), "i");
    const hits = index.grepSources(re, offset + limit + 1);
    if (!hits) {
      return okText(
        "Full-text search needs Minecraft sources, and none are available for this index: give projectDir after running the loader's source task (Loom genSources / ModDevGradle or ForgeGradle IDE sync), or search names (kind=any) and read one method with get_class method=...",
      );
    }
    const pg = page(hits, offset, limit);
    const lines = pg.items.map((h) => `${h.file.replace(/\.java$/, "").replace(/\//g, ".")}:${h.line}  ${clip(h.text, 140)}`);
    return okText([`${pg.items.length} source line(s) matching ${re} (${indexLine(index)})${hits.length > offset + limit ? ` — more: offset=${offset + limit}` : ""}.`, ...lines, ...notes.map((n) => `note: ${n}`)].join("\n"));
  }
  const hits = index.search(a.query, (a.kind as "any" | "class" | "method" | "field") ?? "any", offset + limit + 1);
  const pg = page(hits, offset, limit);
  const lines = pg.items.map((h) =>
    h.kind === "class"
      ? `class  ${dotted(h.name)}`
      : h.kind === "method"
        ? `method ${dotted(h.owner)}#${h.name}${h.desc}${h.access & ACC.STATIC ? "  static" : ""}`
        : `field  ${dotted(h.owner)}#${h.name}: ${descToJava(h.desc!).replace(/^.*\./, "")}${h.access & ACC.STATIC ? "  static" : ""}`,
  );
  const more = hits.length > offset + limit ? ` — more: offset=${offset + limit}` : "";
  return okText([`${pg.items.length} match(es) for "${a.query}" (${indexLine(index)})${more}. Methods are shown as name(descriptor); read one with get_class method=...`, ...lines].join("\n"));
}

function outline(index: McIndex, name: string, a: GetClass): { lines: string[]; total: number; shown: number; more?: string } {
  const c = index.get(name)!;
  const want = new Set(a.members ?? ["fields", "methods", "inner"]);
  const f = a.memberFilter?.toLowerCase();
  const owners = a.inherited ? index.hierarchy(name) : [c];
  const keep = (n: string, acc: number) => (!f || n.toLowerCase().includes(f)) && !(acc & ACC.SYNTHETIC);
  const desc = a.descriptors !== false;
  const items: string[] = [];
  const simple = (t: string) => t.replace(/[\w.]*\./g, "");
  if (want.has("fields")) {
    for (const o of owners) {
      const fs = o.f.filter(([n, , acc]) => keep(n, acc));
      if (!fs.length) continue;
      items.push(`FIELDS${o.n !== name ? ` (from ${dotted(o.n)})` : ""}`);
      for (const [n, d, acc] of fs) items.push(`  ${ACCESS_SHORT(acc, false)} ${simple(descToJava(d))} ${n}`.replace(/ {2,}/g, " ").replace(/^ /, "  "));
    }
  }
  if (want.has("methods")) {
    for (const o of owners) {
      const ms = o.m.filter(([n, , acc]) => keep(n, acc) && n !== "<clinit>" && (o.n === name || n !== "<init>"));
      if (!ms.length) continue;
      items.push(`METHODS${o.n !== name ? ` (from ${dotted(o.n)})` : ""}`);
      for (const [n, d, acc] of ms) {
        const sig = desc ? `${n}${d}` : simple(methodToJava(n, d, o.n));
        items.push(`  ${ACCESS_SHORT(acc, true)} ${sig}`.replace(/ {2,}/g, " ").replace(/^ /, "  "));
      }
    }
  }
  if (want.has("inner")) {
    const inner = [...index.classes.keys()].filter((k) => k.startsWith(`${name}$`) && !k.slice(name.length + 1).includes("$") && !/\$\d/.test(k.slice(name.length)));
    if (inner.length) items.push(`INNER ${inner.map((k) => k.slice(name.length + 1)).join(", ")}`);
  }
  const off = a.offset ?? 0;
  const lim = a.limit ?? 200;
  const pg = page(items, off, lim);
  return { lines: pg.items, total: items.length, shown: pg.items.length, more: pg.more };
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
  const kind = c.a & ACC.ANNOTATION ? "@interface" : c.a & ACC.INTERFACE ? "interface" : c.a & ACC.ENUM ? "enum" : c.s === "java/lang/Record" ? "record" : "class";
  const anns = index.reader(name)?.info.annotations?.map((d) => `@${descToJava(d).replace(/^.*\./, "")}`) ?? [];
  const header = [
    `${anns.length ? `${anns.join(" ")} ` : ""}${accessString(c.a & ~ACC.SYNCHRONIZED, false).replace(/\b(abstract )?interface\b/, "").trim()} ${kind} ${dotted(name)}${c.s && c.s !== "java/lang/Object" && kind !== "enum" && kind !== "record" ? ` extends ${dotted(c.s)}` : ""}${c.i.length ? ` ${kind === "interface" ? "extends" : "implements"} ${c.i.map(dotted).join(", ")}` : ""}`.replace(/ {2,}/g, " ").trim(),
    `(${indexLine(index)}; ${c.f.length} fields, ${c.m.length} methods)`,
  ];

  if (a.method || a.detail === "full") {
    let src;
    try {
      src = await services.indexes.source(index, name);
    } catch (e) {
      return fail(`Source unavailable for ${dotted(name)}: ${(e as Error).message}`);
    }
    if (!src) return fail(`No source for ${dotted(name)} (no sources jar and decompilation failed). Use the outline (detail=outline) or mixin_targets for bytecode-level details.`);
    if (a.method) {
      const paren = a.method.indexOf("(");
      const mname = paren > 0 ? a.method.slice(0, paren) : a.method;
      const mdesc = paren > 0 ? a.method.slice(paren) : undefined;
      const inBytecode = c.m.filter(([n, d]) => n === mname && (!mdesc || d === mdesc));
      if (!inBytecode.length) {
        const same = c.m.filter(([n]) => n === mname).map(([n, d]) => n + d);
        const inh = index.hierarchy(name).slice(1).find((h) => h.m.some(([n, d]) => n === mname && (!mdesc || d === mdesc)));
        const sugg = same.length ? same : c.m.filter(([n]) => n.toLowerCase().includes(mname.toLowerCase())).map(([n, d]) => n + d).slice(0, 8);
        return fail(
          `${dotted(name)} has no method ${a.method}.${inh ? ` It is declared in ${dotted(inh.n)} (get_class className=${dotted(inh.n)}).` : ""}${sugg.length ? ` ${same.length ? "Overloads" : "Similar"}: ${sugg.join(", ")}` : ""}`,
        );
      }
      const path = name.slice(name.lastIndexOf("/") + 1).split("$");
      const declName = mname === "<init>" ? path.at(-1)! : mname;
      let found2 = extractMethods(src.text, path, declName);
      if (mdesc) found2 = found2.filter((m) => paramsMatch(m.params, mdesc));
      if (!found2.length) return fail(`Could not locate ${declName} in the ${src.origin} source of ${dotted(name)} (it may be synthetic or generated). Use detail=full with offset/limit to read around it.`);
      const MAX = 5;
      const cap = a.limit ?? 250;
      const parts = found2.slice(0, MAX).map((m) => {
        const ls = m.text.split("\n");
        return `// lines ${m.startLine}-${m.endLine}\n${ls.slice(0, cap).join("\n")}${ls.length > cap ? `\n// … ${ls.length - cap} more line(s): detail=full offset=${m.startLine - 1 + cap}` : ""}`;
      });
      const bc = inBytecode.map(([n, d]) => n + d);
      return okText(
        [`${dotted(name)}#${mname}: ${found2.length} declaration(s)${found2.length > MAX ? `, showing ${MAX}` : ""} (${src.origin}). Selectors: ${bc.slice(0, 6).join(", ")}${bc.length > 6 ? " …" : ""}`, ...parts].join("\n"),
      );
    }
    const lines = src.text.split("\n");
    const off = a.offset ?? 0;
    const lim = a.limit ?? 300;
    const end = Math.min(lines.length, off + lim);
    return okText(
      [`${header[0]}`, `// ${src.origin}: lines ${off + 1}-${end} of ${lines.length}${end < lines.length ? ` — more: offset=${end}` : ""}`, ...lines.slice(off, end)].join("\n"),
    );
  }

  const o = outline(index, name, a);
  return okText(
    [
      ...header,
      ...o.lines,
      ...(o.more ? [`… ${o.more}`] : []),
      `Next: get_class method="<name>" for one method's source; mixin_targets for injection points.`,
      ...notes.map((n) => `note: ${n}`),
    ].join("\n"),
  );
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
        "Search the real Minecraft classes, methods (name + JVM descriptor) and fields of an exact version in the chosen names, or grep the sources (kind=text). Compact one-line results, 30 per page (offset/limit). The index is built on first use from official jars + mappings (or the project's own Minecraft jar) and cached.",
      inputSchema: searchInput,
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    (a) => guard(() => searchMcSource(services, a)),
  );
  server.registerTool(
    "get_class",
    {
      title: "Get Minecraft class",
      description:
        "A Minecraft class for an exact version and mappings. Default: compact outline (header, fields, methods as name(descriptor) = mixin selector, inner classes; no bodies; paged). method=<name>[descriptor] returns just that method's source (all overloads, capped). detail=full returns the whole (decompiled) source paged by lines — expensive, use only when needed. Token-saving workflow: outline first, then method.",
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
