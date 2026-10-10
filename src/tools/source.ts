import { z } from "zod";
import { accessString, ACC, descToJava, methodToJava } from "../index/classfile.js";
import { INDEX_NAMESPACES, type IndexSpec } from "../index/service.js";
import type { McIndex } from "../index/store.js";
import type { Services } from "../services.js";
import { clip, fail, ok, okText, page } from "./result.js";
import { extractMethods, paramsMatch } from "../index/javasrc.js";
import { allInterfaces, allSubtypes, directSubtypes, findUsages, overrides, parseTarget, superChain, type Usage, type UsageTarget } from "../index/xref.js";
import { searchInput, getClassInput, translateInput } from "./schemas.js";


type SpecArgs = { mcVersion?: string; mappings?: (typeof INDEX_NAMESPACES)[number]; loader?: string; projectDir?: string; source?: "auto" | "vanilla" | "project" | "loader" };
export const toSpec = (a: SpecArgs): IndexSpec => ({ mcVersion: a.mcVersion, mappings: a.mappings, loader: a.loader, projectDir: a.projectDir, source: a.source });

const dotted = (n: string) => n.replace(/\//g, ".");






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

/** Classes decompiled per text-search call when there is no sources jar (one Vineflower run per batch). */
const DECOMPILE_BUDGET = 40;

async function textSearch(services: Services, index: McIndex, re: RegExp, offset: number, limit: number) {
  const hits = index.grepSources(re, offset + limit + 1);
  if (hits) return { hits, origin: "sources jar" };
  // No sources jar: grep decompiled sources, decompiling only classes whose constant pool can match (cached per class).
  const cands = index.textCandidates(re);
  if (!cands) return { hits: [], origin: "no sources jar, and the regex has no literal word (3+ letters) to preselect classes for decompilation — add one, e.g. a method or field name" };
  const out: { file: string; line: number; text: string }[] = [];
  let decompiled = 0;
  let scanned = 0;
  const grep = (outer: string, text: string) => {
    const lines = text.split("\n");
    for (let i = 0; i < lines.length && out.length < offset + limit + 1; i++) if (re.test(lines[i]!)) out.push({ file: `${outer}.java`, line: i + 1, text: lines[i]!.trim().slice(0, 240) });
  };
  // Grep strictly in candidate order (stable paging); uncached classes are decompiled in look-ahead batches.
  const fresh = new Map<string, string>();
  for (let k = 0; k < cands.length && out.length < offset + limit + 1; k++) {
    const o = cands[k]!;
    let text = fresh.get(o) ?? (await index.cachedSource(o));
    if (text === undefined) {
      if (decompiled >= DECOMPILE_BUDGET) break;
      const batch: string[] = [];
      for (let j = k; j < cands.length && batch.length < Math.min(20, DECOMPILE_BUDGET - decompiled); j++) if ((await index.cachedSource(cands[j]!)) === undefined) batch.push(cands[j]!);
      const m = await services.indexes.decompileMany(index, batch);
      decompiled += batch.length;
      for (const [n, t] of m) fresh.set(n, t);
      text = m.get(o) ?? "";
    }
    grep(o, text);
    scanned = k + 1;
  }
  const rest = cands.length - scanned;
  return {
    hits: out,
    origin: `decompiled (Vineflower, cached): ${scanned}/${cands.length} candidate classes scanned${decompiled ? `, ${decompiled} decompiled now` : ""}${rest > 0 && out.length <= offset + limit ? ` — ${rest} not scanned yet: call again to continue` : ""}`,
  };
}

function usageLine(u: Usage): string {
  return `${dotted(u.cls)}${u.method ? `#${u.method}` : ""}  ${u.how}${u.via ? ` via ${dotted(u.via)}` : ""}`;
}

export async function searchMcSource(services: Services, a: Search) {
  const { index, notes } = await services.indexes.open(toSpec(a));
  const limit = a.limit ?? 30;
  const offset = a.offset ?? 0;
  if (a.kind === "usages") {
    const t = parseTarget(a.query);
    const found = index.resolve(t.cls);
    if (found.length !== 1) return fail(found.length ? `"${t.cls}" is ambiguous: ${found.slice(0, 8).map(dotted).join(", ")}.` : `Class ${t.cls} not found (${indexLine(index)}).`);
    const owner = found[0]!;
    const c = index.get(owner)!;
    let member: UsageTarget["member"];
    if (t.member) {
      const isField = !t.desc?.startsWith("(") && c.f.some(([n]) => n === t.member) && !c.m.some(([n]) => n === t.member);
      member = { kind: isField ? "field" : "method", name: t.member, desc: t.desc };
      const known = [owner, ...superChain(index, owner), ...allInterfaces(index, owner)].some((o) => (isField ? index.get(o)?.f : index.get(o)?.m)?.some(([n, d]) => n === t.member && (!t.desc || d === t.desc)));
      if (!known) return fail(`${dotted(owner)} has no ${isField ? "field" : "method"} ${t.member}${t.desc ?? ""}.`);
    }
    const us = await findUsages(index, { owner, member });
    const pg = page(us, offset, limit);
    const what = `${dotted(owner)}${member ? `#${member.name}${member.desc ?? ""}` : ""}`;
    return okText(
      [`${us.length} usage(s) of ${what} (${indexLine(index)}; bytecode, Minecraft classes only)${pg.more ? ` — ${pg.more}` : ""}.`, ...pg.items.map(usageLine), ...notes.map((n) => `note: ${n}`)].join("\n"),
    );
  }
  if (a.kind === "text") {
    const re = new RegExp(a.query.replace(/^\/(.*)\/$/, "$1"), "i");
    const { hits, origin } = await textSearch(services, index, re, offset, limit);
    const pg = page(hits, offset, limit);
    const lines = pg.items.map((h) => `${h.file.replace(/\.java$/, "").replace(/\//g, ".")}:${h.line}  ${clip(h.text, 140)}`);
    return okText([`${pg.items.length} source line(s) matching ${re} (${indexLine(index)}; ${origin})${hits.length > offset + limit ? ` — more: offset=${offset + limit}` : ""}.`, ...lines, ...notes.map((n) => `note: ${n}`)].join("\n"));
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

function hierarchyView(index: McIndex, name: string, a: GetClass, header: string[]): string[] {
  const supers = superChain(index, name);
  const ifaces = allInterfaces(index, name);
  const direct = directSubtypes(index, name);
  const all = allSubtypes(index, name);
  const lines = [header[0]!, `extends: ${supers.length ? supers.map(dotted).join(" → ") : "-"}`, `interfaces (all): ${ifaces.length ? ifaces.map(dotted).join(", ") : "-"}`];
  if (a.method) {
    const paren = a.method.indexOf("(");
    const mname = paren > 0 ? a.method.slice(0, paren) : a.method;
    const descs = [...new Set([name, ...supers, ...ifaces].flatMap((o) => (index.get(o)?.m ?? []).filter(([n, d]) => n === mname && (paren < 0 || d === a.method!.slice(paren))).map(([, d]) => d)))];
    if (!descs.length) lines.push(`method ${a.method}: not declared in ${dotted(name)} or its supertypes`);
    for (const d of descs.slice(0, 5)) {
      const o = overrides(index, name, mname, d);
      const pg = page(o.overriddenBy, a.offset ?? 0, a.limit ?? 50);
      lines.push(`${mname}${d}: overrides ${o.overrides.length ? o.overrides.map(dotted).join(", ") : "-"}; overridden in ${o.overriddenBy.length} subtype(s)${pg.more ? ` (${pg.more})` : ""}`);
      lines.push(...pg.items.map((s) => `  ${dotted(s)}`));
    }
  } else {
    const pg = page(direct, a.offset ?? 0, a.limit ?? 100);
    lines.push(`direct subtypes: ${direct.length} (all transitive: ${all.length})${pg.more ? ` — ${pg.more}` : ""}`);
    lines.push(...pg.items.map((s) => {
      const k = directSubtypes(index, s).length;
      return `  ${dotted(s)}${k ? ` (+${k})` : ""}`;
    }));
  }
  lines.push(`(${indexLine(index)}; subtypes are Minecraft/loader classes in the index, not your mod)`);
  return lines;
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

  if (a.detail === "hierarchy") return okText(hierarchyView(index, name, a, header).join("\n"));
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
