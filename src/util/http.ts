import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile, rename } from "node:fs/promises";
import path from "node:path";

export interface FetchResult {
  body: string;
  /** Where the body came from. */
  source: "network" | "cache" | "stale-cache";
  fetchedAt: number;
  /** Set when a network error forced us to serve stale data. */
  warning?: string;
}

/** Abstraction over HTTP so version sources are testable with fixtures. */
export interface Fetcher {
  /**
   * @param ttlMs how long a cached copy counts as fresh. `Infinity` for immutable resources.
   */
  getText(url: string, opts?: { ttlMs?: number }): Promise<FetchResult>;
}

export class HttpError extends Error {
  constructor(
    public readonly url: string,
    public readonly status: number,
  ) {
    super(`HTTP ${status} for ${url}`);
  }
}

interface CacheEntry {
  url: string;
  fetchedAt: number;
  body: string;
}

/**
 * Fetcher with an on-disk cache:
 * - fresh cache hit -> no network
 * - stale/missing -> network; on failure fall back to stale cache with a warning
 * - offline mode -> cache only (any age)
 */
export class CachingFetcher implements Fetcher {
  constructor(
    private readonly opts: {
      cacheDir: string;
      defaultTtlMs: number;
      offline?: boolean;
      userAgent: string;
      timeoutMs?: number;
    },
  ) {}

  private cachePath(url: string): string {
    const h = createHash("sha256").update(url).digest("hex").slice(0, 32);
    return path.join(this.opts.cacheDir, "http", `${h}.json`);
  }

  private async readCache(url: string): Promise<CacheEntry | null> {
    try {
      const entry = JSON.parse(await readFile(this.cachePath(url), "utf8")) as CacheEntry;
      return entry.url === url ? entry : null;
    } catch {
      return null;
    }
  }

  private async writeCache(entry: CacheEntry): Promise<void> {
    const p = this.cachePath(entry.url);
    await mkdir(path.dirname(p), { recursive: true });
    const tmp = `${p}.${process.pid}.tmp`;
    await writeFile(tmp, JSON.stringify(entry));
    await rename(tmp, p);
  }

  async getText(url: string, o: { ttlMs?: number } = {}): Promise<FetchResult> {
    const ttl = o.ttlMs ?? this.opts.defaultTtlMs;
    const cached = await this.readCache(url);
    const now = Date.now();
    if (cached && (this.opts.offline || now - cached.fetchedAt < ttl)) {
      return { body: cached.body, source: "cache", fetchedAt: cached.fetchedAt };
    }
    if (this.opts.offline) {
      throw new Error(`Offline mode (FFN_OFFLINE) and no cached copy of ${url}`);
    }
    try {
      const res = await fetch(url, {
        headers: { "User-Agent": this.opts.userAgent, Accept: "*/*" },
        redirect: "follow",
        signal: AbortSignal.timeout(this.opts.timeoutMs ?? 20_000),
      });
      if (!res.ok) throw new HttpError(url, res.status);
      const body = await res.text();
      await this.writeCache({ url, fetchedAt: now, body }).catch(() => undefined);
      return { body, source: "network", fetchedAt: now };
    } catch (err) {
      // A 404 is an authoritative answer ("does not exist"), not a reason to serve stale data.
      if (err instanceof HttpError && err.status === 404) throw err;
      if (cached) {
        const ageH = ((now - cached.fetchedAt) / 3_600_000).toFixed(1);
        return {
          body: cached.body,
          source: "stale-cache",
          fetchedAt: cached.fetchedAt,
          warning: `Network fetch failed for ${url} (${(err as Error).message}); using cached copy from ${ageH}h ago.`,
        };
      }
      throw err;
    }
  }
}
