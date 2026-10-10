import AdmZip from "adm-zip";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { diagnose, classMajorToJava } from "../src/diagnostics/parse.js";
import { ClassReader, javaToDesc, methodToJava, parseMethodDesc } from "../src/index/classfile.js";
import { MappingTable, parseProguard, parseTinyV2, parseTsrg2, writeTinyV2 } from "../src/index/mappings.js";
import { indexJar, McIndex, type IndexMeta } from "../src/index/store.js";
import { matchHints, loadHints } from "../src/mixin/hints.js";
import { parseJava } from "../src/mixin/javaparse.js";
import { MixinValidator, parseSelector, validateProject, type ValidateContext } from "../src/mixin/validate.js";
import { parseProperties, readProjectInfo } from "../src/project/info.js";
import { pickJdk, parseJavaMajor } from "../src/jdk/discover.js";
import { FIXTURES, fixtureServices, tmpDir } from "./helpers.js";

const CLASSES = path.join(FIXTURES, "classes");
const cls = (n: string) => readFileSync(path.join(CLASSES, `${n}.class`));

function fakeIndex(): McIndex {
  const dir = tmpDir("ffn-idx-");
  const zip = new AdmZip();
  for (const n of ["FakeServer", "FakeLoop", "FakeServer$Inner"]) zip.addFile(`net/minecraft/server/${n}.class`, cls(n));
  const jar = path.join(dir, "fake.jar");
  zip.writeZip(jar);
  const classes = indexJar(jar);
  const meta: IndexMeta = { formatVersion: 1, kind: "vanilla", mcVersion: "1.20.1", namespace: "mojmap", jar, obfuscated: false, builtAt: "", classCount: classes.length, notes: [] };
  return new McIndex(dir, meta, classes);
}

function fakeProject(mixins: Record<string, string>, extra: Record<string, unknown> = {}) {
  const dir = tmpDir("ffn-proj-");
  const pkgDir = path.join(dir, "src/main/java/com/example/m/mixin");
  mkdirSync(pkgDir, { recursive: true });
  mkdirSync(path.join(dir, "src/main/resources"), { recursive: true });
  for (const [n, src] of Object.entries(mixins)) writeFileSync(path.join(pkgDir, `${n}.java`), src);
  writeFileSync(
    path.join(dir, "src/main/resources/m.mixins.json"),
    JSON.stringify({ required: true, package: "com.example.m.mixin", compatibilityLevel: "JAVA_17", mixins: Object.keys(mixins), client: [], ...extra }, null, 2),
  );
  writeFileSync(path.join(dir, "src/main/resources/fabric.mod.json"), JSON.stringify({ id: "m", mixins: ["m.mixins.json"] }));
  mkdirSync(path.join(dir, ".ffn"));
  writeFileSync(path.join(dir, ".ffn/project.json"), JSON.stringify({ loader: "fabric", mcVersion: "1.20.1", mappings: "mojmap", modId: "m" }));
  return dir;
}

async function ctxFor(dir: string, opts: Partial<ValidateContext> = {}): Promise<ValidateContext> {
  return { index: fakeIndex(), project: await readProjectInfo(dir), vanillaForLoader: false, mixinExtrasAvailable: true, ...opts };
}

const HEADER = `package com.example.m.mixin;
import net.minecraft.server.FakeServer;
import java.util.function.BooleanSupplier;
import org.spongepowered.asm.mixin.Mixin;
import org.spongepowered.asm.mixin.Shadow;
import org.spongepowered.asm.mixin.injection.*;
import org.spongepowered.asm.mixin.injection.callback.CallbackInfo;
import org.spongepowered.asm.mixin.injection.callback.CallbackInfoReturnable;
`;

describe("diagnostics", () => {
  it("parses javac errors with file:line and symbol details", () => {
    const d = diagnose("> Task :compileJava FAILED\n/p/src/main/java/a/B.java:12: error: cannot find symbol\n        foo.bar();\n  symbol:   method bar()\n  location: variable foo of type Foo\n1 error\n");
    const f = d.findings.find((x) => x.kind === "compile_error")!;
    expect(f.file).toBe("/p/src/main/java/a/B.java");
    expect(f.line).toBe(12);
    expect(f.message).toContain("symbol:   method bar()".replace(/\s+/g, " ").trim().split(" ")[0]);
  });
  it("recognises JVM mismatches and class file versions", () => {
    expect(diagnose("Dependency requires at least JVM runtime version 25. This build uses a Java 21 JVM.").findings[0]!.kind).toBe("jvm_mismatch");
    const d = diagnose("java.lang.UnsupportedClassVersionError: a/B has been compiled by a more recent version of the Java Runtime (class file version 69.0), this version of the Java Runtime only recognizes class file versions up to 65.0");
    expect(d.findings[0]!.message).toContain("Java 25");
    expect(d.findings[0]!.message).toContain("Java 21");
    expect(classMajorToJava(61)).toBe(17);
  });
  it("finds mixin failures and the culprit mod", () => {
    const d = diagnose(
      "[main/ERROR] Mixin apply for mod coolmod failed coolmod.mixins.json:FooMixin -> net.minecraft.server.MinecraftServer: org.spongepowered.asm.mixin.injection.throwables.InvalidInjectionException Critical injection failure: @Inject annotation on onTick could not find any targets matching 'tickz' in net.minecraft.server.MinecraftServer. Using refmap coolmod.refmap.json [PREINJECT Applicator Phase]",
    );
    expect(d.findings.some((f) => f.kind === "mixin_error")).toBe(true);
    expect(d.culprit?.mod).toBe("coolmod");
  });
  it("reads crash reports (description, suspected mods, missing deps)", () => {
    const report = [
      "---- Minecraft Crash Report ----",
      "Description: Mod loading error has occurred",
      "",
      "java.lang.Exception: Mod Loading has failed",
      "Suspected Mods: Cool Mod (coolmod), Version: 1.0",
      "\tMod ID: 'jei', Requested by: 'coolmod', Expected range: '[15,)', Actual version: '[MISSING]'",
    ].join("\n");
    const d = diagnose(report);
    expect(d.source).toBe("crash-report");
    expect(d.description).toBe("Mod loading error has occurred");
    expect(d.culprit).toMatchObject({ mod: "coolmod", confidence: "high" });
    expect(d.findings.find((f) => f.kind === "missing_mod_dependency")!.message).toContain("jei");
  });
  it("parses Fabric missing-dependency lines and dependency resolution failures", () => {
    const d = diagnose(" - Mod 'Cool Mod' (coolmod) 1.0.0 requires any version of fabric-api, which is missing!\n> Could not resolve net.fabricmc:fabric-loader:0.99.0.\n   > Received status code 502 from server");
    expect(d.findings.map((f) => f.kind)).toEqual(expect.arrayContaining(["missing_mod_dependency", "dependency_resolution"]));
    expect(d.findings.find((f) => f.kind === "dependency_resolution")!.suggestion).toMatch(/temporary/);
  });
});

describe("class files", () => {
  it("reads header, members and bytecode references", () => {
    const r = new ClassReader(cls("FakeServer"));
    expect(r.info.name).toBe("net/minecraft/server/FakeServer");
    expect(r.info.superName).toBe("net/minecraft/server/FakeLoop");
    expect(r.info.interfaces).toEqual(["java/lang/Runnable"]);
    expect(r.info.fields.map((f) => f.name)).toEqual(expect.arrayContaining(["tickCount", "NAME", "names"]));
    const tick = r.info.methods.find((m) => m.name === "tickServer")!;
    expect(tick.desc).toBe("(Ljava/util/function/BooleanSupplier;)V");
    const refs = r.analyze(tick);
    expect(refs.invokes.map((i) => i.name)).toEqual(expect.arrayContaining(["tickChildren", "autoSave", "run"]));
    expect(refs.fields.some((f) => f.name === "tickCount" && f.opcode === "PUTFIELD")).toBe(true);
    expect(r.info.methods.some((m) => m.name.startsWith("lambda$tickServer$"))).toBe(true);
  });
  it("converts descriptors", () => {
    expect(javaToDesc("int[]")).toBe("[I");
    expect(javaToDesc("net.minecraft.Foo$Bar")).toBe("Lnet/minecraft/Foo$Bar;");
    expect(parseMethodDesc("(I[JLjava/lang/String;)Z")).toEqual({ params: ["I", "[J", "Ljava/lang/String;"], ret: "Z" });
    expect(methodToJava("tick", "(Ljava/util/function/BooleanSupplier;)V")).toBe("void tick(java.util.function.BooleanSupplier)");
  });
  it("indexes a jar and searches it", () => {
    const idx = fakeIndex();
    expect(idx.resolve("FakeServer")).toEqual(["net/minecraft/server/FakeServer"]);
    expect(idx.resolve("net.minecraft.server.FakeServer.Inner")).toEqual(["net/minecraft/server/FakeServer$Inner"]);
    expect(idx.search("tickChildren", "method")[0]).toMatchObject({ owner: "net/minecraft/server/FakeServer", desc: "(Ljava/util/function/BooleanSupplier;)V" });
    expect(idx.hierarchy("net/minecraft/server/FakeServer").map((c) => c.n)).toContain("net/minecraft/server/FakeLoop");
  });
});

describe("mappings", () => {
  const proguard = [
    "# comment",
    "net.minecraft.core.BlockPos -> gu:",
    "    int x -> a",
    "    1:2:net.minecraft.core.BlockPos offset(int,int,int) -> b",
    "net.minecraft.server.MinecraftServer -> net.minecraft.server.MinecraftServer:",
    "    void loadLevel() -> n_",
  ].join("\n");
  const tiny = ["tiny\t2\t0\tofficial\tintermediary\tnamed", "c\tgu\tnet/minecraft/class_2338\tnet/minecraft/util/math/BlockPos", "\tm\t(III)Lgu;\tb\tmethod_10069\tadd", "c\tnet/minecraft/server/MinecraftServer\tnet/minecraft/server/MinecraftServer\tnet/minecraft/server/MinecraftServer", "\tm\t()V\tn_\tmethod_3735\tloadWorld"].join("\n");
  const tsrg = ["tsrg2 obf srg id", "gu net/minecraft/src/C_4675_ 4675", "\ta f_123285_ 123285", "\tb (III)Lgu; m_7918_ 7918", "\t\tstatic", "net/minecraft/server/MinecraftServer net/minecraft/server/MinecraftServer 1", "\tn_ ()V m_130006_ 130006"].join("\n");

  it("parses ProGuard with obfuscated descriptors", () => {
    const s = parseProguard(proguard);
    expect(s.classes.get("gu")).toEqual(["gu", "net/minecraft/core/BlockPos"]);
    expect(s.methods.get("gu\tb\t(III)Lgu;")).toEqual(["b", "offset"]);
    expect(writeTinyV2(s, 1)).toContain("c\tgu\tnet/minecraft/core/BlockPos");
  });
  it("joins ProGuard, tiny v2 and tsrg2 on obfuscated names", () => {
    const table = new MappingTable([parseProguard(proguard), parseTinyV2(tiny, { official: "obf", named: "yarn" }), (() => { const t = parseTsrg2(tsrg); t.namespaces = t.namespaces.slice(0, 2); return t; })()]);
    expect(table.namespaces).toEqual(["obf", "mojmap", "intermediary", "yarn", "srg"]);
    const m = table.find("MinecraftServer#loadLevel", "mojmap")[0]!;
    expect(m.names).toMatchObject({ obf: "n_", intermediary: "method_3735", yarn: "loadWorld", srg: "m_130006_" });
    const c = table.find("class_2338", "intermediary", "class")[0]!;
    expect(c.names.mojmap).toBe("net/minecraft/core/BlockPos");
    expect(table.find("offset", "mojmap", "method")[0]!.desc!.mojmap).toBe("(III)Lnet/minecraft/core/BlockPos;");
    expect(table.find("x", "mojmap", "field")[0]!.names.srg).toBe("f_123285_");
  });
});

describe("mixin parsing & validation", () => {
  it("parses annotations, selectors and declarations", () => {
    const p = parseJava(`${HEADER}@Mixin(value = FakeServer.class, priority = 900)\npublic abstract class A {\n  @Inject(method = {"tickServer"}, at = @At(value = "INVOKE", target = "Lnet/minecraft/server/FakeServer;tickChildren" + "(Ljava/util/function/BooleanSupplier;)V", ordinal = 0))\n  private void h(BooleanSupplier s, CallbackInfo ci) { if (true) { } }\n}`);
    expect(p.classAnnotations[0]!.name).toBe("Mixin");
    const h = p.members[0]!;
    expect(h.params.map((x) => x.type)).toEqual(["BooleanSupplier", "CallbackInfo"]);
    expect(parseSelector("Lnet/minecraft/A;b(I)V")).toEqual({ owner: "net/minecraft/A", name: "b", desc: "(I)V" });
  });

  it("accepts a correct mixin and reports broken ones precisely", async () => {
    const good = `${HEADER}@Mixin(FakeServer.class)\npublic abstract class GoodMixin {\n  @Shadow private int tickCount;\n  @Inject(method = "tickServer", at = @At(value = "INVOKE", target = "Lnet/minecraft/server/FakeServer;tickChildren(Ljava/util/function/BooleanSupplier;)V"))\n  private void m$a(BooleanSupplier s, CallbackInfo ci) {}\n  @Inject(method = "initServer", at = @At("RETURN"))\n  private void m$b(CallbackInfoReturnable<Boolean> cir) {}\n}`;
    const bad = `${HEADER}@Mixin(FakeServer.class)\npublic abstract class BadMixin {\n  @Shadow private int tickCountz;\n  @Inject(method = "tickServerz", at = @At("HEAD"))\n  private void m$a(CallbackInfo ci) {}\n  @Inject(method = "initServer", at = @At("HEAD"))\n  private void m$b(CallbackInfo ci) {}\n  @Inject(method = "loadLevel", at = @At(value = "INVOKE", target = "Lnet/minecraft/server/FakeServer;autoSave()V"))\n  private void m$c(CallbackInfo ci) {}\n  @Inject(method = "tickServer", at = @At("HEAD"))\n  private static void m$d(int x, CallbackInfo ci) {}\n}`;
    const dir = fakeProject({ GoodMixin: good, BadMixin: bad }, { client: ["Ghost"] });
    writeFileSync(path.join(dir, "src/main/java/com/example/m/mixin/Unlisted.java"), `${HEADER}@Mixin(FakeServer.class) abstract class Unlisted {}`);
    const { issues, configs } = await validateProject(await ctxFor(dir));
    expect(configs[0]!.registered).toBe(true);
    const good1 = issues.filter((i) => i.mixin === "GoodMixin" && i.severity === "error");
    expect(good1).toEqual([]);
    const msgs = issues.filter((i) => i.severity === "error").map((i) => i.message).join("\n");
    expect(msgs).toMatch(/@Shadow field tickCountz not found/);
    expect(msgs).toMatch(/method "tickServerz" not found/);
    expect(msgs).toMatch(/CallbackInfoReturnable<Boolean>/);
    expect(msgs).toMatch(/never calls Lnet\/minecraft\/server\/FakeServer;autoSave\(\)V/);
    expect(msgs).toMatch(/must not be static/);
    expect(msgs).toMatch(/parameter 1 is I/);
    expect(msgs).toMatch(/Ghost is listed in "client" but no source file/);
    expect(issues.some((i) => i.severity === "warning" && /Unlisted|not listed/.test(i.message))).toBe(true);
    expect(issues.find((i) => /tickServerz/.test(i.message))!.suggestion).toMatch(/tickServer/);
  });

  it("points at lambdas when a call lives inside one", () => {
    const v = new MixinValidator({ index: fakeIndex(), project: { dir: "/x", loader: "fabric", mcVersion: "1.20.1", mappings: "mojmap", source: "ffn", mixinConfigs: [], javaSourceRoots: [], resourceRoots: [] }, vanillaForLoader: false, mixinExtrasAvailable: true });
    const src = `${HEADER}@Mixin(FakeServer.class)\nabstract class L {\n  @Inject(method = "loadLevel", at = @At(value = "INVOKE", target = "Lnet/minecraft/server/FakeServer;autoSave()V"))\n  private void h(CallbackInfo ci) {}\n}`;
    const r = v.validateSource(src, "L.java", "mixins");
    expect(r.issues.find((i) => i.severity === "error")!.message).toMatch(/never calls/);
    const src2 = src.replace('"loadLevel"', '"tickServer"');
    expect(v.validateSource(src2, "L.java", "mixins").issues.filter((i) => i.severity === "error")).toEqual([]);
  });

  it("flags compatibilityLevel above the bundled Mixin and accessor name clashes", async () => {
    const acc = `package com.example.m.mixin;\nimport net.minecraft.server.FakeServer;\nimport org.spongepowered.asm.mixin.Mixin;\nimport org.spongepowered.asm.mixin.gen.Accessor;\n@Mixin(FakeServer.class)\npublic interface Acc {\n  @Accessor("tickCount") int getTickCount();\n  @Accessor("nope") int getNope();\n}`;
    const dir = fakeProject({ Acc: acc }, { compatibilityLevel: "JAVA_25" });
    const ctx = await ctxFor(dir);
    ctx.profile = { loader: "forge", mcVersion: "1.20.1", java: 17, mixin: { maxCompatibilityLevel: "JAVA_18", refmap: false, registration: "fabric.mod.json", mixinExtras: { bundled: false } } } as unknown as ValidateContext["profile"];
    const { issues } = await validateProject(ctx);
    expect(issues.some((i) => /JAVA_25 is above JAVA_18/.test(i.message))).toBe(true);
    expect(issues.some((i) => /same name and descriptor/.test(i.message))).toBe(true);
    expect(issues.some((i) => /field "nope" not found/.test(i.message))).toBe(true);
  });
});

describe("mixin hints", () => {
  it("matches event hints", async () => {
    const hints = await loadHints(fixtureServices().config);
    const h = matchHints(hints, "net/minecraft/server/MinecraftServer", "tickServer", "fabric");
    expect(h[0]).toMatchObject({ id: "server-tick" });
    expect(String(h[0]!.fabric)).toMatch(/ServerTickEvents/);
  });
});

describe("projects and JDKs", () => {
  it("infers project info without .ffn/project.json", async () => {
    const dir = tmpDir();
    writeFileSync(path.join(dir, "gradle.properties"), "minecraft_version=1.21.1\nneo_version=21.1.1\nmod_id=foo\n");
    writeFileSync(path.join(dir, "build.gradle"), "plugins { id 'net.neoforged.moddev' version '2.0.1' }\n");
    const info = await readProjectInfo(dir);
    expect(info).toMatchObject({ loader: "neoforge", mcVersion: "1.21.1", mappings: "mojmap", modId: "foo", source: "inferred" });
    expect(parseProperties("a = b\n# c\nd:e")).toEqual({ a: "b", d: "e" });
  });
  it("picks the smallest suitable JDK and explains when none fits", () => {
    expect(parseJavaMajor("1.8.0_402")).toBe(8);
    expect(parseJavaMajor("21.0.2")).toBe(21);
    const jdks = [17, 21, 25].map((major) => ({ home: `/j${major}`, major, version: String(major), isJdk: true, source: "test" }));
    expect(pickJdk(jdks, 21, "x").jdk!.major).toBe(21);
    expect(pickJdk(jdks, 18, "x").jdk!.major).toBe(21);
    expect(pickJdk(jdks.slice(0, 1), 25, "need 25").missing).toMatch(/No JDK 25\+/);
  });
});
