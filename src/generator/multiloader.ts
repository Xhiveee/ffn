/**
 * create_project layout=multiloader: one independent Gradle build per loader (fabric/, forge/, neoforge/) that
 * all compile the shared common/ tree. Driven by profiles/layouts/multiloader.yaml.
 */
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import YAML from "yaml";
import { z } from "zod";
import type { Services } from "../services.js";
import { compareMcVersions } from "../util/mcversion.js";
import { planProject, ProjectError } from "./index.js";
import type { FileContent, ProjectParams, ProjectPlan } from "./types.js";

const LayoutSchema = z.object({
  commonDir: z.string().default("common"),
  defaults: z.array(z.object({ since: z.string().optional(), until: z.string().optional(), loaders: z.array(z.enum(["fabric", "forge", "neoforge"])), note: z.string().optional() })),
  buildScriptAppend: z.string(),
  sharedPrefixes: z.array(z.string()),
});
export type MultiloaderLayout = z.infer<typeof LayoutSchema>;

export async function loadMultiloaderLayout(services: Services): Promise<{ layout: MultiloaderLayout; source: string }> {
  const user = path.join(services.config.userProfilesDir, "layouts", "multiloader.yaml");
  const file = existsSync(user) ? user : path.join(services.config.builtinProfilesDir, "layouts", "multiloader.yaml");
  const parsed = LayoutSchema.safeParse(YAML.parse(await readFile(file, "utf8")));
  if (!parsed.success) throw new ProjectError(`Invalid layout file ${file}: ${parsed.error.message}`);
  return { layout: parsed.data, source: file };
}

export function defaultLoaders(layout: MultiloaderLayout, mc: string): { loaders: string[]; note?: string } | undefined {
  for (const d of layout.defaults) {
    if (d.since && compareMcVersions(mc, d.since) < 0) continue;
    if (d.until && compareMcVersions(mc, d.until) > 0) continue;
    return { loaders: d.loaders, note: d.note };
  }
  return undefined;
}

function same(a: FileContent, b: FileContent): boolean {
  if (typeof a === "string" || typeof b === "string") return a === b;
  return a.copyFrom === b.copyFrom;
}

export interface MultiloaderPlan {
  files: Map<string, FileContent>;
  plans: Record<string, ProjectPlan>;
  loaders: string[];
  warnings: string[];
  notes: string[];
}

export async function planMultiloader(services: Services, input: Omit<ProjectParams, "loader">, loadersIn?: string[]): Promise<MultiloaderPlan> {
  const { layout, source } = await loadMultiloaderLayout(services);
  const notes: string[] = [`layout from ${source}`];
  let loaders = loadersIn?.length ? [...new Set(loadersIn)] : undefined;
  if (!loaders) {
    const d = defaultLoaders(layout, input.mcVersion);
    if (!d) throw new ProjectError(`No default multiloader loader set for Minecraft ${input.mcVersion}; pass loaders explicitly.`);
    loaders = d.loaders;
    if (d.note) notes.push(d.note);
  }
  if (loaders.length < 2) throw new ProjectError("A multiloader project needs at least two loaders.");
  const plans: Record<string, ProjectPlan> = {};
  const warnings: string[] = [];
  for (const l of loaders) {
    const p = await planProject(services, { ...input, loader: l as ProjectParams["loader"] });
    plans[l] = p;
    for (const w of p.warnings) warnings.push(`${l}: ${w}`);
  }
  const first = plans[loaders[0]!]!;
  const { params } = first.context;
  const common = layout.commonDir;
  const files = new Map<string, FileContent>();

  // Shared assets/data that every loader generates identically → common/
  const sharedRel = [...first.files.keys()].filter(
    (r) => layout.sharedPrefixes.some((p) => r.startsWith(p)) && loaders!.every((l) => plans[l]!.files.has(r) && same(plans[l]!.files.get(r)!, first.files.get(r)!)),
  );
  for (const r of sharedRel) files.set(`${common}/${r}`, first.files.get(r)!);

  const pkgPath = params.package.replace(/\./g, "/");
  const commonClass = `${params.mainClass}Common`;
  files.set(
    `${common}/src/main/java/${pkgPath}/${commonClass}.java`,
    `package ${params.package};

/**
 * Loader-independent code, compiled into every loader build (FFN multiloader layout).
 * Only use vanilla Minecraft classes here; put loader-specific code in the loader subprojects.
 */
public final class ${commonClass} {
    public static final String MOD_ID = "${params.modId}";

    private ${commonClass}() {}

    /** Called from every loader's mod initializer. */
    public static void init() {
    }
}
`,
  );

  for (const l of loaders) {
    const p = plans[l]!;
    for (const [rel, content] of p.files) {
      if (sharedRel.includes(rel) || rel === ".gitignore") continue;
      let c = content;
      if (rel === "README.md") continue;
      if (rel === "build.gradle" && typeof c === "string") c = c + layout.buildScriptAppend.replace(/\{\{common\}\}/g, `../${common}`);
      else if (rel === "build.gradle.kts") throw new ProjectError(`${l}: Kotlin DSL build scripts are not supported by the multiloader layout yet.`);
      if (rel === `src/main/java/${pkgPath}/${params.mainClass}.java` && typeof c === "string") {
        const hooked = c.replace(/^(\s*)(LOGGER\.info\("Hello from \{\}!", MOD_ID\);)/m, `$1$2\n$1${commonClass}.init();`);
        if (hooked === c) warnings.push(`${l}: could not find the hook point in ${params.mainClass}.java; call ${commonClass}.init() from your initializer.`);
        c = hooked;
      }
      if (rel === ".ffn/project.json" && typeof c === "string") {
        const j = JSON.parse(c) as Record<string, unknown>;
        c = `${JSON.stringify({ ...j, multiloaderRoot: "..", commonDir: `../${common}` }, null, 2)}\n`;
      }
      files.set(`${l}/${rel}`, c);
    }
  }
  if (!plans[loaders[0]!]!.files.has("build.gradle")) throw new ProjectError("Expected build.gradle in the loader plans.");
  const gi = first.files.get(".gitignore");
  if (gi) files.set(".gitignore", gi);
  files.set(
    "README.md",
    `# ${params.modName}

Multiloader mod for Minecraft ${params.mcVersion} (${loaders.join(", ")}), generated by FFN.

- \`${common}/\` — loader-independent code and assets (\`${params.package}.${commonClass}\`). It has no Gradle build of its own:
  every loader build adds it as an extra source directory, so it is compiled against each loader's classpath.
- ${loaders.map((l) => `\`${l}/\` — ${l} build (run \`./gradlew build\` inside it; Java ${plans[l]!.context.profile.java})`).join("\n- ")}

Each loader is an independent Gradle build because the loaders' Gradle plugins need different Gradle versions.
`,
  );
  files.set(
    ".ffn/project.json",
    `${JSON.stringify(
      {
        generator: "ffn",
        layout: "multiloader",
        generatedAt: new Date().toISOString(),
        mcVersion: params.mcVersion,
        modId: params.modId,
        modName: params.modName,
        author: params.author,
        version: params.version,
        package: params.package,
        mainClass: params.mainClass,
        loaders,
        common,
        subprojects: Object.fromEntries(loaders.map((l) => [l, l])),
      },
      null,
      2,
    )}\n`,
  );
  notes.push(`${sharedRel.length} identical asset/data file(s) placed in ${common}/.`);
  return { files, plans, loaders, warnings, notes };
}
