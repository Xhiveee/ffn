import AdmZip from "adm-zip";
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { extractMethods, paramsMatch, paramType } from "../src/index/javasrc.js";
import { indexJar, McIndex, type IndexMeta } from "../src/index/store.js";
import type { Services } from "../src/services.js";
import { mixinTargets } from "../src/tools/mixin.js";
import { clip, ok, page, prune } from "../src/tools/result.js";
import { getClass, searchMcSource } from "../src/tools/source.js";
import { FIXTURES, fixtureServices, tmpDir } from "./helpers.js";

const CLASSES = path.join(FIXTURES, "classes");
const SRC = readFileSync(path.join(CLASSES, "FakeServer.java"), "utf8");

function fakeIndex(): McIndex {
  const dir = tmpDir("ffn-idx5-");
  const zip = new AdmZip();
  for (const n of ["FakeServer", "FakeLoop", "FakeServer$Inner"]) zip.addFile(`net/minecraft/server/${n}.class`, readFileSync(path.join(CLASSES, `${n}.class`)));
  const jar = path.join(dir, "fake.jar");
  zip.writeZip(jar);
  const classes = indexJar(jar);
  const meta: IndexMeta = { formatVersion: 1, kind: "vanilla", mcVersion: "1.20.1", namespace: "mojmap", jar, obfuscated: false, builtAt: "", classCount: classes.length, notes: [] };
  return new McIndex(dir, meta, classes);
}

function stubServices(src = SRC): Services {
  const index = fakeIndex();
  const base = fixtureServices();
  return { ...base, indexes: { open: async () => ({ index, notes: [] }), source: async () => ({ text: src, origin: "test source" }) } } as unknown as Services;
}

const txt = (r: { content: unknown }) => (r.content as { text: string }[])[0]!.text;
const approxTokens = (s: string) => Math.round(s.length / 4);

describe("result helpers (token economy)", () => {
  it("emits compact JSON once, without structuredContent or empty values", () => {
    const r = ok("Summary.", { a: 1, empty: [], none: undefined, nested: { x: "" }, list: [{ k: "v" }] });
    expect(r.structuredContent).toBeUndefined();
    expect(txt(r)).toBe('Summary.\n{"a":1,"list":[{"k":"v"}]}');
    expect(prune({ a: null, b: {} })).toEqual({});
  });
  it("pages and clips", () => {
    const p = page([1, 2, 3, 4, 5], 1, 2);
    expect(p.items).toEqual([2, 3]);
    expect(p.more).toMatch(/2 more — call again with offset=3/);
    expect(page([1, 2], 0, 5).more).toBeUndefined();
    expect(clip("abcdef", 4)).toBe("abc…");
  });
});

describe("Java source method extraction", () => {
  const src = `package x;
public class Outer {
    /** doc */
    @Override
    public void tick() {
        String s = "{ not a brace }";
        if (s.isEmpty()) { tick(1); }
    }
    protected int tick(int n) { return n; }
    public Outer(String a,
                 java.util.Map<String, Integer> b) {
        this.tick();
    }
    abstract void later(final String... xs);
    static class Inner {
        void tick() {}
    }
}`;
  it("finds overloads with javadoc/annotations and ignores calls and inner classes", () => {
    const ms = extractMethods(src, ["Outer"], "tick");
    expect(ms.map((m) => m.params)).toEqual([[], ["int"]]);
    expect(ms[0]!.text).toMatch(/^ {4}\/\*\* doc \*\/\n {4}@Override\n/);
    expect(ms[0]!.text.trimEnd().endsWith("}")).toBe(true);
    expect(ms[0]!.endLine - ms[0]!.startLine).toBe(5);
  });
  it("handles constructors with multi-line params, abstract methods and inner classes", () => {
    const ctor = extractMethods(src, ["Outer"], "Outer");
    expect(ctor).toHaveLength(1);
    expect(ctor[0]!.params).toEqual(["String", "Map"]);
    expect(extractMethods(src, ["Outer"], "later")[0]!.params).toEqual(["String[]"]);
    expect(extractMethods(src, ["Outer", "Inner"], "tick")).toHaveLength(1);
  });
  it("matches descriptors to declared parameter types", () => {
    expect(paramType("final java.util.List<String> names")).toBe("List");
    expect(paramsMatch(["Map"], "(Ljava/util/Map;)V")).toBe(true);
    expect(paramsMatch(["int"], "(I)V")).toBe(true);
    expect(paramsMatch(["int"], "(J)V")).toBe(false);
    expect(paramsMatch(["T"], "(Ljava/lang/Object;)V")).toBe(true);
  });
});

describe("get_class", () => {
  it("defaults to a compact outline with selectors and no bodies", async () => {
    const r = await getClass(stubServices(), { className: "FakeServer" });
    const t = txt(r);
    expect(t).toMatch(/^public abstract class net\.minecraft\.server\.FakeServer extends net\.minecraft\.server\.FakeLoop implements java\.lang\.Runnable/);
    expect(t).toContain("METHODS");
    expect(t).toContain("  public tickServer(Ljava/util/function/BooleanSupplier;)V");
    expect(t).toContain("  private int tickCount");
    expect(t).toContain("INNER Inner");
    expect(t).not.toContain("++this.tickCount");
    expect(t).toContain('get_class method="<name>"');
  });
  it("pages the outline and filters sections", async () => {
    const r = await getClass(stubServices(), { className: "FakeServer", limit: 3 });
    expect(txt(r)).toMatch(/more — call again with offset=3/);
    const f = txt(await getClass(stubServices(), { className: "FakeServer", members: ["fields"] }));
    expect(f).toContain("FIELDS");
    expect(f).not.toContain("METHODS");
    const j = txt(await getClass(stubServices(), { className: "FakeServer", descriptors: false, memberFilter: "tick" }));
    expect(j).toContain("public void tickServer(BooleanSupplier)");
  });
  it("returns one method's source", async () => {
    const t = txt(await getClass(stubServices(), { className: "FakeServer", method: "tickServer" }));
    expect(t).toContain("Selectors: tickServer(Ljava/util/function/BooleanSupplier;)V");
    expect(t).toContain("++this.tickCount;");
    expect(t).not.toContain("loadLevel");
    const d = txt(await getClass(stubServices(), { className: "FakeServer", method: "tickServer(Ljava/util/function/BooleanSupplier;)V" }));
    expect(d).toContain("++this.tickCount;");
    const miss = await getClass(stubServices(), { className: "FakeServer", method: "nope" });
    expect(miss.isError).toBe(true);
  });
  it("caps long method bodies and pages full source", async () => {
    const t = txt(await getClass(stubServices(), { className: "FakeServer", method: "tickServer", limit: 3 }));
    expect(t).toMatch(/more line\(s\): detail=full offset=/);
    const full = txt(await getClass(stubServices(), { className: "FakeServer", detail: "full", offset: 0, limit: 5 }));
    const lines = full.split("\n");
    expect(lines[1]).toMatch(/lines 1-5 of \d+ — more: offset=5/);
    expect(lines).toHaveLength(7);
  });
  it("outline is much smaller than the full source", async () => {
    const outline = txt(await getClass(stubServices(), { className: "FakeServer", members: ["methods"] }));
    const method = txt(await getClass(stubServices(), { className: "FakeServer", method: "initServer" }));
    expect(approxTokens(method)).toBeLessThan(approxTokens(SRC));
    expect(approxTokens(outline)).toBeLessThan(400);
  });
});

describe("search_mc_source and mixin_targets paging", () => {
  it("search returns one line per hit with paging", async () => {
    const t = txt(await searchMcSource(stubServices(), { query: "tick", limit: 1 }));
    const lines = t.split("\n");
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatch(/more: offset=1/);
  });
  it("mixin_targets lists selectors compactly and injection points only for filtered methods", async () => {
    const all = txt(await mixinTargets(stubServices(), { targetClass: "FakeServer" }));
    expect(all).toContain("tickServer(Ljava/util/function/BooleanSupplier;)V");
    expect(all).not.toMatch(/INVOKE \(\d+\)/);
    expect(all).toMatch(/Pass methodFilter/);
    const one = txt(await mixinTargets(stubServices(), { targetClass: "FakeServer", methodFilter: "tickServer" }));
    expect(one).toMatch(/INVOKE \(\d+\):/);
    expect(one).toContain("Lnet/minecraft/server/FakeServer;tickChildren(Ljava/util/function/BooleanSupplier;)V");
    const capped = txt(await mixinTargets(stubServices(), { targetClass: "FakeServer", methodFilter: "tickServer", maxPoints: 1 }));
    expect(capped).toMatch(/more \(maxPoints\)/);
    const paged = txt(await mixinTargets(stubServices(), { targetClass: "FakeServer", limit: 2 }));
    expect(paged).toMatch(/more — call again with offset=2/);
  });
});
