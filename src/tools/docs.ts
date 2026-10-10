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
  limit: z.number().int().min(1).max(25).optional().describe("Max results (default 5)"),
  includeCode: z.boolean().optional().describe("Include the first code block of each matching section (default true)"),
  verifyUrls: z.boolean().optional().describe("Check that every returned page URL responds (default true)"),
};
type Args = { [K in keyof typeof docsSearchInput]?: z.infer<(typeof docsSearchInput)[K]> } & { query: string };

let store: DocsStore | undefined;

export async function docsSearch(services: Services, a: Args) {
  store ??= new DocsStore(services.config);
  let loader = a.loader as Loader | undefined;
  let mc = a.mcVersion;
  if (a.projectDir) {
    const info = await readProjectInfo(a.projectDir);
    loader ??= info.loader;
    mc ??= info.mcVersion;
  }
  const kinds = new Set(a.kinds ?? ["docs", "primer", "changelog"]);
  const sources = (await loadDocSources(services.config)).filter((s) => kinds.has(s.kind) && (!loader || s.loaders.includes(loader)));
  if (!sources.length) return fail(`No documentation sources for ${loader ?? "any loader"} / ${[...kinds].join(", ")}.`);
  const warnings: string[] = [];
  const notes: string[] = [];
  const loaded = new Map<string, DocPage[]>();
  await Promise.all(
    sources.map(async (s) => {
      try {
        loaded.set(s.id, await store!.load(s, warnings));
      } catch (e) {
        warnings.push(`${s.title} unavailable: ${(e as Error).message}`);
      }
    }),
  );

  // --- choose which pages are in scope
  const inScope = new Set<DocPage>();
  const boostOf = new Map<DocPage, number>();
  const loaders: Loader[] = loader ? [loader] : ["fabric", "forge", "neoforge"];
  const used: string[] = [];
  for (const l of loaders) {
    const docSources = sources.filter((s) => s.kind === "docs" && s.loaders.includes(l));
    const pages = docSources.flatMap((s) => loaded.get(s.id) ?? []);
    const choice = chooseSet(
      pages.map((p) => p.version),
      mc,
      `${l} docs`,
    );
    if (!choice) continue;
    if (choice.note) notes.push(choice.note);
    for (const p of pages) if (p.version === choice.version) inScope.add(p);
    const titles = [...new Set(pages.filter((p) => p.version === choice.version).map((p) => p.sourceTitle))];
    used.push(`${titles.join(" + ")} [${choice.version}]`);
  }
  for (const s of sources.filter((x: DocSource) => x.kind !== "docs")) {
    const pages = loaded.get(s.id) ?? [];
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
  if (!inScope.size) return fail(`No documentation could be loaded.${warnings.length ? ` ${warnings.join(" ")}` : ""}`);

  // --- rank
  const limit = a.limit ?? 5;
  const hits = rank([...inScope], a.query, (p) => (boostOf.get(p) ?? 1) * (p.kind === "docs" ? 1 : 0.8));
  const seen = new Set<string>();
  const top = [];
  for (const h of hits) {
    const key = `${h.page.url}#${h.section.anchor}`;
    if (seen.has(key)) continue;
    seen.add(key);
    top.push(h);
    if (top.length >= limit) break;
  }

  const verify = a.verifyUrls !== false;
  const results = await Promise.all(
    top.map(async (h) => {
      let url = h.page.url;
      let verified: boolean | undefined;
      if (verify) {
        verified = await store!.verifyUrl(url);
        if (!verified && h.page.fallbackUrl && (await store!.verifyUrl(h.page.fallbackUrl))) {
          url = h.page.fallbackUrl;
          verified = true;
        }
      }
      const code = a.includeCode === false ? undefined : h.section.code[0];
      return {
        title: h.page.title,
        section: h.section.heading || undefined,
        source: h.page.sourceTitle,
        kind: h.page.kind,
        version: h.page.version,
        url: h.section.anchor ? `${url}#${h.section.anchor}` : url,
        pageUrl: url,
        verified,
        repoPath: h.page.repoPath,
        score: Math.round(h.score * 100) / 100,
        snippet: snippet(h.section.text, a.query, 240),
        code: code ? (code.length > 500 ? `${code.slice(0, 500)}\n…` : code) : undefined,
      };
    }),
  );
  const unverified = results.filter((r) => verify && !r.verified).length;
  if (unverified) warnings.push(`${unverified} result URL(s) could not be verified (offline, or the page moved): treat them as UNVERIFIED and check the repository path.`);

  const lines = results.map((r, i) => {
    const head = `${i + 1}. ${r.title}${r.section && r.section !== r.title ? ` › ${r.section}` : ""} — ${r.source} (${r.version})${verify ? (r.verified ? "" : " [UNVERIFIED URL]") : ""}\n   ${r.url}\n   ${r.snippet}`;
    return r.code ? `${head}\n   \`\`\`\n${r.code.split("\n").map((l) => `   ${l}`).join("\n")}\n   \`\`\`` : head;
  });
  const summary = [
    results.length ? `${results.length} result(s) for "${a.query}"${loader ? ` (${loader}${mc ? ` ${mc}` : ""})` : mc ? ` (${mc})` : ""}.` : `No matches for "${a.query}".`,
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
        "Search the official Fabric, Forge and NeoForge documentation, the NeoForged version primers (what changed in each Minecraft version, for porting) and Fabric's per-version announcements. Version-aware: picks the doc set matching the project's/requested Minecraft version (or says which closest set it used). Pages are fetched from the official repositories, cached, and every returned page URL is checked to exist. Returns snippets, code blocks and source URLs.",
      inputSchema: docsSearchInput,
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    (a) => guard(() => docsSearch(services, a as Args)),
  );
}
