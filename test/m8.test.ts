import AdmZip from "adm-zip";
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { indexJar, McIndex, regexLiterals, type IndexMeta } from "../src/index/store.js";
import { allInterfaces, allSubtypes, directSubtypes, findUsages, overrides, parseTarget, superChain } from "../src/index/xref.js";
import { FIXTURES, tmpDir } from "./helpers.js";

const cls = (n: string) => readFileSync(path.join(FIXTURES, "classes", `${n}.class`));
function fakeIndex(): McIndex {
  const dir = tmpDir("ffn-idx8-");
  const zip = new AdmZip();
  for (const n of ["FakeServer", "FakeLoop", "FakeServer$Inner"]) zip.addFile(`net/minecraft/server/${n}.class`, cls(n));
  const jar = path.join(dir, "fake.jar");
  zip.writeZip(jar);
  const classes = indexJar(jar);
  const meta: IndexMeta = { formatVersion: 1, kind: "vanilla", mcVersion: "1.20.1", namespace: "mojmap", jar, obfuscated: false, builtAt: "", classCount: classes.length, notes: [] };
  return new McIndex(dir, meta, classes);
}
const S = "net/minecraft/server/FakeServer";
const L = "net/minecraft/server/FakeLoop";

describe("navigation (xrefs)", () => {
  it("parses targets", () => {
    expect(parseTarget("a.b.C#m(I)V")).toMatchObject({ cls: "a.b.C", member: "m", desc: "(I)V" });
    expect(parseTarget("a.b.C#f:I")).toMatchObject({ cls: "a.b.C", member: "f", desc: "I" });
    expect(parseTarget("a.b.C")).toMatchObject({ cls: "a.b.C" });
  });
  it("walks the hierarchy", () => {
    const idx = fakeIndex();
    expect(superChain(idx, S)).toEqual([L, "java/lang/Object"]);
    expect(allInterfaces(idx, S)).toContain("java/lang/Runnable");
    expect(directSubtypes(idx, L)).toEqual([S]);
    expect(allSubtypes(idx, L)).toEqual([S]);
    expect(overrides(idx, S, "runAllTasks", "()V")).toMatchObject({ overriddenBy: [] });
  });
  it("finds method and field usages", async () => {
    const idx = fakeIndex();
    const calls = await findUsages(idx, { owner: S, member: { kind: "method", name: "autoSave", desc: "()V" } });
    expect(calls.map((u) => u.method)).toEqual(expect.arrayContaining([expect.stringMatching(/^tickServer/), expect.stringMatching(/^lambda\$/)]));
    const reads = await findUsages(idx, { owner: S, member: { kind: "field", name: "tickCount" } });
    expect(reads.map((u) => u.how)).toEqual(expect.arrayContaining(["GETFIELD", "PUTFIELD"]));
    expect(reads.some((u) => u.method?.startsWith("getTickCount"))).toBe(true);
    const none = await findUsages(idx, { owner: L, member: { kind: "method", name: "runAllTasks", desc: "()V" } });
    expect(none).toEqual([]);
  });
  it("finds class usages", async () => {
    const idx = fakeIndex();
    const us = await findUsages(idx, { owner: L });
    expect(us.some((u) => u.cls === S)).toBe(true);
  });
});

describe("text-search prefilter", () => {
  it("extracts required literals", () => {
    expect(regexLiterals("isInvulnerableTo\\(")).toEqual({ mode: "all", tokens: ["isinvulnerableto"] });
    expect(regexLiterals("foo|barBaz")).toEqual({ mode: "any", tokens: ["foo", "barbaz"] });
    expect(regexLiterals("\\d+\\s*")).toBeUndefined();
    expect(regexLiterals("tick(Count)?\\s+=")).toEqual({ mode: "all", tokens: ["tick"] });
    expect(regexLiterals("[abc]{3}x|y")).toBeUndefined();
  });
  it("preselects classes by constant pool text", () => {
    const idx = fakeIndex();
    expect(idx.textCandidates(/loaded /)).toEqual([S]);
    expect(idx.textCandidates(/runAllTasks/)).toEqual([L]);
  });
});

describe("loader workspaces", () => {
  it("lists official MDK archives", async () => {
    const { mdkUrls } = await import("../src/index/loaderws.js");
    expect(mdkUrls("forge", "1.21.1", "52.1.0")[0]).toBe("https://maven.minecraftforge.net/net/minecraftforge/forge/1.21.1-52.1.0/forge-1.21.1-52.1.0-mdk.zip");
    expect(mdkUrls("neoforge", "1.20.2")).toEqual([
      "https://github.com/NeoForgeMDKs/MDK-1.20.2-ModDevGradle/archive/refs/heads/main.zip",
      "https://github.com/NeoForgeMDKs/MDK-1.20.2-NeoGradle/archive/refs/heads/main.zip",
    ]);
  });
  it("extracts a GitHub archive without its top folder", async () => {
    const { extractMdk } = await import("../src/index/loaderws.js");
    const { existsSync } = await import("node:fs");
    const dir = tmpDir("ffn-mdk-");
    const zip = new AdmZip();
    zip.addFile("MDK-x-main/build.gradle", Buffer.from("plugins {}"));
    zip.addFile("MDK-x-main/gradlew", Buffer.from("#!/bin/sh"));
    zip.addFile("MDK-x-main/src/main/java/A.java", Buffer.from("class A {}"));
    const z = path.join(dir, "a.zip");
    zip.writeZip(z);
    extractMdk(z, path.join(dir, "out"));
    expect(existsSync(path.join(dir, "out/build.gradle"))).toBe(true);
    expect(existsSync(path.join(dir, "out/src/main/java/A.java"))).toBe(true);
  });
});

describe("pack format from version.json", () => {
  it("normalises pack_version shapes", async () => {
    const { parsePackVersion } = await import("../src/sources/packformat.js");
    expect(parsePackVersion('{"pack_version":7}')).toEqual({ resource: "7", data: "7" });
    expect(parsePackVersion('{"pack_version":{"resource":34,"data":48}}')).toEqual({ resource: "34", data: "48" });
    expect(parsePackVersion('{"pack_version":{"resource_major":97,"resource_minor":1,"data_major":121,"data_minor":0}}')).toEqual({ resource: "97.1", data: "121" });
    expect(parsePackVersion("{}")).toBeUndefined();
  });
  it("reads one zip entry over HTTP range requests", async () => {
    const http = await import("node:http");
    const { remoteZipEntry } = await import("../src/sources/packformat.js");
    const zip = new AdmZip();
    zip.addFile("a/b.class", Buffer.alloc(5000, 1));
    zip.addFile("version.json", Buffer.from(JSON.stringify({ pack_version: { resource: 15, data: 15 }, pad: "x".repeat(3000) })));
    const buf = zip.toBuffer();
    const srv = http.createServer((req, res) => {
      const m = /bytes=(\d*)-(\d*)/.exec(req.headers.range ?? "")!;
      const [s, e] = m[1] === "" ? [Math.max(0, buf.length - Number(m[2])), buf.length - 1] : [Number(m[1]), Math.min(buf.length - 1, m[2] ? Number(m[2]) : buf.length - 1)];
      res.writeHead(206, { "Content-Length": e - s + 1 });
      res.end(buf.subarray(s, e + 1));
    });
    await new Promise<void>((r) => srv.listen(0, "127.0.0.1", () => r()));
    const port = (srv.address() as { port: number }).port;
    try {
      const got = await remoteZipEntry(`http://127.0.0.1:${port}/client.jar`, "t", "version.json");
      expect(JSON.parse(got!.toString()).pack_version).toEqual({ resource: 15, data: 15 });
      expect(await remoteZipEntry(`http://127.0.0.1:${port}/client.jar`, "t", "nope.json")).toBeUndefined();
    } finally {
      srv.close();
    }
  });
});

describe("Java parser (mixin classes)", () => {
  it("parses with a real parser: constants, nested annotations, comments, generics", async () => {
    const { parseJava } = await import("../src/mixin/javaparse.js");
    const src = `package com.example.m.mixin;
import net.minecraft.server.FakeServer;
import org.spongepowered.asm.mixin.*;
import org.spongepowered.asm.mixin.injection.*;
/* a comment with { braces } and @Fake(annotation) */
@Mixin(value = {FakeServer.class}, priority = 900)
public abstract class A<T> {
    private static final String OWNER = "Lnet/minecraft/server/FakeServer;";
    static final String TARGET = OWNER + "tickChildren(Ljava/util/function/BooleanSupplier;)V";
    @Shadow private int tickCount; // trailing { comment
    @Inject(method = "tickServer", at = @At(value = "INVOKE", target = A.TARGET, shift = At.Shift.AFTER, ordinal = -1))
    private <R extends Comparable<R>> void h(java.util.function.BooleanSupplier s, @Local(ordinal = 0) int x, String... rest) {
        Runnable r = () -> { if (true) {} };
    }
    @ModifyConstant(method = "x", constant = @Constant(stringValue = """
        hi"""))
    private String k(String s) { return s; }
    public A() {}
}`;
    const p = parseJava(src);
    expect(p.problems).toEqual([]);
    expect(p.className).toBe("A");
    expect(p.wildcardImports).toContain("org.spongepowered.asm.mixin");
    expect(p.classAnnotations[0]!.args.priority).toEqual({ t: "num", v: "900" });
    const h = p.members.find((m) => m.name === "h")!;
    const at = h.annotations[0]!.args.at!;
    expect(at.t === "ann" && at.v.args.target).toEqual({ t: "str", v: "Lnet/minecraft/server/FakeServer;tickChildren(Ljava/util/function/BooleanSupplier;)V" });
    expect(at.t === "ann" && at.v.args.shift).toEqual({ t: "ident", v: "At.Shift.AFTER" });
    expect(at.t === "ann" && at.v.args.ordinal).toEqual({ t: "num", v: "-1" });
    expect(h.params.map((x) => `${x.type} ${x.name}`)).toEqual(["java.util.function.BooleanSupplier s", "int x", "String[] rest"]);
    expect(h.params[1]!.annotations[0]!.name).toBe("Local");
    expect(h.line).toBe(12);
    const k = p.members.find((m) => m.name === "k")!;
    const c = k.annotations[0]!.args.constant!;
    expect(c.t === "ann" && c.v.args.stringValue).toEqual({ t: "str", v: "hi" });
    expect(p.members.some((m) => m.name === "<init>")).toBe(true);
    expect(p.members.find((m) => m.name === "tickCount")!.annotations[0]!.name).toBe("Shadow");
  });
  it("falls back to the tolerant parser on syntax errors and says so", async () => {
    const { parseJava } = await import("../src/mixin/javaparse.js");
    const p = parseJava(`package a;\n@Mixin(X.class)\npublic abstract class B {\n  @Shadow private int t\n  @Inject(method = "m", at = @At("HEAD")) private void h(CallbackInfo ci) {}\n}`);
    expect(p.problems[0]).toMatch(/syntax error.*fallback/);
    expect(p.className).toBe("B");
  });
});

describe("@Local / @ModifyVariable with the local variable table", () => {
  const H = `package com.example.m.mixin;
import java.util.function.BooleanSupplier;
import net.minecraft.server.FakeServer;
import org.spongepowered.asm.mixin.Mixin;
import org.spongepowered.asm.mixin.injection.*;
import org.spongepowered.asm.mixin.injection.callback.CallbackInfo;
import com.llamalad7.mixinextras.sugar.Local;
`;
  const index = (dirName: string) => {
    const dir = tmpDir("ffn-lvt-");
    const zip = new AdmZip();
    for (const n of ["FakeServer", "FakeLoop", "FakeServer$Inner"]) zip.addFile(`net/minecraft/server/${n}.class`, readFileSync(path.join(FIXTURES, dirName, `${n}.class`)));
    const jar = path.join(dir, "fake.jar");
    zip.writeZip(jar);
    const classes = indexJar(jar);
    return new McIndex(dir, { formatVersion: 1, kind: "vanilla", mcVersion: "1.20.1", namespace: "mojmap", jar, obfuscated: false, builtAt: "", classCount: classes.length, notes: [] }, classes);
  };
  const run = async (dirName: string, handler: string) => {
    const { MixinValidator } = await import("../src/mixin/validate.js");
    const v = new MixinValidator({ index: index(dirName), project: { dir: "/x", loader: "fabric", mcVersion: "1.20.1", mappings: "mojmap", source: "ffn", mixinConfigs: [], javaSourceRoots: [], resourceRoots: [] }, vanillaForLoader: false, mixinExtrasAvailable: true });
    const src = `${H}@Mixin(FakeServer.class)\nabstract class L {\n  @Inject(method = "tickServer", at = @At("TAIL"))\n  ${handler}\n}`;
    return v.validateSource(src, "L.java", "mixins").issues;
  };
  it("checks @Local names against the LVT", async () => {
    expect((await run("classes-lvt", `private void h(BooleanSupplier s, CallbackInfo ci, @Local(name = "r") Runnable r) {}`)).filter((i) => i.severity !== "info")).toEqual([]);
    const bad = await run("classes-lvt", `private void h(BooleanSupplier s, CallbackInfo ci, @Local(name = "q") Runnable r) {}`);
    expect(bad.find((i) => i.severity === "error")!.message).toMatch(/no Ljava\/lang\/Runnable; local named q; .*locals: r/);
    const wrongType = await run("classes-lvt", `private void h(BooleanSupplier s, CallbackInfo ci, @Local(name = "r") String r) {}`);
    expect(wrongType.find((i) => i.severity === "error")!.message).toMatch(/local r is Ljava\/lang\/Runnable;/);
    const ord = await run("classes-lvt", `private void h(BooleanSupplier s, CallbackInfo ci, @Local(ordinal = 1) Runnable r) {}`);
    expect(ord.find((i) => i.severity === "error")!.message).toMatch(/ordinal = 1 but the target has only 1/);
  });
  it("reports names as unverifiable without an LVT", async () => {
    const issues = await run("classes", `private void h(BooleanSupplier s, CallbackInfo ci, @Local(name = "q") Runnable r) {}`);
    expect(issues.some((i) => i.severity === "error")).toBe(false);
    expect(issues.find((i) => /unverifiable/.test(i.message))!.severity).toBe("info");
  });
});

describe("multi-project builds", () => {
  it("parses settings includes", async () => {
    const { parseSettingsIncludes } = await import("../src/project/info.js");
    expect(parseSettingsIncludes(`rootProject.name = 'x'\ninclude('common')\ninclude 'fabric', ':neoforge'\n// include 'old'\ninclude(":forge:sub")\nproject(':forge:sub').projectDir = file('forge-sub')`)).toEqual([
      { path: ":common", dir: "common" },
      { path: ":fabric", dir: "fabric" },
      { path: ":neoforge", dir: "neoforge" },
      { path: ":forge:sub", dir: "forge-sub" },
    ]);
    expect(parseSettingsIncludes(`include("common")\nfor (platform in providers.gradleProperty("enabled_platforms").get().split(",")) include(platform)`, { enabled_platforms: "fabric,neoforge" }).map((x) => x.path)).toEqual([":common", ":fabric", ":neoforge"]);
    expect(parseSettingsIncludes(`pluginManagement { includeBuild("build-logic") }`)).toEqual([]);
  });
  it("detects an Architectury build per subproject", async () => {
    const { mkdirSync, writeFileSync } = await import("node:fs");
    const { readProjectInfo } = await import("../src/project/info.js");
    const root = tmpDir("ffn-multi-");
    const w = (rel: string, text: string) => {
      mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
      writeFileSync(path.join(root, rel), text);
    };
    w("settings.gradle", `pluginManagement { repositories { maven { url "https://maven.fabricmc.net/" } } }\ninclude("common")\nfor (p in enabled_platforms.split(',')) include(p)`);
    w("gradle.properties", "minecraft_version=1.21.1\nenabled_platforms=fabric,neoforge\nmod_id=demo\nneoforge_version=21.1.80\n");
    w("build.gradle", `plugins { id "dev.architectury.loom" version "1.7-SNAPSHOT" apply false\n id "architectury-plugin" version "3.4-SNAPSHOT" }`);
    w("common/build.gradle", `architectury { common(rootProject.enabled_platforms.split(',')) }`);
    w("fabric/build.gradle", `plugins { id "com.github.johnrengelman.shadow" }\narchitectury { platformSetupLoomIde()\n fabric() }`);
    w("neoforge/build.gradle", `architectury { platformSetupLoomIde()\n neoForge() }`);
    w("common/src/main/resources/demo.mixins.json", "{}");
    w("fabric/src/main/resources/demo-fabric.mixins.json", "{}");
    w("neoforge/src/main/resources/demo-neoforge.mixins.json", "{}");
    w("gradlew", "");
    const r = await readProjectInfo(root);
    expect(r.subprojects!.map((x) => `${x.path}=${x.platform}`)).toEqual([":common=common", ":fabric=fabric", ":neoforge=neoforge"]);
    expect(r.classpathProject).toBe(":fabric");
    expect(r.mixinConfigs.length).toBe(3);
    const n = await readProjectInfo(path.join(root, "neoforge"));
    expect([n.loader, n.mcVersion, n.gradlePath, n.rootDir]).toEqual(["neoforge", "1.21.1", ":neoforge", root]);
    expect(n.mixinConfigs.map((f) => path.basename(f))).toEqual(["demo-neoforge.mixins.json"]);
    const c = await readProjectInfo(path.join(root, "common"));
    expect([c.platform, c.mcVersion, c.gradlePath]).toEqual(["common", "1.21.1", ":common"]);
  });
  it("caps the JDK at what the project's Gradle can run on", async () => {
    const { gradleMaxJvm } = await import("../src/tools/gradle.js");
    const { pickJdk } = await import("../src/jdk/discover.js");
    expect(gradleMaxJvm("8.10")).toBe(23);
    expect(gradleMaxJvm("8.14.3")).toBe(24);
    expect(gradleMaxJvm("9.2.1")).toBe(25);
    expect(gradleMaxJvm("7.6")).toBe(19);
    const jdks = [17, 25].map((major) => ({ home: `/j${major}`, major, version: String(major), isJdk: true, source: "t" }));
    expect(pickJdk([...jdks, { home: "/j21", major: 21, version: "21", isJdk: true, source: "t" }], 18, "x", 23).jdk!.major).toBe(21);
    expect(pickJdk(jdks, 18, "x", 23).jdk!.major).toBe(25); // nothing in range: still the next newer one
  });
});
