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
