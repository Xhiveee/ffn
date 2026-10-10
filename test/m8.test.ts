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
