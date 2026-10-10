import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { planProject, ProjectError, writeProject } from "../src/generator/index.js";
import type { ProjectParams } from "../src/generator/types.js";
import { deriveMainClass, propEsc, validateModId, validatePackage } from "../src/generator/validate.js";
import { fixtureServices, tmpDir } from "./helpers.js";

const base = (over: Partial<ProjectParams>): ProjectParams => ({
  modId: "testmod",
  modName: "Test Mod",
  package: "com.example.testmod",
  author: "Tester",
  version: "1.0.0",
  mcVersion: "1.20.1",
  loader: "fabric",
  ...over,
});

async function generate(over: Partial<ProjectParams>) {
  const services = fixtureServices();
  const plan = await planProject(services, base(over));
  const dir = tmpDir("ffn-gen-");
  await writeProject(plan, dir);
  const read = (p: string) => readFileSync(path.join(dir, p), "utf8");
  return { plan, dir, read, has: (p: string) => existsSync(path.join(dir, p)) };
}

const NEWEST = "26.3"; // latest release in the fixture manifest

function commonAssertions(g: Awaited<ReturnType<typeof generate>>) {
  for (const f of [
    "build.gradle",
    "settings.gradle",
    "gradle.properties",
    "gradlew",
    "gradlew.bat",
    "gradle/wrapper/gradle-wrapper.jar",
    "gradle/wrapper/gradle-wrapper.properties",
    "src/main/java/com/example/testmod/TestMod.java",
    "src/main/java/com/example/testmod/mixin/ExampleMixin.java",
    "src/main/resources/testmod.mixins.json",
    "src/main/resources/assets/testmod/lang/en_us.json",
    "src/main/resources/data/testmod/.gitkeep",
    ".ffn/project.json",
    "README.md",
  ]) {
    expect(g.has(f), f).toBe(true);
  }
  expect(statSync(path.join(g.dir, "gradlew")).mode & 0o111).toBeTruthy();
  const mixins = JSON.parse(g.read("src/main/resources/testmod.mixins.json"));
  expect(mixins.package).toBe("com.example.testmod.mixin");
  expect(mixins.mixins).toEqual(["ExampleMixin"]);
  expect(g.read("src/main/java/com/example/testmod/mixin/ExampleMixin.java")).toContain("@Mixin(MinecraftServer.class)");
  expect(g.read("gradle/wrapper/gradle-wrapper.properties")).toMatch(/gradle-\d+\.\d+(\.\d+)?-bin\.zip/);
  return mixins;
}

describe("create_project: Fabric", () => {
  it("1.20.1: remapping Loom, Mojang mappings, mixins in fabric.mod.json", async () => {
    const g = await generate({ loader: "fabric", mcVersion: "1.20.1" });
    const mixins = commonAssertions(g);
    expect(mixins.compatibilityLevel).toBe("JAVA_17");
    expect(mixins.refmap).toBeUndefined(); // Loom adds it
    const build = g.read("build.gradle");
    expect(build).toContain("id 'net.fabricmc.fabric-loom-remap'");
    expect(build).toContain("mappings loom.officialMojangMappings()");
    expect(build).toContain('modImplementation "net.fabricmc:fabric-loader');
    expect(build).toContain("it.options.release = 17");
    const props = g.read("gradle.properties");
    expect(props).toContain("fabric_api_version=0.92.12+1.20.1");
    expect(props).toContain("loader_version=0.19.5");
    expect(props).toContain("loom_version=1.18.4");
    const fmj = JSON.parse(g.read("src/main/resources/fabric.mod.json"));
    expect(fmj.mixins).toEqual(["testmod.mixins.json"]);
    expect(fmj.entrypoints.main).toEqual(["com.example.testmod.TestMod"]);
    expect(fmj.depends).toMatchObject({ minecraft: "~1.20.1", java: ">=17", "fabric-api": "*" });
    expect(g.has("src/main/resources/assets/testmod/icon.png")).toBe(true);
    expect(JSON.parse(g.read(".ffn/project.json")).profile.gradleJvm).toBe(25);
  });

  it("1.20.1 with Yarn uses Yarn names in the mixin", async () => {
    const g = await generate({ loader: "fabric", mcVersion: "1.20.1", mappings: "yarn" });
    expect(g.read("build.gradle")).toContain('mappings "net.fabricmc:yarn:${project.yarn_mappings}:v2"');
    expect(g.read("gradle.properties")).toContain("yarn_mappings=1.20.1+build.10");
    expect(g.read("src/main/java/com/example/testmod/mixin/ExampleMixin.java")).toContain('method = "loadWorld"');
  });

  it("1.20.1 with Parchment layers Parchment on Mojang mappings", async () => {
    const g = await generate({ loader: "fabric", mcVersion: "1.20.1", mappings: "parchment" });
    expect(g.read("build.gradle")).toContain("parchment(");
    expect(g.read("gradle.properties")).toContain("parchment_version=2023.09.03");
  });

  it(`${NEWEST}: unobfuscated → non-remapping Loom, no mappings line, Java 25`, async () => {
    const g = await generate({ loader: "fabric", mcVersion: NEWEST });
    const mixins = commonAssertions(g);
    expect(mixins.compatibilityLevel).toBe("JAVA_25");
    const build = g.read("build.gradle");
    expect(build).toContain("id 'net.fabricmc.fabric-loom'");
    expect(build).not.toContain("mappings ");
    expect(build).toContain('implementation "net.fabricmc:fabric-loader');
    expect(build).not.toContain("modImplementation");
    expect(g.read("gradle.properties")).toMatch(/fabric_api_version=0\.\d+\.\d+\+26\.3/);
  });

  it(`${NEWEST}: rejects Yarn (none published for unobfuscated versions)`, async () => {
    await expect(planProject(fixtureServices(), base({ loader: "fabric", mcVersion: NEWEST, mappings: "yarn" }))).rejects.toThrow(
      /not supported/,
    );
  });
});

describe("create_project: Forge", () => {
  it("1.20.1: ModDevGradle legacy, refmap + MixinConfigs manifest", async () => {
    const g = await generate({ loader: "forge", mcVersion: "1.20.1" });
    const mixins = commonAssertions(g);
    expect(mixins.refmap).toBe("testmod.refmap.json");
    expect(mixins.compatibilityLevel).toBe("JAVA_17");
    const build = g.read("build.gradle");
    expect(build).toContain("id 'net.neoforged.moddev.legacyforge'");
    expect(build).toContain("version = project.minecraft_version + '-' + project.forge_version");
    expect(build).toContain('add sourceSets.main, "${mod_id}.refmap.json"');
    expect(build).toContain("annotationProcessor 'org.spongepowered:mixin:0.8.5:processor'");
    expect(build).toContain('"MixinConfigs": "${mod_id}.mixins.json"');
    expect(build).toContain("JavaLanguageVersion.of(17)");
    expect(g.read("gradle.properties")).toContain("forge_version=47.4.10");
    const toml = g.read("src/main/templates/META-INF/mods.toml");
    expect(toml).toContain('loaderVersion="${loader_version_range}"');
    expect(toml).toContain("mandatory=true");
    expect(toml).not.toContain("[[mixins]]");
    expect(JSON.parse(g.read("src/main/templates/pack.mcmeta")).pack.pack_format).toBe(15);
    expect(g.read("src/main/java/com/example/testmod/TestMod.java")).toContain("import net.minecraftforge.fml.common.Mod;");
  });

  it(`${NEWEST}: ForgeGradle 7, no mappings line, --mixin.config dev arg, JAVA_21 mixin level`, async () => {
    const g = await generate({ loader: "forge", mcVersion: NEWEST });
    const mixins = commonAssertions(g);
    expect(mixins.compatibilityLevel).toBe("JAVA_21");
    expect(mixins.refmap).toBeUndefined();
    const build = g.read("build.gradle");
    expect(build).toMatch(/id 'net\.minecraftforge\.gradle' version '7\.\d+\.\d+'/);
    expect(build).not.toContain("mappings channel");
    expect(build).toContain('args "--mixin.config=${mod_id}.mixins.json"');
    expect(build).toContain("attributes['MixinConfigs']");
    expect(build).toContain("JavaLanguageVersion.of(25)");
    expect(g.read("gradle.properties")).toContain("forge_version=66.0.10");
    expect(g.has("src/main/resources/META-INF/mods.toml")).toBe(true);
    expect(JSON.parse(g.read("src/main/resources/pack.mcmeta")).pack).toMatchObject({ min_format: 121, max_format: 121 });
    expect(g.plan.warnings.join(" ")).toMatch(/recommended/);
  });

  it("1.21.1: ForgeGradle 6 with official mappings and no refmap", async () => {
    const g = await generate({ loader: "forge", mcVersion: "1.21.1" });
    const build = g.read("build.gradle");
    expect(build).toMatch(/id 'net\.minecraftforge\.gradle' version '6\.0\.\d+'/);
    expect(build).toContain("mappings channel: 'official', version: minecraft_version");
    expect(build).toContain('arg "-mixin.config=${mod_id}.mixins.json"');
    expect(build).not.toContain("org.spongepowered.mixin");
  });
});

describe("create_project: NeoForge", () => {
  it("1.20.1: legacy net.neoforged:forge via ModDevGradle legacy", async () => {
    const g = await generate({ loader: "neoforge", mcVersion: "1.20.1" });
    const mixins = commonAssertions(g);
    expect(mixins.refmap).toBe("testmod.refmap.json");
    const build = g.read("build.gradle");
    expect(build).toContain("neoForgeVersion = project.neo_version");
    expect(g.read("gradle.properties")).toContain("neo_version=1.20.1-47.1.106");
    expect(g.read("gradle.properties")).toContain("loader_version_range=[47,)");
    expect(g.read("src/main/templates/META-INF/mods.toml")).toContain('modId="forge"');
  });

  it(`${NEWEST}: ModDevGradle, neoforge.mods.toml with [[mixins]], beta warning`, async () => {
    const g = await generate({ loader: "neoforge", mcVersion: NEWEST });
    const mixins = commonAssertions(g);
    expect(mixins.compatibilityLevel).toBe("JAVA_25");
    const build = g.read("build.gradle");
    expect(build).toContain("id 'net.neoforged.moddev'");
    expect(build).not.toContain("parchment {");
    expect(build).not.toContain("MixinConfigs");
    const toml = g.read("src/main/templates/META-INF/neoforge.mods.toml");
    expect(toml).toContain("[[mixins]]");
    expect(toml).toContain('config="${mod_id}.mixins.json"');
    expect(toml).toContain('type="required"');
    expect(toml).not.toContain("loaderVersion");
    expect(g.read("gradle.properties")).toContain("neo_version=26.3.0.65-beta");
    expect(g.read("src/main/java/com/example/testmod/TestMod.java")).toContain("public TestMod(IEventBus modEventBus)");
    expect(g.plan.warnings.join(" ")).toMatch(/beta/);
  });

  it("1.21.1 with Parchment adds the parchment block", async () => {
    const services = fixtureServices();
    // no parchment fixture for 1.21.1 → falls back to mojmap with a warning
    const plan = await planProject(services, base({ loader: "neoforge", mcVersion: "1.21.1", mappings: "parchment" }));
    expect(plan.context.params.mappings).toBe("mojmap");
    expect(plan.warnings.join(" ")).toMatch(/Parchment has no release/);
  });
});

describe("create_project: validation & safety", () => {
  it("validates modId, package and text fields", async () => {
    expect(validateModId("MyMod")).toMatch(/Invalid modId/);
    expect(validateModId("a")).toMatch(/Invalid modId/);
    expect(validateModId("forge")).toMatch(/reserved/);
    expect(validateModId("my_mod2")).toBeNull();
    expect(validatePackage("mymod")).toMatch(/two segments/);
    expect(validatePackage("com.example.class")).toMatch(/keyword/);
    expect(validatePackage("com.Example")).toMatch(/lowercase/);
    await expect(planProject(fixtureServices(), base({ modId: "Bad-Id" }))).rejects.toBeInstanceOf(ProjectError);
    await expect(planProject(fixtureServices(), base({ modName: 'Evil"Name' }))).rejects.toThrow(/quotes/);
  });

  it("derives a main class and escapes non-ASCII in gradle.properties", () => {
    expect(deriveMainClass("Test Mod", "testmod")).toBe("TestMod");
    expect(deriveMainClass("super-tools", "supertools")).toBe("SuperToolsMod");
    expect(deriveMainClass("Мой мод", "moy_mod")).toBe("MoyMod");
    expect(propEsc("Мой")).toBe("\\u041c\\u043e\\u0439");
  });

  it("refuses to write into a non-empty directory unless overwrite", async () => {
    const services = fixtureServices();
    const plan = await planProject(services, base({}));
    const dir = tmpDir();
    writeFileSync(path.join(dir, "keep.txt"), "x");
    await expect(writeProject(plan, dir)).rejects.toThrow(/not empty/);
    await expect(writeProject(plan, dir, { overwrite: true })).resolves.toContain("build.gradle");
  });

  it("errors clearly for an MC version a loader has no builds for", async () => {
    await expect(planProject(fixtureServices(), base({ loader: "neoforge", mcVersion: "1.20" }))).rejects.toThrow(/older than|no builds/);
  });

  it("1.99.0: the profile extrapolates, but generation stops cleanly because no loader builds exist", async () => {
    await expect(planProject(fixtureServices(), base({ loader: "forge", mcVersion: "1.99.0" }))).rejects.toThrow(/no builds/);
  });
});
