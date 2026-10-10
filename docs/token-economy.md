# FFN — token economy


Minecraft classes are huge (decompiled `LivingEntity` ≈ 28k tokens on 1.20.1, ≈ 39k on 26.3), so every FFN tool
returns a compact, capped answer by default and tells the agent how to get more:

1. `get_class` → **outline** (signatures + selectors, no bodies, 200 members per page).
2. `get_class method="hurt"` → only that method's source (add a descriptor to pick one overload).
3. `get_class detail="full" offset=… limit=…` → raw source, 300 lines per page, only when really needed.

Other rules: results are plain text or one line of compact JSON (no pretty-printing, no duplicated
`structuredContent`, empty fields pruned); lists are paged with `offset`/`limit` and end with
`N more — call again with offset=…`; long messages, snippets and log tails are clipped. Per tool:
`search_mc_source` 30 hits, `mixin_targets` 100 selectors / 25 points per kind, `docs_search` 5 results,
`analyze_crash` and `gradle_build` 20 findings (log tail only on failure), `get_profile` / `check_profiles`
summaries unless `verbose: true`. The server instructions tell agents: outline first, then method.

Approximate tokens (characters / 4), measured with `scripts/measure-tokens.mjs` (0.4.1 → 0.5.0):

| Call | 0.4.1 | 0.5.0 |
|---|---|---|
| `get_class` LivingEntity 1.20.1 | 42,447 (members) / 100,929 (source) | 2,426 outline page · 5,168 whole outline · 1,110 `method=hurt` |
| `get_class` Entity 1.20.1 | 56,325 / 112,932 | 2,284 page · 6,528 whole outline |
| `get_class` Level 1.20.1 | 24,363 / 40,877 | 3,139 outline |
| `get_class` LivingEntity 26.3 | 59,282 / 136,965 | 2,550 page · 7,405 whole outline · 1,011 `method=hurtServer` · 4,072 first 300 source lines |
| `get_class` Entity 26.3 | 77,002 / 153,351 | 2,163 page · 9,322 whole outline |
| `get_class` Level 26.3 | 26,591 / 47,316 | 3,485 outline |
| `search_mc_source` "tick" | 4,797 | 491 |
| `mixin_targets` LivingEntity (26.3) | 49,459 | 1,583 |
| `mixin_targets` LivingEntity `tick` | 1,551 | 136 |
| `list_versions` | 2,044 | 282 |
| `get_profile` | 1,126 | 243 |
| `docs_search` | 9,008 | 1,257 |

Tool definitions and startup (`scripts/measure-startup.mjs`, median of 7 runs; 0.7.0 → 0.8.0, same 11 tools with more features):
`tools/list` 4,303 → 3,149 tokens, server instructions 392 → 206 tokens, start-up to first `tools/list` 339 → 246 ms,
RSS 92 → 76 MB. Tool modules and their dependencies (index, Java parser, Vineflower glue, docs) load on first call.
