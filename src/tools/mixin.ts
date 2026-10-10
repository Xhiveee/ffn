import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { ACC } from "../index/classfile.js";
import { loadHints, matchHints, MIXIN_POLICY } from "../mixin/hints.js";
import { validateProject, type MixinIssue, type ValidateContext } from "../mixin/validate.js";
import { readProjectInfo } from "../project/info.js";
import type { ResolvedProfile } from "../profiles/schema.js";
import { lookupProfile, type Services } from "../services.js";
import { fail, ok, okText, page } from "./result.js";
import { toSpec } from "./source.js";
import { mixinValidateInput, mixinTargetsInput } from "./schemas.js";


export async function mixinContext(services: Services, projectDir: string, source?: "auto" | "vanilla" | "project"): Promise<{ ctx: ValidateContext; notes: string[] }> {
  const project = await readProjectInfo(projectDir);
  const notes: string[] = [];
  let profile: ResolvedProfile | undefined;
  try {
    profile = (await lookupProfile(services, project.loader, project.mcVersion)).profile;
  } catch (e) {
    notes.push(`Profile unavailable (${(e as Error).message}); config checks limited.`);
  }
  const opened = await services.indexes.open({ projectDir, source: source ?? "auto" });
  notes.push(...opened.notes);
  const build = ["build.gradle", "build.gradle.kts"].map((f) => path.join(project.dir, f)).find(existsSync);
  const buildText = build ? await readFile(build, "utf8") : "";
  const mixinExtrasAvailable = !!profile?.mixin.mixinExtras.bundled || /mixinextras/i.test(buildText);
  const vanillaForLoader = opened.index.meta.kind === "vanilla" && project.loader !== "fabric";
  if (vanillaForLoader) notes.push("Checked against vanilla Minecraft: methods added by Forge/NeoForge patches are not visible.");
  return { ctx: { index: opened.index, project, profile, vanillaForLoader, mixinExtrasAvailable }, notes };
}

const summarize = (issues: MixinIssue[]) => ({
  errors: issues.filter((i) => i.severity === "error").length,
  warnings: issues.filter((i) => i.severity === "warning").length,
  infos: issues.filter((i) => i.severity === "info").length,
});



type V = z.infer<z.ZodObject<typeof mixinValidateInput>>;
type T = z.infer<z.ZodObject<typeof mixinTargetsInput>>;

export async function mixinValidate(services: Services, a: V) {
  const project = await readProjectInfo(a.projectDir);
  // Multi-project root (common + loader subprojects): validate each subproject against its own classpath.
  const units = project.subprojects && project.classpathProject !== ":" ? project.subprojects.map((x) => x.dir) : [project.dir];
  const runs: { label?: string; ctx: ValidateContext; configs: Awaited<ReturnType<typeof validateProject>>["configs"]; issues: MixinIssue[]; notes: string[] }[] = [];
  for (const dir of units) {
    if (units.length > 1 && !(await readProjectInfo(dir)).mixinConfigs.length) continue;
    const { ctx, notes } = await mixinContext(services, dir, a.source);
    const { configs, issues } = await validateProject(ctx, { mixinClass: a.mixinClass });
    await suggestFromOtherMappings(services, ctx, issues, notes);
    runs.push({ label: units.length > 1 ? ctx.project.gradlePath : undefined, ctx, configs, issues, notes });
  }
  if (!runs.length) return okText(`No *.mixins.json in any subproject of ${project.dir}.`);
  const issues = runs.flatMap((r) => (r.label ? r.issues.map((i) => ({ ...i, file: i.file ? `${r.label}: ${i.file}` : r.label })) : r.issues));
  const shown = a.includeInfo ? issues : issues.filter((i) => i.severity !== "info");
  const s = summarize(issues);
  const against = (r: (typeof runs)[number]) => {
    const m = r.ctx.index.meta;
    return `${r.label ? `${r.label}: ` : ""}Minecraft ${m.mcVersion}, ${m.namespace} names, ${m.kind === "vanilla" ? "vanilla jar" : `${m.loader ?? "project"} jar`}`;
  };
  const data = {
    checkedAgainst: runs.length > 1 ? runs.map(against) : against(runs[0]!),
    ...s,
    configs: runs.flatMap((r) =>
      r.configs.map((c) => ({
        file: r.label ? `${r.label}: ${c.file}` : c.file, registered: c.registered, compatibilityLevel: c.compatibilityLevel,
        mixins: c.mixins.map((x) => `${x.name} [${x.section}]${x.errors ? ` ${x.errors} error(s)` : ""}${x.warnings ? ` ${x.warnings} warning(s)` : ""}`),
      })),
    ),
    issues: shown.map((i) => ({ ...i, missing: undefined })),
    notes: [...new Set(runs.flatMap((r) => r.notes))],
  };
  const n = runs.reduce((k, r) => k + r.configs.reduce((x, c) => x + c.mixins.length, 0), 0);
  const where = runs.length > 1 ? ` in ${runs.length} subprojects` : "";
  const head = s.errors ? `Mixin validation FAILED: ${s.errors} error(s), ${s.warnings} warning(s)${where}.` : `Mixin validation passed (${n} mixin(s) checked${where}${s.warnings ? `, ${s.warnings} warning(s)` : ""}).`;
  return { ...ok(head, data), isError: s.errors > 0 };
}

/** For members not found, check whether the name exists in another mapping set (e.g. a Mojang name in a Yarn project). */
async function suggestFromOtherMappings(services: Services, ctx: ValidateContext, issues: MixinIssue[], notes: string[]) {
  const missing = issues.filter((i) => i.missing);
  if (!missing.length) return;
  const details = await services.versions.mojangVersion(ctx.project.mcVersion).catch(() => undefined);
  if (!details?.obfuscated) return;
  const ns = ctx.index.meta.namespace;
  try {
    const { table } = await services.indexes.table(ctx.project.mcVersion);
    for (const i of missing) {
      const hits: string[] = [];
      for (const from of table.namespaces) {
        if (from === ns || from === "obf") continue;
        for (const t of table.find(`${i.missing!.owner}#${i.missing!.name}`, from, i.missing!.kind, 5)) {
          const mine = t.names[ns];
          if (mine && mine !== i.missing!.name) hits.push(`"${i.missing!.name}" is the ${from} name; in ${ns} names it is "${mine}"`);
        }
        if (!hits.length) for (const t of table.find(i.missing!.name, from, i.missing!.kind, 5)) {
          const owner = t.owner?.[ns];
          if (t.names[ns] && owner === i.missing!.owner) hits.push(`"${i.missing!.name}" is the ${from} name; in ${ns} names it is "${t.names[ns]}"`);
        }
      }
      if (hits.length) i.suggestion = `${[...new Set(hits)].join("; ")}.`;
    }
  } catch (e) {
    notes.push(`Cross-mapping lookup unavailable: ${(e as Error).message}`);
  }
}

export async function mixinTargets(services: Services, a: T) {
  const { index, project } = await services.indexes.open(toSpec(a));
  const found = index.resolve(a.targetClass);
  if (found.length !== 1) return fail(found.length ? `Ambiguous: ${found.map((f) => f.replace(/\//g, ".")).join(", ")}` : `Class ${a.targetClass} not found in Minecraft ${index.meta.mcVersion} (${index.meta.namespace}).`);
  const name = found[0]!;
  const cls = index.get(name)!;
  const f = a.methodFilter;
  const methods = cls.m.filter(([n, d, acc]) => (a.includeSynthetic || !(acc & ACC.SYNTHETIC)) && n !== "<clinit>" && (!f || (f.includes("(") ? `${n}${d}` === f : n.toLowerCase().includes(f.toLowerCase()))));
  const withPoints = a.injectionPoints ?? methods.length <= 3;
  const pg = page(methods, a.offset ?? 0, a.limit ?? (withPoints ? 3 : 100));
  const reader = withPoints ? index.reader(name) : undefined;
  const max = a.maxPoints ?? 25;
  const list = (label: string, xs: string[]) => {
    if (!xs.length) return [];
    const counts = new Map<string, number>();
    for (const x of xs) counts.set(x, (counts.get(x) ?? 0) + 1);
    const uniq = [...counts].map(([x, n]) => (n > 1 ? `${x} ×${n}` : x));
    return [`  ${label} (${uniq.length}):`, ...uniq.slice(0, max).map((x) => `    ${x}`), ...(uniq.length > max ? [`    … ${uniq.length - max} more (maxPoints)`] : [])];
  };
  const out: string[] = [];
  for (const [n, d, acc] of pg.items) {
    const flags = [acc & ACC.STATIC ? "static" : "", acc & ACC.ABSTRACT ? "abstract — no body; target an implementation" : ""].filter(Boolean).join(", ");
    out.push(`${n}${d}${flags ? `  [${flags}]` : ""}`);
    if (!reader || acc & ACC.ABSTRACT) continue;
    const m = reader.info.methods.find((x) => x.name === n && x.desc === d);
    if (!m) continue;
    const r = reader.analyze(m);
    out.push(`  HEAD | ${r.returns ? `RETURN ×${r.returns}` : "no RETURN"} | TAIL${r.jumpOps.length ? ` | JUMP ×${r.jumpOps.length}` : ""}`);
    out.push(...list("INVOKE", r.invokes.map((i) => `L${i.owner};${i.name}${i.desc}`)));
    out.push(...list("FIELD", r.fields.map((x) => `L${x.owner};${x.name}:${x.desc} ${x.opcode}`)));
    out.push(...list("NEW", r.news.map((x) => `L${x};`)));
    out.push(...list("CONSTANT", r.typedConstants.map((c) => `${c.type}:${c.type === "string" ? JSON.stringify(c.value) : c.value}`)));
    const lambdas = cls.m.filter(([ln, , la]) => la & ACC.SYNTHETIC && ln.startsWith(`lambda$${n.replace(/[<>]/g, "")}$`)).map(([ln, ld]) => ln + ld);
    if (lambdas.length) out.push(`  lambdas: ${lambdas.join(", ")}`);
  }
  const hints = matchHints(await loadHints(services.config), name, f && !f.includes("(") ? methods[0]?.[0] : undefined, project?.loader ?? a.loader);
  const hintLines = hints.map((h) => {
    const loaders = Object.entries(h).filter(([k, v]) => ["fabric", "forge", "neoforge"].includes(k) && v);
    return `hint: ${h.use} → ${loaders.map(([k, v]) => `${k}: ${v}`).join("; ") || "a loader event"}`;
  });
  const simpleName = name.slice(name.lastIndexOf("/") + 1).replace(/\$/g, ".");
  const head = `${name.replace(/\//g, ".")} — ${pg.total} method(s)${f ? ` matching "${f}"` : ""}, showing ${pg.items.length} (Minecraft ${index.meta.mcVersion}, ${index.meta.namespace}). @Mixin(${simpleName}.class)${/^(net\/minecraft\/client\/|com\/mojang\/blaze3d\/)/.test(name) ? " — client-only: register in \"client\"" : ""}`;
  return okText(
    [
      head,
      ...(hintLines.length ? [...hintLines, `policy: ${MIXIN_POLICY}`] : []),
      ...out,
      ...(pg.more ? [`… ${pg.more}`] : []),
      ...(!withPoints ? ["Pass methodFilter (≤3 matches) or injectionPoints=true for INVOKE/FIELD/NEW/CONSTANT targets."] : []),
    ].join("\n"),
  );
}
