import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { mcFromLoaderVersion, readProjectInfo, stripComments } from "../src/project/info.js";
import { tmpDir } from "./helpers.js";

/** A project directory with the given files (paths relative to the root); no .ffn/project.json. */
function project(files: Record<string, string>): string {
  const dir = tmpDir("ffn-proj-");
  for (const [rel, text] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    writeFileSync(path.join(dir, rel), text);
  }
  return dir;
}

describe("project detection from the project's own files (official MDK layouts)", () => {
  it("Fabric example mod: Loom plugin + minecraft_version; mod id from fabric.mod.json", async () => {
    const dir = project({
      "build.gradle": "plugins {\n  id 'net.fabricmc.fabric-loom' version \"${loom_version}\"\n}\ndependencies {\n  minecraft \"com.mojang:minecraft:${project.minecraft_version}\"\n}\n",
      "gradle.properties": "minecraft_version=26.3\nloader_version=0.19.5\narchives_base_name=example-mod\n",
      "src/main/resources/fabric.mod.json": '{ "id": "modid", "mixins": ["modid.mixins.json"] }',
      "src/main/resources/modid.mixins.json": "{}",
    });
    const i = await readProjectInfo(dir);
    expect(i).toMatchObject({ source: "inferred", loader: "fabric", mcVersion: "26.3", mappings: "mojmap", modId: "modid" });
    expect(i.mixinConfigs).toHaveLength(1);
    expect(i.detectedFrom).toEqual(["build.gradle: Loom plugin", "gradle.properties: minecraft_version=26.3", "mappings: mojmap"]);
  });

  it("Fabric with Yarn (Kotlin DSL, version only in the dependency coordinate)", async () => {
    const dir = project({
      "build.gradle.kts": 'plugins { id("fabric-loom") version "1.7.1" }\ndependencies {\n  minecraft("com.mojang:minecraft:1.20.1")\n  mappings("net.fabricmc:yarn:1.20.1+build.10:v2")\n}\n',
    });
    expect(await readProjectInfo(dir)).toMatchObject({ loader: "fabric", mcVersion: "1.20.1", mappings: "yarn" });
  });

  it("NeoForge ModDevGradle MDK with Parchment", async () => {
    const dir = project({
      "build.gradle": "plugins {\n  id 'net.neoforged.moddev' version '2.0.78'\n}\nneoForge {\n  version = project.neo_version\n  parchment { mappingsVersion = project.parchment_mappings_version }\n}\n",
      "gradle.properties": "minecraft_version=1.21.1\nneo_version=21.1.77\nparchment_minecraft_version=1.21.1\nparchment_mappings_version=2024.11.17\nmod_id=examplemod\n",
    });
    expect(await readProjectInfo(dir)).toMatchObject({ loader: "neoforge", mcVersion: "1.21.1", mappings: "parchment", modId: "examplemod", mappingsVersion: "2024.11.17" });
  });

  it("NeoGradle MDK; Minecraft version derived from neo_version when minecraft_version is missing", async () => {
    const dir = project({
      "build.gradle": "plugins { id 'net.neoforged.gradle.userdev' version '7.0.170' }\n",
      "gradle.properties": "neo_version=21.1.77\nneogradle.subsystems.parchment.mappingsVersion=2024.11.17\nmod_id=examplemod\n",
      "src/main/templates/META-INF/neoforge.mods.toml": 'modId="${mod_id}"\n',
    });
    const i = await readProjectInfo(dir);
    expect(i).toMatchObject({ loader: "neoforge", mcVersion: "1.21.1", mappings: "parchment", modId: "examplemod" });
    expect(i.detectedFrom).toContain("loader version 21.1.77 → Minecraft 1.21.1");
  });

  it("ModDevGradle legacyforge: Forge 1.20.1 MDK vs NeoForge 1.20.1", async () => {
    const forge = project({ "build.gradle": "plugins { id 'net.neoforged.moddev.legacyforge' version '2.0.91' }\nlegacyForge { version = \"${minecraft_version}-${forge_version}\" }\n", "gradle.properties": "minecraft_version=1.20.1\nforge_version=47.4.10\n" });
    expect(await readProjectInfo(forge)).toMatchObject({ loader: "forge", mcVersion: "1.20.1" });
    const neo = project({ "build.gradle": "plugins { id 'net.neoforged.moddev.legacyforge' version '2.0.91' }\n", "gradle.properties": "minecraft_version=1.20.1\nneo_version=1.20.1-47.1.106\n" });
    expect(await readProjectInfo(neo)).toMatchObject({ loader: "neoforge", mcVersion: "1.20.1" });
  });

  it("ForgeGradle MDK: mapping_channel decides; 'parchment' in comments does not count; mod id from mods.toml", async () => {
    const dir = project({
      "build.gradle": "plugins {\n  id 'net.minecraftforge.gradle' version '[6.0.24,6.2)'\n}\nminecraft {\n  // Use 'parchment' for Parchment mappings, see https://parchmentmc.org\n  /* parchment { } */\n  mappings channel: mapping_channel, version: mapping_version\n}\n",
      "gradle.properties": "minecraft_version=1.21.1\nforge_version=52.1.0\nmapping_channel=official\nmapping_version=1.21.1\n",
      "src/main/resources/META-INF/mods.toml": '[[mods]]\nmodId="examplemod"\n',
    });
    expect(await readProjectInfo(dir)).toMatchObject({ loader: "forge", mcVersion: "1.21.1", mappings: "mojmap", modId: "examplemod" });
  });

  it("explains what it looks for when the project cannot be understood; placeholders are not versions", async () => {
    await expect(readProjectInfo(project({ "build.gradle": "plugins { id 'java' }\n" }))).rejects.toThrow(/gradle\.properties \(minecraft_version.*Loom, ModDevGradle, NeoGradle, ForgeGradle/);
    await expect(readProjectInfo(project({ "build.gradle": "plugins { id 'net.minecraftforge.gradle' version '6.0' }\n", "gradle.properties": "minecraft_version=@MC_VERSION@\n" }))).rejects.toThrow(/the Minecraft version/);
  });

  it("helpers", () => {
    expect(mcFromLoaderVersion("neoforge", "21.1.77")).toBe("1.21.1");
    expect(mcFromLoaderVersion("neoforge", "21.0.167")).toBe("1.21");
    expect(mcFromLoaderVersion("neoforge", "20.4.237")).toBe("1.20.4");
    expect(mcFromLoaderVersion("neoforge", "26.3.0.65-beta")).toBe("26.3");
    expect(mcFromLoaderVersion("forge", "1.20.1-47.4.10")).toBe("1.20.1");
    expect(mcFromLoaderVersion("forge", "52.1.0")).toBeUndefined();
    expect(stripComments("a // x\nb /* y */ c 'https://x'")).toBe("a \nb  c 'https://x'");
  });
});
