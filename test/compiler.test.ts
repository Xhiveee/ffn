import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { groupCompilerMessages, parseCompilerOutput } from "../src/diagnostics/compiler.js";
import { diagnose } from "../src/diagnostics/parse.js";

const fx = (f: string) => readFileSync(path.join(__dirname, "fixtures", "logs", f), "utf8");
const compile = (text: string) => diagnose(text).findings.filter((f) => f.kind === "compile_error");

describe("compiler errors (shared by gradle_build and analyze_crash)", () => {
  it("Gradle 8.11+ output: groups duplicates from the failure summary and repeated symbols", () => {
    const d = diagnose(fx("gradle-javac-linux.log"));
    const errs = d.findings.filter((f) => f.kind === "compile_error");
    expect(d.findings.some((f) => f.kind === "gradle_failure")).toBe(false);
    expect(errs).toHaveLength(11);
    const ident = errs[0]!;
    expect(ident.message).toBe("cannot find symbol: class Identifier (in package net.minecraft.util) ×3");
    expect(ident.file).toMatch(/ExampleMod\.java$/);
    expect(ident.line).toBe(5);
    expect(ident.also).toEqual(["ExampleMod.java:31", "ClientThing.java:9"]);
    expect(ident.suggestion).toMatch(/Yarn name.*ResourceLocation.*translate_mapping name=Identifier from=yarn/);
    const by = (re: RegExp) => errs.find((f) => re.test(f.message))!;
    expect(by(/m_6469_/).suggestion).toMatch(/SRG name: translate_mapping name=m_6469_ from=srg/);
    expect(by(/getServerWorld/).suggestion).toMatch(/get_class className=net\.minecraft\.server\.level\.ServerPlayer memberFilter=getServerWorld/);
    expect(by(/does not exist/).message).toMatch(/\[import net\.minecraft\.world\.level\.storage\.loot\.functions\.foo\.Bar\]/);
    expect(by(/does not exist/).suggestion).toMatch(/search_mc_source query=Bar/);
    expect(by(/cannot be applied/).message).toBe("method hurt in class Entity cannot be applied to given types (required: DamageSource,float; found: float) — actual and formal argument lists differ in length");
    expect(by(/cannot be applied/).suggestion).toMatch(/get_class className=Entity method=hurt/);
    expect(by(/is not abstract/).suggestion).toMatch(/className=BaseEntityBlock method=codec/);
    expect(by(/private access/)).toBeTruthy();
    expect(by(/unreported exception IOException/)).toBeTruthy();
    expect(by(/incompatible types: int cannot be converted to String/).suggestion).toBeUndefined();
    expect(by(/cannot access Codec/).message).toMatch(/class file for com\.mojang\.serialization\.Codec not found/);
    expect(by(/does not override or implement/)).toBeTruthy();
  });

  it("Windows paths and CRLF", () => {
    const d = diagnose(fx("gradle-javac-windows.log"));
    const errs = d.findings.filter((f) => f.kind === "compile_error");
    expect(errs).toHaveLength(1);
    expect(errs[0]!.file).toBe("C:\\Users\\Alex\\mods\\examplemod\\src\\main\\java\\com\\example\\examplemod\\ExampleMod.java");
    expect(errs[0]!.line).toBe(5);
    expect(errs[0]!.message).toBe("cannot find symbol: class Identifier (in package net.minecraft.util) ×2");
    expect(errs[0]!.message).not.toMatch(/\r/);
    expect(d.findings.some((f) => f.kind === "gradle_failure")).toBe(false);
  });

  it("Maven-style [ERROR] path:[line,col] with Windows and Linux paths, summary repeat deduped", () => {
    expect(diagnose(fx("maven-javac.log")).source).toBe("maven");
    const errs = compile(fx("maven-javac.log"));
    expect(errs.map((f) => [f.file, f.line, f.message])).toEqual([
      ["C:\\dev\\myplugin\\src\\main\\java\\me\\alex\\MyPlugin.java", 14, "cannot find symbol: class EntityPlayer (in package net.minecraft.server.level) ×2"],
      ["/home/alex/myplugin/src/main/java/me/alex/Util.java", 8, "package org.bukkit.craftbukkit.v1_20_R3.entity does not exist"],
    ]);
  });

  it("Kotlin unresolved references (file:// URIs, Windows drive)", () => {
    const errs = compile(fx("gradle-kotlin.log"));
    expect(errs.map((f) => [f.file, f.line, f.message])).toEqual([
      ["/home/alex/mods/kmod/src/main/kotlin/com/example/KMod.kt", 12, "Unresolved reference: Identifier"],
      ["C:/Users/Alex/kmod/src/main/kotlin/com/example/KMod.kt", 15, "Unresolved reference: MinecraftClient"],
    ]);
    expect(errs[1]!.suggestion).toMatch(/Yarn name; Mojang mappings call it Minecraft/);
  });

  it("ANSI colours, CI timestamps and the own-code case without hints", () => {
    const text = "2026-10-10T12:00:00.1234567Z \x1b[31m/w/src/Foo.java:3: error: cannot find symbol\x1b[0m\n        bar();\n        ^\n  symbol:   method bar()\n  location: class com.acme.Foo\n1 error\n";
    const [e] = compile(text);
    expect(e).toMatchObject({ file: "/w/src/Foo.java", line: 3, message: "cannot find symbol: method bar() (in class com.acme.Foo)" });
    expect(e!.suggestion).toBeUndefined();
  });

  it("caps further places", () => {
    const text = Array.from({ length: 9 }, (_, i) => `/p/A${i}.java:${i + 1}: error: cannot find symbol\n  symbol:   class Identifier\n  location: class A${i}`).join("\n");
    const [g] = groupCompilerMessages(parseCompilerOutput(text.split("\n")).messages);
    expect(g!.count).toBe(9);
    expect(g!.also).toEqual(["A1.java:2", "A2.java:3", "A3.java:4", "A4.java:5", "+4 more"]);
  });
});

describe("localised javac (Russian Windows, CRLF)", () => {
  it("recognises the Russian labels and normalises symbol/location", () => {
    const d = diagnose(fx("gradle-javac-ru-windows.log"));
    expect(d.findings.some((f) => f.kind === "gradle_failure")).toBe(false);
    const errs = d.findings.filter((f) => f.kind === "compile_error");
    expect(errs.map((f) => [f.line, f.message])).toEqual([
      [5, "cannot find symbol: class Identifier (in package net.minecraft.util)"],
      [44, "cannot find symbol: method getServerWorld() (in variable player of type net.minecraft.server.level.ServerPlayer)"],
      [52, "метод hurt в классе Entity не может быть применен к указанным типам (required: DamageSource,float; found: float) — фактический и формальный списки аргументов различаются по длине"],
      [60, "несовместимые типы: int нельзя преобразовать в String"],
    ]);
    expect(errs[0]!.file).toBe("C:\\Users\\Алексей\\mods\\examplemod\\src\\main\\java\\com\\example\\examplemod\\ExampleMod.java");
    expect(errs[0]!.suggestion).toMatch(/translate_mapping name=Identifier from=yarn/);
    expect(errs[1]!.suggestion).toMatch(/get_class className=net\.minecraft\.server\.level\.ServerPlayer memberFilter=getServerWorld/);
    expect(errs[2]!.suggestion).toMatch(/get_class className=Entity method=hurt/);
  });
});
