import { describe, expect, it } from "vitest";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig } from "../src/config.js";
import { createServices } from "../src/services.js";
import { defaultLoaders, loadMultiloaderLayout } from "../src/generator/multiloader.js";
import { compareDotted, pluginBehind } from "../src/tools/checkProfiles.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

describe("multiloader layout profile", () => {
  it("loads and picks default loaders per version", async () => {
    const services = createServices({ config: { ...loadConfig(), builtinProfilesDir: path.join(root, "profiles"), userProfilesDir: path.join(root, "nonexistent-user-profiles") } });
    const { layout } = await loadMultiloaderLayout(services);
    expect(layout.commonDir).toBe("common");
    expect(defaultLoaders(layout, "1.20.1")?.loaders).toEqual(["fabric", "forge"]);
    expect(defaultLoaders(layout, "1.21.1")?.loaders).toEqual(["fabric", "neoforge"]);
    expect(defaultLoaders(layout, "26.3")?.loaders).toEqual(["fabric", "neoforge"]);
    expect(layout.buildScriptAppend).toContain("{{common}}/src/main/java");
  });
});

describe("check_profiles helpers", () => {
  it("compares dotted versions numerically", () => {
    expect(compareDotted("9.10.0", "9.8.1")).toBeGreaterThan(0);
    expect(compareDotted("9.7.1", "9.7.1")).toBe(0);
    expect(compareDotted("8.14.5", "9.2.1")).toBeLessThan(0);
  });
  it("treats SNAPSHOT/ranged references as plugin lines", () => {
    expect(pluginBehind("1.18.4", "1.18-SNAPSHOT")).toBe(false);
    expect(pluginBehind("1.17.9", "1.18-SNAPSHOT")).toBe(true);
    expect(pluginBehind("2.0.148", "2.0.148")).toBe(false);
    expect(pluginBehind("2.0.140", "2.0.148")).toBe(true);
    expect(pluginBehind("6.0.30", "[6.0,6.2)")).toBe(false);
  });
});
