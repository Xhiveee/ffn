import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { gzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { dokuSlug, dokuwikiToMarkdown, DocsStore, fillUrl, loadDocSources, parseMarkdown, slug, snippet, type DocSource } from "../src/docs/search.js";
import { docsSearch } from "../src/tools/docs.js";
import { FIXTURES, fixtureServices, tmpDir } from "./helpers.js";

const DOCS = path.join(FIXTURES, "docs");
const txt = (r: { content: unknown }) => (r.content as { text: string }[])[0]!.text;

/** A local git repository with the fixture wiki pages (stands in for https://github.com/<o>/<r>.wiki.git). */
function wikiRepo(name: string): string {
  const dir = path.join(tmpDir("ffn-wiki-"), `${name}.wiki`);
  cpSync(path.join(DOCS, name), dir, { recursive: true });
  const g = (...args: string[]) => execFileSync("git", ["-c", "user.name=ffn", "-c", "user.email=ffn@local", ...args], { cwd: dir, stdio: "ignore" });
  g("init", "-q");
  g("add", "-A");
  g("commit", "-q", "-m", "wiki");
  return dir;
}

/** Fake HTTP for the DokuWiki fixture: gzipped sitemap + export_raw pages; records requested URLs. */
function dokuHttp(requested: string[]) {
  return async (url: string) => {
    requested.push(url);
    if (url === "https://wiki.fabricmc.net/doku.php?do=sitemap") return new Response(gzipSync(readFileSync(path.join(DOCS, "fabric-wiki/sitemap.xml"))));
    if (url === "https://wiki.fabricmc.net/tutorial:mixin_injects?do=export_raw") return new Response(readFileSync(path.join(DOCS, "fabric-wiki/tutorial_mixin_injects.txt"), "utf8"));
    return new Response("not found", { status: 404 });
  };
}

function sourcesYaml(mixinWiki: string, extrasWiki: string): string {
  return `sources:
  - id: mixin-wiki
    title: SpongePowered Mixin wiki
    loaders: [fabric, forge, neoforge]
    topics: [mixin]
    versioned: false
    titleFromName: true
    git: { url: '${mixinWiki}' }
    files:
      - match: '^([^_/][^/]*)\\.md$'
        url: 'https://github.com/SpongePowered/Mixin/wiki/{page:url}'
  - id: mixinextras-wiki
    title: MixinExtras wiki
    loaders: [fabric, forge, neoforge]
    topics: [mixin]
    versioned: false
    titleFromName: true
    git: { url: '${extrasWiki}' }
    files:
      - match: '^([^_/][^/]*)\\.md$'
        url: 'https://github.com/LlamaLad7/MixinExtras/wiki/{page:url}'
  - id: fabric-wiki-mixin
    title: Fabric wiki (Mixin tutorials)
    loaders: [fabric]
    topics: [mixin]
    versioned: false
    dokuwiki: { base: 'https://wiki.fabricmc.net' }
    files:
      - match: '^tutorial:(mixin[a-z0-9_]*)$'
        url: 'https://wiki.fabricmc.net/tutorial:{page}'
  - id: loader-docs
    title: Loader docs
    loaders: [forge]
    git: { url: '${mixinWiki}' }
    files:
      - match: '^(Home)\\.md$'
        version: latest
        url: 'https://example.invalid/{page}'
`;
}

describe("Mixin docs sources (profiles/docs/sources.yaml)", () => {
  it("built-in profile declares the Mixin wiki, MixinExtras wiki and Fabric mixin pages", async () => {
    const all = await loadDocSources(fixtureServices().config);
    const byId = new Map(all.map((s) => [s.id, s]));
    expect(byId.get("mixin-wiki")).toMatchObject({ versioned: false, topics: ["mixin"], git: { url: "https://github.com/SpongePowered/Mixin.wiki.git" } });
    expect(byId.get("mixinextras-wiki")).toMatchObject({ versioned: false, topics: ["mixin"], git: { url: "https://github.com/LlamaLad7/MixinExtras.wiki.git" } });
    expect(byId.get("fabric-wiki-mixin")).toMatchObject({ versioned: false, loaders: ["fabric"], dokuwiki: { base: "https://wiki.fabricmc.net" } });
    const fabricDocs = byId.get("fabric-docs")!;
    expect(fabricDocs.files[0]!.topics).toEqual(["mixin"]);
    expect("develop/mixins/accessors.md").toMatch(new RegExp(fabricDocs.files[0]!.match));
    // regular loader docs carry no topic
    expect(byId.get("neoforge-docs")!.topics).toEqual([]);
  });

  it("encodes GitHub wiki page names and builds GitHub-style anchors", () => {
    const m = "Flippin'-Mixins,-how-do-they-work?.md".match(/^([^_/][^/]*)\.md$/)!;
    expect(fillUrl("https://github.com/SpongePowered/Mixin/wiki/{page:url}", m, m[1]!)).toBe("https://github.com/SpongePowered/Mixin/wiki/Flippin'-Mixins%2C-how-do-they-work%3F");
    expect(slug("1. Code Out Of The Aether - Discovering Injectors")).toBe("1-code-out-of-the-aether---discovering-injectors");
    expect(slug("1.1 Recapping - Stuff You Already Know&#8482;")).toBe("11-recapping---stuff-you-already-know");
  });

  it("converts DokuWiki markup (headings with DokuWiki ids, code, links, inline code)", () => {
    expect(dokuSlug("Effects & Use-Cases")).toBe("effects_use-cases");
    expect(dokuSlug("@Inject")).toBe("inject");
    const md = parseMarkdown(dokuwikiToMarkdown(readFileSync(path.join(DOCS, "fabric-wiki/tutorial_mixin_injects.txt"), "utf8")));
    expect(md.title).toBe("@Inject");
    expect(md.sections.map((s) => [s.heading, s.anchor])).toEqual([
      ["@Inject", "inject"],
      ["Effects & Use-Cases", "effects_use-cases"],
      ["Cancelling the target method", "cancelling_the_target_method"],
    ]);
    const eff = md.sections[1]!.text;
    expect(eff).toContain("`@Inject` injects a call");
    expect(eff).toContain("by cancelling.");
    expect(eff).toContain("`@WrapOperation`");
    expect(eff).not.toContain("[[");
    const cancel = md.sections[2]!;
    expect(cancel.code[0]).toMatch(/^@Inject\(method = "tick".*\n.*skipTick/s);
    expect(cancel.text).not.toContain("FIXME");
    expect(cancel.text).toContain("This section needs an example.");
  });

  it("loads a GitHub wiki from git: titles from file names, encoded URLs, no _Sidebar, version 'any'", async () => {
    const services = fixtureServices();
    const src = (await loadDocSourcesFrom(sourcesYaml(wikiRepo("mixin-wiki"), wikiRepo("mixinextras-wiki")))).find((s) => s.id === "mixin-wiki")!;
    const pages = await new DocsStore(services.config).load(src, []);
    const byPath = new Map(pages.map((p) => [p.repoPath, p]));
    expect([...byPath.keys()].sort()).toEqual(["Advanced-Mixin-Usage---Callback-Injectors.md", "Flippin'-Mixins,-how-do-they-work.md", "Home.md"]);
    const cb = byPath.get("Advanced-Mixin-Usage---Callback-Injectors.md")!;
    expect(cb).toMatchObject({ title: "Advanced Mixin Usage - Callback Injectors", version: "any", topics: ["mixin"], url: "https://github.com/SpongePowered/Mixin/wiki/Advanced-Mixin-Usage---Callback-Injectors" });
    expect(cb.sections.map((s) => s.anchor)).toEqual(["", "2-building-handler-methods", "3-cancellable-injections", "31-stuff-you-already-know"]);
    expect(byPath.get("Flippin'-Mixins,-how-do-they-work.md")!.url).toBe("https://github.com/SpongePowered/Mixin/wiki/Flippin'-Mixins%2C-how-do-they-work");
  });

  it("loads only matching English DokuWiki pages from the sitemap", async () => {
    const requested: string[] = [];
    const services = fixtureServices();
    const src = (await loadDocSourcesFrom(sourcesYaml("/x", "/y"))).find((s) => s.id === "fabric-wiki-mixin")!;
    const pages = await new DocsStore(services.config, dokuHttp(requested)).load(src, []);
    expect(pages.map((p) => [p.repoPath, p.url, p.title, p.version])).toEqual([["tutorial:mixin_injects", "https://wiki.fabricmc.net/tutorial:mixin_injects", "@Inject", "any"]]);
    expect(requested).toEqual(["https://wiki.fabricmc.net/doku.php?do=sitemap", "https://wiki.fabricmc.net/tutorial:mixin_injects?do=export_raw"]);
  });
});

async function loadDocSourcesFrom(yaml: string): Promise<DocSource[]> {
  const dir = tmpDir("ffn-docsprof-");
  mkdirSync(path.join(dir, "docs"));
  writeFileSync(path.join(dir, "docs", "sources.yaml"), yaml);
  return loadDocSources({ ...fixtureServices().config, builtinProfilesDir: dir });
}

describe("docs_search topic / source filters", () => {
  async function setup() {
    const dir = tmpDir("ffn-docsprof-");
    mkdirSync(path.join(dir, "docs"));
    writeFileSync(path.join(dir, "docs", "sources.yaml"), sourcesYaml(wikiRepo("mixin-wiki"), wikiRepo("mixinextras-wiki")));
    const services = fixtureServices({ builtinProfilesDir: dir });
    const store = new DocsStore(services.config, dokuHttp([]));
    return { services, store };
  }

  it("topic=mixin searches only Mixin docs, version-independent, with compact output", async () => {
    const { services, store } = await setup();
    const t = txt(await docsSearch(services, { query: "@WrapOperation", topic: "mixin", mcVersion: "1.20.1", verifyUrls: false, includeCode: false }, store));
    const lines = t.split("\n");
    expect(lines[0]).toBe('3 result(s) for "@WrapOperation" (1.20.1) [topic mixin].');
    expect(lines[1]).toBe("Searched: SpongePowered Mixin wiki [any version]; MixinExtras wiki [any version]; Fabric wiki (Mixin tutorials) [any version].");
    expect(lines[3]).toMatch(/^1\. WrapOperation( › Example)? — MixinExtras wiki$/);
    expect(t).not.toContain("Loader docs");
    expect(t).not.toContain("(any)");
    expect(t).not.toContain("example.invalid/javadoc"); // markdown link targets are dropped from snippets
  });

  it("finds cancellable @Inject sections with anchors", async () => {
    const { services, store } = await setup();
    const t = txt(await docsSearch(services, { query: "@Inject cancellable", topic: "mixin", verifyUrls: false, limit: 3 }, store));
    expect(t).toContain("https://github.com/SpongePowered/Mixin/wiki/Advanced-Mixin-Usage---Callback-Injectors#3-cancellable-injections");
    expect(t).toContain("https://wiki.fabricmc.net/tutorial:mixin_injects#cancelling_the_target_method");
    expect(t).toContain('@Inject(method = "setPos", at = @At("HEAD"), cancellable = true)');
  });

  it("loader and source filters apply; unknown ids/topics are explained", async () => {
    const { services, store } = await setup();
    const forge = txt(await docsSearch(services, { query: "cancellable", topic: "mixin", loader: "forge", verifyUrls: false }, store));
    expect(forge).not.toContain("Fabric wiki");
    const only = txt(await docsSearch(services, { query: "cancellable", sources: ["mixinextras-wiki"], verifyUrls: false }, store));
    expect(only).toContain("Searched: MixinExtras wiki [any version].");
    const bad = await docsSearch(services, { query: "x y", sources: ["nope"] }, store);
    expect(bad.isError).toBe(true);
    expect(txt(bad)).toMatch(/Unknown docs source id\(s\): nope\. Known: mixin-wiki, mixinextras-wiki, fabric-wiki-mixin, loader-docs/);
    const badTopic = await docsSearch(services, { query: "x y", topic: "rendering" }, store);
    expect(txt(badTopic)).toMatch(/known topics: mixin/);
  });

  it("without a topic, versioned loader docs and Mixin docs are searched together", async () => {
    const { services, store } = await setup();
    const t = txt(await docsSearch(services, { query: "mixin wiki introduction", loader: "forge", verifyUrls: false }, store));
    expect(t).toMatch(/Searched: Loader docs \[latest\]; SpongePowered Mixin wiki \[any version\]; MixinExtras wiki \[any version\]\./);
  });

  it("skips results whose page returns 404 and takes the next hit", async () => {
    const { services, store } = await setup();
    const first = txt(await docsSearch(services, { query: "@Inject cancellable", topic: "mixin", verifyUrls: false, limit: 1 }, store));
    const gone = /https:\/\/\S+/.exec(first)![0].replace(/#.*$/, "");
    store.verifyUrl = async (u: string) => (u === gone ? false : true);
    const t = txt(await docsSearch(services, { query: "@Inject cancellable", topic: "mixin", limit: 1 }, store));
    expect(t).not.toContain(gone);
    expect(t).toMatch(/1 matching page\(s\) skipped: their published URL returns 404/);
    store.verifyUrl = async () => undefined; // offline: keep, but mark
    expect(txt(await docsSearch(services, { query: "@Inject cancellable", topic: "mixin", limit: 1 }, store))).toContain("[UNVERIFIED URL]");
  });

  it("snippets drop markdown link targets", () => {
    expect(snippet("See [`INVOKE`](https://x.invalid/a.html) and more", "invoke")).toBe("See `INVOKE` and more");
  });
});
