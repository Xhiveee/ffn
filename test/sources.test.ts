import { afterEach, describe, expect, it, vi } from "vitest";
import { fabricApiVersionsFor, parseFabricGameVersions, parseLatestFabricLoader, parseLatestYarn } from "../src/sources/fabric.js";
import { forgeMinecraftVersions, forgeVersionsFor, parseForgePromotions } from "../src/sources/forge.js";
import { Notes, VersionService } from "../src/sources/index.js";
import { parseMojangManifest, parseMojangVersionDetails } from "../src/sources/mojang.js";
import {
  neoforgeLegacyVersionsFor,
  neoforgeMinecraftVersions,
  neoforgeToMinecraft,
  neoforgeVersionsFor,
} from "../src/sources/neoforge.js";
import { latestFromMetadata } from "../src/sources/plugins.js";
import { parseMavenMetadata } from "../src/util/maven.js";
import { CachingFetcher, HttpError } from "../src/util/http.js";
import { FixtureFetcher, fixture, tmpDir } from "./helpers.js";

describe("Mojang", () => {
  it("parses the manifest", () => {
    const m = parseMojangManifest(fixture("mojang/version_manifest_v2.json"));
    expect(m.latest.release).toBe("26.3");
    expect(m.versions.find((v) => v.id === "1.20.1")?.type).toBe("release");
  });

  it("derives Java version and obfuscation from per-version JSON", () => {
    const v1201 = parseMojangVersionDetails(fixture("mojang/1.20.1.json"));
    expect(v1201).toMatchObject({ javaMajor: 17, obfuscated: true });
    expect(parseMojangVersionDetails(fixture("mojang/1.21.11.json"))).toMatchObject({ javaMajor: 21, obfuscated: true });
    // 26.x ships without client_mappings → unobfuscated, Java 25
    expect(parseMojangVersionDetails(fixture("mojang/26.3.json"))).toMatchObject({ javaMajor: 25, obfuscated: false });
  });
});

describe("Fabric", () => {
  it("reads game versions, newest stable loader and yarn", () => {
    expect(parseFabricGameVersions(fixture("fabric-game.json")).some((g) => g.version === "26.3" && g.stable)).toBe(true);
    expect(parseLatestFabricLoader(fixture("fabric-loader.json"))).toBe("0.19.5");
    expect(parseLatestYarn(fixture("fabric-yarn-1.20.1.json"))).toBe("1.20.1+build.10");
    expect(parseLatestYarn(fixture("fabric-yarn-26.3.json"))).toBeUndefined();
  });

  it("finds Fabric API per MC version even though maven-metadata is unsorted", () => {
    const xml = fixture("fabric-api-metadata.xml");
    // The metadata lists 0.92.12+1.20.1 after many 26.x builds; it must still win for 1.20.1.
    expect(fabricApiVersionsFor(xml, "1.20.1")[0]).toBe("0.92.12+1.20.1");
    expect(fabricApiVersionsFor(xml, "26.3")[0]).toMatch(/\+26\.3$/);
    // "+26.3" must not match "+26.3.1"-style suffixes of other versions
    expect(fabricApiVersionsFor(xml, "1.21")[0]).toMatch(/\+1\.21$/);
    expect(fabricApiVersionsFor(xml, "9.9.9")).toEqual([]);
  });
});

describe("Forge", () => {
  const xml = fixture("forge-metadata.xml");
  const promos = parseForgePromotions(fixture("forge-promotions_slim.json"));

  it("uses promotions for recommended/latest and maven-metadata for the full list", () => {
    const f = forgeVersionsFor(xml, promos, "1.20.1");
    expect(f.recommended).toBe("47.4.10");
    expect(f.latest).toBe("47.4.26");
    expect(f.all[0]).toBe("47.4.26");
    expect(f.all).toContain("47.1.0");
  });

  it("does not confuse 1.21 with 1.21.1", () => {
    const f = forgeVersionsFor(xml, promos, "1.21");
    expect(f.all.every((v) => v.startsWith("51."))).toBe(true);
  });

  it("handles versions with only a latest build", () => {
    const f = forgeVersionsFor(xml, promos, "26.3");
    expect(f.recommended).toBeUndefined();
    expect(f.latest).toBe("66.0.10");
  });

  it("lists MC versions with Forge builds", () => {
    const mcs = forgeMinecraftVersions(xml);
    expect(mcs).toContain("1.20.1");
    expect(mcs).toContain("26.3");
  });
});

describe("NeoForge", () => {
  it.each([
    ["20.4.251", "1.20.4"],
    ["20.2.88", "1.20.2"],
    ["21.0.3-beta", "1.21"],
    ["21.1.256", "1.21.1"],
    ["21.4.10-beta-pr-1744-gh-1582", "1.21.4"],
    ["21.11.45", "1.21.11"],
    ["26.1.0.40", "26.1"],
    ["26.1.2.115", "26.1.2"],
    ["26.3.0.65-beta", "26.3"],
    ["26.1.0.0-alpha.3+snapshot-1", "26.1-snapshot-1"],
    ["26.1.1.0-alpha.0+snapshot-4.20260121.223952", "26.1.1-snapshot-4"],
    ["0.25w14craftmine.3-beta", null],
  ])("maps NeoForge %s → Minecraft %s", (neo, mc) => {
    expect(neoforgeToMinecraft(neo)).toBe(mc);
  });

  it("picks stable over beta and reports beta-only versions", () => {
    const xml = fixture("neoforge-metadata.xml");
    const n211 = neoforgeVersionsFor(xml, "1.21.1");
    expect(n211.latestStable).toBe("21.1.257");
    const n263 = neoforgeVersionsFor(xml, "26.3");
    expect(n263.latestStable).toBeUndefined();
    expect(n263.latest).toBe("26.3.0.65-beta");
    expect(neoforgeMinecraftVersions(xml)).toEqual(expect.arrayContaining(["1.20.2", "1.21.1", "26.3"]));
  });

  it("reads legacy 1.20.1 builds from net.neoforged:forge, including the unprefixed quirk", () => {
    const legacy = neoforgeLegacyVersionsFor(fixture("neoforge-legacy-metadata.xml"), "1.20.1");
    expect(legacy.artifact).toBe("net.neoforged:forge");
    expect(legacy.latestStable).toBe("1.20.1-47.1.106");
    expect(legacy.all).toContain("1.20.1-47.1.82");
  });
});

describe("Gradle plugin metadata", () => {
  it("resolves the newest stable plugin version, optionally by prefix", () => {
    expect(latestFromMetadata(fixture("fabric-loom-metadata.xml"))).toBe("1.18.4");
    expect(latestFromMetadata(fixture("moddev-metadata.xml"))).toMatch(/^2\.0\.\d+$/);
    expect(latestFromMetadata(fixture("forgegradle-metadata.xml"), { prefix: "6.0." })).toMatch(/^6\.0\.\d+$/);
    expect(latestFromMetadata(fixture("forgegradle-plugin-metadata.xml"), { prefix: "7." })).toMatch(/^7\.\d+\.\d+$/);
  });

  it("parses maven-metadata.xml", () => {
    const md = parseMavenMetadata(fixture("parchment-1.20.1-metadata.xml"));
    expect(md.release).toBe("2023.09.03");
    expect(md.versions.length).toBeGreaterThan(0);
  });
});

describe("VersionService (fixtures)", () => {
  const svc = new VersionService(new FixtureFetcher());

  it("aggregates per-loader data", async () => {
    const notes = new Notes();
    const fab = await svc.fabric("1.20.1", notes);
    expect(fab).toMatchObject({ gameSupported: true, loader: "0.19.5", fabricApi: "0.92.12+1.20.1", yarn: "1.20.1+build.10" });
    const neo = await svc.neoforge("1.20.1", notes);
    expect(neo.artifact).toBe("net.neoforged:forge");
    expect(await svc.parchment("1.20.1")).toBe("2023.09.03");
    expect(await svc.parchment("26.3")).toBeUndefined(); // 404 → none
    expect(notes.sources.size).toBeGreaterThan(3);
  });

  it("maps snapshots to the release whose profile applies", async () => {
    expect(await svc.profileVersionFor("1.21.1")).toEqual({ release: "1.21.1" });
    expect((await svc.profileVersionFor("26.4-snapshot-3")).release).toBe("26.4");
    const weekly = await svc.profileVersionFor("25w46a");
    expect(weekly.release).toBe("1.21.10");
    expect(weekly.note).toMatch(/snapshot/);
    await expect(svc.profileVersionFor("99w99z")).rejects.toThrow(/Unknown Minecraft version/);
  });

  it("reports loader availability per MC version", async () => {
    const a = await svc.loaderAvailability();
    expect(a.neoforge.has("1.20.1")).toBe(true);
    expect(a.forge.has("1.20.1")).toBe(true);
    expect(a.fabric.has("26.3")).toBe(true);
  });
});

describe("CachingFetcher", () => {
  afterEach(() => vi.unstubAllGlobals());
  const mk = (offline = false, cacheDir = tmpDir()) =>
    new CachingFetcher({ cacheDir, defaultTtlMs: 60_000, offline, userAgent: "ffn-test" });

  it("serves fresh cache without network and sends a User-Agent", async () => {
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      expect((init?.headers as Record<string, string>)["User-Agent"]).toBe("ffn-test");
      return new Response("hello", { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);
    const f = mk();
    expect((await f.getText("https://example.test/a")).source).toBe("network");
    expect((await f.getText("https://example.test/a")).source).toBe("cache");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("falls back to stale cache when the network fails", async () => {
    const dir = tmpDir();
    vi.stubGlobal("fetch", vi.fn(async () => new Response("v1", { status: 200 })));
    await mk(false, dir).getText("https://example.test/b");
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("ENOTFOUND"); }));
    const r = await mk(false, dir).getText("https://example.test/b", { ttlMs: 0 });
    expect(r).toMatchObject({ body: "v1", source: "stale-cache" });
    expect(r.warning).toMatch(/ENOTFOUND/);
  });

  it("treats 404 as authoritative and supports offline mode", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("nope", { status: 404 })));
    await expect(mk().getText("https://example.test/missing")).rejects.toBeInstanceOf(HttpError);
    await expect(mk(true).getText("https://example.test/never-cached")).rejects.toThrow(/Offline/);
  });
});
