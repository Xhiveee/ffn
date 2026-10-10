# FFN

MCP-сервер для разработки модов Minecraft (Forge, Fabric, NeoForge, 1.20.1 → новейшая версия): настоящие классы игры и загрузчика, маппинги, проверка миксинов, сборка и документация для AI-агента.

## Требования

- Node.js 20+.
- JDK 17+ для индекса исходников (декомпиляция, ремаппинг). Для сборки модов нужна JDK под версию Minecraft (17 / 21 / 25). FFN сам находит установленные JDK; если они лежат в нестандартном месте, задайте `FFN_JDKS`.
- git не обязателен. С ним быстрее скачиваются вики по Mixin.

## Установка

```sh
git clone https://github.com/Xhiveee/ffn.git
cd ffn
npm install
npm run build      # → dist/index.js
npm test           # необязательно
```

## Подключение к MCP-клиенту

FFN работает через stdio. В любом клиенте укажите команду `node` и **абсолютный** путь к `dist/index.js`:

```json
{
  "mcpServers": {
    "ffn": {
      "command": "node",
      "args": ["/home/you/ffn/dist/index.js"],
      "env": { "FFN_OFFLINE": "0" }
    }
  }
}
```

Блок `env` можно не указывать. На Windows путь пишется так: `"args": ["C:\\Users\\you\\ffn\\dist\\index.js"]`.

**Cursor:** файл `.cursor/mcp.json` в проекте или `~/.cursor/mcp.json` для всех проектов.

```json
{ "mcpServers": { "ffn": { "type": "stdio", "command": "node", "args": ["/home/you/ffn/dist/index.js"] } } }
```

**Claude Desktop:** Settings → Developer → Edit Config. Это файл `~/Library/Application Support/Claude/claude_desktop_config.json` на macOS или `%APPDATA%\Claude\claude_desktop_config.json` на Windows. Формат `mcpServers` такой же, как выше. После правки полностью перезапустите приложение.

**Claude Code:**

```sh
claude mcp add --transport stdio --scope user ffn -- node /home/you/ffn/dist/index.js
```

**VS Code (Copilot):** файл `.vscode/mcp.json`. Обратите внимание: здесь ключ `servers`, а не `mcpServers`.

```json
{ "servers": { "ffn": { "type": "stdio", "command": "node", "args": ["/home/you/ffn/dist/index.js"] } } }
```

Другой вариант — переносимый `.mcp.json` в корне проекта с ключом `mcpServers`.

**Codex CLI:** выполните `codex mcp add ffn -- node /home/you/ffn/dist/index.js` или добавьте сервер в `~/.codex/config.toml`:

```toml
[mcp_servers.ffn]
command = "node"
args = ["/home/you/ffn/dist/index.js"]
# env = { FFN_OFFLINE = "1" }
```

## Переменные окружения

| Переменная | Назначение | По умолчанию |
|---|---|---|
| `FFN_CACHE_DIR` | Кэш: версии, jar-файлы, индексы, документация | `~/.cache/ffn`; macOS `~/Library/Caches/ffn`; Windows `%LOCALAPPDATA%\ffn` |
| `FFN_PROFILES_DIR` | Пользовательские профили версий | `~/.config/ffn/profiles`; macOS `~/Library/Application Support/ffn/profiles`; Windows `%APPDATA%\ffn\profiles` |
| `FFN_OFFLINE` | `1` или `true`: только кэш, без сети | выключено |
| `FFN_CACHE_TTL_MINUTES` | Как долго кэшированные списки версий считаются свежими | `360` |
| `FFN_JDKS` | Дополнительные JDK (пути через `:`, на Windows через `;`) | — |
| `GITHUB_TOKEN` | Повышает лимит запросов к GitHub для `docs_search` | — |

## Инструменты (11)

- `list_versions` (`mcVersion?`, `includeSnapshots?`) — версии Minecraft и есть ли под них загрузчики; с `mcVersion` — версии загрузчиков, Java и Gradle-плагина.
- `get_profile` (`mcVersion`, `loader`) — что нужно для сборки: Java, Gradle-плагин, файл метаданных, маппинги, правила Mixin, pack format.
- `gradle_build` (`projectDir`, `tasks?`) — запускает Gradle с подходящей JDK и возвращает ошибки в виде `файл:строка`.
- `search_mc_source` (`query`, `kind`: имена / `text` / `usages` / `callees` / `packages`, `mcVersion` или `projectDir`, `source?`) — поиск классов и методов, текста в исходниках, кто вызывает метод (`usages`) и что вызывает он сам (`callees`), обзор пакета: подпакеты и классы (`packages`, `query: "."` — корень).
- `get_class` (`className`, `method?`, `detail`: `outline` / `hierarchy` / `full`) — класс кратко (outline), исходник одного метода, иерархия и переопределения или полный исходник постранично.
- `translate_mapping` (`mcVersion`, `name`, `from`, `to?`) — перевод имён между Mojmap, Yarn, Intermediary, SRG и obf.
- `mixin_targets` (`targetClass`, `methodFilter?`) — готовые селекторы и точки инъекции; сначала подсказывает подходящие события загрузчика.
- `mixin_validate` (`projectDir`, `mixinClass?`) — проверяет миксины проекта по реальным классам.
- `analyze_crash` (`log`, `path` или `projectDir`) — разбирает крэш или лог: причина, мод-виновник, как исправить.
- `docs_search` (`query`, `loader?`, `mcVersion?`, `topic?` — например `mixin`) — поиск по документации Fabric, Forge и NeoForge под нужную версию, праймерам NeoForged и вики по Mixin.
- `check_profiles` (`loaders?`) — сверяет профили FFN с официальными MDK и новыми релизами; предлагает YAML-патчи, сам ничего не меняет.

`source: "loader"` — классы с патчами Forge/NeoForge без своего проекта: FFN использует кэшированный официальный MDK, первый запуск занимает несколько минут.
Проект указывается через `projectDir` (корень или подпроект; многомодульные сборки поддерживаются). Загрузчик, версию и маппинги FFN определяет по файлам сборки.

## Профиль для новой версии Minecraft

Обычно ничего делать не нужно: новые версии подхватываются автоматически, с предупреждением `UNVERIFIED`. Если что-то действительно изменилось, положите YAML-файл в `FFN_PROFILES_DIR`, например `neoforge-27.1.yaml`:

```yaml
loader: neoforge
testedUpTo: "27.1"
rules:
  - since: "27.1"
    set: { metadata: { file: META-INF/neoforge.mods.toml } }
```

Перезапускать сервер не нужно. Формат правил описан в [docs/reference.md](docs/reference.md#adding-a-profile-for-a-new-minecraft-version).

## Шаблон AGENTS.md

Готовые правила для агента: без JavaDoc и комментариев, плоская структура, проверка API через этот MCP, сборка, коммит и версия после каждой фичи. Скопируй [templates/AGENTS.md](templates/AGENTS.md) в корень своего проекта (для Claude Code назови `CLAUDE.md`):

```
curl -o AGENTS.md https://raw.githubusercontent.com/Xhiveee/ffn/main/templates/AGENTS.md
```

## Подробнее

- [docs/reference.md](docs/reference.md) — как работают инструменты, определение проекта, архитектура.
- [docs/limitations.md](docs/limitations.md) — известные ограничения.
- [docs/verification.md](docs/verification.md) — что и как проверялось.
- [docs/token-economy.md](docs/token-economy.md) — замеры токенов и времени запуска.

## English (short)

FFN is an MCP (stdio) server that gives AI agents real Minecraft/loader classes, mappings, mixin checks, Gradle builds and docs for Forge/Fabric/NeoForge 1.20.1+. To install: `git clone https://github.com/Xhiveee/ffn.git && cd ffn && npm install && npm run build`. To connect, use `node /abs/path/ffn/dist/index.js` in your MCP client (snippets above). Node 20+ and a JDK 17+ are required; git is optional. Details are in [docs/](docs/reference.md).

Лицензия: MIT.
