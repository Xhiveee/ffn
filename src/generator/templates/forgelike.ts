import type { FileContent, ProjectContext } from "../types.js";
import { exampleMixin, foojayVersion, langJson, mixinsJson, packMcmeta, pkgPath } from "./common.js";
import { propEsc } from "../validate.js";

/**
 * Templates for Forge and NeoForge (ModDevGradle, ModDevGradle-legacy, ForgeGradle 6/7).
 * Metadata files live in src/main/templates (MDK style) or src/main/resources and get
 * ${property} expansion from gradle.properties at build time.
 */

function isNeo(ctx: ProjectContext): boolean {
  return ctx.profile.loader === "neoforge";
}

/** Gradle properties shared by all Forge-like build systems. */
function commonProps(ctx: ProjectContext, extra: string[]): string {
  const { params, versions, profile } = ctx;
  const lines = [
    "org.gradle.jvmargs=-Xmx3G",
    "org.gradle.daemon=true",
    "org.gradle.parallel=true",
    "org.gradle.caching=true",
    "",
    "# Environment (resolved live by FFN)",
    `minecraft_version=${versions.minecraft}`,
    `minecraft_version_range=[${versions.minecraft}]`,
    ...extra,
    "",
    "# Mod properties",
    `mod_id=${params.modId}`,
    `mod_name=${propEsc(params.modName)}`,
    `mod_license=${propEsc(params.license)}`,
    `mod_version=${propEsc(params.version)}`,
    `mod_group_id=${params.package}`,
    `mod_authors=${propEsc(params.author)}`,
    `mod_description=${propEsc(params.description)}`,
  ];
  if (versions.parchment) {
    lines.splice(
      5,
      0,
      "# Parchment: parameter names + javadoc on top of Mojang mappings (https://parchmentmc.org)",
      `parchment_minecraft_version=${versions.minecraft}`,
      `parchment_mappings_version=${versions.parchment}`,
      "",
    );
  }
  void profile;
  return `${lines.join("\n")}\n`;
}

/** mods.toml / neoforge.mods.toml with ${...} placeholders expanded by Gradle. */
function modsToml(ctx: ProjectContext, loaderVersionProp: string | null, loaderDepRangeExpr: string): string {
  const md = ctx.profile.metadata;
  const typeStyle = md.dependencyStyle === "type";
  const req = typeStyle ? 'type="required"' : "mandatory=true";
  const lines: string[] = [];
  if (loaderVersionProp) lines.push('modLoader="javafml"', `loaderVersion="${loaderVersionProp}"`);
  lines.push(
    'license="${mod_license}"',
    "",
    "[[mods]]",
    'modId="${mod_id}"',
    'version="${mod_version}"',
    'displayName="${mod_name}"',
    'authors="${mod_authors}"',
    "description='''${mod_description}'''",
    "",
  );
  if (ctx.profile.mixin.registration === "mods.toml") {
    lines.push("# Mixin configs are declared to FML here.", "[[mixins]]", 'config="${mod_id}.mixins.json"', "");
  }
  lines.push(
    "[[dependencies.${mod_id}]]",
    `    modId="${md.loaderModId ?? (isNeo(ctx) ? "neoforge" : "forge")}"`,
    `    ${req}`,
    `    versionRange="${loaderDepRangeExpr}"`,
    '    ordering="NONE"',
    '    side="BOTH"',
    "",
    "[[dependencies.${mod_id}]]",
    '    modId="minecraft"',
    `    ${req}`,
    '    versionRange="${minecraft_version_range}"',
    '    ordering="NONE"',
    '    side="BOTH"',
    "",
  );
  return lines.join("\n");
}

function loaderVersionValue(ctx: ProjectContext): string | null {
  const lv = ctx.profile.metadata.loaderVersion;
  if (lv === null || lv === undefined) return null;
  if (lv === "forge-major") return `[${ctx.versions.forgeMajor},)`;
  return lv;
}

function mainClassModern(ctx: ProjectContext): string {
  const { params } = ctx;
  return `package ${params.package};

import net.neoforged.bus.api.IEventBus;
import net.neoforged.fml.common.Mod;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

@Mod(${params.mainClass}.MOD_ID)
public class ${params.mainClass} {
    public static final String MOD_ID = "${params.modId}";
    public static final Logger LOGGER = LoggerFactory.getLogger(MOD_ID);

    public ${params.mainClass}(IEventBus modEventBus) {
        // Register DeferredRegisters and mod-bus listeners on modEventBus here.
        LOGGER.info("Hello from {}!", MOD_ID);
    }
}
`;
}

function mainClassForge(ctx: ProjectContext, withContext: boolean): string {
  const { params } = ctx;
  return `package ${params.package};

import net.minecraftforge.fml.common.Mod;
${withContext ? "import net.minecraftforge.fml.javafmlmod.FMLJavaModLoadingContext;\n" : ""}import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

@Mod(${params.mainClass}.MOD_ID)
public class ${params.mainClass} {
    public static final String MOD_ID = "${params.modId}";
    public static final Logger LOGGER = LoggerFactory.getLogger(MOD_ID);

    public ${params.mainClass}(${withContext ? "FMLJavaModLoadingContext context" : ""}) {
        // Register DeferredRegisters and event listeners here.
        LOGGER.info("Hello from {}!", MOD_ID);
    }
}
`;
}

const GENERATE_METADATA = (extName: string, props: string[]) => `// Expand \${...} properties from gradle.properties into src/main/templates (MDK convention).
var generateModMetadata = tasks.register("generateModMetadata", ProcessResources) {
    var replaceProperties = [
${props.map((p) => `            ${p}: ${p},`).join("\n")}
    ]
    inputs.properties replaceProperties
    expand replaceProperties
    from "src/main/templates"
    into "build/generated/sources/modMetadata"
}
sourceSets.main.resources.srcDir generateModMetadata
${extName}.ideSyncTask generateModMetadata
`;

const META_PROPS_BASE = [
  "minecraft_version",
  "minecraft_version_range",
  "mod_id",
  "mod_name",
  "mod_license",
  "mod_version",
  "mod_authors",
  "mod_description",
];

function commonFiles(ctx: ProjectContext, files: Map<string, FileContent>, metaDir: "templates" | "resources"): void {
  const { params } = ctx;
  const javaSrc = `src/main/java/${pkgPath(params.package)}`;
  files.set(`${javaSrc}/mixin/ExampleMixin.java`, exampleMixin(ctx));
  files.set(`src/main/resources/${params.modId}.mixins.json`, mixinsJson(ctx));
  files.set(`src/main/resources/assets/${params.modId}/lang/en_us.json`, langJson(ctx));
  const pack = packMcmeta(ctx);
  if (pack) files.set(`src/main/${metaDir}/pack.mcmeta`, pack);
}

// ---------------------------------------------------------------------------
// NeoForge 20.2+ — ModDevGradle
// ---------------------------------------------------------------------------
export function moddevgradleFiles(ctx: ProjectContext): Map<string, FileContent> {
  const { params, profile, versions } = ctx;
  const files = new Map<string, FileContent>();
  files.set(
    "settings.gradle",
    `pluginManagement {
    repositories {
        gradlePluginPortal()
        maven { url = 'https://maven.neoforged.net/releases' }
    }
}

plugins {
    id 'org.gradle.toolchains.foojay-resolver-convention' version '${foojayVersion(profile.gradle.version)}'
}

rootProject.name = '${params.modId}'
`,
  );
  const neoProps = [`neo_version=${versions.loader}`, `moddev_version=${versions.pluginVersion}`];
  if (profile.metadata.loaderVersion) neoProps.push(`loader_version_range=${loaderVersionValue(ctx)}`);
  files.set("gradle.properties", commonProps(ctx, neoProps));

  const parchment = versions.parchment
    ? `
    parchment {
        mappingsVersion = project.parchment_mappings_version
        minecraftVersion = project.parchment_minecraft_version
    }
`
    : "";
  const metaProps = [...META_PROPS_BASE, "neo_version", ...(profile.metadata.loaderVersion ? ["loader_version_range"] : [])];
  files.set(
    "build.gradle",
    `plugins {
    id 'java-library'
    id 'maven-publish'
    id 'idea'
    id 'net.neoforged.moddev' version "\${moddev_version}"
}

version = mod_version
group = mod_group_id

base {
    archivesName = mod_id
}

// Mojang ships Java ${profile.java} for Minecraft ${versions.minecraft}.
java.toolchain.languageVersion = JavaLanguageVersion.of(${profile.java})

neoForge {
    version = project.neo_version
${parchment}
    runs {
        client {
            client()
        }
        server {
            server()
            programArgument '--nogui'
        }
        configureEach {
            logLevel = org.slf4j.event.Level.DEBUG
        }
    }

    mods {
        "\${mod_id}" {
            sourceSet(sourceSets.main)
        }
    }
}

sourceSets.main.resources { srcDir 'src/generated/resources' }

dependencies {
    // Add mod dependencies here.
}

${GENERATE_METADATA("neoForge", metaProps)}
tasks.withType(JavaCompile).configureEach {
    options.encoding = 'UTF-8'
}

publishing {
    publications {
        register('mavenJava', MavenPublication) {
            from components.java
        }
    }
}
`,
  );
  files.set(`src/main/templates/${profile.metadata.file}`, modsToml(ctx, profile.metadata.loaderVersion ? "${loader_version_range}" : null, "[${neo_version},)"));
  files.set(`src/main/java/${pkgPath(params.package)}/${params.mainClass}.java`, mainClassModern(ctx));
  commonFiles(ctx, files, "templates");
  return files;
}

// ---------------------------------------------------------------------------
// Forge / NeoForge 1.20.1 — ModDevGradle legacyforge
// ---------------------------------------------------------------------------
export function moddevgradleLegacyFiles(ctx: ProjectContext): Map<string, FileContent> {
  const { params, profile, versions } = ctx;
  const neo = isNeo(ctx);
  const files = new Map<string, FileContent>();
  files.set(
    "settings.gradle",
    `pluginManagement {
    repositories {
        gradlePluginPortal()
        maven { url = 'https://maven.neoforged.net/releases' }
    }
}

plugins {
    id 'org.gradle.toolchains.foojay-resolver-convention' version '${foojayVersion(profile.gradle.version)}'
}

rootProject.name = '${params.modId}'
`,
  );
  const loaderProps = neo
    ? [`neo_version=${versions.loader}`, `forge_major=${versions.forgeMajor}`]
    : [`forge_version=${versions.loader}`, `forge_major=${versions.forgeMajor}`];
  files.set(
    "gradle.properties",
    commonProps(ctx, [...loaderProps, `loader_version_range=${loaderVersionValue(ctx)}`, `moddev_version=${versions.pluginVersion}`]),
  );
  const parchment = versions.parchment
    ? `
    parchment {
        mappingsVersion = project.parchment_mappings_version
        minecraftVersion = project.parchment_minecraft_version
    }
`
    : "";
  const versionLine = neo
    ? `    // NeoForge for 1.20.1 is published as net.neoforged:forge
    enable {
        neoForgeVersion = project.neo_version
    }`
    : `    version = project.minecraft_version + '-' + project.forge_version`;
  const metaProps = [...META_PROPS_BASE, "loader_version_range", "forge_major"];
  const ap = profile.mixin.annotationProcessor ?? "org.spongepowered:mixin:0.8.5:processor";
  files.set(
    "build.gradle",
    `plugins {
    id 'java-library'
    id 'maven-publish'
    id 'idea'
    id 'net.neoforged.moddev.legacyforge' version "\${moddev_version}"
}

version = mod_version
group = mod_group_id

base {
    archivesName = mod_id
}

// Mojang ships Java ${profile.java} for Minecraft ${versions.minecraft}.
java.toolchain.languageVersion = JavaLanguageVersion.of(${profile.java})

legacyForge {
${versionLine}
${parchment}
    runs {
        client {
            client()
        }
        server {
            server()
            programArgument '--nogui'
        }
        configureEach {
            logLevel = org.slf4j.event.Level.DEBUG
        }
    }

    mods {
        "\${mod_id}" {
            sourceSet(sourceSets.main)
        }
    }
}

sourceSets.main.resources { srcDir 'src/generated/resources' }

// Mixin: 1.20.1 runs on SRG names, so the annotation processor writes a refmap.
mixin {
    add sourceSets.main, "\${mod_id}.refmap.json"
    config "\${mod_id}.mixins.json"
}

dependencies {
    annotationProcessor '${ap}'
    // Mod dependencies must use mod* configurations (modImplementation, ...) so they are remapped.
}

jar {
    manifest.attributes([
            "MixinConfigs": "\${mod_id}.mixins.json"
    ])
}

${GENERATE_METADATA("legacyForge", metaProps)}
tasks.withType(JavaCompile).configureEach {
    options.encoding = 'UTF-8'
}

publishing {
    publications {
        register('mavenJava', MavenPublication) {
            from components.java
        }
    }
}
`,
  );
  files.set(`src/main/templates/${profile.metadata.file}`, modsToml(ctx, "${loader_version_range}", "[${forge_major},)"));
  files.set(`src/main/java/${pkgPath(params.package)}/${params.mainClass}.java`, mainClassForge(ctx, false));
  commonFiles(ctx, files, "templates");
  return files;
}

// ---------------------------------------------------------------------------
// Forge — ForgeGradle 6 / 7 (official MDK layout)
// ---------------------------------------------------------------------------
function forgeProcessResources(): string {
  return `tasks.named('processResources', ProcessResources).configure {
    var replaceProperties = [
            minecraft_version: minecraft_version, minecraft_version_range: minecraft_version_range,
            forge_version: forge_version, forge_major: forge_major, loader_version_range: loader_version_range,
            mod_id: mod_id, mod_name: mod_name, mod_license: mod_license, mod_version: mod_version,
            mod_authors: mod_authors, mod_description: mod_description,
    ]
    inputs.properties replaceProperties
    filesMatching(['META-INF/mods.toml', 'pack.mcmeta']) {
        expand replaceProperties
    }
}`;
}

export function forgegradleFiles(ctx: ProjectContext, fg: 6 | 7): Map<string, FileContent> {
  const { params, profile, versions } = ctx;
  const files = new Map<string, FileContent>();
  const mg = profile.mixin.mixinGradle;
  files.set(
    "settings.gradle",
    `pluginManagement {
    repositories {
        gradlePluginPortal()
        maven {
            name = 'MinecraftForge'
            url = 'https://maven.minecraftforge.net/'
        }
${mg ? "        maven { url = 'https://repo.spongepowered.org/repository/maven-public/' }\n" : ""}    }
}

plugins {
    id 'org.gradle.toolchains.foojay-resolver-convention' version '${foojayVersion(profile.gradle.version)}'
}

rootProject.name = '${params.modId}'
`,
  );
  const fgProps = [
    `forge_version=${versions.loader}`,
    `forge_major=${versions.forgeMajor}`,
    `loader_version_range=${loaderVersionValue(ctx) ?? `[${versions.forgeMajor},)`}`,
  ];
  let props = commonProps(ctx, fgProps);
  if (fg === 7) props += "\n# ForgeGradle 7\nnet.minecraftforge.gradle.merge-source-sets=true\n";
  files.set("gradle.properties", props);

  const mixinRunArg = profile.mixin.devRunArg
    ? fg === 6
      ? `            arg "-mixin.config=\${mod_id}.mixins.json"\n`
      : `            args "--mixin.config=\${mod_id}.mixins.json"\n`
    : "";
  const mappings = profile.obfuscated ? `    mappings channel: 'official', version: minecraft_version\n` : "";
  const ap = profile.mixin.refmap && profile.mixin.annotationProcessor ? `    annotationProcessor '${profile.mixin.annotationProcessor}'\n` : "";
  const mixinBlock =
    profile.mixin.refmap && mg
      ? `
mixin {
    add sourceSets.main, "\${mod_id}.refmap.json"
    config "\${mod_id}.mixins.json"
}
`
      : "";

  if (fg === 6) {
    files.set(
      "build.gradle",
      `plugins {
    id 'eclipse'
    id 'idea'
    id 'maven-publish'
    id 'net.minecraftforge.gradle' version '${versions.pluginVersion}'
${mg ? `    id '${mg.id}' version '${mg.version}'\n` : ""}}

version = mod_version
group = mod_group_id

base {
    archivesName = mod_id
}

// Mojang ships Java ${profile.java} for Minecraft ${versions.minecraft}.
java.toolchain.languageVersion = JavaLanguageVersion.of(${profile.java})

minecraft {
${mappings}    copyIdeResources = true

    runs {
        configureEach {
            workingDirectory project.file('run')
            property 'forge.logging.console.level', 'debug'
${mixinRunArg}            mods {
                "\${mod_id}" {
                    source sourceSets.main
                }
            }
        }
        client {}
        server {
            args '--nogui'
        }
    }
}
${mixinBlock}
sourceSets.main.resources { srcDir 'src/generated/resources' }

dependencies {
    minecraft "net.minecraftforge:forge:\${minecraft_version}-\${forge_version}"
${ap}}

${forgeProcessResources()}

tasks.named('jar', Jar).configure {
    manifest {
        attributes([
                'Specification-Title'   : mod_id,
                'Specification-Vendor'  : mod_authors,
                'Specification-Version' : '1',
                'Implementation-Title'  : project.name,
                'Implementation-Version': project.jar.archiveVersion,
                'Implementation-Vendor' : mod_authors,
                'MixinConfigs'          : "\${mod_id}.mixins.json"
        ])
    }
${profile.reobfJar ? "    finalizedBy 'reobfJar'\n" : ""}}

tasks.withType(JavaCompile).configureEach {
    options.encoding = 'UTF-8'
}
`,
    );
  } else {
    files.set(
      "build.gradle",
      `plugins {
    id 'java'
    id 'idea'
    id 'eclipse'
    id 'maven-publish'
    id 'net.minecraftforge.gradle' version '${versions.pluginVersion}'
}

version = mod_version
group = mod_group_id
base.archivesName = mod_id

// Mojang ships Java ${profile.java} for Minecraft ${versions.minecraft}.
java.toolchain.languageVersion = JavaLanguageVersion.of(${profile.java})

sourceSets.main.resources { srcDir 'src/generated/resources' }

minecraft {
${mappings}    runs {
        configureEach {
            workingDir.convention layout.projectDirectory.dir('run')
            // Mixin reads configs from the jar manifest in production; dev runs need the argument.
${mixinRunArg}        }
        register('client')
        register('server') {
            args '--nogui'
        }
    }
}

repositories {
    minecraft.mavenizer(it)
    maven fg.forgeMaven
    maven fg.minecraftLibsMaven
    mavenCentral()
}

dependencies {
    implementation minecraft.dependency("net.minecraftforge:forge:\${minecraft_version}-\${forge_version}")
${ap}}

${forgeProcessResources()}

tasks.named('jar', Jar) {
    manifest {
        attributes['MixinConfigs'] = "\${mod_id}.mixins.json"
    }
}

tasks.withType(JavaCompile).configureEach {
    options.encoding = 'UTF-8'
}
`,
    );
  }
  files.set(`src/main/resources/${profile.metadata.file}`, modsToml(ctx, "${loader_version_range}", "[${forge_major},)"));
  files.set(`src/main/java/${pkgPath(params.package)}/${params.mainClass}.java`, mainClassForge(ctx, fg === 7));
  commonFiles(ctx, files, "resources");
  return files;
}
