import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { existsSync } from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServer } from "../src/server.js";
import { fixtureServices, tmpDir } from "./helpers.js";

let client: Client;

beforeAll(async () => {
  const server = createServer(fixtureServices());
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a);
  client = new Client({ name: "ffn-test", version: "0.0.0" });
  await client.connect(b);
});

afterAll(async () => {
  await client.close();
});

const text = (r: Awaited<ReturnType<Client["callTool"]>>) => (r.content as { type: string; text: string }[])[0]!.text;

describe("MCP server", () => {
  it("registers all tools", async () => {
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name).sort();
    expect(names).toEqual(
      [
        "list_versions",
        "get_profile",
        "create_project",
        "search_mc_source",
        "get_class",
        "translate_mapping",
        "mixin_targets",
        "mixin_validate",
        "gradle_build",
        "run_client",
        "run_server",
        "analyze_crash",
        "docs_search",
        "check_profiles",
      ].sort(),
    );
    const cp = tools.find((t) => t.name === "create_project")!;
    expect(Object.keys(cp.inputSchema.properties ?? {})).toEqual(
      expect.arrayContaining(["modId", "modName", "package", "author", "version", "mcVersion", "loader", "mappings", "targetDir"]),
    );
  });

  it("list_versions returns releases with loader availability", async () => {
    const r = await client.callTool({ name: "list_versions", arguments: {} });
    expect(r.isError).toBeFalsy();
    const data = r.structuredContent as { latest: { release: string }; versions: { id: string; loaders: string[] }[] };
    expect(data.latest.release).toBe("26.3");
    expect(data.versions.at(-1)!.id).toBe("1.20.1");
    expect(data.versions.find((v) => v.id === "1.20.1")!.loaders).toEqual(["forge", "fabric", "neoforge"]);
  });

  it("list_versions with mcVersion returns per-loader details", async () => {
    const r = await client.callTool({ name: "list_versions", arguments: { mcVersion: "1.20.1" } });
    const data = r.structuredContent as Record<string, any>;
    expect(data.java).toBe(17);
    expect(data.loaders.forge.versions.recommended).toBe("47.4.10");
    expect(data.loaders.fabric.versions.fabricApi).toBe("0.92.12+1.20.1");
    expect(data.loaders.neoforge.versions.artifact).toBe("net.neoforged:forge");
    expect(data.loaders.fabric.toolchain.gradlePlugin).toBe("net.fabricmc.fabric-loom-remap 1.18.4");
    expect(data.parchment).toBe("2023.09.03");
  });

  it("get_profile flags unknown future versions", async () => {
    const r = await client.callTool({ name: "get_profile", arguments: { mcVersion: "1.99.0", loader: "neoforge" } });
    expect(r.isError).toBeFalsy();
    expect(text(r)).toMatch(/EXTRAPOLATED/);
    expect(text(r)).toMatch(/UNVERIFIED/);
  });

  it("create_project writes a project", async () => {
    const dir = path.join(tmpDir(), "proj");
    const r = await client.callTool({
      name: "create_project",
      arguments: { targetDir: dir, loader: "neoforge", mcVersion: "1.21.1", modId: "demo", modName: "Demo", package: "com.example.demo", author: "Me" },
    });
    expect(r.isError, text(r)).toBeFalsy();
    expect(existsSync(path.join(dir, "src/main/templates/META-INF/neoforge.mods.toml"))).toBe(true);
  });

  it("create_project reports validation errors as tool errors", async () => {
    const r = await client.callTool({
      name: "create_project",
      arguments: { targetDir: tmpDir(), loader: "forge", mcVersion: "1.20.1", modId: "X", modName: "X", package: "com.x", author: "a" },
    });
    expect(r.isError).toBe(true);
    expect(text(r)).toMatch(/Invalid modId/);
  });

  it("run_server refuses without acceptEula (EULA is never auto-accepted)", async () => {
    const r = await client.callTool({ name: "run_server", arguments: { projectDir: "/nonexistent-ffn-project" } });
    expect(r.isError).toBe(true);
  });

});
