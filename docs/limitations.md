# FFN — known limitations


- `source: "loader"` needs a published official MDK for that version (not yet for Forge 26.x); the first run takes 1–2.5 minutes of Gradle setup.
- Text search over decompiled code cannot find comments, and Vineflower's local variable names may differ from the sources jar; one call decompiles at most 40 candidate classes (call again to continue).
- `check_profiles` compares only what the references publish. For example, the Forge 1.20.1 MDK has no Gradle wrapper in `mdk/`, and newer Forge branches may not be found.
- `docs_search` Mixin wikis: with `git` FFN shallow-clones them; without it it crawls the rendered wiki from Home/_Sidebar, which reaches only linked pages (17 of 19 Mixin wiki pages). Fabric wiki pages are DokuWiki markup converted heuristically (headings, code, links).
- `docs_search`: Fabric docs pull code from `reference/` files (`@[code]` includes); those snippets show as include
  markers, not code. Forge has no 26.x docs, so the closest set (1.21.x) is used and every such result is labelled `FALLBACK`.
- `@Local` / `@ModifyVariable` name checks need a local variable table, which Mojang jars do not have; checks are not scope-aware at the injection point (a local declared later in the method still matches). MixinExtras expressions are not checked.
- Windows and macOS support is unit-tested with simulated platforms and covered by CI, but was not run on real machines here. The Architectury layout is covered by fixture tests, not by a compiled template.
- FFN does not launch the game; runtime behaviour is checked by running it yourself.
- `get_class method=…` finds methods in the source with a lightweight brace-matching parser; overloads are matched by simple parameter type names.
