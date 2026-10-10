import path from "node:path";
import { discoverJdks, type JdkInfo } from "../jdk/discover.js";
import type { Services } from "../services.js";
import { ENDPOINTS } from "../sources/endpoints.js";
import { latestFromMetadata } from "../sources/plugins.js";
import { downloadFile } from "../util/download.js";

/** Last versions verified with FFN; used only if the live metadata cannot be read. */
const FALLBACK = { tinyRemapper: "0.14.1", vineflower: "1.12.0" };

export async function toolJar(services: Services, tool: "tiny-remapper" | "vineflower"): Promise<string> {
  const isTr = tool === "tiny-remapper";
  let version: string | undefined;
  try {
    const xml = await services.versions.text(isTr ? ENDPOINTS.tinyRemapperMetadata : ENDPOINTS.vineflowerMetadata);
    version = xml ? latestFromMetadata(xml) : undefined;
  } catch {
    /* offline → fallback */
  }
  version ??= isTr ? FALLBACK.tinyRemapper : FALLBACK.vineflower;
  const url = isTr ? ENDPOINTS.tinyRemapperJar(version) : ENDPOINTS.vineflowerJar(version);
  const dest = path.join(services.config.cacheDir, "tools", path.basename(url));
  return downloadFile(url, dest, { userAgent: services.config.userAgent, offline: services.config.offline });
}

let cachedJdks: JdkInfo[] | undefined;
/** Newest installed full JDK ≥ 17 for running helper tools (tiny-remapper, Vineflower, Gradle classpath probe). */
export async function toolJava(min = 17): Promise<string> {
  cachedJdks ??= await discoverJdks();
  const jdk = cachedJdks.filter((j) => j.isJdk && j.major >= min).sort((a, b) => b.major - a.major)[0];
  if (!jdk) throw new Error(`Building the source index needs a JDK ${min}+ (none found). Install Temurin (https://adoptium.net) or set FFN_JDKS.`);
  return path.join(jdk.home, "bin", process.platform === "win32" ? "java.exe" : "java");
}
