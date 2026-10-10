import { z } from "zod";

export const MojangManifestSchema = z.object({
  latest: z.object({ release: z.string(), snapshot: z.string() }),
  versions: z.array(
    z.object({
      id: z.string(),
      type: z.string(), // release | snapshot | old_beta | old_alpha
      url: z.string(),
      releaseTime: z.string(),
      sha1: z.string().optional(),
    }).passthrough(),
  ),
});
export type MojangManifest = z.infer<typeof MojangManifestSchema>;
export type MojangVersionEntry = MojangManifest["versions"][number];

export interface MojangVersionDetails {
  id: string;
  type: string;
  releaseTime: string;
  javaMajor?: number;
  javaComponent?: string;
  /**
   * Mojang publishes ProGuard `client_mappings` only for obfuscated builds.
   * From 26.1 the game ships unobfuscated, so this flips to false — derived, never hardcoded.
   */
  obfuscated: boolean;
  /** Download URLs (client/server jars and, for obfuscated versions, ProGuard mappings). */
  downloads: Partial<Record<"client" | "server" | "client_mappings" | "server_mappings", { url: string; sha1?: string; size?: number }>>;
}

export function parseMojangManifest(json: string): MojangManifest {
  return MojangManifestSchema.parse(JSON.parse(json));
}

export function parseMojangVersionDetails(json: string): MojangVersionDetails {
  const d = JSON.parse(json) as {
    id: string;
    type: string;
    releaseTime: string;
    javaVersion?: { majorVersion?: number; component?: string };
    downloads?: Record<string, unknown>;
  };
  const downloads = d.downloads ?? {};
  return {
    id: d.id,
    type: d.type,
    releaseTime: d.releaseTime,
    javaMajor: d.javaVersion?.majorVersion,
    javaComponent: d.javaVersion?.component,
    obfuscated: "client_mappings" in downloads || "server_mappings" in downloads,
    downloads: Object.fromEntries(
      ["client", "server", "client_mappings", "server_mappings"]
        .filter((k) => downloads[k] && typeof (downloads[k] as { url?: unknown }).url === "string")
        .map((k) => [k, downloads[k] as { url: string; sha1?: string; size?: number }]),
    ),
  };
}
