/**
 * Live checks against the real official endpoints. Skipped unless FFN_LIVE_TESTS=1
 * (run with `npm run test:live`). They verify that every URL FFN depends on still
 * answers and still parses — the early-warning system for upstream format changes.
 */
import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { planProject } from "../src/generator/index.js";
import { createServices } from "../src/services.js";
import { tmpDir } from "./helpers.js";

const live = process.env.FFN_LIVE_TESTS === "1";

describe.skipIf(!live)("live official endpoints", () => {
  const services = createServices({ config: { ...loadConfig({}), cacheDir: tmpDir("ffn-live-"), userProfilesDir: tmpDir() } });
  const v = services.versions;

  it("Mojang manifest + per-version JSON", async () => {
    const latest = await v.latestRelease();
    const d = await v.mojangVersion(latest);
    expect(d?.javaMajor).toBeGreaterThanOrEqual(17);
    expect((await v.mojangVersion("1.20.1"))?.obfuscated).toBe(true);
  });

  it.each(["fabric", "forge", "neoforge"] as const)("%s has builds for 1.20.1 and can plan the newest release", async (loader) => {
    const latest = await v.latestRelease();
    const p1 = await planProject(services, { modId: "livetest", modName: "Live", package: "com.example.live", author: "t", version: "1.0.0", mcVersion: "1.20.1", loader });
    expect(p1.context.versions.loader).toBeTruthy();
    try {
      const p2 = await planProject(services, { modId: "livetest", modName: "Live", package: "com.example.live", author: "t", version: "1.0.0", mcVersion: latest, loader });
      expect(p2.context.versions.pluginVersion).toBeTruthy();
    } catch (e) {
      // A brand-new release may not have loader builds yet; that must be a clear error.
      expect((e as Error).message).toMatch(/no builds/);
    }
  });

  it("Parchment and Gradle plugin metadata", async () => {
    expect(await v.parchment("1.20.1")).toMatch(/^\d{4}\.\d{2}\.\d{2}$/);
    expect(
      await v.latestPluginVersion("https://maven.fabricmc.net/net/fabricmc/fabric-loom/maven-metadata.xml", {}),
    ).toMatch(/^\d+\.\d+/);
  });
});
