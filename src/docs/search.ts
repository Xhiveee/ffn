/**
 * docs_search: official loader documentation, primers and changelogs, fetched from their source repositories
 * (declared in profiles/docs/*.yaml), cached on disk, split into heading sections and ranked with BM25.
 * Nothing about specific versions lives here: which doc sets exist comes from the repositories themselves.
 */
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile, readdir, rename, rm, stat, utimes, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { gunzipSync } from "node:zlib";
import YAML from "yaml";
import { z } from "zod";
import type { FfnConfig } from "../config.js";
import { ZipDir } from "../util/zip.js";
import { compareMcVersions, parseMcVersion } from "../util/mcversion.js";

const FileRule = z.object({
  match: z.string(),
  version: z.string().optional(),
  versionFromContent: z.string().optional(),
  url: z.string(),
  fallbackUrl: z.string().optional(),
  /** Extra topics for pages matched by this rule (e.g. the mixin pages inside a loader's docs). */
  topics: z.array(z.string()).optional(),
});
const SourceSchema = z
  .object({
    id: z.string(),
    title: z.string(),
    loaders: z.array(z.enum(["fabric", "forge", "neoforge"])),
    kind: z.enum(["docs", "primer", "changelog"]).default("docs"),
    /** Topics of every page of this source, e.g. [mixin]; docs_search can be restricted to one topic. */
    topics: z.array(z.string()).default([]),
    /** false: the docs are not tied to Minecraft versions (e.g. the Mixin wiki); pages get version "any". */
    versioned: z.boolean().default(true),
    /** Page title from the file name (GitHub wiki style: dashes are spaces) instead of the first heading. */
    titleFromName: z.boolean().default(false),
    zip: z.string().optional(),
    githubTree: z.object({ repo: z.string(), branch: z.string() }).optional(),
    /** Any git repository (e.g. a GitHub wiki: https://github.com/<owner>/<repo>.wiki.git), shallow-cloned. */
    git: z.object({ url: z.string(), branch: z.string().optional() }).optional(),
    /** A DokuWiki: pages listed from its sitemap (do=sitemap), raw text via do=export_raw. repoPath = page id. */
    dokuwiki: z.object({ base: z.string() }).optional(),
    files: z.array(FileRule),
  })
  .refine((s) => [s.zip, s.githubTree, s.git, s.dokuwiki].filter(Boolean).length === 1, { message: "exactly one of zip, githubTree, git or dokuwiki" });
export type DocSource = z.infer<typeof SourceSchema>;
const SourcesFile = z.object({ sources: z.array(SourceSchema) });

export async function loadDocSources(config: FfnConfig): Promise<DocSource[]> {
  const byId = new Map<string, DocSource>();
  for (const dir of [path.join(config.builtinProfilesDir, "docs"), path.join(config.userProfilesDir, "docs")]) {
    if (!existsSync(dir)) continue;
    for (const f of (await readdir(dir)).filter((n) => /\.ya?ml$/.test(n)).sort()) {
      const parsed = SourcesFile.safeParse(YAML.parse(await readFile(path.join(dir, f), "utf8")));
      if (!parsed.success) throw new Error(`Invalid docs source file ${path.join(dir, f)}: ${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`);
      for (const s of parsed.data.sources) byId.set(s.id, s);
    }
  }
  return [...byId.values()];
}

export interface DocPage {
  sourceId: string;
  sourceTitle: string;
  kind: DocSource["kind"];
  /** Doc-set version: "latest", "1.21.1", "1.21.x", or "any" for version-independent docs. */
  version: string;
  topics: string[];
  repoPath: string;
  url: string;
  fallbackUrl?: string;
  title: string;
  sections: DocSection[];
}
export interface DocSection {
  heading: string;
  anchor: string;
  text: string;
  code: string[];
}

const DOCS_TTL_MS = 24 * 3600_000;

/** Fills a URL template: $1..$9, {page}, {page:url} (percent-encoded segments), {pad2:$n}; collapses accidental double slashes. */
export function fillUrl(tpl: string, m: RegExpMatchArray, page: string): string {
  let out = tpl.replace(/\{pad2:\$(\d)\}/g, (_, d) => (m[Number(d)] ?? "").padStart(2, "0"));
  out = out.replace(/\{page:url\}/g, page.split("/").map(encodeURIComponent).join("/")).replace(/\{page\}/g, page).replace(/\$(\d)/g, (_, d) => m[Number(d)] ?? "");
  return out.replace(/([^:])\/{2,}/g, "$1/");
}

function pageOf(m: RegExpMatchArray): string {
  // the last group is the page path (without extension)
  const last = m[m.length - 1] ?? "";
  return last.replace(/(^|\/)(index|README)$/i, "");
}

export function slug(h: string): string {
  return h
    .replace(/&#?\w+;/g, "")
    .toLowerCase()
    .replace(/<[^>]+>/g, "")
    .replace(/[`*_~[\]()]/g, "")
    .replace(/[^\p{L}\p{N}\s-]/gu, "")
    .trim()
    .replace(/\s+/g, "-");
}

/** DokuWiki section id (as rendered by DokuWiki: "Effects & Use-Cases" -> "effects_use-cases"). */
export function dokuSlug(h: string): string {
  return h
    .toLowerCase()
    .replace(/[^a-z0-9_.-]+/g, "_")
    .replace(/_+/g, "_")
    .replace(/^[_.-]+|[_.-]+$/g, "");
}

/** Convert DokuWiki markup to the Markdown subset parseMarkdown understands (headings, code, links, inline code). */
export function dokuwikiToMarkdown(src: string): string {
  const out: string[] = [];
  const lines = src.replace(/\r\n/g, "\n").split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const code = /^\s*<(code|file)\b[^>]*>(.*)$/.exec(line);
    if (code) {
      const end = new RegExp(`</${code[1]}>`);
      const buf: string[] = [];
      let rest = code[2]!;
      while (!end.test(rest) && i + 1 < lines.length) {
        if (rest.trim()) buf.push(rest);
        rest = lines[++i]!;
      }
      const before = rest.split(end)[0]!;
      if (before.trim()) buf.push(before);
      out.push("```", ...buf, "```");
      continue;
    }
    const h = /^\s*(={2,6})\s*(.+?)\s*={2,6}\s*$/.exec(line);
    if (h) {
      const level = Math.min(4, 7 - h[1]!.length);
      out.push(`${"#".repeat(level)} ${inlineDoku(h[2]!)} {#${dokuSlug(h[2]!)}}`);
      continue;
    }
    out.push(inlineDoku(line));
  }
  return out.join("\n");
}

function inlineDoku(s: string): string {
  return s
    .replace(/\[\[[^\]|]*\|([^\]]*)\]\]/g, "$1")
    .replace(/\[\[([^\]]*)\]\]/g, "$1")
    .replace(/''(.+?)''/g, "`$1`")
    .replace(/(^|[^:])\/\/(.+?)\/\//g, "$1$2")
    .replace(/^FIXME\s*/, "")
    .replace(/\\\\\s*$/, "");
}

/** Strip front matter and MDX/HTML noise, then split into heading sections (code blocks kept separately). */
export function parseMarkdown(src: string): { title?: string; frontTitle?: string; sections: DocSection[] } {
  let body = src.replace(/\r\n/g, "\n");
  let frontTitle: string | undefined;
  const fm = /^---\n([\s\S]*?)\n---\n/.exec(body);
  if (fm) {
    const t = /^title:\s*(.+)$/m.exec(fm[1]!);
    if (t) frontTitle = t[1]!.trim().replace(/^["']|["']$/g, "");
    body = body.slice(fm[0].length);
  }
  const sections: DocSection[] = [];
  let cur: DocSection = { heading: "", anchor: "", text: "", code: [] };
  let title: string | undefined;
  const lines = body.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const fence = /^\s*(```|~~~)/.exec(line);
    if (fence) {
      const buf: string[] = [];
      for (i++; i < lines.length && !lines[i]!.trimStart().startsWith(fence[1]!); i++) buf.push(lines[i]!);
      const code = buf.join("\n").trim();
      if (code) cur.code.push(code);
      cur.text += ` ${code}\n`;
      continue;
    }
    const h = /^(#{1,4})\s+(.+?)\s*#*\s*$/.exec(line);
    if (h) {
      if (cur.text.trim() || cur.heading) sections.push(cur);
      const raw = h[2]!;
      const explicit = /\{#([\w.-]+)\}\s*$/.exec(raw);
      const heading = raw.replace(/\s*\{#[\w.-]+\}\s*$/, "").replace(/<[^>]+>/g, "").replace(/&#?\w+;/g, "").trim();
      if (h[1] === "#" && !title) title = heading;
      cur = { heading, anchor: explicit ? explicit[1]! : slug(heading), text: "", code: [] };
      continue;
    }
    if (/^\s*(import|export)\s.+from\s/.test(line)) continue;
    cur.text += `${line.replace(/<[^>]+>/g, " ")}\n`;
  }
  if (cur.text.trim() || cur.heading) sections.push(cur);
  return { title, frontTitle, sections };
}

export class DocsStore {
  private pages = new Map<string, Promise<DocPage[]>>();
  constructor(
    private readonly config: FfnConfig,
    private readonly http: (url: string, init?: RequestInit) => Promise<Response> = fetch,
  ) {}

  private get dir(): string {
    return path.join(this.config.cacheDir, "docs");
  }

  private headers(github = false): Record<string, string> {
    const h: Record<string, string> = { "User-Agent": this.config.userAgent };
    if (github && process.env.GITHUB_TOKEN) h.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
    return h;
  }

  /** Cached download with TTL; on network failure a stale copy is used (reported in warnings). */
  private async cached(url: string, file: string, warnings: string[], github = false): Promise<Buffer> {
    const p = path.join(this.dir, file);
    const fresh = existsSync(p) && Date.now() - (await stat(p)).mtimeMs < DOCS_TTL_MS;
    if (fresh || (this.config.offline && existsSync(p))) return readFile(p);
    if (this.config.offline) throw new Error(`Offline mode and ${url} is not cached.`);
    try {
      const res = await this.http(url, { headers: this.headers(github) });
      if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
      const buf = Buffer.from(await res.arrayBuffer());
      await mkdir(path.dirname(p), { recursive: true });
      await writeFile(`${p}.tmp`, buf);
      await rename(`${p}.tmp`, p);
      return buf;
    } catch (e) {
      if (existsSync(p)) {
        warnings.push(`Using a stale cached copy of ${url}: ${(e as Error).message}`);
        return readFile(p);
      }
      throw e;
    }
  }

  /** Raw files of a githubTree source, content-addressed by blob sha (never re-downloaded unless changed). */
  private async treeFiles(src: DocSource, warnings: string[]): Promise<Map<string, string>> {
    const { repo, branch } = src.githubTree!;
    const tree = JSON.parse(
      (await this.cached(`https://api.github.com/repos/${repo}/git/trees/${encodeURIComponent(branch)}?recursive=1`, `${src.id}.tree.json`, warnings, true)).toString("utf8"),
    ) as { tree?: { path: string; type: string; sha: string }[]; truncated?: boolean };
    if (!tree.tree) throw new Error(`GitHub returned no tree for ${repo}@${branch}`);
    if (tree.truncated) warnings.push(`GitHub truncated the file tree of ${repo}; some pages may be missing.`);
    const rules = src.files.map((f) => new RegExp(f.match));
    const wanted = tree.tree.filter((t) => t.type === "blob" && rules.some((r) => r.test(t.path)));
    const out = new Map<string, string>();
    const queue = [...wanted];
    const worker = async () => {
      for (let t = queue.shift(); t; t = queue.shift()) {
        const p = path.join(this.dir, "blobs", `${t.sha}.md`);
        if (existsSync(p)) {
          out.set(t.path, await readFile(p, "utf8"));
          continue;
        }
        if (this.config.offline) continue;
        try {
          const res = await this.http(`https://raw.githubusercontent.com/${repo}/${encodeURIComponent(branch)}/${t.path.split("/").map(encodeURIComponent).join("/")}`, { headers: this.headers() });
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          const text = await res.text();
          await mkdir(path.dirname(p), { recursive: true });
          await writeFile(p, text);
          out.set(t.path, text);
        } catch (e) {
          warnings.push(`Could not fetch ${repo}/${t.path}: ${(e as Error).message}`);
        }
      }
    };
    await Promise.all(Array.from({ length: 12 }, worker));
    return out;
  }

  private async zipFiles(src: DocSource, warnings: string[]): Promise<Map<string, string>> {
    await this.cached(src.zip!, `${src.id}.zip`, warnings);
    const zip = new ZipDir(path.join(this.dir, `${src.id}.zip`));
    const rules = src.files.map((f) => new RegExp(f.match));
    const out = new Map<string, string>();
    for (const name of zip.entries.keys()) {
      const rel = name.replace(/^[^/]+\//, ""); // strip the "<repo>-<branch>/" archive prefix
      if (!rel || rel.endsWith("/") || !rules.some((r) => r.test(rel))) continue;
      out.set(rel, zip.read(name)?.toString("utf8") ?? "");
    }
    return out;
  }

  /** Shallow clone of a git repository, refreshed after the TTL; a stale clone is used when the fetch fails. */
  private async gitFiles(src: DocSource, warnings: string[]): Promise<Map<string, string>> {
    const { url, branch } = src.git!;
    const dir = path.join(this.dir, "git", src.id);
    const stamp = path.join(this.dir, "git", `${src.id}.stamp`);
    const have = existsSync(path.join(dir, ".git"));
    const fresh = have && existsSync(stamp) && Date.now() - (await stat(stamp)).mtimeMs < DOCS_TTL_MS;
    if (!have && this.config.offline) throw new Error(`Offline mode and ${url} is not cached.`);
    if (!fresh && !this.config.offline) {
      try {
        if (have) {
          await git(["-C", dir, "fetch", "-q", "--depth", "1", "origin", ...(branch ? [branch] : [])]);
          await git(["-C", dir, "reset", "-q", "--hard", "FETCH_HEAD"]);
        } else {
          await rm(dir, { recursive: true, force: true });
          await mkdir(path.dirname(dir), { recursive: true });
          await git(["clone", "-q", "--depth", "1", ...(branch ? ["--branch", branch] : []), url, dir]);
        }
        const now = new Date();
        await writeFile(stamp, now.toISOString()).then(() => utimes(stamp, now, now));
      } catch (e) {
        if (!have) {
          // git is optional: GitHub wikis can be crawled page by page over HTTPS
          const wiki = /github\.com\/([^/]+)\/([^/]+?)\.wiki(?:\.git)?$/.exec(url);
          if (wiki) {
            const files = await this.crawlGithubWiki(src, wiki[1]!, wiki[2]!, warnings);
            warnings.push(`git unavailable (${(e as Error).message.split("\n")[0]}); crawled ${files.size} wiki page(s) over HTTPS instead.`);
            return files;
          }
          throw new Error(`git clone ${url} failed (is git installed?): ${(e as Error).message.split("\n")[0]}`);
        }
        warnings.push(`Using a stale clone of ${url}: ${(e as Error).message.split("\n")[0]}`);
      }
    }
    const rules = src.files.map((f) => new RegExp(f.match));
    const out = new Map<string, string>();
    const walk = async (rel: string): Promise<void> => {
      for (const e of await readdir(path.join(dir, rel), { withFileTypes: true })) {
        if (e.name === ".git") continue;
        const r = rel ? `${rel}/${e.name}` : e.name;
        if (e.isDirectory()) await walk(r);
        else if (rules.some((x) => x.test(r))) out.set(r, await readFile(path.join(dir, r), "utf8"));
      }
    };
    await walk("");
    return out;
  }

  /** GitHub wiki without git: raw pages from raw.githubusercontent.com/wiki, following wiki links from Home and _Sidebar. */
  private async crawlGithubWiki(src: DocSource, owner: string, repo: string, warnings: string[], maxPages = 300): Promise<Map<string, string>> {
    const rules = src.files.map((f) => new RegExp(f.match));
    const out = new Map<string, string>();
    const seen = new Set<string>(["Home", "_Sidebar"]);
    const queue = ["Home", "_Sidebar"];
    const linkRe = new RegExp(`github\\.com/${owner}/${repo}/wiki/([^)\\s#"'>]+)|\\[\\[(?:[^\\]|]*\\|)?([^\\]]+)\\]\\]`, "gi");
    const worker = async () => {
      for (let page = queue.shift(); page !== undefined; page = queue.shift()) {
        let text: string;
        try {
          text = (await this.cached(`https://raw.githubusercontent.com/wiki/${owner}/${repo}/${encodeURIComponent(page)}.md`, path.join(`${src.id}-http`, `${page.replace(/[^\w.-]+/g, "_")}.md`), [])).toString("utf8");
        } catch {
          continue; // missing page
        }
        if (rules.some((r) => r.test(`${page}.md`))) out.set(`${page}.md`, text);
        for (const m of text.matchAll(linkRe)) {
          const next = decodeURIComponent(m[1] ?? m[2]!.trim().replace(/ /g, "-"));
          if (!seen.has(next) && seen.size < maxPages) seen.add(next), queue.push(next);
        }
      }
    };
    // a few workers; each re-checks the queue, so pages found late are still fetched
    for (let round = 0; round < 50 && queue.length; round++) await Promise.all(Array.from({ length: 4 }, worker));
    if (!out.size) warnings.push(`No pages found in the ${owner}/${repo} wiki.`);
    return out;
  }

  /** DokuWiki pages: ids from the sitemap that match a rule, raw markup via do=export_raw (each cached with the TTL). */
  private async dokuwikiFiles(src: DocSource, warnings: string[]): Promise<Map<string, string>> {
    const base = src.dokuwiki!.base.replace(/\/+$/, "");
    let xml = await this.cached(`${base}/doku.php?do=sitemap`, `${src.id}.sitemap`, warnings);
    if (xml[0] === 0x1f && xml[1] === 0x8b) xml = gunzipSync(xml);
    const ids = [...xml.toString("utf8").matchAll(/<loc>([^<]+)<\/loc>/g)]
      .map((m) => decodeURIComponent(m[1]!.trim().slice(base.length + 1)).replace(/^doku\.php\?id=/, ""))
      .filter((id) => src.files.some((f) => new RegExp(f.match).test(id)));
    const out = new Map<string, string>();
    const queue = [...new Set(ids)];
    const worker = async () => {
      for (let id = queue.shift(); id; id = queue.shift()) {
        try {
          const raw = await this.cached(`${base}/${id.split(":").map(encodeURIComponent).join(":")}?do=export_raw`, path.join(src.id, `${id.replace(/[^\w.-]+/g, "_")}.txt`), warnings);
          out.set(id, raw.toString("utf8"));
        } catch (e) {
          warnings.push(`Could not fetch ${base}/${id}: ${(e as Error).message}`);
        }
      }
    };
    await Promise.all(Array.from({ length: 6 }, worker));
    return out;
  }

  private files(src: DocSource, warnings: string[]): Promise<Map<string, string>> {
    if (src.zip) return this.zipFiles(src, warnings);
    if (src.githubTree) return this.treeFiles(src, warnings);
    if (src.git) return this.gitFiles(src, warnings);
    return this.dokuwikiFiles(src, warnings);
  }

  async load(src: DocSource, warnings: string[]): Promise<DocPage[]> {
    let p = this.pages.get(src.id);
    if (!p) {
      p = (async () => {
        const files = await this.files(src, warnings);
        const pages: DocPage[] = [];
        for (const [repoPath, text] of files) {
          for (const rule of src.files) {
            const m = repoPath.match(new RegExp(rule.match));
            if (!m) continue;
            let version = rule.version ? rule.version.replace(/\$(\d)/g, (_, d) => m[Number(d)] ?? "") : "";
            if (rule.versionFromContent) {
              const vm = new RegExp(rule.versionFromContent, "m").exec(text);
              if (!vm) break; // e.g. a blog post that is not a version announcement
              version = vm[1]!;
            }
            const md = parseMarkdown(src.dokuwiki ? dokuwikiToMarkdown(text) : text);
            const page = pageOf(m);
            const name = page.split(/[/:]/).pop() || repoPath;
            pages.push({
              sourceId: src.id,
              sourceTitle: src.title,
              kind: src.kind,
              version: src.versioned ? version || "latest" : "any",
              topics: [...new Set([...src.topics, ...(rule.topics ?? [])])],
              repoPath,
              url: fillUrl(rule.url, m, page),
              fallbackUrl: rule.fallbackUrl ? fillUrl(rule.fallbackUrl, m, page) : undefined,
              title: src.titleFromName ? name.replace(/-/g, " ").replace(/ {3}/g, " - ") : (md.frontTitle ?? md.title ?? name),
              sections: md.sections,
            });
            break;
          }
        }
        return pages;
      })();
      this.pages.set(src.id, p);
      p.catch(() => this.pages.delete(src.id));
    }
    return p;
  }

  private verified = new Map<string, Promise<boolean | undefined>>();
  /**
   * true: the URL answers 2xx (cached per process and on disk for the docs TTL); false: the page is gone
   * (404/410); undefined: could not tell (offline, network error, other status).
   */
  async verifyUrl(url: string): Promise<boolean | undefined> {
    if (this.config.offline) return undefined;
    let v = this.verified.get(url);
    if (!v) {
      v = (async () => {
        const file = path.join(this.dir, "verified.json");
        let db: Record<string, number> = {};
        try {
          db = JSON.parse(await readFile(file, "utf8")) as Record<string, number>;
        } catch {
          /* first run */
        }
        if (db[url] && Date.now() - db[url]! < DOCS_TTL_MS * 7) return true;
        try {
          let res = await this.http(url, { method: "HEAD", headers: this.headers(), redirect: "follow" });
          if (res.status === 405 || res.status === 403) res = await this.http(url, { headers: this.headers(), redirect: "follow" });
          if (!res.ok) return res.status === 404 || res.status === 410 ? false : undefined;
          try {
            db = JSON.parse(await readFile(file, "utf8")) as Record<string, number>;
          } catch {
            /* ignore */
          }
          db[url] = Date.now();
          await mkdir(this.dir, { recursive: true });
          await writeFile(file, JSON.stringify(db));
          return true;
        } catch {
          return undefined;
        }
      })();
      this.verified.set(url, v);
    }
    return v;
  }
}

const execFileP = promisify(execFile);
async function git(args: string[]): Promise<void> {
  await execFileP("git", args, { timeout: 120_000, env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } });
}

// ---------------------------------------------------------------- version selection

/** Does a doc-set version label cover a Minecraft version? ("1.21.x" covers 1.21 and 1.21.4). */
export function versionCovers(label: string, mc: string): boolean {
  if (label === mc) return true;
  if (label.endsWith(".x")) {
    const base = label.slice(0, -2);
    return mc === base || mc.startsWith(`${base}.`);
  }
  return false;
}

function numericKey(label: string): string {
  return label.endsWith(".x") ? label.slice(0, -2) : label;
}

export interface SetChoice {
  version: string;
  exact: boolean;
  note?: string;
}

/**
 * Pick the doc set of one source for a Minecraft version: an exact/wildcard match; else "latest" when the
 * version is newer than every numbered set; else the closest older set (or the oldest one) with a note.
 */
export function chooseSet(versions: string[], mc: string | undefined, sourceTitle: string): SetChoice | null {
  const uniq = [...new Set(versions)];
  if (!uniq.length) return null;
  const numbered = uniq.filter((v) => v !== "latest" && parseMcVersion(numericKey(v))).sort((a, b) => compareMcVersions(numericKey(a), numericKey(b)));
  const hasLatest = uniq.includes("latest");
  if (!mc) return { version: hasLatest ? "latest" : numbered[numbered.length - 1]!, exact: true };
  const hit = uniq.find((v) => versionCovers(v, mc));
  if (hit) return { version: hit, exact: true };
  if (!parseMcVersion(mc)) return hasLatest ? { version: "latest", exact: false, note: `${sourceTitle}: could not parse ${mc}; searched the latest docs.` } : null;
  const newest = numbered[numbered.length - 1];
  if (hasLatest && (!newest || compareMcVersions(mc, numericKey(newest)) > 0))
    return { version: "latest", exact: true };
  const older = numbered.filter((v) => compareMcVersions(numericKey(v), mc) <= 0);
  const pick = older[older.length - 1] ?? numbered[0];
  if (!pick) return hasLatest ? { version: "latest", exact: false } : null;
  return { version: pick, exact: false, note: `${sourceTitle} has no docs for ${mc}; closest set: ${pick}.` };
}

// ---------------------------------------------------------------- ranking

const STOP = new Set("a an the and or of to in on for with is are be how do i my what when which use using from by it this that as at can".split(" "));
export function tokens(s: string): string[] {
  return (s.toLowerCase().match(/[\p{L}\p{N}_]+/gu) ?? []).filter((t) => t.length > 1 && !STOP.has(t));
}
function identTokens(s: string): string[] {
  const out: string[] = [];
  for (const m of s.match(/[A-Za-z][A-Za-z0-9]*/g) ?? []) {
    const parts = m.split(/(?<=[a-z0-9])(?=[A-Z])/).map((p) => p.toLowerCase());
    if (parts.length > 1) out.push(...parts);
  }
  return out;
}

export interface DocHit {
  page: DocPage;
  section: DocSection;
  score: number;
}

export function rank(pages: DocPage[], query: string, boost: (p: DocPage) => number): DocHit[] {
  const q = [...new Set([...tokens(query), ...identTokens(query)])];
  if (!q.length) return [];
  const docs: { page: DocPage; section: DocSection; tf: Map<string, number>; len: number; head: Set<string> }[] = [];
  for (const page of pages)
    for (const section of page.sections) {
      const all = [...tokens(section.text), ...identTokens(section.text)];
      const tf = new Map<string, number>();
      for (const t of all) tf.set(t, (tf.get(t) ?? 0) + 1);
      const head = new Set([...tokens(`${page.title} ${section.heading}`), ...identTokens(`${page.title} ${section.heading}`)]);
      docs.push({ page, section, tf, len: all.length || 1, head });
    }
  const N = docs.length;
  const avg = docs.reduce((s, d) => s + d.len, 0) / Math.max(1, N);
  const df = new Map<string, number>();
  for (const t of q) df.set(t, docs.filter((d) => d.tf.has(t) || d.head.has(t)).length);
  const k1 = 1.2;
  const b = 0.75;
  const phrase = query.toLowerCase().trim();
  const bare = phrase.replace(/[^a-z0-9]/g, "");
  const hits: DocHit[] = [];
  for (const d of docs) {
    let s = 0;
    let matched = 0;
    for (const t of q) {
      const n = df.get(t) ?? 0;
      if (!n) continue;
      const idf = Math.log(1 + (N - n + 0.5) / (n + 0.5));
      const f = d.tf.get(t) ?? 0;
      if (f || d.head.has(t)) matched++;
      s += idf * ((f * (k1 + 1)) / (f + k1 * (1 - b + (b * d.len) / avg)));
      if (d.head.has(t)) s += idf * 1.5;
    }
    if (!s) continue;
    s *= 0.5 + matched / q.length; // prefer sections matching more distinct terms
    if (phrase.length > 3 && `${d.section.heading}\n${d.section.text}`.toLowerCase().includes(phrase)) s *= 1.5;
    // the page that is named after the query (e.g. "WrapOperation" for "@WrapOperation") is the canonical answer
    if (bare.length > 3 && d.page.title.toLowerCase().replace(/[^a-z0-9]/g, "") === bare) s *= d.section.heading === "" || d.section.heading === d.page.title ? 2 : 1.3;
    hits.push({ page: d.page, section: d.section, score: s * boost(d.page) });
  }
  return hits.sort((a, b2) => b2.score - a.score);
}

/** A ~maxLen window of the section text around the densest cluster of query terms. */
export function snippet(text: string, query: string, maxLen = 320): string {
  // markdown links cost tokens and carry no meaning in a snippet: keep their text only
  const clean = text.replace(/\[([^\]]*)\]\([^)]*\)/g, "$1").replace(/\s+/g, " ").trim();
  if (clean.length <= maxLen) return clean;
  const q = [...tokens(query), ...identTokens(query)];
  const lower = clean.toLowerCase();
  let best = 0;
  let bestScore = -1;
  for (let i = 0; i < clean.length; i += 40) {
    const win = lower.slice(i, i + maxLen);
    const sc = q.reduce((s, t) => s + (win.includes(t) ? 1 : 0), 0);
    if (sc > bestScore) {
      bestScore = sc;
      best = i;
    }
  }
  const start = Math.max(0, best - 20);
  return `${start > 0 ? "…" : ""}${clean.slice(start, start + maxLen).trim()}${start + maxLen < clean.length ? "…" : ""}`;
}
