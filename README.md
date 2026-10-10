# FFN — ForgeFabricNeoForge MCP server

FFN is a [Model Context Protocol](https://modelcontextprotocol.io) server that helps AI assistants
build Minecraft mods for **Forge**, **Fabric** and **NeoForge**, from **Minecraft 1.20.1 up to the newest release**.

It is designed so that **new Minecraft versions need no code changes**:

- **Live version data, no hardcoded version lists.** Minecraft versions, Java requirements, loader builds,
  Fabric API, Yarn, Parchment and Gradle plugin versions are fetched at call time from the official sources
  and cached locally (with TTL and an offline fallback).
- **Facts are derived, not tabulated.** The required Java version comes from Mojang's per-version JSON;
  whether the game is obfuscated (and therefore whether remapping, Yarn, refmaps… apply) is derived from
  whether Mojang still publishes `client_mappings`; NeoForge ↔ Minecraft compatibility is computed from the
  NeoForge version number.
- **Everything else lives in declarative YAML profiles** (`profiles/*.yaml`) with "from version X and up"
  rules. A version newer than anything verified resolves to the closest lower rules and is flagged
  `UNVERIFIED`. Users can add or override rules in a config directory — no rebuild needed.

> Status: **0.4 (M4: multiloader projects, `check_profiles`)**. Porting tools (`mixin_port`, `port_mod`) were dropped from the plan.
> M3/M4 generated code is verified **by compilation only** (see [M3](#m3-verification-2026-10-10) / [M4 verification](#m4-verification-2026-10-10)); runtime loading is not verified.

---

## Tools

| Tool | Status | What it does |
|---|---|---|
| `list_versions` | ✅ | Minecraft releases (optionally snapshots) with loader availability; for one version: Fabric Loader / Fabric API / Yarn, Forge recommended/latest, NeoForge stable/beta, Parchment, Java, recommended Gradle plugin per loader |
| `get_profile` | ✅ | Resolved profile for `(mcVersion, loader)`: Java, Gradle + plugin, metadata file, mappings, Mixin registration/refmap/MixinExtras/max compatibility level, with extrapolation warnings |
| `create_project` | ✅ | Ready-to-build project: Gradle wrapper, `build.gradle`, `gradle.properties`, `settings.gradle`, loader metadata, main class, example Mixin + `<modid>.mixins.json` wired correctly for that loader/version, assets/data folders, `.ffn/project.json`. `layout: "multiloader"` creates `common/` + one build per loader (see [Multiloader projects](#multiloader-projects)) |
| `gradle_build` | ✅ | Runs Gradle tasks with an automatically chosen JDK, timeout and full log; returns structured findings (javac `file:line` errors, Mixin AP, dependency resolution, JVM/toolchain mismatch…) |
| `run_client` | ✅ | Starts the game client (headless via Xvfb when there is no display). `mode: "smoke"` waits for "mod loaded + main menu reached" (plus your own `waitFor` regexes), then stops and reports PASS/FAIL |
| `run_server` | ✅ | Starts the dedicated server. **Requires `acceptEula: true`** (see [EULA](#minecraft-eula)); smoke mode waits for `Done (…)!` |
| `analyze_crash` | ✅ | Crash report / log analysis: root exception, Mixin failures, missing/duplicate mods, class-version problems; scores the most likely culprit mod |
| `search_mc_source` | ✅ | Class/member search (names, descriptors) and text search in sources of the exact MC version, vanilla or as seen by the project (loader patches included) |
| `get_class` | ✅ | Members with ready-to-paste Mixin selectors, supertypes, inner classes, decompiled source (Vineflower) or the loader's sources jar |
| `translate_mapping` | ✅ | Class/method/field names across Mojmap ↔ Yarn ↔ Intermediary ↔ SRG ↔ obfuscated (identity on unobfuscated 26.x+) |
| `mixin_targets` | ✅ | For a target class/method: injection points read from bytecode (calls, field accesses, `new`, returns, lambdas), **loader event hints first**, and the mixin policy |
| `mixin_generate` | ✅ | Writes a mixin (inject, redirect, modify_arg, modify_variable, modify_constant, modify_return_value, modify_expression_value, wrap_operation, wrap_with_condition, wrap_method, accessor, invoker, overwrite) with correct signatures, imports and config registration; `@At` HEAD/RETURN/TAIL/INVOKE/FIELD/NEW; validates before writing. `overwrite` is a last resort and is always flagged with a warning |
| `mixin_validate` | ✅ | Checks mixin configs and classes against the real game classes (see below) |
| `generate` | ✅ | Content for the project's loader + version: block (block item, blockstate, models, texture, loot, lang), item, block_entity, entity (attributes + renderer), recipe, loot_table, tag, creative_tab, event_handler, networking, config, datagen. Driven by `profiles/content/*.yaml`; every referenced class/method is checked against the project's compile classpath before writing |
| `docs_search` | ✅ | Searches the official Fabric/Forge/NeoForge docs, the NeoForged version primers and Fabric's per-version announcements for the project's version; cached; returns snippets, code and URLs that were checked to exist |
| `check_profiles` | ✅ | Compares the profiles with the official Fabric example mod, NeoForge/Forge MDKs, Gradle and plugin metadata, and with Minecraft releases newer than `testedUpTo`; reports outdated/unverified items and suggests user-profile YAML patches (never applied) |

## Install

Requirements: **Node.js 20+**. To build generated mods you need a JDK (see the table below; Gradle's
toolchain support + foojay can download the target JDK automatically).

```sh
git clone <this repo> ffn && cd ffn
npm install
npm run build
npm test            # offline tests (fixtures)
npm run test:live   # optional: checks every official endpoint is reachable and still parses
```

## Connecting FFN to an MCP client

FFN speaks MCP over **stdio**. Example for Claude Desktop / Cursor / any client using the common
`mcpServers` JSON format:

```json
{
  "mcpServers": {
    "ffn": {
      "command": "node",
      "args": ["/absolute/path/to/ffn/dist/index.js"],
      "env": {
        "FFN_CACHE_TTL_MINUTES": "360"
      }
    }
  }
}
```

Environment variables (all optional):

| Variable | Default | Meaning |
|---|---|---|
| `FFN_PROFILES_DIR` | `~/.config/ffn/profiles` (Linux), `~/Library/Application Support/ffn/profiles` (macOS), `%APPDATA%\ffn\profiles` (Windows) | User profile overrides |
| `FFN_CACHE_DIR` | `~/.cache/ffn` / `~/Library/Caches/ffn` / `%LOCALAPPDATA%\ffn` | HTTP cache |
| `FFN_CACHE_TTL_MINUTES` | `360` | Freshness of mutable indexes (manifests, maven-metadata). Per-version Mojang JSON is cached forever. |
| `FFN_OFFLINE` | unset | `1` = never touch the network, serve from cache |
| `FFN_USER_AGENT` | `FFN-MCP/0.3 …` | Some hosts reject blank/generic agents |
| `FFN_JDKS` | unset | Extra JDK locations (path-separated) for automatic JDK selection |
| `FFN_EGL_DIR` | unset | Unpacked Mesa EGL (`usr/lib/<triplet>/libEGL.so.1`) for headless 26.x clients on machines without root (see below) |

You can try it with the MCP Inspector: `npx @modelcontextprotocol/inspector node dist/index.js`.

## Building and running

**JDK selection.** `gradle_build`, `run_client` and `run_server` pick the JDK themselves: the required version is
`max(profile Java, minimum JVM of the Gradle plugin)`, e.g. Java 25 for Fabric Loom 1.18 even on 1.20.1.
FFN looks in `JAVA_HOME`, `PATH`, `FFN_JDKS`, `~/.gradle/jdks`, `~/jdks`, SDKMAN, `/usr/lib/jvm`, macOS and
Windows default locations, and passes all found JDKs to Gradle (`org.gradle.java.installations.paths`) so
toolchains resolve without downloads. Pass `javaHome` to override.

**Logs and errors.** Every run writes `<project>/.ffn/logs/<task>-<time>.log`. The output is parsed into
findings with `kind`, `severity`, `file`/`line` where known and a suggestion. Run tasks use `--no-daemon`, so
a timeout or smoke stop kills the whole process tree.

**Headless client.** With no display on Linux, `run_client` starts a private Xvfb (`display: "xvfb"` forces
it) with Mesa software OpenGL. Minecraft 26.x opens its window through SDL3, whose GLX path finds no
matching visual on Xvfb; FFN therefore forces SDL's EGL path when `libEGL.so.1` is available (install
`libegl1 libegl-mesa0`, or unpack those Debian packages and point `FFN_EGL_DIR` at them). 1.20.x/1.21.x use
GLFW and work with plain GLX. Missing OpenAL on a headless box is reported as info and is harmless.

**Smoke test.** Markers are only evaluated after Gradle starts the run task: your mod id, your mixin config,
"main menu reached" (texture atlases created) for the client or `Done (…)!` for the server, plus optional
`waitFor` regexes (use them for your own mixin's log line: the example mixin targets a server class
that only loads with a world). Fatal lines (crash report saved, early-display failure) stop the run
immediately instead of waiting for the timeout.

### Minecraft EULA

`run_server` **never accepts the Minecraft EULA on its own.** It refuses unless `run/eula.txt` already
contains `eula=true` or the caller passes `acceptEula: true`. An assistant must only pass `acceptEula: true`
after **the user has read and agreed to the [Minecraft EULA](https://aka.ms/MinecraftEULA)** themselves;
FFN then writes `eula.txt` with a comment recording that. `run_client` needs no EULA file.

## Source index and mappings

`search_mc_source`, `get_class`, `translate_mapping` and the Mixin tools share one index per version:

| Strategy (`source`) | What is indexed | When |
|---|---|---|
| `project` (default when `projectDir` is given) | The game jar on the project's compile classpath, exactly as the loader sees it (Forge/NeoForge patches, project mappings), plus its `-sources.jar` if present | FFN asks Gradle once (`ffnPrintClasspath`), caches the classpath in `.ffn/classpath.json` until build files change |
| `vanilla` | Mojang's client jar + the server jar from the bundler, merged; remapped with tiny-remapper to `mojmap`, `yarn` or `intermediary`; 26.x+ is used as is (unobfuscated) | No project, or `source: "vanilla"` |

The index lives in `~/.cache/ffn/index/<mc>/<namespace>/` (`project/<hash>/` for projects). Building the
1.20.1 Mojmap index takes about 5 s. Classes without a sources jar are decompiled one at a time with
Vineflower (about 1.5 s, then cached). Text search needs real sources (a sources jar), not decompiled code.
Mappings: Mojang ProGuard files, Fabric Intermediary and Yarn (tiny v2) and MCPConfig (tsrg2), joined on obfuscated names.
SRG names are offered only where they are real (`m_N_` up to 1.20.x Forge).

## Mixin tooling

`mixin_validate` (whole project or one class) checks, against the real classes:

- config JSON, `package`, registration in `fabric.mod.json` / `mods.toml` / manifest / build script, refmap where the profile needs one;
- `compatibilityLevel` against the bundled Mixin version (`mixin.maxCompatibilityLevel` in the profile) and the project's Java;
- listed classes exist and unlisted `@Mixin` classes; targets exist; client-only targets in `"mixins"`;
- method selectors (overloads, inherited members, "did you mean", the other mapping's name), `@At` HEAD/RETURN/TAIL/INVOKE/FIELD/NEW against the bytecode (including calls that actually sit in a lambda);
- handler signatures for `@Inject` (CallbackInfo vs CallbackInfoReturnable, argument lists, static), `@Redirect`, `@ModifyArg`, `@ModifyVariable`, `@ModifyReturnValue`, `@ModifyExpressionValue`, `@WrapOperation`, `@WrapWithCondition`, `@WrapMethod`;
- `@Accessor` / `@Invoker` / `@Shadow` / `@Overwrite`, MixinExtras availability, and mixin methods that accidentally collide with a target method (a runtime "@Overwrite is required" crash).

`mixin_generate` uses the same data, so the generated handler signature, `@At` target and descriptor are
exact for the version. It refuses to write when validation finds errors (`dryRun` previews).

**Event hints.** `mixin_targets` first lists loader events/APIs that cover common needs (server tick, player
join, block break, damage, item tooltips, HUD rendering…) with the Fabric/Forge/NeoForge names. They live in
`profiles/hints/mixin-hints.yaml`; add or override hints in `<FFN_PROFILES_DIR>/hints/*.yaml`. The policy:
prefer events, then `@Inject`/MixinExtras wrappers, `@Redirect`/`@Overwrite` only as a last resort.

## Content generation (`generate`)

`generate {projectDir, kind, name, params}` writes content in the style of the project's loader and Minecraft version.
Nothing version-specific is in the engine. All of it is in **content catalogs** (`profiles/content/common.yaml`,
`fabric.yaml`, `forge.yaml`, `neoforge.yaml`; add or override in `<FFN_PROFILES_DIR>/content/`):

- **probes** check the project's real compile classpath (game jar with loader patches + loader/API jars) for a class
  or member, e.g. `net.minecraft.world.item.Item$Properties#setId(`. Templates switch on `has.<probe>`. That is how
  ResourceKey ids (1.21.2+), data components / `CustomPacketPayload` + `StreamCodec` (1.20.5+), `ValueInput/ValueOutput`
  block entity saving (26.x), `Identifier` vs `ResourceLocation`, Forge EventBus 7, Fabric's renamed APIs
  (`serverboundPlay`, `FabricCreativeModeTab`, `FabricPackOutput`) and NeoForge 26.x changes are chosen.
- **symbols** are class aliases with candidate lists. The first one present on the classpath wins, and imports are added
  automatically.
- **rules** (`since:`) drive data-pack formats: recipe result keys, singular/plural data folders, ingredient style,
  item model definitions (1.21.4+).
- **delegate**: NeoForge 1.20.1 (a Forge 47 fork) uses the Forge templates.

Before writing, every class/member that the generated code references is verified on the classpath. Mismatches are
reported and nothing is written unless `force: true`. `dryRun: true` shows the plan. Generated registration code goes into
`registry/Mod*.java` containers, and the mod's init method gets one hook line per container (idempotent: running a kind again
adds only what is missing; a name clash is an error).

## Docs search (`docs_search`)

Sources are declared in `profiles/docs/sources.yaml`:

| Source | Fetched from | Page URLs |
|---|---|---|
| NeoForge docs (latest + versioned) | `neoforged/Documentation` (zip) | `docs.neoforged.net/docs/[version/]…` |
| NeoForged version primers | `neoforged/.github` `primers/<ver>` (zip) | `docs.neoforged.net/primer/docs/<ver>/` |
| Fabric docs (latest + versioned) | `FabricMC/fabric-docs` (git tree + raw files) | `docs.fabricmc.net/[version/]develop/…` (falls back to the GitHub file when the versioned page is not published) |
| Fabric announcements ("Fabric for Minecraft X") | `FabricMC/fabricmc.net` `_posts` | `fabricmc.net/yyyy/mm/dd/<slug>.html` |
| Forge docs 1.20.1 / 1.20.x / 1.21.x | `MinecraftForge/Documentation` branches (zip) | `docs.minecraftforge.net/en/<branch>/…` |

Pages are cached under `<cache>/docs` (24 h, stale copy used when offline) and split into heading sections. Results are
ranked with BM25 (camelCase identifiers are split). The doc set is chosen by version: exact or wildcard match, `latest` for
versions newer than every numbered set, otherwise the closest set, with a note. Primers and announcements up to the target
version are included, and closer versions rank higher. Every returned page URL is checked with HEAD/GET (cached) and is
marked `[UNVERIFIED URL]` if the check fails. Set `GITHUB_TOKEN` if the GitHub API rate limit is a problem.

## Multiloader projects

`create_project` with `layout: "multiloader"` (optionally `loaders: [...]`) creates:

```
<target>/
  common/src/main/java/<pkg>/<Main>Common.java   loader-independent code (vanilla classes only)
  common/src/main/resources/                     assets/data shared by all loaders
  fabric/  neoforge/  forge/                     one complete Gradle build per loader (own wrapper)
  .ffn/project.json                              layout: multiloader, loaders, subprojects
```

Every loader build adds `../common/src/main/{java,resources}` as extra source directories, and each loader's
main class calls `<Main>Common.init()`. Style is MultiLoader-Template (no extra runtime dependency). Architectury is not offered.

FFN deliberately does **not** use one shared Gradle build as MultiLoader-Template does. The loaders' Gradle plugins need
different Gradle versions (e.g. ModDevGradle-legacy on Gradle 8.x vs Loom on Gradle 9), so independent builds are
the only layout that works for every loader/version pair. Downsides: `common/` has no build of its own (IDEs see it
through the loader builds), and you run Gradle per loader directory.

Default loaders and the build-script snippet live in `profiles/layouts/multiloader.yaml`: fabric + forge on 1.20.1, fabric + neoforge on 1.20.2+.
A user file at `$FFN_PROFILES_DIR/layouts/multiloader.yaml` replaces it.
Multiloader projects use Mojang mappings (no Yarn).

`generate` on a multiloader root plans the content once per loader. Files that every loader generates identically
(blockstates, models, textures, loot tables, recipes, tags, lang) go to `common/`, and lang/JSON files are deep-merged.
Files that differ (registries, main-class hooks, loader events) go to each loader. Symbol checks run per loader against that loader's classpath.

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
  generator/
    index.ts            planProject() (resolve profile + live versions → file plan), writeProject()
    multiloader.ts      layout=multiloader planner (common/ + per-loader builds, profiles/layouts/multiloader.yaml)
    templates/          fabric.ts, forgelike.ts (ModDevGradle, MDG-legacy, ForgeGradle 6/7), common.ts
  jdk/                  JDK discovery and selection
  exec/                 process runner (timeouts, process groups), Xvfb/EGL display
  diagnostics/          log/crash parser → findings + culprit
  project/              reads .ffn/project.json or infers loader/version/mappings from Gradle files
  index/                class-file reader, mappings (ProGuard/tiny/tsrg), index store, tool jars, IndexService
  mixin/                Java annotation parser, validator, generator, event hints
  tools/                one file per tool group (gradle, source, mixin, crash, generate, docs, checkProfiles, …)
profiles/               built-in YAML profiles (fabric/forge/neoforge.yaml) and hints/mixin-hints.yaml
templates/              Gradle wrapper (jar + scripts) and a placeholder icon
test/                   vitest; fixtures are real responses captured from the official endpoints
```

Flow of `create_project`: validate input → `lookupProfile()` (Mojang facts → rule resolution) →
live versions (loader, Fabric API / Yarn / Parchment, Gradle plugin "latest" from its maven-metadata) →
template for the profile's `buildSystem` → write files.

### Version sources (all verified to respond)

| Data | Endpoint |
|---|---|
| MC versions | `https://piston-meta.mojang.com/mc/game/version_manifest_v2.json` (+ per-version JSON: `javaVersion.majorVersion`, `downloads.client_mappings`) |
| Fabric | `https://meta.fabricmc.net/v2/versions/{game,loader,yarn/<mc>}`, Fabric API `https://maven.fabricmc.net/net/fabricmc/fabric-api/fabric-api/maven-metadata.xml`, Loom `…/fabric-loom/maven-metadata.xml` |
| Forge | `https://maven.minecraftforge.net/net/minecraftforge/forge/maven-metadata.xml`, `https://files.minecraftforge.net/net/minecraftforge/forge/promotions_slim.json` |
| NeoForge | `https://maven.neoforged.net/releases/net/neoforged/neoforge/maven-metadata.xml`, 1.20.1: `…/net/neoforged/forge/maven-metadata.xml` |
| Parchment | `https://maven.parchmentmc.org/org/parchmentmc/data/parchment-<mc>/maven-metadata.xml` |
| Gradle plugins | ModDevGradle (maven.neoforged.net), ForgeGradle 6 (maven.minecraftforge.net), ForgeGradle 7 (plugins.gradle.org) |

### Templates: why profile-driven instead of copying MDK zips

FFN generates projects from small, profile-driven templates that **mirror the official MDKs**
(FabricMC/fabric-example-mod, NeoForgeMDKs/*, the Forge MDK zips and MinecraftForge/MDKExamples).
Copying MDK zips verbatim was rejected because (a) Fabric and NeoForge MDKs live in per-version Git
branches/repos that appear days after a release, (b) every MDK wires Mixins differently (or not at all),
and FFN must always produce a correctly wired Mixin, and (c) generated code must be deterministic and
testable offline. The profile's `references` field links to the upstream MDK each rule was checked
against, so a maintainer can diff when a new version ships.

### What each loader gets (built-in profiles)

| Loader | MC | Build system | Metadata | Mixin wiring |
|---|---|---|---|---|
| Fabric | 1.20.1 – 1.21.11 (obfuscated) | Loom `net.fabricmc.fabric-loom-remap`, Mojmap / Parchment / Yarn | `fabric.mod.json` | `"mixins"` in fabric.mod.json, refmap by Loom |
| Fabric | 26.1+ (unobfuscated) | Loom `net.fabricmc.fabric-loom`, no remapping | `fabric.mod.json` | same, no refmap |
| Forge | 1.20.1 | ModDevGradle *legacyforge* | `META-INF/mods.toml` | `MixinConfigs` manifest + refmap via Mixin AP |
| Forge | 1.20.2 – 1.21.10 | ForgeGradle 6 | `META-INF/mods.toml` | manifest + `-mixin.config` dev arg (+ MixinGradle refmap ≤ 1.20.4) |
| Forge | 1.21.11+ | ForgeGradle 7 | `META-INF/mods.toml` | manifest + `--mixin.config` dev arg |
| NeoForge | 1.20.1 | ModDevGradle *legacyforge* (`net.neoforged:forge`) | `META-INF/mods.toml` | manifest + refmap |
| NeoForge | 1.20.2 – 1.20.4 | ModDevGradle | `META-INF/mods.toml` | `[[mixins]]` |
| NeoForge | 1.20.5+ | ModDevGradle | `META-INF/neoforge.mods.toml` | `[[mixins]]` |

### Build verification

Generated projects were built with `./gradlew build` on 2026-10-10 (live versions of that day,
Temurin JDK 17/21/25). All produced a jar; the Mixin wiring was checked inside the jars (refmap with SRG
names where needed, `MixinConfigs` manifest entry, `[[mixins]]` / `fabric.mod.json` registration).

| Project | Result | Notes |
|---|---|---|
| Fabric 1.20.1 (Mojmap) | ✅ | Loom 1.18.4 — Gradle must run on JDK 25 |
| Fabric 1.20.1 (Yarn) | ✅ | |
| Fabric 1.21.1 | ✅ | |
| Fabric 26.3 | ✅ | non-remapping Loom, Java 25 |
| Forge 1.20.1 | ✅ | MDG legacyforge, refmap `m_130006_` |
| Forge 1.20.4 | ✅ | ForgeGradle 6 + MixinGradle, refmap |
| Forge 1.21.1 | ✅ | ForgeGradle 6, no reobf |
| Forge 26.3 | ✅ | ForgeGradle 7 |
| NeoForge 1.20.1 | ✅ | `net.neoforged:forge` 1.20.1-47.1.106 via MDG legacyforge |
| NeoForge 1.21.1 | ✅ | |
| NeoForge 26.3 | ✅ | beta build 26.3.0.65-beta (no stable yet) |

### M2 verification (2026-10-10)

| Check | Result |
|---|---|
| `mixin_validate` on all 11 generated projects (Fabric 1.20.1 Mojmap + Yarn, 1.21.1, 26.3; Forge 1.20.1, 1.20.4, 1.21.1, 26.3; NeoForge 1.20.1, 1.21.1, 26.3), project index | ✅ no errors |
| Same with the vanilla index for 1.20.1 and 26.3, every loader | ✅ |
| Deliberately broken mixin (Forge 26.3): wrong method name, `@Shadow` typo, CallbackInfo on a boolean method, INVOKE the target never calls, wrong handler params, missing listed class, `JAVA_25` with Mixin 0.8.7 | ✅ each one reported |
| Yarn project using a Mojmap name | ✅ reported with the Yarn name |
| `mixin_generate`: 7 kinds written into Fabric 1.20.1 → compiled, validated, **applied at runtime** (smoke with `waitFor`) | ✅ |
| `gradle_build` (JDK auto-pick; broken source → `file:line` compile error) | ✅ |
| `run_client` smoke (Xvfb): Fabric 1.20.1 & 26.3, Forge 1.20.1 & 26.3, NeoForge 1.20.1, 1.21.1 & 26.3 (26.x via SDL EGL) | ✅ main menu reached, 16–113 s |
| `run_server` without `acceptEula` | ✅ refused, no `eula.txt` written. The server itself was **not** started (FFN does not accept the EULA for the user) |
| `analyze_crash` on a real Mixin crash | ✅ culprit `ffnsample`, high confidence |
| `translate_mapping` `MinecraftServer#loadLevel` (1.20.1) | ✅ obf `n_`, intermediary `method_3735`, yarn `loadWorld`, srg `m_130006_` |

Reproduce with `node scripts/gen-sample.mjs <dir> <loader> <mc>` and `scripts/build-generated.sh <dir>`.

### M3 verification (2026-10-10)

Fresh projects were created for all 3 loaders on 1.20.1, 1.21.1 and 26.3. Each one then got every kind generated into it:

- a block and a creative tab;
- an item placed in that tab;
- a ticking block entity;
- an entity, its loot table and its renderer;
- 3 recipes (shaped, shapeless, smelting);
- 2 tags;
- 5 event handlers;
- 2 network payloads (to server, to client);
- a config with 4 entries;
- datagen.

| Check | Result |
|---|---|
| `gradle_build compileJava`: Fabric, Forge, NeoForge × 1.20.1, 1.21.1, 26.3 (9 projects) | ✅ all compile |
| `mixin_generate` modify_constant / NEW (inject, wrap_operation) / overwrite into Fabric 26.3 → compiled | ✅ |
| `mixin_validate` on a mixin with planted CONSTANT/JUMP/LOAD/@Slice mistakes → every mistake reported | ✅ |
| `docs_search` live against all sources (NeoForge 26.3, Fabric 1.20.1/26.3, Forge 26.3) | ✅ |
| Runtime loading of M3 content (`run_client`) | ⚠️ **not verified.** Runtime smoke runs were dropped from M3 verification at the user's request. Three client smoke runs done earlier in development (Fabric 1.20.1, Forge 26.3, NeoForge 26.3) reached the main menu; the Forge 26.3 one found an EventBus 7 bug, which was fixed. That is not systematic coverage. |

### M4 verification (2026-10-10)

Each multiloader project got a block, an item and a shapeless recipe through `generate`. Everything was checked with `gradle_build compileJava`, run separately in each loader directory.

| Check | Result |
|---|---|
| Multiloader 1.20.1 (fabric + forge): common class, assets, lang, recipe and loot in `common/`; registries per loader | ✅ both compile |
| Multiloader 1.21.1 (fabric + neoforge) | ✅ both compile |
| Multiloader 26.3 (fabric + neoforge) | ✅ both compile |
| Multiloader 26.3 with all three loaders (fabric + neoforge + forge) | ✅ all compile |
| `check_profiles` live: no outdated items. Forge 26.3 MDK reference not published; Forge 1.20.1 plugin deviation reported as info | ✅ |
| Runtime (`run_client` / `run_server`) | ⚠️ not run (compile-only verification at the user's request) |

## Development

```sh
npm run build && npm test
node scripts/gen-sample.mjs /tmp/ffn/forge-1.20.1 forge 1.20.1   # generate with live data
JDKS=$HOME/jdks scripts/build-generated.sh /tmp/ffn/forge-1.20.1   # ./gradlew build with the right JDK
node scripts/smoke-stdio.mjs 1.21.1                                 # talk to dist/index.js over stdio
node scripts/call-tool.mjs mixin_validate '{"projectDir":"/tmp/ffn/forge-1.20.1"}'  # call any tool in-process
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
add a test in `test/profiles.test.ts`, and build a generated project.

Only when a loader adopts a **new build system** (e.g. a ForgeGradle 8) does FFN need code: add a value to
`BUILD_SYSTEMS` in `src/profiles/schema.ts` and a template in `src/generator/templates/`.

## Roadmap

- ~~**M1 — foundation:** live versions, profiles, `create_project`.~~ ✅
- ~~**M2 — build, run, source & Mixin intelligence:** `gradle_build` / `run_client` / `run_server`, `analyze_crash`,
  source index + mappings, `mixin_targets` / `mixin_validate` / `mixin_generate`.~~ ✅
- ~~**M3 — content generators & docs:** `generate` (12 kinds, catalog-driven, classpath-verified), `docs_search`,
  `@At` CONSTANT/JUMP/LOAD/STORE/NEW and `@Slice` checks, NEW / `@ModifyConstant` / `@Overwrite` generation.~~ ✅ (compile-verified)
- ~~**M4 — multiloader & profile check:** `create_project layout: multiloader` (common + per-loader builds),
  multiloader-aware `generate`, `check_profiles`.~~ ✅ (compile-verified). Porting tools (`mixin_port`, `port_mod`) were dropped from the plan.
- **Next (proposal):** runtime verification of generated content, Kotlin DSL build scripts, more content kinds.

### Known limitations

- Text search in `search_mc_source` needs a sources jar (project index with sources, e.g. Loom/MDG); decompiled sources are per class.
- M3 generated content and M4 multiloader projects are compile-verified only; runtime loading was not verified systematically.
- Multiloader: `common/` has no Gradle build of its own; Kotlin DSL and Yarn are not supported there. Architectury is not offered.
  `generate` does not see files already in `common/` when it checks for duplicates (lang/JSON is merged; a Java file that conflicts is refused unless `force`).
- `check_profiles` compares only what the references publish. For example, the Forge 1.20.1 MDK has no Gradle wrapper in `mdk/`, and newer Forge branches may not be found.
- `generate`: the entity renderer is a `NoopRenderer` placeholder (invisible); textures are 16×16 placeholder PNGs;
  event handlers cover 5 common events; the Forge networking kind registers one direction per message.
  On NeoForge 26.3, `ModConfig.Type` has no COMMON/SERVER; `configType: common` maps to LOCAL and `server` maps to SYNCED.
  That mapping is flagged UNVERIFIED. Forge configs use `ModLoadingContext.get()`, which is deprecated and gives a warning on newer Forge.
- `docs_search`: Fabric docs pull code from `reference/` files (`@[code]` includes); those snippets show as include
  markers, not code. Forge has no 26.x docs, so the closest set (1.21.x) is used and FFN says so.
- `@ModifyVariable` LOAD/STORE checks work by slot and type. Name checks need a local variable table, which Mojang jars do not have.
  `@Slice` checks support INVOKE/FIELD/NEW/CONSTANT/JUMP/HEAD/RETURN/TAIL anchors. MixinExtras expressions are not checked.
- The Java parser for mixin classes is heuristic: it handles normal mixin code, but not every Java construct.
- The vanilla index does not contain loader patches. Use the project index for Forge/NeoForge-patched methods.
- NeoForge 1.20.2–1.21.0: the maximum Mixin compatibility level is not verified (no warning is given).
- A smoke test proves the mod and its mixin config load and the main menu is reached. It does not prove every injection applied; use `waitFor` for that.
- `run_server` was only tested up to the EULA gate.

---

## Кратко по-русски

**FFN** — MCP-сервер для разработки модов Minecraft под **Forge, Fabric и NeoForge** (от 1.20.1 до новейшей версии).
Главная идея — **ничего не зашито в код**: список версий, нужная Java, версии загрузчиков, Fabric API, Yarn,
Parchment и Gradle-плагинов берутся из официальных источников в момент запроса и кэшируются (есть офлайн-режим).
Различия между версиями описаны в YAML-профилях (`profiles/*.yaml`) правилами «от версии X и выше».
Если вышла версия новее проверенных, FFN берёт ближайшие правила и честно предупреждает `UNVERIFIED`.

**Установка:** Node.js 20+, затем `npm install && npm run build`. Тесты: `npm test`.

**Подключение к MCP-клиенту:** добавьте в конфиг клиента:

```json
{ "mcpServers": { "ffn": { "command": "node", "args": ["/путь/к/ffn/dist/index.js"] } } }
```

**Новая версия Minecraft:** обычно ничего делать не нужно. Если что-то действительно поменялось, положите YAML-файл
с правилом `since: "<версия>"` в папку пользовательских профилей (`~/.config/ffn/profiles`, на Windows
`%APPDATA%\ffn\profiles`, или путь из `FFN_PROFILES_DIR`) — пересобирать сервер не нужно.

**Сейчас работают (0.4):**

- `list_versions`, `get_profile`, `create_project`.
- `gradle_build`, `run_client`, `run_server`: сборка и запуск с автоматическим выбором JDK, таймаутами, логами в `.ffn/logs` и разбором ошибок (файл:строка, Mixin, зависимости, версия Java).
- `run_client` умеет работать без монитора (Xvfb). Режим `smoke` проверяет, что мод загрузился и игра дошла до главного меню, после чего останавливает её. Для 26.x на Xvfb нужен Mesa EGL (`libegl1 libegl-mesa0` или `FFN_EGL_DIR`).
- `analyze_crash`: разбор крэш-репорта или лога с указанием мода-виновника.
- `search_mc_source`, `get_class`, `translate_mapping`: индекс классов конкретной версии (ванильный или из проекта, с патчами загрузчика), исходники через sources jar или Vineflower, перевод имён Mojmap ↔ Yarn ↔ Intermediary ↔ SRG.
- `mixin_targets`, `mixin_validate`, `mixin_generate`:
  - точки инъекции берутся из байткода;
  - подсказки по событиям загрузчика (их можно дополнить файлами в `<FFN_PROFILES_DIR>/hints/`);
  - проверка конфигов, селекторов, `@At` и сигнатур обработчиков по реальным классам;
  - генерация миксинов 13 видов, включая `@ModifyConstant`, инъекции в точку NEW и `@Overwrite` (последний — только в крайнем случае и всегда с предупреждением);
  - подробные проверки `@At` CONSTANT/JUMP/LOAD/STORE/NEW и `@Slice`.
- `generate` — контент под загрузчик и версию проекта:
  - виды: блок (с предметом, blockstate, моделями, текстурой, лутом и переводом), предмет, block entity, сущность (атрибуты и рендерер), рецепт, таблица лута, тег, вкладка творческого режима, обработчик события, сетевой пакет, конфиг, datagen;
  - всё описано в `profiles/content/*.yaml`;
  - перед записью каждый используемый класс и метод проверяется по classpath проекта.
- `docs_search` — поиск по официальной документации Fabric/Forge/NeoForge, праймерам NeoForged и анонсам Fabric:
  - набор документации выбирается под версию;
  - найденное кэшируется;
  - результаты содержат фрагменты и код, а каждая ссылка проверена на существование.

- `create_project` с `layout: "multiloader"` создаёт мультилоадер-проект:
  - `common/` для общего кода и ресурсов, плюс отдельная Gradle-сборка на каждый загрузчик (fabric + forge на 1.20.1, fabric + neoforge на 1.20.2+; набор можно задать через `loaders`);
  - стиль MultiLoader-Template, без лишних зависимостей в рантайме; Architectury не поддерживается;
  - сборки раздельные, потому что Gradle-плагины загрузчиков требуют разных версий Gradle;
  - настройки лежат в `profiles/layouts/multiloader.yaml`.
- `generate` в мультилоадер-проекте: одинаковые для всех загрузчиков файлы (модели, текстуры, лут, рецепты, теги, перевод) кладутся в `common/`, остальные — в папку каждого загрузчика.
- `check_profiles` сравнивает профили с официальными fabric-example-mod, NeoForge/Forge MDK, Gradle и метаданными плагинов, а также с новыми релизами Minecraft:
  - показывает, что устарело или не проверено;
  - предлагает YAML-патчи для пользовательских профилей (сам ничего не применяет);
  - источники описаны в `profiles/checks/upstream.yaml`.
- Инструменты портирования (`mixin_port`, `port_mod`) исключены из плана по решению пользователя.

**EULA Minecraft:** `run_server` **никогда не принимает EULA сам**. Он требует параметр `acceptEula: true`, а передавать его можно только после того, как **пользователь сам прочитал [EULA](https://aka.ms/MinecraftEULA) и согласился** с ним. Для `run_client` EULA не нужен.

**Ограничения:**

- текстовый поиск работает только с sources jar;
- контент M3 проверен только компиляцией (9 проектов: 3 загрузчика × 1.20.1/1.21.1/26.3); загрузка в игре системно не проверялась;
- мультилоадер M4 проверен только компиляцией: 1.20.1 (fabric+forge), 1.21.1 и 26.3 (fabric+neoforge), 26.3 со всеми тремя загрузчиками;
- у `common/` нет своей Gradle-сборки; Kotlin DSL и Yarn в мультилоадере не поддерживаются;
- рендерер сущности — заглушка `NoopRenderer`, текстуры — заглушки 16×16;
- ванильный индекс не видит патчей Forge/NeoForge;
- smoke-тест доказывает загрузку мода и выход в меню, но не применение каждой инъекции (для этого есть `waitFor`).

**Дальше (предложение):** проверка сгенерированного контента в игре, Kotlin DSL, новые виды контента.
