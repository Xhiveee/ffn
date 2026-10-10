import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

/**
 * Token economy: results are sent once, as text. The summary comes first; structured data (if any) follows on the
 * last line as compact JSON with empty values removed. No pretty-printing and no duplicate structuredContent.
 */
export function prune(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(prune).filter((x) => x !== undefined);
  if (v && typeof v === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
      const p = prune(x);
      if (p === undefined || p === null || p === "") continue;
      if (Array.isArray(p) && !p.length) continue;
      if (typeof p === "object" && !Array.isArray(p) && !Object.keys(p as object).length) continue;
      out[k] = p;
    }
    return out;
  }
  return v;
}

export function compactJson(data: unknown): string {
  return JSON.stringify(prune(data));
}

export function ok(summary: string, data?: unknown): CallToolResult {
  const text = data === undefined ? summary : `${summary}\n${compactJson(data)}`;
  return { content: [{ type: "text", text }] };
}

/** Plain-text result (preferred for listings: one item per line). */
export function okText(text: string): CallToolResult {
  return { content: [{ type: "text", text }] };
}

export function fail(message: string): CallToolResult {
  return { content: [{ type: "text", text: message }], isError: true };
}

export async function guard(fn: () => Promise<CallToolResult>): Promise<CallToolResult> {
  try {
    return await fn();
  } catch (e) {
    return fail(`Error: ${(e as Error).message}`);
  }
}

/** Slice a list for paging and describe what is left. */
export function page<T>(items: T[], offset = 0, limit = 50): { items: T[]; total: number; more?: string } {
  const slice = items.slice(offset, offset + limit);
  const rest = items.length - offset - slice.length;
  return { items: slice, total: items.length, ...(rest > 0 ? { more: `${rest} more — call again with offset=${offset + slice.length}` } : {}) };
}

/** Truncate long text with an ellipsis marker. */
export function clip(s: string, max: number): string {
  return s.length <= max ? s : `${s.slice(0, max - 1)}…`;
}
