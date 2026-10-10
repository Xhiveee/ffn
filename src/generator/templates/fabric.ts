import type { ProjectContext, FileContent } from "../types.js";
import { exampleMixin, langJson, mixinsJson, pkgPath } from "./common.js";

export function fabricFiles(ctx: ProjectContext): Map<string, FileContent> {
  const { params, profile, versions } = ctx;
  const files = new Map<string, FileContent>();
  const remap = profile.obfuscated && profile.plugin.id.endsWith("-remap");
  const depCfg = remap ? "modImplementation" : "implementation";
  const javaSrc = `src/main/java/${pkgPath(params.package)}`;

  let mappingsLine = "";
  let extraRepos = "";
  if (profile.obfuscated) {
    if (params.mappings === "yarn") mappingsLine = `\tmappings "net.fabricmc:yarn:\${project.yarn_mappings}:v2"`;
    else if (params.mappings === "parchment") {
      mappingsLine = `\tmappings loom.layered() {\n\t\tofficialMojangMappings()\n\t\tparchment("org.parchmentmc.data:parchment-\${project.minecraft_version}:\${project.parchment_version}@zip")\n\t}`;
      extraRepos = `\tmaven {\n\t\tname = 'ParchmentMC'\n\t\turl = 'https://maven.parchmentmc.org'\n\t}\n`;
    } else mappingsLine = "\tmappings loom.officialMojangMappings()";
  }

  files.set(
    "settings.gradle",
    `pluginManagement {
\trepositories {
\t\tmaven {
\t\t\tname = 'Fabric'
\t\t\turl = 'https://maven.fabricmc.net/'
\t\t}
\t\tmavenCentral()
\t\tgradlePluginPortal()
\t}
}

rootProject.name = '${params.modId}'
`,
  );

  const props = [
    "# Done to increase the memory available to Gradle.",
    "org.gradle.jvmargs=-Xmx2G",
    "org.gradle.parallel=true",
    "",
    "# Fabric properties (resolved live by FFN; see https://fabricmc.net/develop)",
    `minecraft_version=${versions.minecraft}`,
    `loader_version=${versions.loader}`,
    `loom_version=${versions.pluginVersion}`,
  ];
  if (versions.yarn) props.push(`yarn_mappings=${versions.yarn}`);
  if (versions.parchment) props.push(`parchment_version=${versions.parchment}`);
  props.push("", "# Mod properties", `mod_version=${params.version}`, `maven_group=${params.package}`, `archives_base_name=${params.modId}`);
  if (versions.fabricApi) props.push("", "# Dependencies", `fabric_api_version=${versions.fabricApi}`);
  files.set("gradle.properties", `${props.join("\n")}\n`);

  files.set(
    "build.gradle",
    `plugins {
\tid '${profile.plugin.id}' version "\${loom_version}"
\tid 'maven-publish'
}

version = project.mod_version
group = project.maven_group

base {
\tarchivesName = project.archives_base_name
}

repositories {
${extraRepos}\t// Add repositories for other mods' artifacts here. Loom adds Minecraft/Fabric repositories automatically.
}

dependencies {
\tminecraft "com.mojang:minecraft:\${project.minecraft_version}"
${mappingsLine ? `${mappingsLine}\n` : ""}\t${depCfg} "net.fabricmc:fabric-loader:\${project.loader_version}"
${versions.fabricApi ? `\t${depCfg} "net.fabricmc.fabric-api:fabric-api:\${project.fabric_api_version}"\n` : "\t// Fabric API has no build for this Minecraft version yet; add it once available.\n"}}

processResources {
\tdef version = project.version
\tinputs.property "version", version

\tfilesMatching("fabric.mod.json") {
\t\texpand "version": version
\t}
}

tasks.withType(JavaCompile).configureEach {
\tit.options.encoding = "UTF-8"
\tit.options.release = ${profile.java}
}

java {
\twithSourcesJar()
\tsourceCompatibility = JavaVersion.VERSION_${profile.java}
\ttargetCompatibility = JavaVersion.VERSION_${profile.java}
}

publishing {
\tpublications {
\t\tcreate("mavenJava", MavenPublication) {
\t\t\tartifactId = project.archives_base_name
\t\t\tfrom components.java
\t\t}
\t}
}
`,
  );

  const depends: Record<string, string> = {
    fabricloader: `>=${versions.loader}`,
    minecraft: `~${versions.minecraft}`,
    java: `>=${profile.java}`,
  };
  if (versions.fabricApi) depends["fabric-api"] = "*";
  files.set(
    "src/main/resources/fabric.mod.json",
    `${JSON.stringify(
      {
        schemaVersion: 1,
        id: params.modId,
        version: "${version}",
        name: params.modName,
        description: params.description,
        authors: [params.author],
        contact: {},
        license: params.license,
        icon: `assets/${params.modId}/icon.png`,
        environment: "*",
        entrypoints: { main: [`${params.package}.${params.mainClass}`] },
        mixins: [`${params.modId}.mixins.json`],
        depends,
      },
      null,
      2,
    )}\n`,
  );

  files.set(
    `${javaSrc}/${params.mainClass}.java`,
    `package ${params.package};

import net.fabricmc.api.ModInitializer;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

public class ${params.mainClass} implements ModInitializer {
    public static final String MOD_ID = "${params.modId}";
    public static final Logger LOGGER = LoggerFactory.getLogger(MOD_ID);

    @Override
    public void onInitialize() {
        // Runs once Minecraft is in a mod-load-ready state.
        LOGGER.info("Hello from {}!", MOD_ID);
    }
}
`,
  );
  files.set(`${javaSrc}/mixin/ExampleMixin.java`, exampleMixin(ctx));
  files.set(`src/main/resources/${params.modId}.mixins.json`, mixinsJson(ctx));
  files.set(`src/main/resources/assets/${params.modId}/lang/en_us.json`, langJson(ctx));
  return files;
}
