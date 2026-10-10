/** Official endpoints FFN reads. All verified to respond (see README "Version sources"). */
export const ENDPOINTS = {
  mojangManifest: "https://piston-meta.mojang.com/mc/game/version_manifest_v2.json",
  fabricGame: "https://meta.fabricmc.net/v2/versions/game",
  fabricLoader: "https://meta.fabricmc.net/v2/versions/loader",
  fabricYarn: (mc: string) => `https://meta.fabricmc.net/v2/versions/yarn/${encodeURIComponent(mc)}`,
  fabricApiMetadata: "https://maven.fabricmc.net/net/fabricmc/fabric-api/fabric-api/maven-metadata.xml",
  forgeMetadata: "https://maven.minecraftforge.net/net/minecraftforge/forge/maven-metadata.xml",
  forgePromotions: "https://files.minecraftforge.net/net/minecraftforge/forge/promotions_slim.json",
  neoforgeMetadata: "https://maven.neoforged.net/releases/net/neoforged/neoforge/maven-metadata.xml",
  /** NeoForge for 1.20.1 was published as net.neoforged:forge (1.20.1-47.1.x). */
  neoforgeLegacyMetadata: "https://maven.neoforged.net/releases/net/neoforged/forge/maven-metadata.xml",
  parchmentMetadata: (mc: string) =>
    `https://maven.parchmentmc.org/org/parchmentmc/data/parchment-${encodeURIComponent(mc)}/maven-metadata.xml`,
} as const;
