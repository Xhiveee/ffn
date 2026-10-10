import { XMLParser } from "fast-xml-parser";

export interface MavenMetadata {
  groupId?: string;
  artifactId?: string;
  latest?: string;
  release?: string;
  versions: string[];
  lastUpdated?: string;
}

/** Parse a Maven `maven-metadata.xml`. Version order is preserved as published (NOT sorted). */
export function parseMavenMetadata(xml: string): MavenMetadata {
  const parser = new XMLParser({ ignoreAttributes: true, parseTagValue: false, isArray: (name) => name === "version" });
  const doc = parser.parse(xml);
  const md = doc?.metadata;
  if (!md) throw new Error("Not a maven-metadata.xml document");
  const v = md.versioning ?? {};
  const versions: string[] = (v.versions?.version ?? []).map((x: unknown) => String(x));
  return {
    groupId: md.groupId,
    artifactId: md.artifactId,
    latest: v.latest ? String(v.latest) : undefined,
    release: v.release ? String(v.release) : undefined,
    versions,
    lastUpdated: v.lastUpdated ? String(v.lastUpdated) : undefined,
  };
}
