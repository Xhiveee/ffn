import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { ACC, methodToJava } from "../index/classfile.js";
import { INJECTION_KINDS, planMixin, writePlan } from "../mixin/generate.js";
import { loadHints, matchHints, MIXIN_POLICY } from "../mixin/hints.js";
import { validateProject, type MixinIssue, type ValidateContext } from "../mixin/validate.js";
import { readProjectInfo } from "../project/info.js";
import type { ResolvedProfile } from "../profiles/schema.js";
import { lookupProfile, type Services } from "../services.js";
import { fail, guard, ok } from "./result.js";
import { describeIndex, indexSpecShape, toSpec } from "./source.js";

const sourceOpt = z.enum(["auto", "vanilla", "project"]).optional().describe("Class data: auto (default) = the Minecraft jar the project compiles against (exact names incl. loader patches; first call resolves it via Gradle), falling back to vanilla Minecraft; vanilla = official jars + mappings only.");

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

export const mixinValidateInput = {
  projectDir: z.string(),
  mixinClass: z.string().optional().describe("Only validate this mixin (simple or fully-qualified name)."),
  source: sourceOpt,
  includeInfo: z.boolean().optional().describe("Include info-level notes (default false)."),
};

export const mixinTargetsInput = {
  ...indexSpecShape,
  targetClass: z.string(),
  methodFilter: z.string().optional().describe("Only methods whose name contains this (or exact selector name(desc))."),
  injectionPoints: z.boolean().optional().describe("List INVOKE/FIELD/NEW/CONSTANT targets inside the methods (default: when ≤ 8 methods match)."),
  includeSynthetic: z.boolean().optional().describe("Include synthetic methods such as lambda bodies (lambda$name$0)."),
};

export const mixinGenerateInput = {
  projectDir: z.string(),
  targetClass: z.string().describe("Minecraft class to mix into (any accepted name form)."),
  method: z.string().describe("Target method name or selector name(desc); for accessor: the field name; for invoker: the method."),
  injection: z.enum(INJECTION_KINDS).describe(
    "inject | redirect | modify_arg | modify_variable (method arguments) | modify_constant (needs constant) | modify_return_value* | modify_expression_value* | wrap_operation* | wrap_with_condition* | wrap_method* | accessor | invoker | overwrite (last resort: replaces the whole method, conflicts with other mods)  (*MixinExtras)",
  ),
  at: z.string().optional().describe('HEAD (default for inject) | RETURN | TAIL | INVOKE:<call> | FIELD:<field> | NEW:<class> (inject, redirect, modify_expression_value, wrap_operation). <call> may be a bare name ("INVOKE:tickChildren") or full "Lowner;name(desc)ret"; FFN resolves it from the method bytecode.'),
  constant: z.string().optional().describe('modify_constant: the constant, e.g. "5", "0.5F", "2.0", "10L", "\"text\"", or typed "int:5", "float:0.5", "string:text", "class:net.minecraft.world.item.Item". FFN checks it exists in the target bytecode.'),
  side: z.enum(["common", "client", "server"]).optional().describe('mixins.json list; default: "client" for client-only classes, else "common" (mixins).'),
  name: z.string().optional().describe("Mixin class name (default <Target>Mixin / <Target>Accessor). An existing mixin with that name gets the new handler appended."),
  handlerName: z.string().optional(),
  cancellable: z.boolean().optional().describe("inject: allow ci.cancel()/cir.setReturnValue()."),
  argIndex: z.number().int().min(0).optional().describe("modify_arg: call argument index; modify_variable: target method parameter index."),
  ordinal: z.number().int().min(0).optional().describe("Which occurrence of the injection point (default all)."),
  setter: z.boolean().optional().describe("accessor: also generate a setter (adds @Mutable for final fields)."),
  configFile: z.string().optional().describe("Which *.mixins.json to register in (default <modid>.mixins.json)."),
  dryRun: z.boolean().optional().describe("Return the code without writing."),
  force: z.boolean().optional().describe("Write even if validation reports errors."),
  source: sourceOpt,
};

type V = z.infer<z.ZodObject<typeof mixinValidateInput>>;
type T = z.infer<z.ZodObject<typeof mixinTargetsInput>>;
type G = z.infer<z.ZodObject<typeof mixinGenerateInput>>;

export async function mixinValidate(services: Services, a: V) {
  const { ctx, notes } = await mixinContext(services, a.projectDir, a.source);
  const { configs, issues } = await validateProject(ctx, { mixinClass: a.mixinClass });
  await suggestFromOtherMappings(services, ctx, issues, notes);
  const shown = a.includeInfo ? issues : issues.filter((i) => i.severity !== "info");
  const s = summarize(issues);
  const data = {
    project: { dir: ctx.project.dir, loader: ctx.project.loader, mcVersion: ctx.project.mcVersion, mappings: ctx.project.mappings },
    index: describeIndex(ctx.index),
    ...s,
    configs,
    issues: shown,
    notes,
  };
  const head = s.errors ? `Mixin validation FAILED: ${s.errors} error(s), ${s.warnings} warning(s).` : `Mixin validation passed (${configs.reduce((n, c) => n + c.mixins.length, 0)} mixin(s) checked${s.warnings ? `, ${s.warnings} warning(s)` : ""}).`;
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
  const { index, notes, project } = await services.indexes.open(toSpec(a));
  const found = index.resolve(a.targetClass);
  if (found.length !== 1) return fail(found.length ? `Ambiguous: ${found.map((f) => f.replace(/\//g, ".")).join(", ")}` : `Class ${a.targetClass} not found in Minecraft ${index.meta.mcVersion} (${index.meta.namespace}).`);
  const name = found[0]!;
  const cls = index.get(name)!;
  const f = a.methodFilter;
  const methods = cls.m.filter(([n, d, acc]) => (a.includeSynthetic || !(acc & ACC.SYNTHETIC)) && (!f || (f.includes("(") ? `${n}${d}` === f : n.toLowerCase().includes(f.toLowerCase()))));
  const withPoints = a.injectionPoints ?? methods.length <= 8;
  const reader = withPoints ? index.reader(name) : undefined;
  const out = methods.map(([n, d, acc]) => {
    const entry: Record<string, unknown> = {
      name: n, descriptor: d, signature: methodToJava(n, d, name), static: !!(acc & ACC.STATIC), selector: `${n}${d}`,
      ...(acc & ACC.ABSTRACT ? { note: "abstract — no body to inject into; target an implementation" } : {}),
    };
    if (reader && !(acc & ACC.ABSTRACT)) {
      const m = reader.info.methods.find((x) => x.name === n && x.desc === d);
      if (m) {
        const r = reader.analyze(m);
        entry.injectionPoints = {
          simple: ["HEAD", r.returns ? `RETURN (${r.returns} return instruction${r.returns > 1 ? "s" : ""})` : undefined, "TAIL"].filter(Boolean),
          INVOKE: r.invokes.map((i) => `L${i.owner};${i.name}${i.desc}`),
          FIELD: r.fields.map((x) => `L${x.owner};${x.name}:${x.desc} (${x.opcode})`),
          NEW: r.news.map((x) => `L${x};`),
          CONSTANT: [...new Set(r.typedConstants.map((c) => `${c.type}:${c.type === "string" ? JSON.stringify(c.value) : c.value}`))].slice(0, 40),
          JUMP: r.jumpOps.length ? `${r.jumpOps.length} jump instruction(s)` : undefined,
        };
        const lambdas = cls.m.filter(([ln, , la]) => la & ACC.SYNTHETIC && ln.startsWith(`lambda$${n.replace(/[<>]/g, "")}$`)).map(([ln, ld]) => ln + ld);
        if (lambdas.length) entry.lambdas = lambdas;
      }
    }
    return entry;
  });
  const hints = matchHints(await loadHints(services.config), name, f && !f.includes("(") ? methods[0]?.[0] : undefined, project?.loader ?? a.loader);
  return ok(`${name.replace(/\//g, ".")}: ${out.length} method(s)${f ? ` matching "${f}"` : ""} in Minecraft ${index.meta.mcVersion} (${index.meta.namespace}).${hints.length ? " A loader event may cover this — see hints." : ""}`, {
    index: describeIndex(index),
    class: name.replace(/\//g, "."),
    mixinTarget: `@Mixin(${name.slice(name.lastIndexOf("/") + 1).replace(/\$/g, ".")}.class)`,
    clientOnly: /^(net\/minecraft\/client\/|com\/mojang\/blaze3d\/)/.test(name),
    methods: out,
    hints,
    policy: MIXIN_POLICY,
    notes,
  });
}

export async function mixinGenerate(services: Services, a: G) {
  const { ctx, notes } = await mixinContext(services, a.projectDir, a.source);
  const plan = await planMixin(ctx, {
    targetClass: a.targetClass, member: a.method, injection: a.injection, at: a.at, side: a.side, mixinName: a.name, handlerName: a.handlerName,
    cancellable: a.cancellable, argIndex: a.argIndex, ordinal: a.ordinal, setter: a.setter, configFile: a.configFile, constant: a.constant,
  });
  const errors = plan.issues.filter((i) => i.severity === "error");
  const write = !a.dryRun && (errors.length === 0 || a.force);
  if (write) await writePlan(plan);
  const target = ctx.index.resolve(a.targetClass)[0]!;
  const hints = matchHints(await loadHints(services.config), target, a.method.replace(/\(.*/, ""), ctx.project.loader);
  const data = {
    written: write,
    file: plan.file,
    mixin: plan.fqcn,
    appendedToExisting: plan.appended,
    registeredIn: { config: plan.config, list: plan.section, changed: plan.configChanged },
    handler: plan.handler,
    annotation: plan.annotation,
    code: plan.content,
    validation: { ...summarize(plan.issues), issues: plan.issues.filter((i) => i.severity !== "info") },
    hints,
    policy: hints.length ? MIXIN_POLICY : undefined,
    notes,
  };
  const head = write
    ? `${plan.appended ? "Added handler to" : "Created"} ${plan.fqcn} (${plan.annotation})${plan.configChanged ? ` and registered it in ${path.basename(plan.config)} "${plan.section}"` : ""}.`
    : a.dryRun
      ? `Dry run: ${plan.fqcn} (${plan.annotation}); nothing written.`
      : `Not written: validation found ${errors.length} error(s) (pass force=true to write anyway).`;
  return { ...ok(`${head}${hints.length ? ` Consider instead: ${hints.map((h) => `${h.use} → ${(h as Record<string, unknown>)[ctx.project.loader] ?? "loader event"}`).join("; ")}.` : ""}`, data), isError: !write && !a.dryRun };
}

export function registerMixinTools(server: McpServer, services: Services): void {
  server.registerTool(
    "mixin_targets",
    {
      title: "Mixin targets",
      description:
        "Real methods of a Minecraft class (descriptors, ready-to-paste selectors) and the injection points inside them (INVOKE/FIELD/NEW targets read from bytecode) for an exact version and mappings, plus hints when a loader event covers the same need.",
      inputSchema: mixinTargetsInput,
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    (a) => guard(() => mixinTargets(services, a)),
  );
  server.registerTool(
    "mixin_validate",
    {
      title: "Validate mixins",
      description:
        "Statically validate a project's mixins before running the game: mixins.json (package, listed classes exist, unlisted @Mixin classes, registration, compatibilityLevel vs. the bundled Mixin, refmap), target classes, method selectors/descriptors, @At INVOKE/FIELD/NEW targets (checked in the target's bytecode), handler signatures, @Accessor/@Invoker/@Shadow members, client-only targets in common lists, MixinExtras availability.",
      inputSchema: mixinValidateInput,
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    (a) => guard(() => mixinValidate(services, a)),
  );
  server.registerTool(
    "mixin_generate",
    {
      title: "Generate mixin",
      description:
        "Generate a mixin handler from the target's real descriptor (@Inject, @Redirect, @ModifyArg, @ModifyVariable, @Accessor, @Invoker, and MixinExtras @ModifyReturnValue/@ModifyExpressionValue/@WrapOperation/@WrapWithCondition/@WrapMethod where available), validate it, then write it (new class or appended to an existing mixin) and register it in the mixins.json. Suggests loader events when they cover the use case.",
      inputSchema: mixinGenerateInput,
      annotations: { readOnlyHint: false, openWorldHint: true },
    },
    (a) => guard(() => mixinGenerate(services, a)),
  );
}
