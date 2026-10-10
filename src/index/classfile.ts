/**
 * Minimal JVM class-file reader: class header, fields, methods and (on demand) a walk over
 * method bytecode collecting the references Mixin injection points can target.
 * Works for any class-file version (the format is append-only).
 */

export const ACC = {
  PUBLIC: 0x0001, PRIVATE: 0x0002, PROTECTED: 0x0004, STATIC: 0x0008, FINAL: 0x0010,
  SYNCHRONIZED: 0x0020, BRIDGE: 0x0040, VARARGS: 0x0080, NATIVE: 0x0100, INTERFACE: 0x0200,
  ABSTRACT: 0x0400, SYNTHETIC: 0x1000, ANNOTATION: 0x2000, ENUM: 0x4000, RECORD_HINT: 0x10000,
} as const;

export interface MemberInfo {
  name: string;
  desc: string;
  access: number;
  signature?: string;
}

export interface MethodInfo extends MemberInfo {
  /** Offset/length of the Code attribute's bytecode within the class buffer. */
  code?: { start: number; length: number };
  localVariables?: { name: string; desc: string; index: number }[];
}

export interface ClassInfo {
  name: string;
  access: number;
  superName?: string;
  interfaces: string[];
  fields: MemberInfo[];
  methods: MethodInfo[];
  signature?: string;
  sourceFile?: string;
  major: number;
}

type Const =
  | { tag: 1; value: string }
  | { tag: 3 | 4; value: number }
  | { tag: 5 | 6; value: bigint | number }
  | { tag: 7 | 8 | 16 | 19 | 20; index: number }
  | { tag: 9 | 10 | 11; classIndex: number; natIndex: number }
  | { tag: 12; nameIndex: number; descIndex: number }
  | { tag: 15; kind: number; refIndex: number }
  | { tag: 17 | 18; bsm: number; natIndex: number }
  | undefined;

export class ClassReader {
  readonly pool: Const[] = [];
  readonly info: ClassInfo;
  private pos = 0;

  constructor(readonly buf: Buffer) {
    if (buf.readUInt32BE(0) !== 0xcafebabe) throw new Error("Not a class file");
    const major = buf.readUInt16BE(6);
    const count = buf.readUInt16BE(8);
    this.pos = 10;
    for (let i = 1; i < count; i++) {
      const tag = buf[this.pos++]!;
      switch (tag) {
        case 1: {
          const len = this.u2();
          this.pool[i] = { tag: 1, value: decodeModifiedUtf8(buf, this.pos, len) };
          this.pos += len;
          break;
        }
        case 3: this.pool[i] = { tag: 3, value: buf.readInt32BE(this.pos) }; this.pos += 4; break;
        case 4: this.pool[i] = { tag: 4, value: buf.readFloatBE(this.pos) }; this.pos += 4; break;
        case 5: this.pool[i] = { tag: 5, value: buf.readBigInt64BE(this.pos) }; this.pos += 8; i++; break;
        case 6: this.pool[i] = { tag: 6, value: buf.readDoubleBE(this.pos) }; this.pos += 8; i++; break;
        case 7: case 8: case 16: case 19: case 20: this.pool[i] = { tag, index: this.u2() }; break;
        case 9: case 10: case 11: this.pool[i] = { tag, classIndex: this.u2(), natIndex: this.u2() }; break;
        case 12: this.pool[i] = { tag: 12, nameIndex: this.u2(), descIndex: this.u2() }; break;
        case 15: this.pool[i] = { tag: 15, kind: buf[this.pos++]!, refIndex: this.u2() }; break;
        case 17: case 18: this.pool[i] = { tag, bsm: this.u2(), natIndex: this.u2() }; break;
        default: throw new Error(`Bad constant pool tag ${tag} at ${this.pos - 1}`);
      }
    }
    const access = this.u2();
    const name = this.className(this.u2())!;
    const superIdx = this.u2();
    const superName = superIdx ? this.className(superIdx) : undefined;
    const interfaces: string[] = [];
    for (let n = this.u2(); n > 0; n--) interfaces.push(this.className(this.u2())!);
    const fields: MemberInfo[] = [];
    for (let n = this.u2(); n > 0; n--) fields.push(this.member(false));
    const methods: MethodInfo[] = [];
    for (let n = this.u2(); n > 0; n--) methods.push(this.member(true));
    let signature: string | undefined;
    let sourceFile: string | undefined;
    for (let n = this.u2(); n > 0; n--) {
      const an = this.utf8(this.u2());
      const len = this.u4();
      if (an === "Signature") signature = this.utf8(buf.readUInt16BE(this.pos));
      else if (an === "SourceFile") sourceFile = this.utf8(buf.readUInt16BE(this.pos));
      this.pos += len;
    }
    this.info = { name, access, superName, interfaces, fields, methods, signature, sourceFile, major };
  }

  private u2(): number { const v = this.buf.readUInt16BE(this.pos); this.pos += 2; return v; }
  private u4(): number { const v = this.buf.readUInt32BE(this.pos); this.pos += 4; return v; }

  utf8(i: number): string {
    const c = this.pool[i];
    if (!c || c.tag !== 1) throw new Error(`Constant ${i} is not Utf8`);
    return c.value;
  }
  className(i: number): string | undefined {
    const c = this.pool[i];
    return c && c.tag === 7 ? this.utf8(c.index) : undefined;
  }
  nat(i: number): { name: string; desc: string } {
    const c = this.pool[i] as { tag: 12; nameIndex: number; descIndex: number };
    return { name: this.utf8(c.nameIndex), desc: this.utf8(c.descIndex) };
  }
  ref(i: number): { owner: string; name: string; desc: string } {
    const c = this.pool[i] as { tag: 9 | 10 | 11; classIndex: number; natIndex: number };
    return { owner: this.className(c.classIndex)!, ...this.nat(c.natIndex) };
  }

  private member(isMethod: boolean): MethodInfo {
    const access = this.u2();
    const name = this.utf8(this.u2());
    const desc = this.utf8(this.u2());
    const m: MethodInfo = { name, desc, access };
    for (let n = this.u2(); n > 0; n--) {
      const an = this.utf8(this.u2());
      const len = this.u4();
      const start = this.pos;
      if (an === "Signature") m.signature = this.utf8(this.buf.readUInt16BE(start));
      else if (isMethod && an === "Code") {
        const codeLen = this.buf.readUInt32BE(start + 4);
        m.code = { start: start + 8, length: codeLen };
        // nested attributes: LocalVariableTable
        let p = start + 8 + codeLen;
        const exLen = this.buf.readUInt16BE(p);
        p += 2 + exLen * 8;
        const attrs = this.buf.readUInt16BE(p);
        p += 2;
        for (let k = 0; k < attrs; k++) {
          const nn = this.utf8(this.buf.readUInt16BE(p));
          const l = this.buf.readUInt32BE(p + 2);
          if (nn === "LocalVariableTable") {
            const cnt = this.buf.readUInt16BE(p + 6);
            m.localVariables = [];
            for (let e = 0; e < cnt; e++) {
              const o = p + 8 + e * 10;
              m.localVariables.push({ name: this.utf8(this.buf.readUInt16BE(o + 4)), desc: this.utf8(this.buf.readUInt16BE(o + 6)), index: this.buf.readUInt16BE(o + 8) });
            }
          }
          p += 6 + l;
        }
      }
      this.pos = start + len;
    }
    return m;
  }

  /** Walk a method's bytecode and collect references usable as Mixin @At targets. */
  analyze(m: MethodInfo): CodeRefs {
    const refs: CodeRefs = { invokes: [], fields: [], news: [], constants: [], returns: 0, instanceofs: [], jumps: 0, typedConstants: [], locals: [], jumpOps: [], seq: [] };
    if (!m.code) return refs;
    const b = this.buf;
    const base = m.code.start;
    const end = base + m.code.length;
    let p = base;
    const seen = new Set<string>();
    const addOnce = <T>(list: T[], key: string, v: T) => {
      if (!seen.has(key)) {
        seen.add(key);
        list.push(v);
      }
    };
    const LT = ["I", "J", "F", "D", "A"] as const;
    const tconst = (type: TypedConstant["type"], value: string) => {
      refs.typedConstants.push({ type, value, pc: p - base });
      refs.seq.push({ pc: p - base, kind: "CONSTANT", key: `${type}:${value}` });
    };
    const local = (kind: "LOAD" | "STORE", t: number, index: number) => {
      refs.locals.push({ kind, type: LT[t]!, index, pc: p - base });
      refs.seq.push({ pc: p - base, kind, key: `${LT[t]}${index}` });
    };
    const jump = (code: number) => {
      refs.jumps++;
      refs.jumpOps.push({ opcode: code, pc: p - base });
      refs.seq.push({ pc: p - base, kind: "JUMP", key: String(code) });
    };
    while (p < end) {
      const op = b[p]!;
      switch (true) {
        case op === 0x01: tconst("null", "null"); p += 1; break;
        case op === 0x12 || op === 0x13 || op === 0x14: {
          const idx = op === 0x12 ? b[p + 1]! : b.readUInt16BE(p + 1);
          const c = this.pool[idx];
          if (c) {
            const v = c.tag === 8 ? JSON.stringify(this.utf8(c.index)) : c.tag === 7 ? `class ${this.utf8(c.index)}` : "value" in c ? String(c.value) : undefined;
            if (v !== undefined) addOnce(refs.constants, `c:${v}`, v);
            const ty = ({ 3: "int", 4: "float", 5: "long", 6: "double", 8: "string", 7: "class" } as Record<number, TypedConstant["type"]>)[c.tag];
            if (ty) tconst(ty, c.tag === 8 || c.tag === 7 ? this.utf8(c.index) : c.tag === 4 ? shortFloat(Number((c as { value: number }).value)) : String((c as { value?: unknown }).value));
          }
          p += op === 0x12 ? 2 : 3;
          break;
        }
        case op === 0x10: addOnce(refs.constants, `c:${b.readInt8(p + 1)}`, String(b.readInt8(p + 1))); tconst("int", String(b.readInt8(p + 1))); p += 2; break;
        case op === 0x11: addOnce(refs.constants, `c:${b.readInt16BE(p + 1)}`, String(b.readInt16BE(p + 1))); tconst("int", String(b.readInt16BE(p + 1))); p += 3; break;
        case op >= 0x02 && op <= 0x08: addOnce(refs.constants, `c:${op - 3}`, String(op - 3)); tconst("int", String(op - 3)); p += 1; break;
        case op === 0x09 || op === 0x0a: tconst("long", String(op - 0x09)); p += 1; break;
        case op >= 0x0b && op <= 0x0d: tconst("float", String(op - 0x0b)); p += 1; break;
        case op === 0x0e || op === 0x0f: tconst("double", String(op - 0x0e)); p += 1; break;
        case op >= 0x15 && op <= 0x19: local("LOAD", op - 0x15, b[p + 1]!); p += 2; break;
        case op >= 0x1a && op <= 0x2d: local("LOAD", Math.floor((op - 0x1a) / 4), (op - 0x1a) % 4); p += 1; break;
        case op >= 0x36 && op <= 0x3a: local("STORE", op - 0x36, b[p + 1]!); p += 2; break;
        case op >= 0x3b && op <= 0x4e: local("STORE", Math.floor((op - 0x3b) / 4), (op - 0x3b) % 4); p += 1; break;
        case op === 0x84: p += 3; break;
        case op >= 0x99 && op <= 0xa8: jump(op); p += 3; break;
        case op === 0xc6 || op === 0xc7: jump(op); p += 3; break;
        case op === 0xa9: p += 2; break;
        case op === 0xaa: {
          let q = p + 1;
          q += (4 - ((q - base) % 4)) % 4;
          const low = b.readInt32BE(q + 4);
          const high = b.readInt32BE(q + 8);
          p = q + 12 + (high - low + 1) * 4;
          break;
        }
        case op === 0xab: {
          let q = p + 1;
          q += (4 - ((q - base) % 4)) % 4;
          const n = b.readInt32BE(q + 4);
          p = q + 8 + n * 8;
          break;
        }
        case op >= 0xac && op <= 0xb1: refs.returns++; refs.seq.push({ pc: p - base, kind: "RETURN", key: "" }); p += 1; break;
        case op >= 0xb2 && op <= 0xb5: {
          const r = this.ref(b.readUInt16BE(p + 1));
          const kind = (["GETSTATIC", "PUTSTATIC", "GETFIELD", "PUTFIELD"] as const)[op - 0xb2]!;
          addOnce(refs.fields, `f:${kind}${r.owner}.${r.name}`, { ...r, opcode: kind });
          refs.seq.push({ pc: p - base, kind: "FIELD", key: `L${r.owner};${r.name}:${r.desc}`, opcode: kind });
          p += 3;
          break;
        }
        case op >= 0xb6 && op <= 0xb9: {
          const r = this.ref(b.readUInt16BE(p + 1));
          const kind = (["INVOKEVIRTUAL", "INVOKESPECIAL", "INVOKESTATIC", "INVOKEINTERFACE"] as const)[op - 0xb6]!;
          addOnce(refs.invokes, `i:${r.owner}.${r.name}${r.desc}`, { ...r, opcode: kind });
          refs.seq.push({ pc: p - base, kind: "INVOKE", key: `L${r.owner};${r.name}${r.desc}`, opcode: kind });
          p += op === 0xb9 ? 5 : 3;
          break;
        }
        case op === 0xba: p += 5; break;
        case op === 0xbb: {
          const cls = this.className(b.readUInt16BE(p + 1))!;
          addOnce(refs.news, `n:${cls}`, cls);
          refs.seq.push({ pc: p - base, kind: "NEW", key: cls });
          p += 3;
          break;
        }
        case op === 0xbc: p += 2; break;
        case op === 0xbd || op === 0xc0: p += 3; break;
        case op === 0xc1: {
          const cls = this.className(b.readUInt16BE(p + 1))!;
          addOnce(refs.instanceofs, `o:${cls}`, cls);
          p += 3;
          break;
        }
        case op === 0xc4: {
          const w = b[p + 1]!;
          if (w >= 0x15 && w <= 0x19) local("LOAD", w - 0x15, b.readUInt16BE(p + 2));
          else if (w >= 0x36 && w <= 0x3a) local("STORE", w - 0x36, b.readUInt16BE(p + 2));
          p += w === 0x84 ? 6 : 4;
          break;
        }
        case op === 0xc5: p += 4; break;
        case op === 0xc8 || op === 0xc9: jump(op); p += 5; break;
        default: p += 1;
      }
    }
    return refs;
  }
}

export interface TypedConstant {
  type: "int" | "long" | "float" | "double" | "string" | "class" | "null";
  value: string;
  pc: number;
}

export interface CodeRefs {
  /** Every constant push in order (ICONST/BIPUSH/SIPUSH/LDC/ACONST_NULL…), for @At("CONSTANT") / @ModifyConstant. */
  typedConstants: TypedConstant[];
  /** Local variable loads/stores (type I/J/F/D/A = int-like, long, float, double, reference). */
  locals: { kind: "LOAD" | "STORE"; type: "I" | "J" | "F" | "D" | "A"; index: number; pc: number }[];
  jumpOps: { opcode: number; pc: number }[];
  /** Instruction sequence of injection-relevant nodes, for @Slice ordering checks. */
  seq: { pc: number; kind: "INVOKE" | "FIELD" | "NEW" | "CONSTANT" | "JUMP" | "LOAD" | "STORE" | "RETURN"; key: string; opcode?: string }[];
  invokes: { owner: string; name: string; desc: string; opcode: string }[];
  fields: { owner: string; name: string; desc: string; opcode: string }[];
  news: string[];
  constants: string[];
  instanceofs: string[];
  returns: number;
  jumps: number;
}

/** Shortest decimal that round-trips through a 32-bit float (0.2f, not 0.20000000298023224). */
function shortFloat(v: number): string {
  if (!Number.isFinite(v)) return String(v);
  for (let p = 1; p <= 9; p++) {
    const s = String(Number(v.toPrecision(p)));
    if (Math.fround(Number(s)) === Math.fround(v)) return s;
  }
  return String(v);
}

function decodeModifiedUtf8(buf: Buffer, start: number, len: number): string {
  // Fast path: plain ASCII (almost all identifiers).
  let ascii = true;
  for (let i = start; i < start + len; i++) if (buf[i]! & 0x80) { ascii = false; break; }
  if (ascii) return buf.toString("latin1", start, start + len);
  let out = "";
  let i = start;
  const end = start + len;
  while (i < end) {
    const a = buf[i++]!;
    if (a < 0x80) out += String.fromCharCode(a);
    else if ((a & 0xe0) === 0xc0) out += String.fromCharCode(((a & 0x1f) << 6) | (buf[i++]! & 0x3f));
    else {
      const b2 = buf[i++]!;
      const c = buf[i++]!;
      out += String.fromCharCode(((a & 0x0f) << 12) | ((b2 & 0x3f) << 6) | (c & 0x3f));
    }
  }
  return out;
}

// ---- descriptor helpers ----

const PRIM: Record<string, string> = { V: "void", Z: "boolean", B: "byte", C: "char", S: "short", I: "int", J: "long", F: "float", D: "double" };
const PRIM_REV: Record<string, string> = Object.fromEntries(Object.entries(PRIM).map(([k, v]) => [v, k]));

/** Split a method descriptor into parameter and return type descriptors. */
export function parseMethodDesc(desc: string): { params: string[]; ret: string } {
  const params: string[] = [];
  let i = 1;
  while (desc[i] !== ")") {
    const s = i;
    while (desc[i] === "[") i++;
    if (desc[i] === "L") i = desc.indexOf(";", i) + 1;
    else i++;
    params.push(desc.slice(s, i));
  }
  return { params, ret: desc.slice(i + 1) };
}

/** `Lnet/minecraft/Foo$Bar;` → `net.minecraft.Foo.Bar` (Java source form; set binary=true to keep `$`). */
export function descToJava(d: string, binary = false): string {
  let dims = 0;
  while (d[dims] === "[") dims++;
  const base = d.slice(dims);
  const t = base.startsWith("L") ? base.slice(1, -1).replace(/\//g, ".") : PRIM[base] ?? base;
  return (binary ? t : t.replace(/\$/g, ".")) + "[]".repeat(dims);
}

/** `int[]` / `java.lang.String` / `net.minecraft.Foo$Bar` → descriptor. */
export function javaToDesc(t: string): string {
  let dims = 0;
  let s = t.trim();
  while (s.endsWith("[]")) { dims++; s = s.slice(0, -2); }
  return "[".repeat(dims) + (PRIM_REV[s] ?? `L${s.replace(/\./g, "/")};`);
}

export function mapDesc(desc: string, mapClass: (internal: string) => string | undefined): string {
  return desc.replace(/L([^;]+);/g, (_, c: string) => `L${mapClass(c) ?? c};`);
}

export function accessString(access: number, isMethod: boolean): string {
  const parts: string[] = [];
  if (access & ACC.PUBLIC) parts.push("public");
  if (access & ACC.PROTECTED) parts.push("protected");
  if (access & ACC.PRIVATE) parts.push("private");
  if (access & ACC.STATIC) parts.push("static");
  if (access & ACC.FINAL) parts.push("final");
  if (access & ACC.ABSTRACT && !(access & ACC.INTERFACE)) parts.push("abstract");
  if (isMethod && access & ACC.SYNCHRONIZED) parts.push("synchronized");
  if (isMethod && access & ACC.NATIVE) parts.push("native");
  if (access & ACC.SYNTHETIC) parts.push("synthetic");
  if (isMethod && access & ACC.BRIDGE) parts.push("bridge");
  return parts.join(" ");
}

/** Human-readable Java-ish signature of a method from its descriptor. */
export function methodToJava(name: string, desc: string, owner?: string): string {
  const { params, ret } = parseMethodDesc(desc);
  const n = name === "<init>" && owner ? owner.slice(owner.lastIndexOf("/") + 1).replace(/.*\$/, "") : name;
  return `${name === "<init>" ? "" : descToJava(ret) + " "}${n}(${params.map((p) => descToJava(p)).join(", ")})`;
}
