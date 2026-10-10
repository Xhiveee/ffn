import { describe, expect, it } from "vitest";
import { evalCondition, render } from "../src/content/template.js";
import { loadCatalog, resolveSettings } from "../src/content/catalog.js";
import { loadConfig } from "../src/config.js";
import { chooseSet, fillUrl, parseMarkdown, rank, versionCovers, type DocPage } from "../src/docs/search.js";
import { constFromAnn, constFromArgs, constMatches, newClassOf } from "../src/mixin/validate.js";
import { parseConstant } from "../src/mixin/generate.js";

describe("template", () => {
  it("renders vars, conditions, each and eq", () => {
    const out = render('{{a}}{{#if b}}+{{else}}-{{/if}}{{#each xs}}[{{this.n}}{{#unless @last}},{{/unless}}]{{/each}}{{#eq k "x"}}X{{/eq}}', { a: "A", b: false, xs: [{ n: 1 }, { n: 2 }], k: "x" });
    expect(out).toBe("A-[1,][2]X");
  });
  it("errors on missing values", () => {
    expect(() => render("{{nope}}", {})).toThrow();
  });
  it("evaluates conditions with ==, !, &&, ||", () => {
    const d = { has: { a: true, b: false }, p: { t: "common" } };
    expect(evalCondition("has.a && !has.b", d)).toBe(true);
    expect(evalCondition('p.t == "common"', d)).toBe(true);
    expect(evalCondition('p.t != "common" || has.b', d)).toBe(false);
  });
});

describe("content catalogs", () => {
  const config = loadConfig();
  for (const l of ["fabric", "forge", "neoforge"] as const) {
    it(`${l} catalog loads and has every public kind`, async () => {
      const c = await loadCatalog(config, l);
      for (const k of ["block", "item", "block_entity", "entity", "recipe", "loot_table", "tag", "creative_tab", "event_handler", "networking", "config", "datagen"]) expect(c.kinds[k], `${l}:${k}`).toBeDefined();
    });
  }
  it("data format rules follow the version", async () => {
    const c = await loadCatalog(config, "fabric");
    expect(resolveSettings(c.rules, "1.20.1", true).recipeResult).toBe("item");
    expect(resolveSettings(c.rules, "1.21.1", true).recipeResult).toBe("id");
    expect(resolveSettings(c.rules, "26.3", false).itemModelDefinitions).toBe(true);
  });
  it("neoforge 1.20.1 delegates to forge", async () => {
    const c = await loadCatalog(config, "neoforge");
    expect(c.delegate[0]?.to).toBe("forge");
  });
});

describe("docs_search helpers", () => {
  it("chooses doc sets by version", () => {
    expect(chooseSet(["latest", "1.21.1", "1.20.4"], "26.3", "x")?.version).toBe("latest");
    expect(chooseSet(["latest", "1.21.1", "1.20.4"], "1.21.1", "x")?.version).toBe("1.21.1");
    expect(chooseSet(["latest", "1.21.1", "1.20.4"], "1.20.1", "x")).toMatchObject({ version: "1.20.4", exact: false });
    expect(chooseSet(["1.20.1", "1.20.x", "1.21.x"], "1.21.4", "x")?.version).toBe("1.21.x");
    expect(chooseSet(["1.20.1", "1.20.x", "1.21.x"], "26.3", "x")).toMatchObject({ version: "1.21.x", exact: false });
    expect(versionCovers("1.21.x", "1.21")).toBe(true);
  });
  it("maps repository paths to page URLs", () => {
    const m = "docs/blocks/index.md".match(/^docs\/(.+)\.mdx?$/)!;
    expect(fillUrl("https://docs.neoforged.net/docs/{page}", m, "blocks")).toBe("https://docs.neoforged.net/docs/blocks");
    const b = "_posts/2025-12-5-12111.md".match(/^_posts\/([0-9]{4})-([0-9]{1,2})-([0-9]{1,2})-(.+)\.md$/)!;
    expect(fillUrl("https://fabricmc.net/$1/{pad2:$2}/{pad2:$3}/$4.html", b, "")).toBe("https://fabricmc.net/2025/12/05/12111.html");
  });
  it("splits markdown into sections and ranks them", () => {
    const md = parseMarkdown("---\ntitle: Blocks\n---\n# Blocks\nintro\n## Registering Blocks {#reg}\nUse DeferredRegister.\n```java\nBLOCKS.register(...)\n```\n## Other\nnothing");
    expect(md.frontTitle).toBe("Blocks");
    expect(md.sections.find((s) => s.anchor === "reg")?.code[0]).toContain("BLOCKS.register");
    const page: DocPage = { sourceId: "s", sourceTitle: "S", kind: "docs", version: "latest", repoPath: "x", url: "u", title: "Blocks", sections: md.sections };
    expect(rank([page], "register block", () => 1)[0]?.section.anchor).toBe("reg");
  });
});

describe("mixin constants", () => {
  it("parses @At CONSTANT args and @Constant values", () => {
    expect(constFromArgs(["floatValue=5.0F"])).toMatchObject({ type: "float", value: "5.0" });
    expect(constFromAnn({ name: "Constant", args: { intValue: { t: "num", v: "3" } }, start: 0 })).toMatchObject({ type: "int", value: "3" });
    expect(constMatches({ type: "float", value: "0.2" }, { type: "float", value: "0.20000000298023224", pc: 0 })).toBe(true);
    expect(constMatches({ type: "int", value: "5" }, { type: "float", value: "5", pc: 0 })).toBe(false);
  });
  it("parses user constants for modify_constant", () => {
    expect(parseConstant("5")).toEqual({ type: "int", value: "5" });
    expect(parseConstant("0.5F")).toEqual({ type: "float", value: "0.5" });
    expect(parseConstant("10L")).toEqual({ type: "long", value: "10" });
    expect(parseConstant('"hi"')).toEqual({ type: "string", value: "hi" });
    expect(parseConstant("class:net.minecraft.world.item.Item")).toEqual({ type: "class", value: "net/minecraft/world/item/Item" });
  });
  it("reads NEW targets", () => {
    expect(newClassOf("(Lnet/a/B;)Lnet/c/D;")).toBe("net/c/D");
    expect(newClassOf("net.c.D")).toBe("net/c/D");
  });
});
