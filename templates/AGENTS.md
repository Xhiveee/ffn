# AGENTS.md

Minecraft mod (Forge / Fabric / NeoForge).

## Code
- No JavaDoc, no comments. Only exception: one line explaining WHY for a non-obvious hack or workaround.
- Clear names instead of comments. No speculative abstractions, interfaces or factories.
- Don't touch code unrelated to the task.
- No new dependencies unless required.

## Structure
- Flat structure. Never create a package for one or two classes.
- Add packages only when there are many classes of one kind (`block/`, `item/`, `entity/`, `mixin/`, `client/`).
- Small related types (records, enums, nested classes) may share a file.
- Keep the project's existing structure.

## Minecraft and loader API
- Never guess Minecraft or loader class/method names. Verify with the FFN MCP: `search_mc_source`, `get_class`, `translate_mapping`.
- Read Minecraft version, loader and mappings from project files (`gradle.properties`, `build.gradle`). Don't change them unless asked.
- Use the loader's API and events first. Use Mixins only when no API exists; validate every mixin with `mixin_validate`.
- Keep client-only code out of common/server code.
- Register content the loader's standard way (DeferredRegister on Forge/NeoForge, Registry on Fabric).

## Verification
- After changes, run `gradlew build` and fix all compile errors. On failure use `analyze_crash`.
- Don't launch the client or server unless asked.

## Git
- After every finished feature or fix: build passes, then commit with a short message.
- Bump `mod_version` in `gradle.properties`: fix 1.0.0 -> 1.0.1, feature 1.0.0 -> 1.1.0.
- Never push, rewrite history or delete branches unless asked.

## Replies
- Short: what changed, which files, does it build. Don't restate the code.
