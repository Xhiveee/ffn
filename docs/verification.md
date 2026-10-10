# FFN — verification log

All checks were compile-only (no Minecraft launches).

## M2 verification (2026-10-10)

| Check | Result |
|---|---|
| `mixin_validate` on 11 sample projects (Fabric 1.20.1 Mojmap + Yarn, 1.21.1, 26.3; Forge 1.20.1, 1.20.4, 1.21.1, 26.3; NeoForge 1.20.1, 1.21.1, 26.3), project index | ✅ no errors |
| Same with the vanilla index for 1.20.1 and 26.3, every loader | ✅ |
| Deliberately broken mixin (Forge 26.3): wrong method name, `@Shadow` typo, CallbackInfo on a boolean method, INVOKE the target never calls, wrong handler params, missing listed class, `JAVA_25` with Mixin 0.8.7 | ✅ each one reported |
| Yarn project using a Mojmap name | ✅ reported with the Yarn name |
| `gradle_build` (JDK auto-pick; broken source → `file:line` compile error) | ✅ |
| `analyze_crash` on a real Mixin crash | ✅ culprit `ffnsample`, high confidence |
| `translate_mapping` `MinecraftServer#loadLevel` (1.20.1) | ✅ obf `n_`, intermediary `method_3735`, yarn `loadWorld`, srg `m_130006_` |

## M3 verification (2026-10-10)

| Check | Result |
|---|---|
| `mixin_validate` on a mixin with planted CONSTANT/JUMP/LOAD/@Slice mistakes → every mistake reported | ✅ |
| `docs_search` live against all sources (NeoForge 26.3, Fabric 1.20.1/26.3, Forge 26.3) | ✅ |

## 0.6 verification (2026-10-10)

| Check | Result |
|---|---|
| Mixin wiki (19 pages), MixinExtras wiki (14), Fabric wiki `tutorial:mixin*` (15), Fabric docs mixin pages (6): fetched live, every page URL HEAD/GET-checked | ✅ 53/54 reachable; the exception is one versioned Fabric page (`1.21.10/develop/mixins/bytecode`: 404 on the site, its GitHub fallback answered 503 at check time → shown as `[UNVERIFIED URL]`) |
| `docs_search` topic=mixin: "@WrapOperation" → MixinExtras `WrapOperation`; "@Inject cancellable" → Mixin wiki "Cancellable Injections" + Fabric wiki `#cancelling_the_target_method` | ✅ |

## 0.7 verification (2026-10-10, compile only)

| Check | Result |
|---|---|
| Detection without `.ffn/project.json` on 11 sample projects (copies with `.ffn` removed: Fabric 1.20.1 Mojmap + Yarn, 1.21.1, 26.3; Forge 1.20.1, 1.20.4, 1.21.1, 26.3; NeoForge 1.20.1, 1.21.1, 26.3) | ✅ loader, MC version, mappings, mod id identical to the old `project.json` |
| Same 11: `gradle_build compileJava` + `mixin_validate` (project index) | ✅ all compile, all mixins valid |
| Official MDKs: Fabric example mod (26.3, split client source set), NeoForge `MDK-1.21.1-ModDevGradle` (Parchment), `MDK-1.21.1-NeoGradle`, `MDK-Forge-1.20.1-ModDevGradle`, Forge MDK zips 1.20.1 / 1.20.4 / 1.21.1 | ✅ detected correctly (7/7) |
| Official MDKs `gradle_build compileJava` + `mixin_validate`: Fabric example mod, NeoForge 1.21.1 MDG, Forge 1.21.1, Forge 1.20.1 MDG | ✅ (the Fabric example mod's client mixin targeting `net.minecraft.client.Minecraft` first failed — client classes are in Loom's separate `clientOnly` jar; fixed by indexing both) |

## 0.8 verification (2026-10-10, compile only)

| Check | Result |
|---|---|
| `gradle_build compileJava` + `mixin_validate` on official MDKs: Fabric example mod, NeoForge 1.20.2 (NeoGradle) and 1.20.4 (MDG) with an added `@Mixin(MinecraftServer)`, Forge 1.20.1 / 1.20.4 / 1.21.1, NeoForge 1.21.1 MDG + NeoGradle, Forge 1.20.1 MDG | ✅ all compile, all valid |
| MultiLoader-Template 1.21.1 (common + fabric + neoforge + forge) | ✅ "4 mixin(s) checked in 4 subprojects", built with JDK 21 (wrapper cap) |
| NeoForge 1.20.2–1.20.4 profiles: universal jars carry Mojang names (no refmap); bundled Mixin 0.8.5 on 20.2 (max `JAVA_18`), sponge-mixin 0.13+ from 20.4 (`JAVA_22`); MixinExtras bundled since 20.2.84 | ✅ marked verified |
| Pack format from Mojang `version.json` `pack_version` (local jar or HTTP range read of the client jar's zip directory) | ✅ 1.20.1 = 15, 1.20.4 = 22/26, 1.21.1 = 34/48 |
| `source: "loader"`: NeoForge 1.20.4 (88 s first run), 1.20.2 (140 s), Forge 1.20.1 (68 s); ≈ 0.9 s cached | ✅ |
| Windows / macOS | ⚠️ not executed here: unit tests with injected platforms + a CI matrix (`.github/workflows/ci.yml`, ubuntu/windows/macos) |

## M4 verification (2026-10-10)

| Check | Result |
|---|---|
| `check_profiles` live: no outdated items. Forge 26.3 MDK reference not published; Forge 1.20.1 plugin deviation reported as info | ✅ |
| Runtime | ⚠️ not run (compile-only verification at the user's request) |
