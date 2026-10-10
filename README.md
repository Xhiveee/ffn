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

> Status: **0.1 (foundation milestone)**. `list_versions`, `get_profile` and `create_project` are implemented;
> the other tools are registered with full input schemas and answer "not implemented yet".

---

## Tools

| Tool | Status | What it does |
|---|---|---|
| `list_versions` | ✅ | Minecraft releases (optionally snapshots) with loader availability; for one version: Fabric Loader / Fabric API / Yarn, Forge recommended/latest, NeoForge stable/beta, Parchment, Java, recommended Gradle plugin per loader |
| `get_profile` | ✅ | Resolved profile for `(mcVersion, loader)`: Java, Gradle + plugin, metadata file, mappings, Mixin registration/refmap/MixinExtras, with extrapolation warnings |
| `create_project` | ✅ | Ready-to-build project: Gradle wrapper, `build.gradle`, `gradle.properties`, `settings.gradle`, loader metadata, main class, example Mixin + `<modid>.mixins.json` wired correctly for that loader/version, assets/data folders, `.ffn/project.json` |
| `search_mc_source`, `get_class`, `translate_mapping` | 🚧 | Source/mapping index of the exact MC version |
| `mixin_targets`, `mixin_generate`, `mixin_validate`, `mixin_port` | 🚧 | Mixin tooling against real signatures |
| `generate` | 🚧 | Blocks, items, entities, recipes, datapacks, events… per profile |
| `gradle_build`, `run_client`, `run_server` | 🚧 | Build/run with the right JDK, parsed errors |
| `analyze_crash`, `port_mod`, `docs_search` | 🚧 | Diagnostics, porting, docs |

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
| `FFN_USER_AGENT` | `FFN-MCP/0.1 …` | Some hosts reject blank/generic agents |

You can try it with the MCP Inspector: `npx @modelcontextprotocol/inspector node dist/index.js`.

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
  tools/                list_versions, get_profile, create_project, stubs
profiles/               built-in YAML profiles: fabric.yaml, forge.yaml, neoforge.yaml
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

Not verified yet: launching the game (`runClient`/`runServer`) to confirm the example mixin applies at runtime.
Reproduce with `node scripts/gen-sample.mjs <dir> <loader> <mc>` and `scripts/build-generated.sh <dir>`.

## Development

```sh
npm run build && npm test
node scripts/gen-sample.mjs /tmp/ffn/forge-1.20.1 forge 1.20.1   # generate with live data
JDKS=$HOME/jdks scripts/build-generated.sh /tmp/ffn/forge-1.20.1   # ./gradlew build with the right JDK
node scripts/smoke-stdio.mjs 1.21.1                                 # talk to dist/index.js over stdio
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

- **M2 — source & build intelligence:** `gradle_build` / `run_client` / `run_server` (JDK selection, error
  parsing), decompiled-source index per version (`search_mc_source`, `get_class`, `mixin_targets`),
  mapping translation (Mojmap ↔ Yarn ↔ Intermediary ↔ SRG).
- **M3 — generators & diagnostics:** `generate` (blocks/items/entities/recipes/datapacks/events),
  `mixin_generate`, `mixin_validate`, `analyze_crash`, `docs_search`.
- **M4 — porting & multiloader:** `port_mod`, `mixin_port`, Architectury / MultiLoader-Template projects,
  a `sync_profiles` check that diffs profiles against new official MDKs.

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

**Сейчас работают:** `list_versions`, `get_profile`, `create_project` (готовый проект с Gradle wrapper, метаданными,
главным классом и примером Mixin, правильно подключённым для конкретного загрузчика и версии).
Остальные инструменты уже зарегистрированы и будут реализованы в следующих этапах (см. Roadmap).
