import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { chooseSet, DocsStore, loadDocSources, rank, snippet, type DocPage, type DocSource } from "../docs/search.js";
import { readProjectInfo } from "../project/info.js";
import { LoaderSchema, type Loader } from "../profiles/schema.js";
import type { Services } from "../services.js";
import { compareMcVersions, parseMcVersion } from "../util/mcversion.js";
import { fail, guard, okText } from "./result.js";

export const docsSearchInput = {
  query: z.string().min(2).describe("What to look for, e.g. 'register a block entity renderer', 'data components', 'CustomPacketPayload'"),
  loader: LoaderSchema.optional().describe("fabric | forge | neoforge (default: from projectDir, else all)"),
  mcVersion: z.string().optional().describe("Minecraft version the answer must fit (default: from projectDir, else latest docs)"),
  projectDir: z.string().optional().describe("Take loader and Minecraft version from this mod project"),
  kinds: z
    .array(z.enum(["docs", "primer", "changelog"]))
    .optional()
    .describe("docs (loader documentation), primer (NeoForged version primers: vanilla + loader changes per version, useful for porting), changelog (Fabric per-version announcements). Default: all"),
  topic: z.string().optional().describe("Only pages about this topic, e.g. 'mixin' (Mixin wiki, MixinExtras wiki, Fabric's mixin docs/wiki pages). Topics come from profiles/docs/*.yaml"),
  sources: z.array(z.string()).optional().describe("Only these source ids, e.g. ['mixin-wiki','mixinextras-wiki'] (see profiles/docs/sources.yaml)"),
  limit: z.number().int().min(1).max(25).optional().describe("Max results (default 5)"),
  includeCode: z.boolean().optional().describe("Include the first code block of each matching section (default true)"),
  verifyUrls: z.boolean().optional().describe("Check that every returned page URL responds (default true)"),
};
type Args = { [K in keyof typeof docsSearchInput]?: z.infer<(typeof docsSearchInput)[K]> } & { query: string };

let shared: DocsStore | undefined;

export async function docsSearch(services: Services, a: Args, injected?: DocsStore) {
  const store = injected ?? (shared ??= new DocsStore(services.config));
  let loader = a.loader as Loader | undefined;
  let mc = a.mcVersion;
  if (a.projectDir) {
    const info = await readProjectInfo(a.projectDir);
    loader ??= info.loader;
    mc ??= info.mcVersion;
  }
  const kinds = new Set(a.kinds ?? ["docs", "primer", "changelog"]);
  const all = await loadDocSources(services.config);
  const topic = a.topic?.toLowerCase();
  const wantIds = a.sources?.length ? new Set(a.sources) : undefined;
  if (wantIds) {
    const unknown = [...wantIds].filter((id) => !all.some((s) => s.id === id));
    if (unknown.length) return fail(`Unknown docs source id(s): ${unknown.join(", ")}. Known: ${all.map((s) => s.id).join(", ")}.`);
  }
  // a topic keeps sources whose pages can carry it (source-level or rule-level topics)
  const hasTopic = (s: DocSource) => !topic || s.topics.includes(topic) || s.files.some((f) => f.topics?.includes(topic));
  const sources = all.filter((s) => kinds.has(s.kind) && (!loader || s.loaders.includes(loader)) && (!wantIds || wantIds.has(s.id)) && hasTopic(s));
  if (!sources.length) {
    const topics = [...new Set(all.flatMap((s) => [...s.topics, ...s.files.flatMap((f) => f.topics ?? [])]))];
    return fail(`No documentation sources for ${loader ?? "any loader"} / ${[...kinds].join(", ")}${topic ? ` / topic ${topic} (known topics: ${topics.join(", ") || "none"})` : ""}.`);
  }
  const warnings: string[] = [];
  const notes: string[] = [];
  const loaded = new Map<string, DocPage[]>();
  await Promise.all(
    sources.map(async (s) => {
      try {
        loaded.set(s.id, await store.load(s, warnings));
      } catch (e) {
        warnings.push(`${s.title} unavailable: ${(e as Error).message}`);
      }
    }),
  );

  // --- choose which pages are in scope
  const inScope = new Set<DocPage>();
  const topicOk = (p: DocPage) => !topic || p.topics.includes(topic);
  const boostOf = new Map<DocPage, number>();
  /** Pages from a doc set chosen for another Minecraft version (e.g. Forge's newest docs for an older release). */
  const fallbackOf = new Map<DocPage, string>();
  const loaders: Loader[] = loader ? [loader] : ["fabric", "forge", "neoforge"];
  const used: string[] = [];
  for (const l of loaders) {
    const docSources = sources.filter((s) => s.kind === "docs" && s.versioned && s.loaders.includes(l));
    // with a topic, pick the doc set among the pages that have it (e.g. mixin pages exist only in some versions)
    const pages = docSources.flatMap((s) => loaded.get(s.id) ?? []).filter(topicOk);
    const choice = chooseSet(
      pages.map((p) => p.version),
      mc,
      `${l} docs`,
    );
    if (!choice) continue;
    if (choice.note && !(mc && !choice.exact)) notes.push(choice.note); // fallbacks are labeled in "Searched" and per result
    const chosen = pages.filter((p) => p.version === choice.version);
    if (!chosen.length) continue;
    for (const p of chosen) {
      inScope.add(p);
      if (!choice.exact && mc) fallbackOf.set(p, `${choice.version} docs, none for ${mc}`);
    }
    const titles = [...new Set(chosen.map((p) => p.sourceTitle))];
    used.push(`${titles.join(" + ")} [${choice.version}${!choice.exact && mc ? ` — FALLBACK, no ${l} docs for ${mc}` : ""}]`);
  }
  // version-independent docs (e.g. the Mixin wiki): always in scope, never version-filtered
  for (const s of sources.filter((x) => x.kind === "docs" && !x.versioned)) {
    const pages = (loaded.get(s.id) ?? []).filter(topicOk);
    for (const p of pages) inScope.add(p);
    if (pages.length) used.push(`${s.title} [any version]`);
  }
  for (const s of sources.filter((x: DocSource) => x.kind !== "docs")) {
    const pages = (loaded.get(s.id) ?? []).filter(topicOk);
    const ok2 = pages.filter((p) => !mc || !parseMcVersion(mc) || !parseMcVersion(p.version) || compareMcVersions(p.version, mc) <= 0);
    // closer versions matter more: the primer/announcement FOR the target version ranks highest
    const versions = [...new Set(ok2.map((p) => p.version))].filter((v) => parseMcVersion(v)).sort(compareMcVersions);
    for (const p of ok2) {
      inScope.add(p);
      const d = versions.length - 1 - versions.indexOf(p.version);
      boostOf.set(p, mc && p.version === mc ? 2 : 1 / (1 + 0.35 * Math.max(0, d)));
    }
    if (ok2.length) used.push(`${s.title} [${mc ? `≤ ${mc}` : "all"}]`);
  }
  if (!inScope.size) return fail(`No documentation could be loaded${topic ? ` for topic ${topic}` : ""}.${warnings.length ? ` ${warnings.join(" ")}` : ""}`);

  // --- rank
  const limit = a.limit ?? 5;
  // topic-only sources (Mixin wikis) stay searchable without a topic, but loader docs win ties
  const topicOnly = new Set(sources.filter((x) => !x.versioned && x.topics.length).map((x) => x.id));
  const hits = rank([...inScope], a.query, (p) => (boostOf.get(p) ?? 1) * (p.kind === "docs" ? 1 : 0.8) * (!topic && topicOnly.has(p.sourceId) ? 0.8 : 1));
  const verify = a.verifyUrls !== false;
  const seen = new Set<string>();
  const results = [];
  let gone = 0;
  for (const h of hits) {
    if (results.length >= limit) break;
    const key = `${h.page.url}#${h.section.anchor}`;
    if (seen.has(key)) continue;
    seen.add(key);
    let url = h.page.url;
    let verified: boolean | undefined;
    if (verify) {
      verified = await store.verifyUrl(url);
      if (verified !== true && h.page.fallbackUrl) {
        const fb = await store.verifyUrl(h.page.fallbackUrl);
        if (fb) (url = h.page.fallbackUrl), (verified = true);
        else if (fb === false && verified === undefined) verified = undefined;
      }
      if (verified === false) {
        gone++; // the published page no longer exists: skip it, take the next hit
        continue;
      }
    }
    const code = a.includeCode === false ? undefined : h.section.code[0];
    results.push({
      title: h.page.title,
      section: h.section.heading || undefined,
      source: h.page.sourceTitle,
      version: h.page.version,
      fallback: fallbackOf.get(h.page),
      url: h.section.anchor ? `${url}#${h.section.anchor}` : url,
      verified,
      snippet: snippet(h.section.text, a.query, 240),
      code: code ? (code.length > 500 ? `${code.slice(0, 500)}\n…` : code) : undefined,
    });
  }
  if (gone) notes.push(`${gone} matching page(s) skipped: their published URL returns 404 (removed upstream).`);
  const unverified = results.filter((r) => verify && r.verified !== true).length;
  if (unverified) warnings.push(`${unverified} result URL(s) could not be verified (offline, or the page moved): treat them as UNVERIFIED and check the repository path.`);

  const lines = results.map((r, i) => {
    const head = `${i + 1}. ${r.title}${r.section && r.section !== r.title ? ` › ${r.section}` : ""} — ${r.source}${r.version === "any" ? "" : r.fallback ? ` (${r.fallback} — FALLBACK)` : ` (${r.version})`}${verify && r.verified !== true ? " [UNVERIFIED URL]" : ""}\n   ${r.url}\n   ${r.snippet}`;
    return r.code ? `${head}\n   \`\`\`\n${r.code.split("\n").map((l) => `   ${l}`).join("\n")}\n   \`\`\`` : head;
  });
  const summary = [
    results.length ? `${results.length} result(s) for "${a.query}"${loader ? ` (${loader}${mc ? ` ${mc}` : ""})` : mc ? ` (${mc})` : ""}${topic ? ` [topic ${topic}]` : ""}.` : `No matches for "${a.query}".`,
    `Searched: ${used.join("; ")}.`,
    ...notes.map((n) => `Note: ${n}`),
    ...warnings.map((w) => `Warning: ${w}`),
    "",
    ...lines,
  ].join("\n");
  return okText(summary);
}

export function registerDocsTools(server: McpServer, services: Services): void {
  server.registerTool(
    "docs_search",
    {
      title: "Search docs",
      description:
        "Search the official Fabric, Forge and NeoForge documentation, the NeoForged version primers (what changed in each Minecraft version, for porting), Fabric's per-version announcements, and Mixin docs (SpongePowered Mixin wiki, MixinExtras wiki, Fabric mixin pages; not version-specific). Pass topic='mixin' to search only Mixin docs. Version-aware: picks the doc set matching the project's/requested Minecraft version (or says which closest set it used). Pages are fetched from the official repositories, cached, and every returned page URL is checked to exist. Returns snippets, code blocks and source URLs.",
      inputSchema: docsSearchInput,
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    (a) => guard(() => docsSearch(services, a as Args)),
  );
}
