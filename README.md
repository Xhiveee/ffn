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

> Status: **0.2 (M2: build, run, source index, Mixin tooling)**. Still stubs: `generate`, `mixin_port`,
> `port_mod`, `docs_search` (they are registered with full input schemas and answer "not implemented yet").

---

## Tools

| Tool | Status | What it does |
|---|---|---|
| `list_versions` | ✅ | Minecraft releases (optionally snapshots) with loader availability; for one version: Fabric Loader / Fabric API / Yarn, Forge recommended/latest, NeoForge stable/beta, Parchment, Java, recommended Gradle plugin per loader |
| `get_profile` | ✅ | Resolved profile for `(mcVersion, loader)`: Java, Gradle + plugin, metadata file, mappings, Mixin registration/refmap/MixinExtras/max compatibility level, with extrapolation warnings |
| `create_project` | ✅ | Ready-to-build project: Gradle wrapper, `build.gradle`, `gradle.properties`, `settings.gradle`, loader metadata, main class, example Mixin + `<modid>.mixins.json` wired correctly for that loader/version, assets/data folders, `.ffn/project.json` |
| `gradle_build` | ✅ | Runs Gradle tasks with an automatically chosen JDK, timeout and full log; returns structured findings (javac `file:line` errors, Mixin AP, dependency resolution, JVM/toolchain mismatch…) |
| `run_client` | ✅ | Starts the game client (headless via Xvfb when there is no display). `mode: "smoke"` waits for "mod loaded + main menu reached" (plus your own `waitFor` regexes), then stops and reports PASS/FAIL |
| `run_server` | ✅ | Starts the dedicated server. **Requires `acceptEula: true`** (see [EULA](#minecraft-eula)); smoke mode waits for `Done (…)!` |
| `analyze_crash` | ✅ | Crash report / log analysis: root exception, Mixin failures, missing/duplicate mods, class-version problems; scores the most likely culprit mod |
| `search_mc_source` | ✅ | Class/member search (names, descriptors) and text search in sources of the exact MC version, vanilla or as seen by the project (loader patches included) |
| `get_class` | ✅ | Members with ready-to-paste Mixin selectors, supertypes, inner classes, decompiled source (Vineflower) or the loader's sources jar |
| `translate_mapping` | ✅ | Class/method/field names across Mojmap ↔ Yarn ↔ Intermediary ↔ SRG ↔ obfuscated (identity on unobfuscated 26.x+) |
| `mixin_targets` | ✅ | For a target class/method: injection points read from bytecode (calls, field accesses, `new`, returns, lambdas), **loader event hints first**, and the mixin policy |
| `mixin_generate` | ✅ | Writes a mixin (inject, redirect, modify_arg, modify_variable, modify_return_value, modify_expression_value, wrap_operation, wrap_with_condition, wrap_method, accessor, invoker) with correct signatures, imports and config registration; validates before writing |
| `mixin_validate` | ✅ | Checks mixin configs and classes against the real game classes (see below) |
| `generate` | 🚧 | Blocks, items, entities, recipes, datapacks, events… per profile (M3) |
| `docs_search` | 🚧 | Loader docs search (M3) |
| `mixin_port`, `port_mod` | 🚧 | Porting between versions/loaders (M4) |

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
| `FFN_USER_AGENT` | `FFN-MCP/0.2 …` | Some hosts reject blank/generic agents |
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
    templates/          fabric.ts, forgelike.ts (ModDevGradle, MDG-legacy, ForgeGradle 6/7), common.ts
  jdk/                  JDK discovery and selection
  exec/                 process runner (timeouts, process groups), Xvfb/EGL display
  diagnostics/          log/crash parser → findings + culprit
  project/              reads .ffn/project.json or infers loader/version/mappings from Gradle files
  index/                class-file reader, mappings (ProGuard/tiny/tsrg), index store, tool jars, IndexService
  mixin/                Java annotation parser, validator, generator, event hints
  tools/                one file per tool group (gradle, source, mixin, crash, …), stubs
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
- **M3 — content generators & docs:** `generate` (blocks, items, block entities, entities, recipes, loot tables,
  tags, datapacks, creative tabs, event handlers, networking, config) per profile with datagen where the loader has it,
  `docs_search` over the official Fabric/Forge/NeoForge docs and changelogs, `@At` CONSTANT/JUMP/LOAD/STORE checks.
- **M4 — porting & multiloader:** `mixin_port` (re-target a mixin to another version or mapping using the index
  diff), `port_mod`, Architectury / MultiLoader-Template projects, a `sync_profiles` check that diffs profiles against new official MDKs.

### Known limitations

- Text search in `search_mc_source` needs a sources jar (project index with sources, e.g. Loom/MDG); decompiled sources are per class.
- `@At` CONSTANT, JUMP, LOAD and STORE and `@Slice` are parsed but not checked in detail. `mixin_generate` does not write NEW-point injections, `@Overwrite` or `@ModifyConstant`.
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

**Сейчас работают (0.2):**

- `list_versions`, `get_profile`, `create_project`.
- `gradle_build`, `run_client`, `run_server`: сборка и запуск с автоматическим выбором JDK, таймаутами, логами в `.ffn/logs` и разбором ошибок (файл:строка, Mixin, зависимости, версия Java).
- `run_client` умеет работать без монитора (Xvfb). Режим `smoke` проверяет, что мод загрузился и игра дошла до главного меню, после чего останавливает её. Для 26.x на Xvfb нужен Mesa EGL (`libegl1 libegl-mesa0` или `FFN_EGL_DIR`).
- `analyze_crash`: разбор крэш-репорта или лога с указанием мода-виновника.
- `search_mc_source`, `get_class`, `translate_mapping`: индекс классов конкретной версии (ванильный или из проекта, с патчами загрузчика), исходники через sources jar или Vineflower, перевод имён Mojmap ↔ Yarn ↔ Intermediary ↔ SRG.
- `mixin_targets`, `mixin_validate`, `mixin_generate`:
  - точки инъекции берутся из байткода;
  - подсказки по событиям загрузчика (их можно дополнить файлами в `<FFN_PROFILES_DIR>/hints/`);
  - проверка конфигов, селекторов, `@At` и сигнатур обработчиков по реальным классам;
  - генерация миксинов 11 видов.

**EULA Minecraft:** `run_server` **никогда не принимает EULA сам**. Он требует параметр `acceptEula: true`, а передавать его можно только после того, как **пользователь сам прочитал [EULA](https://aka.ms/MinecraftEULA) и согласился** с ним. Для `run_client` EULA не нужен.

**Ограничения:**

- текстовый поиск работает только с sources jar;
- `@At` CONSTANT/JUMP/LOAD/STORE подробно не проверяются;
- ванильный индекс не видит патчей Forge/NeoForge;
- smoke-тест доказывает загрузку мода и выход в меню, но не применение каждой инъекции (для этого есть `waitFor`).

**Дальше:** M3 — генераторы контента (`generate`) и `docs_search`; M4 — портирование (`mixin_port`, `port_mod`) и мультилоадер.
