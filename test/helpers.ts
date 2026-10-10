import { readFileSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig, type FfnConfig } from "../src/config.js";
import { createServices, type Services } from "../src/services.js";
import { ENDPOINTS } from "../src/sources/endpoints.js";
import { HttpError, type Fetcher, type FetchResult } from "../src/util/http.js";

const here = path.dirname(fileURLToPath(import.meta.url));
export const FIXTURES = path.join(here, "fixtures");
export const fixture = (name: string) => readFileSync(path.join(FIXTURES, name), "utf8");

/** URL → fixture file. Anything else is a 404, like a real maven repo. */
export function fixtureRoutes(): Record<string, string> {
  const routes: Record<string, string> = {
    [ENDPOINTS.mojangManifest]: "mojang/version_manifest_v2.json",
    [ENDPOINTS.fabricGame]: "fabric-game.json",
    [ENDPOINTS.fabricLoader]: "fabric-loader.json",
    [ENDPOINTS.fabricYarn("1.20.1")]: "fabric-yarn-1.20.1.json",
    [ENDPOINTS.fabricYarn("26.3")]: "fabric-yarn-26.3.json",
    [ENDPOINTS.fabricApiMetadata]: "fabric-api-metadata.xml",
    [ENDPOINTS.forgeMetadata]: "forge-metadata.xml",
    [ENDPOINTS.forgePromotions]: "forge-promotions_slim.json",
    [ENDPOINTS.neoforgeMetadata]: "neoforge-metadata.xml",
    [ENDPOINTS.neoforgeLegacyMetadata]: "neoforge-legacy-metadata.xml",
    [ENDPOINTS.parchmentMetadata("1.20.1")]: "parchment-1.20.1-metadata.xml",
    "https://maven.fabricmc.net/net/fabricmc/fabric-loom/maven-metadata.xml": "fabric-loom-metadata.xml",
    "https://maven.neoforged.net/releases/net/neoforged/moddev/net.neoforged.moddev.gradle.plugin/maven-metadata.xml": "moddev-metadata.xml",
    "https://maven.neoforged.net/releases/net/neoforged/moddev/legacyforge/net.neoforged.moddev.legacyforge.gradle.plugin/maven-metadata.xml":
      "moddev-legacy-metadata.xml",
    "https://maven.minecraftforge.net/net/minecraftforge/gradle/ForgeGradle/maven-metadata.xml": "forgegradle-metadata.xml",
    "https://plugins.gradle.org/m2/net/minecraftforge/gradle/net.minecraftforge.gradle.gradle.plugin/maven-metadata.xml":
      "forgegradle-plugin-metadata.xml",
  };
  const mojangUrls = JSON.parse(fixture("mojang/urls.json")) as Record<string, string>;
  return { ...routes, ...mojangUrls };
}

export class FixtureFetcher implements Fetcher {
  readonly requested: string[] = [];
  constructor(private readonly routes = fixtureRoutes()) {}
  async getText(url: string): Promise<FetchResult> {
    this.requested.push(url);
    const file = this.routes[url];
    if (!file) throw new HttpError(url, 404);
    return { body: fixture(file), source: "cache", fetchedAt: 0 };
  }
}

export function tmpDir(prefix = "ffn-test-"): string {
  return mkdtempSync(path.join(os.tmpdir(), prefix));
}

/** Services wired to fixtures and an isolated (empty) user-profile dir. */
export function fixtureServices(overrides: Partial<FfnConfig> = {}): Services {
  const config: FfnConfig = { ...loadConfig({}), userProfilesDir: tmpDir("ffn-userprofiles-"), cacheDir: tmpDir("ffn-cache-"), ...overrides };
  return createServices({ config, fetcher: new FixtureFetcher() });
}
