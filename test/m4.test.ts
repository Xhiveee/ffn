import { describe, expect, it } from "vitest";
import { compareDotted, pluginBehind } from "../src/tools/checkProfiles.js";

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
