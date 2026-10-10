import AdmZip from "adm-zip";
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { findCallees, listPackage, normPackage, resolvePackage } from "../src/index/browse.js";
import { ClassReader } from "../src/index/classfile.js";
import { indexJar, McIndex, type IndexMeta } from "../src/index/store.js";
import { searchMcSource } from "../src/tools/source.js";
import type { Services } from "../src/services.js";
import { FIXTURES, tmpDir } from "./helpers.js";

const cls = (n: string) => readFileSync(path.join(FIXTURES, "classes", `${n}.class`));
function fakeIndex(): McIndex {
  const dir = tmpDir("ffn-idx9-");
  const zip = new AdmZip();
  for (const n of ["FakeServer", "FakeLoop", "FakeServer$Inner"]) zip.addFile(`net/minecraft/server/${n}.class`, cls(n));
  zip.addFile("net/minecraft/server/level/FakeLevel.class", cls("FakeLoop"));
  const jar = path.join(dir, "fake.jar");
  zip.writeZip(jar);
  const classes = indexJar(jar);
  // second copy under another package (name differs from the bytes' own name; fine for package listing)
  classes.push({ ...classes.find((c) => c.n.endsWith("FakeLoop"))!, n: "net/minecraft/server/level/FakeLevel" });
  const meta: IndexMeta = { formatVersion: 1, kind: "vanilla", mcVersion: "1.21.4", namespace: "mojmap", jar, obfuscated: false, builtAt: "", classCount: classes.length, notes: [] };
  return new McIndex(dir, meta, classes);
}
const S = "net/minecraft/server/FakeServer";
const fakeServices = (index: McIndex) => ({ indexes: { open: async () => ({ index, notes: [] }) } }) as unknown as Services;
const text = (r: { content: { type: string; text?: string }[] }) => r.content.map((c) => c.text ?? "").join("\n");

describe("package browsing", () => {
  it("normalizes package queries", () => {
    expect(normPackage("net.minecraft.server.")).toBe("net/minecraft/server");
    expect(normPackage(".")).toBe("");
    expect(normPackage("net/minecraft/*")).toBe("net/minecraft");
  });
  it("lists subpackages with counts, then top-level classes", () => {
    const idx = fakeIndex();
    const es = listPackage(idx, "net/minecraft/server");
    expect(es[0]).toEqual({ kind: "package", name: "level", info: 1 });
    expect(es.filter((e) => e.kind === "class").map((e) => e.name)).toEqual(["FakeLoop", "FakeServer"]);
    expect(es.find((e) => e.name === "FakeServer")!.info).toBe("abstract");
    expect(listPackage(idx, "")).toEqual([{ kind: "package", name: "net", info: 3 }]);
  });
  it("resolves a package by suffix and suggests candidates", () => {
    const idx = fakeIndex();
    expect(resolvePackage(idx, "server.level").pkg).toBe("net/minecraft/server/level");
    expect(resolvePackage(idx, "lev").candidates).toEqual(["net/minecraft/server/level"]);
  });
  it("search tool: kind=packages output", async () => {
    const out = text(await searchMcSource(fakeServices(fakeIndex()), { query: "minecraft.server", kind: "packages" }));
    expect(out.split("\n")).toEqual([
      "net.minecraft.server: 1 subpackage(s) (class count), 2 class(es) (Minecraft 1.21.4, mojmap names, vanilla jar).",
      "level/ (1)",
      "FakeLoop abstract",
      "FakeServer abstract",
    ]);
  });
});

describe("callees", () => {
  it("collects invokedynamic method handles", () => {
    const r = new ClassReader(cls("FakeServer"));
    const tick = r.info.methods.find((m) => m.name === "tickServer")!;
    expect(r.analyze(tick).handles.map((h) => h.name)).toEqual(expect.arrayContaining([expect.stringMatching(/^lambda\$tickServer\$/)]));
  });
  it("lists calls and field access, following lambda bodies", () => {
    const idx = fakeIndex();
    const cs = findCallees(idx, S, "tickServer", "(Ljava/util/function/BooleanSupplier;)V")!;
    const keys = cs.map((c) => `${c.how} ${c.name}${c.desc}`);
    expect(keys).toEqual(expect.arrayContaining(["call tickChildren(Ljava/util/function/BooleanSupplier;)V", "call autoSave()V", "get tickCount" + "I", "put tickCountI", "call run()V"]));
    expect(cs.some((c) => c.name.startsWith("lambda$"))).toBe(false); // followed, not listed
    expect(new Set(keys).size).toBe(keys.length);
    expect(findCallees(idx, S, "nope", "()V")).toBeUndefined();
  });
  it("search tool: kind=callees output and errors", async () => {
    const svc = fakeServices(fakeIndex());
    const out = text(await searchMcSource(svc, { query: "FakeServer#loadLevel", kind: "callees" }));
    expect(out).toContain("Callees of net.minecraft.server.FakeServer#loadLevel()V");
    expect(out).toContain("call net.minecraft.server.FakeServer#createLevels(I)V");
    expect(out).toMatch(/get {2}java\.lang\.System#out:Ljava\/io\/PrintStream;/);
    const lam = text(await searchMcSource(svc, { query: `FakeServer#tickServer`, kind: "callees" }));
    expect(lam).toContain("call net.minecraft.server.FakeServer#autoSave()V");
    expect(text(await searchMcSource(svc, { query: "FakeServer#runAllTasks", kind: "callees" }))).toContain("Declared in net.minecraft.server.FakeLoop");
    expect(text(await searchMcSource(svc, { query: "FakeServer", kind: "callees" }))).toContain("needs a method");
  });
});
