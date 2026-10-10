import { describe, expect, it } from "vitest";
import {
  compareLooseVersions,
  compareMcVersions,
  isReleaseVersion,
  isWeeklySnapshot,
  parseMcVersion,
  targetRelease,
} from "../src/util/mcversion.js";

describe("Minecraft version ordering", () => {
  it("orders classic versions numerically, not lexically", () => {
    expect(compareMcVersions("1.20.1", "1.20.10")).toBeLessThan(0);
    expect(compareMcVersions("1.21.11", "1.21.9")).toBeGreaterThan(0);
    expect(compareMcVersions("1.21", "1.21.0")).toBe(0);
  });

  it("puts the 2026 year-based scheme after 1.21.x", () => {
    expect(compareMcVersions("26.1", "1.21.11")).toBeGreaterThan(0);
    expect(compareMcVersions("26.1.2", "26.2")).toBeLessThan(0);
    expect(compareMcVersions("1.99.0", "26.1")).toBeLessThan(0);
  });

  it("sorts pre-releases before their release", () => {
    expect(compareMcVersions("26.4-snapshot-3", "26.4")).toBeLessThan(0);
    expect(compareMcVersions("26.3-rc-1", "26.3")).toBeLessThan(0);
    expect(compareMcVersions("1.21.5-pre1", "1.21.5-rc1")).toBeLessThan(0);
    expect(compareMcVersions("26.3-rc-1", "26.2")).toBeGreaterThan(0);
  });

  it("parses and classifies versions", () => {
    expect(parseMcVersion("26.4-snapshot-3")).toMatchObject({ release: [26, 4], preKind: "snapshot", preNumber: 3 });
    expect(isReleaseVersion("1.20.1")).toBe(true);
    expect(isReleaseVersion("26.3-rc-2")).toBe(false);
    expect(isWeeklySnapshot("25w46a")).toBe(true);
    expect(parseMcVersion("25w46a")).toBeNull();
    expect(targetRelease("26.4-snapshot-1")).toBe("26.4");
    expect(() => compareMcVersions("25w46a", "1.20.1")).toThrow();
  });

  it("compares loader/plugin versions", () => {
    expect(compareLooseVersions("0.92.12", "0.116.17")).toBeLessThan(0);
    expect(compareLooseVersions("21.1.256", "21.1.99")).toBeGreaterThan(0);
    expect(compareLooseVersions("26.3.0.65-beta", "26.3.0.64-beta")).toBeGreaterThan(0);
    expect(compareLooseVersions("2.0.148", "2.0.148")).toBe(0);
  });
});
