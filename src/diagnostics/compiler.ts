/**
 * Compiler diagnostics (javac via Gradle or Maven, Kotlin) → grouped, compact errors.
 * Shared by the build tool and analyze_crash through diagnose(); the same file is used by FFN and BSP,
 * only the hints (which tools to suggest) are passed in by the caller.
 */

export type CompilerCode =
  | "cannot_find_symbol"
  | "package_missing"
  | "incompatible_types"
  | "cannot_apply"
  | "no_suitable_method"
  | "cannot_access"
  | "not_abstract"
  | "bad_override"
  | "private_access"
  | "unreported_exception"
  | "unresolved_reference"
  | "other";

export interface CompilerMessage {
  severity: "error" | "warning";
  lang: "java" | "kotlin";
  code: CompilerCode;
  /** The compiler's message (first line). */
  text: string;
  file: string;
  line: number;
  col?: number;
  symbol?: { kind: string; name: string };
  location?: string;
  required?: string;
  found?: string;
  reason?: string;
  /** The offending source line javac echoes (trimmed). */
  source?: string;
  evidence: string;
}

export interface CompilerGroup extends CompilerMessage {
  /** Number of distinct places with this error. */
  count: number;
  /** Further places ("Foo.java:31"), capped. */
  also: string[];
}

/** Per-tool hints: given a grouped error, return a short suggestion or undefined. */
export type CompilerHints = (g: CompilerGroup) => string | undefined;

/** Remove ANSI colours, CI timestamps, task/log prefixes and indentation that Gradle/Maven/CI add around compiler lines. */
export function cleanLine(raw: string): string {
  return raw
    .replace(/\x1b\[[0-9;]*[A-Za-z]/g, "")
    .replace(/\r$/, "")
    .replace(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z\s/, "")
    .replace(/^\s*\[ant:javac\]\s*/, "")
    .trim();
}

const SRC = String.raw`((?:[A-Za-z]:)?[^:\[\]]*?\.(?:java|kts?))`;
// javac localises the label ("error", "ошибка", "Fehler", "エラー", "错误"…), so any short label is accepted.
const JAVAC = new RegExp(String.raw`^(?:\[(?:ERROR|WARNING|WARN)\]\s+)?${SRC}:(\d+):(?:(\d+):)?\s*([^\s:][^:]{0,24}?):\s*(.+)$`);
const WARN_LABEL = /^(?:warning|предупреждение|Warnung|警告|avertissement|avvertenza|advertencia|aviso|ostrzeżenie)$/i;
const MAVEN = new RegExp(String.raw`^\[(ERROR|WARNING|WARN)\]\s+${SRC}:\[(\d+),(\d+)\]\s*(.+)$`);
const KOTLIN = /^(e|w):\s+(?:file:\/\/)?(.+?\.kts?):(\d+):(\d+):?\s+(.+)$/;
const KOTLIN_OLD = /^(e|w):\s+(.+?\.kts?):\s*\((\d+),\s*(\d+)\):\s*(.+)$/;

interface Head { severity: "error" | "warning"; lang: "java" | "kotlin"; file: string; line: number; col?: number; text: string }

function head(l: string): Head | undefined {
  let m: RegExpExecArray | null;
  if ((m = MAVEN.exec(l))) return { severity: m[1] === "ERROR" ? "error" : "warning", lang: m[2]!.endsWith(".java") ? "java" : "kotlin", file: m[2]!, line: Number(m[3]), col: Number(m[4]), text: m[5]!.trim() };
  if ((m = JAVAC.exec(l))) return { severity: WARN_LABEL.test(m[4]!) ? "warning" : "error", lang: m[1]!.endsWith(".java") ? "java" : "kotlin", file: m[1]!, line: Number(m[2]), col: m[3] ? Number(m[3]) : undefined, text: m[5]!.trim() };
  if ((m = KOTLIN.exec(l)) || (m = KOTLIN_OLD.exec(l))) {
    const file = m[2]!.replace(/^\/([A-Za-z]:\/)/, "$1");
    return { severity: m[1] === "e" ? "error" : "warning", lang: "kotlin", file, line: Number(m[3]), col: Number(m[4]), text: m[5]!.trim() };
  }
  return undefined;
}

/** English plus the javac translations shipped with the JDK (ru, de, ja, zh_CN) for the common messages. */
const CODES: [CompilerCode, RegExp][] = [
  ["cannot_find_symbol", /^(?:cannot find symbol|не удается найти символ|Symbol nicht gefunden|シンボルを見つけられません|找不到符号)/],
  ["package_missing", /^(?:package \S+ does not exist|пакет \S+ не существует|Package \S+ (?:ist nicht vorhanden|existiert nicht)|パッケージ\S+は存在しません|程序包\S+不存在)/],
  ["incompatible_types", /^(?:incompatible types|несовместимые типы|[Ii]nkompatible Typen|不適合な型|不兼容的类型)/],
  ["cannot_apply", /cannot be applied to given types|не может быть применен|kann nicht auf die angegebenen Typen angewendet werden|指定された型に適用できません|无法应用到给定类型/],
  ["no_suitable_method", /^(?:no suitable (?:method|constructor) found for|не найден подходящий (?:метод|конструктор)|Keine geeignete (?:Methode|Konstruktor) gefunden)/],
  ["cannot_access", /^(?:cannot access |не удается получить доступ к |Kein Zugriff auf |\S+にアクセスできません|无法访问)/],
  ["not_abstract", /is not abstract and does not override abstract method|не является абстрактным и не переопределяет абстрактный метод|ist nicht abstrakt und überschreibt nicht die abstrakte Methode/],
  ["bad_override", /^(?:method does not override or implement a method from a supertype|метод не переопределяет и не реализует метод из супертипа|Methode überschreibt oder implementiert keine Methode aus einem Supertyp)/],
  ["private_access", /has private access in|имеет закрытый доступ в|hat private Zugriff in|private アクセスされます|在 \S+ 中是 private 访问控制/],
  ["unreported_exception", /^(?:unreported exception|незарегистрированное исключение|Nicht gemeldete Ausnahme|例外\S+は報告されません|未报告的异常错误)/],
  ["unresolved_reference", /^Unresolved reference/],
];
function classify(text: string): CompilerCode {
  return CODES.find(([, re]) => re.test(text))?.[0] ?? "other";
}

const KIND: Record<string, string> = {
  класс: "class", Klasse: "class", クラス: "class", 类: "class", метод: "method", Methode: "method", メソッド: "method", 方法: "method",
  переменная: "variable", Variable: "variable", 変数: "variable", 变量: "variable", пакет: "package", Package: "package", パッケージ: "package", 程序包: "package",
  интерфейс: "interface", Schnittstelle: "interface", インタフェース: "interface", 接口: "interface",
};
const SYMBOL = /^(?:symbol|символ|Symbol|シンボル|符号)\s*:\s+(\S+)\s+(.+)$/;
const LOCATION = /^(?:location|расположение|местоположение|Ort|場所|位置)\s*:\s+(.+)$/;
const REQUIRED = /^(?:required|требуется|Erforderlich|期待値|需要)\s*:\s+(.+)$/i;
const FOUND = /^(?:found|найдено|Ermittelt|検出値|找到)\s*:\s+(.+)$/i;
const REASON = /^(?:reason|причина|Grund|理由|原因)\s*:\s+(.+)$/i;

/** Location text in English: "переменная player типа X" → "variable player of type X". */
function normLocation(loc: string): string {
  return loc
    .replace(/^(\S+)/, (w) => KIND[w] ?? w)
    .replace(/ (?:типа|vom Typ|型|类型为) /, " of type ");
}

/** Parse all compiler messages. `consumed` holds the indices of lines that belong to them. */
export function parseCompilerOutput(lines: string[]): { messages: CompilerMessage[]; consumed: Set<number> } {
  const messages: CompilerMessage[] = [];
  const consumed = new Set<number>();
  for (let i = 0; i < lines.length; i++) {
    const l = cleanLine(lines[i]!);
    const h = head(l);
    if (!h) continue;
    consumed.add(i);
    const msg: CompilerMessage = { ...h, code: classify(h.text), evidence: l };
    let m: RegExpExecArray | null;
    if (msg.code === "unresolved_reference" && (m = /Unresolved reference:?\s*'?([\w$]+)'?/.exec(h.text))) msg.symbol = { kind: "reference", name: m[1]! };
    for (let j = i + 1; j < Math.min(lines.length, i + 10); j++) {
      const c = cleanLine(lines[j]!);
      const d = c.replace(/^\[(?:ERROR|WARNING|INFO)\]\s*/, "");
      if (head(c) || /^\d+\s*\S{0,12}$/.test(d) || /^(?:\* |> |FAILURE|BUILD |Note: |Примечание: |Hinweis: |注: |注意: )/.test(d)) break;
      consumed.add(j);
      if ((m = SYMBOL.exec(d))) msg.symbol = { kind: KIND[m[1]!] ?? m[1]!, name: m[2]!.trim() };
      else if ((m = LOCATION.exec(d))) msg.location = normLocation(m[1]!.trim());
      else if ((m = REQUIRED.exec(d))) msg.required = m[1]!.trim();
      else if ((m = FOUND.exec(d))) msg.found = m[1]!.trim();
      else if ((m = REASON.exec(d))) msg.reason = m[1]!.trim();
      else if (/^(?:class file for \S+ not found|bad class file|class file has wrong version)/.test(d)) msg.reason = msg.reason ? `${msg.reason}; ${d}` : d;
      else if (!msg.source && d && !/^\^+$/.test(d) && msg.lang === "java") msg.source = d;
    }
    messages.push(msg);
  }
  return { messages, consumed };
}

const base = (f: string) => f.split(/[\\/]/).pop() ?? f;

/** Merge duplicates (Gradle prints every error twice since 8.11) and group the same error at different places. */
export function groupCompilerMessages(messages: CompilerMessage[], maxAlso = 4): CompilerGroup[] {
  const seen = new Set<string>();
  const groups = new Map<string, CompilerGroup & { places: string[] }>();
  for (const m of messages) {
    const place = `${m.file}:${m.line}`;
    const exact = `${place}|${m.text}|${m.symbol?.name ?? ""}`;
    if (seen.has(exact)) continue;
    seen.add(exact);
    const key = m.symbol || m.code === "package_missing" ? `${m.severity}|${m.code}|${m.symbol?.kind ?? ""}|${m.symbol?.name ?? m.text}` : `${m.severity}|${m.text}|${place}`;
    const g = groups.get(key);
    if (!g) groups.set(key, { ...m, count: 1, also: [], places: [] });
    else {
      g.count++;
      g.places.push(`${base(m.file)}:${m.line}`);
      if (!g.location && m.location) g.location = m.location;
    }
  }
  return [...groups.values()].map(({ places, ...g }) => ({ ...g, also: places.length > maxAlso ? [...places.slice(0, maxAlso), `+${places.length - maxAlso} more`] : places }));
}

/** One compact line: "cannot find symbol: class Identifier (in package net.minecraft.util) ×3". */
export function describeCompiler(g: CompilerGroup): string {
  let s: string;
  if (g.code === "cannot_find_symbol" && g.symbol) s = `cannot find symbol: ${g.symbol.kind} ${g.symbol.name}${g.location ? ` (in ${g.location})` : ""}`;
  else if (g.code === "unresolved_reference" && g.symbol) s = `Unresolved reference: ${g.symbol.name}`;
  else {
    s = g.text.replace(/;$/, "");
    if (g.required || g.found) s += ` (required: ${g.required ?? "?"}; found: ${g.found ?? "?"})`;
    if (g.reason) s += ` — ${g.reason}`;
  }
  if (g.code === "package_missing" && g.source && /^import /.test(g.source)) s += ` [${g.source.replace(/;$/, "")}]`;
  return g.count > 1 ? `${s} ×${g.count}` : s;
}

/** Names referenced by an error: symbol/member name, owner type, package, imported class. */
export function compilerNames(g: CompilerGroup): { name?: string; owner?: string; pkg?: string; imported?: string } {
  let name = g.symbol?.name.replace(/\(.*$/, "");
  let owner = /(?:of type|class|interface|enum|record)\s+([\w.$]+)(?:<.*)?$/.exec(g.location ?? "")?.[1];
  let m: RegExpExecArray | null;
  if ((m = /^(?:method|constructor|метод|конструктор|Methode|Konstruktor) ([\w$<>]+) (?:in|в|in der) (?:class|interface|enum|record|классе|интерфейсе|перечислении|записи|Klasse|Schnittstelle) ([\w.$]+)/.exec(g.text))) [name, owner] = [m[1], m[2]];
  else if ((m = /^no suitable (?:method|constructor) found for ([\w$<>]+)/.exec(g.text))) name = m[1];
  else if ((m = /does not override abstract method ([\w$]+)\(.*?\) in ([\w.$]+)/.exec(g.text))) [name, owner] = [m[1], m[2]];
  else if ((m = /^([\w$]+)(?:\(.*?\))? has private access in ([\w.$]+)/.exec(g.text))) [name, owner] = [m[1], m[2]];
  const pkg = /^package (\S+?)(?: does not exist)?$/.exec(g.code === "package_missing" ? g.text : g.location ?? "")?.[1];
  const imported = g.source && /^import (?:static )?([\w.$]+);/.exec(g.source)?.[1];
  return { name, owner, pkg, imported: imported || undefined };
}
