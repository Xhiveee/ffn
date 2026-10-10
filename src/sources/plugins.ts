import { compareLooseVersions, isUnstableArtifactVersion } from "../util/mcversion.js";
import { parseMavenMetadata } from "../util/maven.js";

/** Newest version from a maven-metadata.xml, optionally restricted to a prefix and to stable builds. */
export function latestFromMetadata(xml: string, opts: { prefix?: string; allowUnstable?: boolean } = {}): string | undefined {
  const md = parseMavenMetadata(xml);
  return md.versions
    .filter((v) => (opts.prefix ? v.startsWith(opts.prefix) : true))
    .filter((v) => opts.allowUnstable || !isUnstableArtifactVersion(v))
    .sort((a, b) => compareLooseVersions(b, a))[0];
}
