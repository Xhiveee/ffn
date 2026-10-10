import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { loadProfiles, ProfileError } from "../src/profiles/loader.js";
import { mixinCompatibilityLevel, resolveProfile, ProfileResolutionError } from "../src/profiles/resolve.js";
import { tmpDir } from "./helpers.js";

const builtin = loadConfig({}).builtinProfilesDir;
const OBF = { javaMajor: 17, obfuscated: true };
const OBF21 = { javaMajor: 21, obfuscated: true };
const UNOBF = { javaMajor: 25, obfuscated: false };

async function profiles(userDir?: string) {
  return loadProfiles(builtin, userDir ?? tmpDir());
}

describe("built-in profiles", () => {
  it("load and validate for all three loaders", async () => {
    const set = await profiles();
    expect(Object.keys(set).sort()).toEqual(["fabric", "forge", "neoforge"]);
    for (const p of Object.values(set)) expect(p!.minVersion).toBe("1.20.1");
  });

  it("resolve every loader on 1.20.1", async () => {
    const set = await profiles();
    const fabric = resolveProfile(set.fabric!, "1.20.1", OBF);
    expect(fabric).toMatchObject({ java: 17, buildSystem: "fabric-loom", verified: true, extrapolated: false });
    expect(fabric.plugin.id).toBe("net.fabricmc.fabric-loom-remap");
    expect(fabric.mappings.supported).toEqual(["mojmap", "parchment", "yarn"]);

    const forge = resolveProfile(set.forge!, "1.20.1", OBF);
    expect(forge.buildSystem).toBe("moddevgradle-legacy");
    expect(forge.metadata.file).toBe("META-INF/mods.toml");
    expect(forge.mixin).toMatchObject({ registration: "manifest", refmap: true });
    expect(forge.mixin.mixinExtras.bundled).toBe(false);

    const neo = resolveProfile(set.neoforge!, "1.20.1", OBF);
    expect(neo.loaderArtifact).toBe("net.neoforged:forge");
    expect(neo.buildSystem).toBe("moddevgradle-legacy");
  });

  it("switch NeoForge metadata file at 1.20.5 and mixin registration to mods.toml", async () => {
    const set = await profiles();
    const p4 = resolveProfile(set.neoforge!, "1.20.4", OBF);
    expect(p4.metadata.file).toBe("META-INF/mods.toml");
    expect(p4.mixin.registration).toBe("mods.toml");
    const p5 = resolveProfile(set.neoforge!, "1.20.5", OBF21);
    expect(p5.metadata.file).toBe("META-INF/neoforge.mods.toml");
    expect(p5.java).toBe(21);
    expect(p5.mixin.annotationProcessor).toBeNull();
  });

  it("pick ForgeGradle 6 then 7 for Forge, keeping Mixin at JAVA_21 on 26.x", async () => {
    const set = await profiles();
    expect(resolveProfile(set.forge!, "1.20.4", OBF).buildSystem).toBe("forgegradle6");
    expect(resolveProfile(set.forge!, "1.20.4", OBF).mixin.refmap).toBe(true);
    expect(resolveProfile(set.forge!, "1.21.1", OBF21).mixin.refmap).toBe(false);
    const p = resolveProfile(set.forge!, "26.3", UNOBF);
    expect(p.buildSystem).toBe("forgegradle7");
    expect(p.java).toBe(25);
    expect(mixinCompatibilityLevel(p)).toBe("JAVA_21");
    expect(p.verified).toBe(true);
  });

  it("use the unobfuscated Fabric rule from runtime facts, not from a version list", async () => {
    const set = await profiles();
    const p = resolveProfile(set.fabric!, "26.3", UNOBF);
    expect(p.plugin.id).toBe("net.fabricmc.fabric-loom");
    expect(p.mappings.supported).toEqual(["mojmap"]);
    expect(p.mixin.refmap).toBe(false);
    expect(mixinCompatibilityLevel(p)).toBe("JAVA_25");
  });
});

describe("future / unknown versions", () => {
  it("1.99.0 falls back to the closest lower rule with an UNVERIFIED warning", async () => {
    const set = await profiles();
    for (const loader of ["fabric", "forge", "neoforge"] as const) {
      // 1.99.0 sorts between 1.21.11 and 26.1 but is not a real release.
      const p = resolveProfile(set[loader]!, "1.99.0", { javaMajor: 21, obfuscated: true, known: false });
      expect(p.extrapolated).toBe(true);
      expect(p.verified).toBe(false);
      expect(p.warnings.join(" ")).toMatch(/UNVERIFIED/);
      expect(p.warnings.join(" ")).toMatch(/1\.99\.0/);
    }
    const forge = resolveProfile(set.forge!, "1.99.0", { javaMajor: 21, obfuscated: true, known: false });
    expect(forge.basedOn).toBe("1.21.11");
    expect(forge.buildSystem).toBe("forgegradle7");
  });

  it("a real version newer than testedUpTo is extrapolated even when Mojang knows it", async () => {
    const set = await profiles();
    const p = resolveProfile(set.fabric!, "26.4", { javaMajor: 25, obfuscated: false, known: true });
    expect(p.extrapolated).toBe(true);
    expect(p.plugin.id).toBe("net.fabricmc.fabric-loom");
    expect(p.warnings[0]).toMatch(/newer than the newest version/);
  });

  it("27.1 (unobfuscated, newer Java) resolves from facts + latest rules", async () => {
    const set = await profiles();
    const p = resolveProfile(set.neoforge!, "27.1", { javaMajor: 29, obfuscated: false });
    expect(p.java).toBe(29);
    expect(p.extrapolated).toBe(true);
    expect(p.basedOn).toBe("1.21.11");
    expect(p.metadata.file).toBe("META-INF/neoforge.mods.toml");
  });

  it("missing facts produce a warning instead of a crash", async () => {
    const set = await profiles();
    const p = resolveProfile(set.fabric!, "1.21.1", {});
    expect(p.java).toBe(21);
    expect(p.warnings.join(" ")).toMatch(/Java version could not be read/);
  });

  it("versions older than minVersion are rejected", async () => {
    const set = await profiles();
    expect(() => resolveProfile(set.forge!, "1.19.4", OBF)).toThrow(ProfileResolutionError);
  });
});

describe("user profiles", () => {
  it("can add a rule for a new version and raise testedUpTo without code changes", async () => {
    const dir = tmpDir();
    writeFileSync(
      path.join(dir, "forge-1.99.yaml"),
      `loader: forge
testedUpTo: "1.99.0"
rules:
  - since: "1.99.0"
    description: hypothetical future Forge
    verified: ["1.99.0"]
    set:
      gradle: { version: "10.0" }
      packMeta: { kind: min_max, format: 200 } # explicit format still overrides version.json
      addNotes: ["custom rule"]
`,
    );
    const set = await profiles(dir);
    const p = resolveProfile(set.forge!, "1.99.0", { javaMajor: 21, obfuscated: true, known: true });
    expect(p.extrapolated).toBe(false);
    expect(p.verified).toBe(true);
    expect(p.gradle.version).toBe("10.0");
    expect(p.packMeta.format).toBe(200);
    expect(p.notes).toContain("custom rule");
    expect(p.basedOn).toBe("1.99.0");
    // Older versions are untouched
    expect(resolveProfile(set.forge!, "1.20.1", OBF).gradle.version).toBe("8.14.5");
  });

  it("supports bounded rules with `until`", async () => {
    const dir = tmpDir();
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      path.join(dir, "fabric.yaml"),
      `loader: fabric
rules:
  - since: "1.21"
    until: "1.21.4"
    set: { gradle: { version: "8.99" } }
`,
    );
    const set = await profiles(dir);
    expect(resolveProfile(set.fabric!, "1.21.3", OBF21).gradle.version).toBe("8.99");
    expect(resolveProfile(set.fabric!, "1.21.5", OBF21).gradle.version).not.toBe("8.99");
  });

  it("reports schema errors with the file and field path", async () => {
    const dir = tmpDir();
    writeFileSync(path.join(dir, "bad.yaml"), `loader: forge\nrules:\n  - since: "1.21"\n    set: { buildSystem: maven }\n`);
    await expect(profiles(dir)).rejects.toThrow(ProfileError);
    await expect(profiles(dir)).rejects.toThrow(/bad\.yaml[\s\S]*buildSystem/);
  });

  it("rejects malformed version ranges", async () => {
    const dir = tmpDir();
    writeFileSync(path.join(dir, "bad.yaml"), `loader: forge\nrules:\n  - since: "latest"\n    set: {}\n`);
    await expect(profiles(dir)).rejects.toThrow(/since/);
  });
});
