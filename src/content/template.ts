/**
 * Tiny logic-light template language used by content templates (profiles/content/*.yaml):
 *   {{a.b}}                       value (missing value = error, so template bugs surface)
 *   {{@Alias}} / {{@a.b.C}}       class reference: rendered as a simple name, import recorded
 *   {{#if x}}..{{else}}..{{/if}}  {{#unless x}}..{{/unless}}
 *   {{#eq x "lit"}}..{{else}}..{{/eq}}   {{#ne x "lit"}}..{{/ne}}
 *   {{#each list}}{{this.name}}{{@index}}{{#unless @last}}, {{/unless}}{{/each}}
 *   {{> a.b}}                     render the string value a.b as a template (nested templates from tables)
 *   {{! comment }}
 */
export class TemplateError extends Error {}

type Node =
  | { t: "text"; v: string }
  | { t: "var"; path: string }
  | { t: "type"; name: string }
  | { t: "partial"; path: string }
  | { t: "block"; kind: string; arg: string; lit?: string; body: Node[]; alt: Node[] };

export interface RenderContext {
  /** Resolve a class reference to the text to emit (and record its import). */
  type(name: string): string;
}

const cache = new Map<string, Node[]>();

function parse(src: string): Node[] {
  const hit = cache.get(src);
  if (hit) return hit;
  const root: Node[] = [];
  const stack: { node: Extract<Node, { t: "block" }>; inAlt: boolean }[] = [];
  const push = (n: Node) => {
    const top = stack[stack.length - 1];
    (top ? (top.inAlt ? top.node.alt : top.node.body) : root).push(n);
  };
  const re = /\{\{([\s\S]*?)\}\}/g;
  let last = 0;
  for (let m = re.exec(src); m; m = re.exec(src)) {
    if (m.index > last) push({ t: "text", v: src.slice(last, m.index) });
    last = re.lastIndex;
    const tag = m[1]!.trim();
    if (tag.startsWith("!")) continue;
    if (tag.startsWith(">")) {
      push({ t: "partial", path: tag.slice(1).trim() });
      continue;
    }
    if (tag.startsWith("#")) {
      const mm = /^#(\w+)\s+(\S+)(?:\s+"([^"]*)")?$/.exec(tag);
      if (!mm) throw new TemplateError(`Bad block tag {{${tag}}}`);
      const node: Extract<Node, { t: "block" }> = { t: "block", kind: mm[1]!, arg: mm[2]!, ...(mm[3] !== undefined ? { lit: mm[3] } : {}), body: [], alt: [] };
      push(node);
      stack.push({ node, inAlt: false });
    } else if (tag === "else") {
      const top = stack[stack.length - 1];
      if (!top) throw new TemplateError("{{else}} outside a block");
      top.inAlt = true;
    } else if (tag.startsWith("/")) {
      const top = stack.pop();
      if (!top || top.node.kind !== tag.slice(1)) throw new TemplateError(`Unbalanced {{${tag}}}`);
    } else if (tag.startsWith("@") && !/^@(index|first|last)$/.test(tag)) {
      push({ t: "type", name: tag.slice(1) });
    } else {
      push({ t: "var", path: tag });
    }
  }
  if (stack.length) throw new TemplateError(`Unclosed {{#${stack[stack.length - 1]!.node.kind}}}`);
  if (last < src.length) push({ t: "text", v: src.slice(last) });
  cache.set(src, root);
  return root;
}

function lookup(scopes: unknown[], p: string): unknown {
  if (p === "this") {
    const top = scopes[scopes.length - 1];
    return top !== null && typeof top === "object" && "this" in top ? (top as { this: unknown }).this : top;
  }
  const parts = p.replace(/^this\./, "").split(".");
  const fromThis = p.startsWith("this.");
  for (let i = scopes.length - 1; i >= 0; i--) {
    let v: unknown = scopes[i];
    if (v === null || typeof v !== "object" || !(parts[0]! in (v as object))) {
      if (fromThis) return undefined;
      continue;
    }
    for (const part of parts) {
      if (v === null || v === undefined) return undefined;
      v = (v as Record<string, unknown>)[part];
    }
    return v;
  }
  return undefined;
}

function truthy(v: unknown): boolean {
  return Array.isArray(v) ? v.length > 0 : Boolean(v);
}

function run(nodes: Node[], scopes: unknown[], ctx: RenderContext, out: string[]): void {
  for (const n of nodes) {
    if (n.t === "text") out.push(n.v);
    else if (n.t === "type") {
      // [var] inside a class reference interpolates a value: {{@~.block.[Name]Block}}
      const nm = n.name.replace(/\[([\w.@]+)\]/g, (_, p: string) => {
        const v = lookup(scopes, p);
        if (v === undefined || v === null) throw new TemplateError(`Template value "${p}" is not defined`);
        return String(v);
      });
      out.push(ctx.type(nm));
    }
    else if (n.t === "partial") {
      const v = lookup(scopes, n.path);
      if (typeof v !== "string") throw new TemplateError(`Partial "${n.path}" is not a template string`);
      run(parse(v), scopes, ctx, out);
    }
    else if (n.t === "var") {
      const v = lookup(scopes, n.path);
      if (v === undefined || v === null) throw new TemplateError(`Template value "${n.path}" is not defined`);
      out.push(String(v));
    } else {
      const v = lookup(scopes, n.arg);
      if (n.kind === "if" || n.kind === "unless") {
        const cond = n.kind === "if" ? truthy(v) : !truthy(v);
        run(cond ? n.body : n.alt, scopes, ctx, out);
      } else if (n.kind === "eq" || n.kind === "ne") {
        const cond = (String(v) === n.lit) === (n.kind === "eq");
        run(cond ? n.body : n.alt, scopes, ctx, out);
      } else if (n.kind === "each") {
        const list = Array.isArray(v) ? v : [];
        if (!list.length) run(n.alt, scopes, ctx, out);
        list.forEach((item, i) => {
          const meta = { "@index": i, "@first": i === 0, "@last": i === list.length - 1 };
          const itemScope = item !== null && typeof item === "object" ? { ...meta, ...(item as object) } : meta;
          run(n.body, [...scopes, meta, Object.assign(Object.create(null), itemScope, { this: item })], ctx, out);
        });
      } else throw new TemplateError(`Unknown block {{#${n.kind}}}`);
    }
  }
}

export function render(src: string, data: unknown, ctx: RenderContext): string {
  const out: string[] = [];
  run(parse(src), [data], ctx, out);
  return out.join("");
}

/** Truthiness of a condition expression ("a.b", "!a.b", "a && b", "a || b") against data. */
export function evalCondition(expr: string, data: unknown): boolean {
  return expr.split("||").some((alt) =>
    alt.split("&&").every((term) => {
      const t = term.trim();
      const neg = t.startsWith("!");
      const v = truthy(lookup([data], neg ? t.slice(1).trim() : t));
      return neg ? !v : v;
    }),
  );
}
