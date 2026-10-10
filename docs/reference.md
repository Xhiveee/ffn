# FFN — reference

Detailed behaviour of the tools. Short overview: [README](../README.md).

## Tools

| Tool | Status | What it does |
|---|---|---|
| `list_versions` | ✅ | Minecraft releases (optionally snapshots) with loader availability; for one version: Fabric Loader / Fabric API / Yarn, Forge recommended/latest, NeoForge stable/beta, Parchment, Java, recommended Gradle plugin per loader |
| `get_profile` | ✅ | Resolved profile for `(mcVersion, loader)`: Java, Gradle + plugin, metadata file, mappings, Mixin registration/refmap/MixinExtras/max compatibility level, with extrapolation warnings |
| `gradle_build` | ✅ | Runs Gradle tasks with an automatically chosen JDK, timeout and full log; returns structured findings (javac `file:line` errors, Mixin AP, dependency resolution, JVM/toolchain mismatch…) |
| `analyze_crash` | ✅ | Crash report / log analysis: root exception, Mixin failures, missing/duplicate mods, class-version problems; scores the most likely culprit mod |
| `search_mc_source` | ✅ | Class/member search (names, descriptors), **usages** (`kind: "usages"`: who calls a method / reads a field / references a class, from bytecode), **callees** (`kind: "callees"`, `query: Class#method[(desc)]`: what the method calls / reads / writes / passes as a method reference, lambda bodies followed and marked `(lambda)`), **package browsing** (`kind: "packages"`, `query`: package, a unique suffix like `level.block`, or `.` for the root: subpackages with class counts, then top-level classes with `interface`/`enum`/`record`/`abstract`; 100 per page) and text search in sources of the exact MC version: vanilla, as seen by the project, or Forge/NeoForge-patched without a project (`source: "loader"`). Text search works without a sources jar (classes are decompiled lazily, in batches). One line per hit, 30 per page (`offset`/`limit`), snippets clipped |
| `get_class` | ✅ | **Outline by default**: header (super, interfaces, annotations), fields and method signatures with compact JVM descriptors (= ready Mixin selectors), no bodies; `members`/`memberFilter` filters. `method` returns just that method's source (overloads capped at 5). `detail: "hierarchy"` returns super chain, all interfaces and subtypes; with `method`, where it is overridden. `detail: "full"` returns source paged by lines (300 by default) with a "more" hint. Source comes from the loader's sources jar or Vineflower |
| `translate_mapping` | ✅ | Class/method/field names across Mojmap ↔ Yarn ↔ Intermediary ↔ SRG ↔ obfuscated (identity on unobfuscated 26.x+) |
| `mixin_targets` | ✅ | **Loader event hints first**, then the class's method selectors (paged). With `methodFilter` (≤3 matches) or `injectionPoints: true`: concise injection points from bytecode (`HEAD \| RETURN ×n \| TAIL`, INVOKE/FIELD/NEW/CONSTANT targets deduped, `maxPoints` per kind, lambdas) |
| `mixin_validate` | ✅ | Checks mixin configs and classes against the real game classes (see below); every subproject of a multi-project build |
| `docs_search` | ✅ | Searches the official Fabric/Forge/NeoForge docs, the NeoForged version primers, Fabric's per-version announcements and **Mixin docs** (SpongePowered Mixin wiki, MixinExtras wiki, Fabric mixin docs/wiki pages; `topic: "mixin"` searches only those). Version-aware for loader docs; cached; returns short snippets, code and URLs that were checked to exist (pages whose URL returns 404 are skipped; results from a nearest-version fallback, e.g. Forge on 26.x, are labelled `FALLBACK`) |
| `check_profiles` | ✅ | Compares the profiles with the official Fabric example mod, NeoForge/Forge MDKs, Gradle and plugin metadata, and with Minecraft releases newer than `testedUpTo`; reports outdated/unverified items and suggests user-profile YAML patches (never applied) |

## Your project (no FFN files needed)

FFN does not create projects: start from the official MDK (Fabric example mod, NeoForge MDKs, Forge MDK zip) and
pass its directory as `projectDir`. `gradle_build`, `mixin_validate`, the project source index (`source: "project"`
of `search_mc_source` / `get_class` / `mixin_targets`) and `docs_search` read the project's own files:

| What | Read from (first match wins) |
|---|---|
| Loader | Gradle plugin in `build.gradle(.kts)` / `settings.gradle(.kts)`: Loom (`fabric-loom`, `net.fabricmc.fabric-loom[-remap]`) → Fabric; `net.neoforged.moddev.legacyforge` → NeoForge if `neo_version` / `net.neoforged:forge`, else Forge; `net.neoforged.moddev` / `net.neoforged.gradle.*` → NeoForge; `net.minecraftforge.gradle` → Forge. Fallbacks: `fabric.mod.json`, then `neo_version` / `forge_version` in `gradle.properties` |
| Minecraft version | `gradle.properties` `minecraft_version` (or `mc_version`); else a literal `com.mojang:minecraft:<v>` dependency; else derived from the loader version (`neo_version=21.1.77` → 1.21.1, `26.3.0.x` → 26.3, `1.20.1-47.x` → 1.20.1); else `minecraft_version_range=[x]` |
| Mappings | Yarn: `yarn_mappings` or a `net.fabricmc:yarn:` dependency; Parchment: `mapping_channel=parchment`, `parchment_*` / `neogradle.subsystems.parchment.*` properties or a `parchment { }` block; otherwise Mojang mappings |
| Mod id | `mod_id`; else `fabric.mod.json` `id`; else `modId` in `mods.toml` / `neoforge.mods.toml`; else the `<id>.mixins.json` name |
| Mixin configs, sources | `*mixins*.json` under every `src/*/resources` (also one level of subprojects), e.g. the Fabric example mod's `src/main` + `src/client` |
| Minecraft classes (project index) | the project's `compileClasspath` + `clientCompileClasspath` (asked from Gradle once, cached in `.ffn/classpath.json`); Loom's split `minecraft-common` + `minecraft-clientOnly` jars are merged so client targets resolve |

Comments in build scripts are ignored (MDK comments that mention `parchment` do not switch mappings), and template
placeholders such as `${project.minecraft_version}` or `@MC_VERSION@` are never taken as versions. If detection fails,
the error says exactly which keys FFN looks for. A `.ffn/project.json` from older FFN versions is still honoured.
FFN writes only caches into the project (`.ffn/classpath.json`, `.ffn/logs/`).

**Multi-project builds** (MultiLoader-Template, Architectury): pass the root or any subproject. FFN reads
`settings.gradle(.kts)` `include(...)`, detects each subproject's loader (`common` = platform-neutral), runs Gradle from
the root with the subproject's task path (`:neoforge:compileJava`), resolves the classpath per subproject and validates
the mixin configs of every subproject. A common module's config counts as registered when the loader subprojects
register it; `${mod_id}` placeholders in registrations are resolved. For source tools pass `loader` to pick the
subproject whose classpath is used.

## Building

**JDK selection.** `gradle_build` picks the JDK itself: the required version is
`max(profile Java, minimum JVM of the Gradle plugin)`, e.g. Java 25 for Fabric Loom 1.18 even on 1.20.1.
The Gradle wrapper caps it: a JDK newer than the wrapper's Gradle can run on is never picked (MultiLoader 1.21.1 with
Gradle 8.10 builds on JDK 21, not 25). FFN looks in `JAVA_HOME`, `PATH`, `FFN_JDKS`, `~/.gradle/jdks`, `~/jdks`, SDKMAN,
asdf, `/usr/lib/jvm`; on macOS `/Library/Java/JavaVirtualMachines`, Homebrew and `java_home -V`; on Windows
`Program Files` vendor folders (Adoptium, Zulu, Microsoft, BellSoft, Amazon…) and the registry (`reg query`). All found
JDKs are passed to Gradle (`org.gradle.java.installations.paths`) so toolchains resolve without downloads. Pass
`javaHome` to override. On Windows `gradlew.bat` is run through `cmd.exe` with correct quoting.

**Logs and errors.** Every build writes `<project>/.ffn/logs/<task>-<time>.log`. The output is parsed into
findings with `kind`, `severity`, `file`/`line` where known and a suggestion; a timeout kills the whole process tree.

FFN does not launch Minecraft. Run the game yourself (e.g. `./gradlew runClient`) and pass the crash report
or log to `analyze_crash`.

## Source index and mappings

`search_mc_source`, `get_class`, `translate_mapping` and the Mixin tools share one index per version:

| Strategy (`source`) | What is indexed | When |
|---|---|---|
| `project` (default when `projectDir` is given) | The game jar on the project's compile classpath, exactly as the loader sees it (Forge/NeoForge patches, project mappings), plus its `-sources.jar` if present | FFN asks Gradle once (`ffnPrintClasspath`), caches the classpath in `.ffn/classpath.json` until build files change |
| `vanilla` | Mojang's client jar + the server jar from the bundler, merged; remapped with tiny-remapper to `mojmap`, `yarn` or `intermediary`; 26.x+ is used as is (unobfuscated) | No project, or `source: "vanilla"` |
| `loader` | The Forge/NeoForge-patched jar, without a project of yours: FFN unpacks the official MDK (Forge Maven `forge-<mc>-<v>-mdk.zip`, NeoForge `NeoForgeMDKs/MDK-<mc>-ModDevGradle`, else `-NeoGradle`) into `<cache>/loader-ws/` and indexes its classpath | `source: "loader"` + `loader`; first run 1–2.5 min (Gradle setup), then ≈ 1 s |

The index lives in `~/.cache/ffn/index/<mc>/<namespace>/` (`project/<hash>/` for projects). Building the
1.20.1 Mojmap index takes about 5 s. Classes without a sources jar are decompiled with Vineflower (about 1.5 s, then
cached). **Text search without a sources jar** prefilters classes by the literal words of the pattern in their constant
pools, then decompiles up to 40 candidates per call in batches (≈ 3 s for 20 classes, ≈ 1 s cached); results come in a
stable order and the answer says how to continue. **Navigation:** a constant-pool reference table (`refs.json`, built
once per index in ≈ 4 s) answers usages (`LivingEntity#hurt` → 66 call sites with their opcode, including calls via a
subclass), callees (`MinecraftServer#tickServer` → 27 deduped `call`/`get`/`put`/`ref` lines in < 1 s, overloads grouped when
no descriptor is given) and `get_class detail=hierarchy` gives supertypes, subtypes and overrides. `kind: "packages"` lists a
package from the class index (`net.minecraft.world.level.block` on 1.21.1: 4 subpackages, 292 classes).
Mappings: Mojang ProGuard files, Fabric Intermediary and Yarn (tiny v2) and MCPConfig (tsrg2), joined on obfuscated names.
SRG names are offered only where they are real (`m_N_` up to 1.20.x Forge).

## Mixin tooling

`mixin_validate` (whole project or one class) checks, against the real classes:

- config JSON, `package`, registration in `fabric.mod.json` / `mods.toml` / manifest / build script, refmap where the profile needs one;
- `compatibilityLevel` against the bundled Mixin version (`mixin.maxCompatibilityLevel` in the profile) and the project's Java;
- listed classes exist and unlisted `@Mixin` classes; targets exist; client-only targets in `"mixins"`;
- method selectors (overloads, inherited members, "did you mean", the other mapping's name), `@At` HEAD/RETURN/TAIL/INVOKE/FIELD/NEW against the bytecode (including calls that actually sit in a lambda);
- handler signatures for `@Inject` (CallbackInfo vs CallbackInfoReturnable, argument lists, static), `@Redirect`, `@ModifyArg`, `@ModifyVariable`, `@ModifyReturnValue`, `@ModifyExpressionValue`, `@WrapOperation`, `@WrapWithCondition`, `@WrapMethod`;
- `@Accessor` / `@Invoker` / `@Shadow` / `@Overwrite`, MixinExtras availability, and mixin methods that accidentally collide with a target method (a runtime "@Overwrite is required" crash);
- `@ModifyVariable(name=…)` and MixinExtras `@Local` (`ordinal`, `index`, `name`, type) against the target's local variable table when the jar has one (Mojang jars do not: then an info note, not an error).

Mixin classes are parsed with a real Java parser (`java-parser`, loaded on first use); annotation values are
constant-folded (`"a" + CONST`). On a syntax error FFN falls back to a tolerant parser and says so.

**Event hints.** `mixin_targets` first lists loader events/APIs that cover common needs (server tick, player
join, block break, damage, item tooltips, HUD rendering…) with the Fabric/Forge/NeoForge names. They live in
`profiles/hints/mixin-hints.yaml`; add or override hints in `<FFN_PROFILES_DIR>/hints/*.yaml`. The policy:
prefer events, then `@Inject`/MixinExtras wrappers, `@Redirect`/`@Overwrite` only as a last resort.

## Docs search (`docs_search`)

Sources are declared in `profiles/docs/sources.yaml`:

| Source | Fetched from | Page URLs |
|---|---|---|
| NeoForge docs (latest + versioned) | `neoforged/Documentation` (zip) | `docs.neoforged.net/docs/[version/]…` |
| NeoForged version primers | `neoforged/.github` `primers/<ver>` (zip) | `docs.neoforged.net/primer/docs/<ver>/` |
| Fabric docs (latest + versioned) | `FabricMC/fabric-docs` (git tree + raw files) | `docs.fabricmc.net/[version/]develop/…` (falls back to the GitHub file when the versioned page is not published) |
| Fabric announcements ("Fabric for Minecraft X") | `FabricMC/fabricmc.net` `_posts` | `fabricmc.net/yyyy/mm/dd/<slug>.html` |
| Forge docs 1.20.1 / 1.20.x / 1.21.x | `MinecraftForge/Documentation` branches (zip) | `docs.minecraftforge.net/en/<branch>/…` |
| SpongePowered Mixin wiki (topic `mixin`, any version) | `SpongePowered/Mixin.wiki.git` (shallow `git clone`) | `github.com/SpongePowered/Mixin/wiki/<Page>` |
| MixinExtras wiki (topic `mixin`, any version) | `LlamaLad7/MixinExtras.wiki.git` (shallow `git clone`) | `github.com/LlamaLad7/MixinExtras/wiki/<Page>` |
| Fabric wiki Mixin tutorials (topic `mixin`, any version, Fabric) | `wiki.fabricmc.net` DokuWiki: `doku.php?do=sitemap` → English `tutorial:mixin*` pages → `?do=export_raw` | `wiki.fabricmc.net/tutorial:mixin_…` (DokuWiki section anchors) |
| Fabric docs mixin pages (topic `mixin`, versioned) | the `develop/mixins/` pages of `FabricMC/fabric-docs` | `docs.fabricmc.net/[version/]develop/mixins/…` |

Pages are cached under `<cache>/docs` (24 h, stale copy used when offline) and split into heading sections. Results are
ranked with BM25 (camelCase identifiers are split). The doc set is chosen by version: exact or wildcard match, `latest` for
versions newer than every numbered set, otherwise the closest set, with a note. Primers and announcements up to the target
version are included, and closer versions rank higher. Every returned page URL is checked with HEAD/GET (cached) and is
marked `[UNVERIFIED URL]` if the check fails. Set `GITHUB_TOKEN` if the GitHub API rate limit is a problem.

**Topics and sources.** `topic: "mixin"` restricts the search to pages tagged `mixin` (a source's `topics`, or
`files[].topics` for a subset such as Fabric's `develop/mixins/`); `sources: ["mixin-wiki", …]` restricts it to source
ids. Mixin docs are **not tied to Minecraft versions** (`versioned: false`): they are always searched, are never
version-filtered, and are shown without a version label. With a topic, the doc set of versioned sources is chosen among
the pages that have that topic. Without a topic, Mixin wikis are still searched but rank slightly below loader docs.
Wikis are fetched with `git` (must be installed; a stale clone is used offline or when the fetch fails).

Example (`docs_search {query: "@Inject cancellable", topic: "mixin", limit: 2, includeCode: false}`, live):

```
2 result(s) for "@Inject cancellable" [topic mixin].
Searched: Fabric documentation [latest]; SpongePowered Mixin wiki [any version]; MixinExtras wiki [any version]; Fabric wiki (Mixin tutorials) [any version].

1. Cancellable — MixinExtras wiki
   https://github.com/LlamaLad7/MixinExtras/wiki/Cancellable
   Allows you to receive a cancellable `CallbackInfo` or `CallbackInfoReturnable` as appropriate from any kind of injector. …
2. Advanced Mixin Usage - Callback Injectors › 3. Cancellable Injections — SpongePowered Mixin wiki
   https://github.com/SpongePowered/Mixin/wiki/Advanced-Mixin-Usage---Callback-Injectors#3-cancellable-injections
   So far, our injections haven't altered the structure of the target method at all, … **Cancellable Injections** allow…
```

## Profile check (`check_profiles`)

Upstream references are declared in `profiles/checks/upstream.yaml` (URL + regex per value, `{mc}` placeholder):
fabric-example-mod (`gradle.properties`, wrapper), NeoForge MDKs (`NeoForgeMDKs/MDK-<mc>-ModDevGradle`), Forge
MDK (`mdk/` of the `<mc>` branch), plus `services.gradle.org` for the current Gradle release. For each loader the tool reports:

- Minecraft releases newer than `testedUpTo` (and whether the loader already has builds);
- the profile's Gradle pin vs the reference wrapper;
- the plugin version FFN resolves vs the reference (a `1.18-SNAPSHOT` reference is satisfied by any 1.18.x);
- intentional plugin deviations (e.g. ModDevGradle-legacy instead of ForgeGradle 6 for Forge 1.20.1);
- rules without a maintainer build (`verified`).

Suggested patches are user-profile YAML files to drop into `$FFN_PROFILES_DIR`. They are never written automatically.

## Architecture

```
src/
  index.ts              stdio entry point
  server.ts             McpServer + tool registration (add new tools here)
  services.ts           DI container: config, VersionService, profile loading, lookupProfile()
  config.ts             paths & env
  util/
    http.ts             CachingFetcher (TTL, stale-on-error, offline) behind a Fetcher interface
    mcversion.ts        MC version parsing/ordering (1.20.1, 1.21.11, 26.3, 26.4-snapshot-1, …)
    maven.ts            maven-metadata.xml parser
  sources/              one parser per official source (pure functions, fixture-tested)
    mojang.ts fabric.ts forge.ts neoforge.ts plugins.ts endpoints.ts index.ts(VersionService)
  profiles/
    schema.ts           zod schemas for profile files and resolved profiles
    loader.ts           loads built-in + user YAML, merges
    resolve.ts          rule matching ("since/until/when"), merging, extrapolation warnings
  jdk/                  JDK discovery and selection
  exec/                 process runner (timeouts, process groups)
  diagnostics/          log/crash parser → findings + culprit
  project/              detects loader / MC version / mappings / mod id from the project's own Gradle files and metadata
  index/                class-file reader, Java method extractor (javasrc.ts), mappings (ProGuard/tiny/tsrg), index store, tool jars, IndexService
  mixin/                Java annotation parser, validator, event hints
  tools/                one file per tool group (gradle, source, mixin, crash, docs, checkProfiles, …); result.ts = compact output + paging
profiles/               built-in YAML profiles (fabric/forge/neoforge.yaml) and hints/mixin-hints.yaml
test/                   vitest; fixtures are real responses captured from the official endpoints
```

### Version sources (all verified to respond)

| Data | Endpoint |
|---|---|
| MC versions | `https://piston-meta.mojang.com/mc/game/version_manifest_v2.json` (+ per-version JSON: `javaVersion.majorVersion`, `downloads.client_mappings`) |
| Fabric | `https://meta.fabricmc.net/v2/versions/{game,loader,yarn/<mc>}`, Fabric API `https://maven.fabricmc.net/net/fabricmc/fabric-api/fabric-api/maven-metadata.xml`, Loom `…/fabric-loom/maven-metadata.xml` |
| Forge | `https://maven.minecraftforge.net/net/minecraftforge/forge/maven-metadata.xml`, `https://files.minecraftforge.net/net/minecraftforge/forge/promotions_slim.json` |
| NeoForge | `https://maven.neoforged.net/releases/net/neoforged/neoforge/maven-metadata.xml`, 1.20.1: `…/net/neoforged/forge/maven-metadata.xml` |
| Parchment | `https://maven.parchmentmc.org/org/parchmentmc/data/parchment-<mc>/maven-metadata.xml` |
| Gradle plugins | ModDevGradle (maven.neoforged.net), ForgeGradle 6 (maven.minecraftforge.net), ForgeGradle 7 (plugins.gradle.org) |

### What the built-in profiles describe

These facts drive the JDK choice of `gradle_build`, the checks of `mixin_validate` (registration, refmap, compatibility level) and `get_profile`; `check_profiles` compares them with the official MDKs.

| Loader | MC | Build system | Metadata | Mixin wiring |
|---|---|---|---|---|
| Fabric | 1.20.1 – 1.21.11 (obfuscated) | Loom `net.fabricmc.fabric-loom-remap`, Mojmap / Parchment / Yarn | `fabric.mod.json` | `"mixins"` in fabric.mod.json, refmap by Loom |
| Fabric | 26.1+ (unobfuscated) | Loom `net.fabricmc.fabric-loom`, no remapping | `fabric.mod.json` | same, no refmap |
| Forge | 1.20.1 | ModDevGradle *legacyforge* | `META-INF/mods.toml` | `MixinConfigs` manifest + refmap via Mixin AP |
| Forge | 1.20.2 – 1.21.10 | ForgeGradle 6 | `META-INF/mods.toml` | manifest + `-mixin.config` dev arg (+ MixinGradle refmap ≤ 1.20.4) |
| Forge | 1.21.11+ | ForgeGradle 7 | `META-INF/mods.toml` | manifest + `--mixin.config` dev arg |
| NeoForge | 1.20.1 | ModDevGradle *legacyforge* (`net.neoforged:forge`) | `META-INF/mods.toml` | manifest + refmap |
| NeoForge | 1.20.2 – 1.20.4 | ModDevGradle (official 1.20.2 MDK: NeoGradle 7) | `META-INF/mods.toml` | `[[mixins]]` |
| NeoForge | 1.20.5+ | ModDevGradle | `META-INF/neoforge.mods.toml` | `[[mixins]]` |

## Development

```sh
npm run build && npm test
node scripts/smoke-stdio.mjs 1.21.1                                 # talk to dist/index.js over stdio
node scripts/call-tool.mjs mixin_validate '{"projectDir":"/path/to/mdk"}'  # call any tool in-process
```

## Adding a profile for a new Minecraft version

Usually **nothing is needed**: a new release is picked up from Mojang's manifest, Java and obfuscation are
read from Mojang's JSON, loader builds are found by version, and the newest rules apply (with an
`UNVERIFIED` warning until someone confirms it). When something really changed — say NeoForge for 27.1 moves
the metadata file — drop a YAML file into your user profiles directory:

```yaml
# ~/.config/ffn/profiles/neoforge-27.1.yaml
loader: neoforge
testedUpTo: "27.1"          # silences the UNVERIFIED warning up to this version
rules:
  - since: "27.1"           # "from 27.1 and up"; add `until:` to bound it
    description: NeoForge 27.1 renamed the metadata file
    verified: ["27.1"]
    set:
      gradle: { version: "9.9" }
      metadata:
        file: META-INF/neoforge.mods.toml
      addNotes: ["Checked against MDK-27.1-ModDevGradle"]
```

Rules are merged in order (built-ins first, then user files alphabetically): objects merge, arrays and
scalars replace, `addNotes` appends. Conditions: `since`, `until` (inclusive) and `when: { obfuscated: true|false }`.
Profiles are validated with zod; errors name the file and field. They are re-read on every call, so edits
apply without restarting the server. To contribute a rule upstream, add it to `profiles/<loader>.yaml`,
add a test in `test/profiles.test.ts`, and build the official MDK of that version with `gradle_build`.

Only when a loader adopts a **new build system** (e.g. a ForgeGradle 8) does FFN need code: add a value to
`BUILD_SYSTEMS` in `src/profiles/schema.ts` and its plugin id to the detection in `src/project/info.ts`.

## Roadmap

- ~~**M1 — foundation:** live versions, profiles.~~ ✅
- ~~**M2 — build, run, source & Mixin intelligence:** `gradle_build`, `analyze_crash`,
  source index + mappings, `mixin_targets` / `mixin_validate`.~~ ✅
- ~~**M3 — docs & deeper Mixin checks:** `docs_search`, `@At` CONSTANT/JUMP/LOAD/STORE/NEW and `@Slice` checks.~~ ✅
- ~~**M4 — profile check:** `check_profiles`.~~ ✅
- ~~**0.5 — token economy:** outline-first `get_class`, paging and caps everywhere; content/mixin generation removed.~~ ✅
- ~~**0.6 — Mixin docs:** Mixin / MixinExtras / Fabric mixin docs in `docs_search` (`topic`, `sources`); `run_client` / `run_server` removed.~~ ✅
- ~~**0.7 — bring your own project:** `create_project` removed; detection from MDK build files.~~ ✅
- ~~**0.8 — navigation & robustness:** usages/hierarchy/overrides, text search via lazy decompilation, `source: "loader"`, multi-project builds, real Java parser + LVT checks, pack format from `version.json`, docs 404/fallback labels, cross-platform JDK discovery, lazy tool loading (−27 % `tools/list` tokens).~~ ✅
- ~~**0.9 — code map:** `search_mc_source` `kind: "callees"` (reverse of usages, lambdas followed) and `kind: "packages"` (package browsing); +48 `tools/list` tokens, no new tool.~~ ✅
- **Next (proposal):** scope-aware `@Local` checks, MixinExtras expression checks.
