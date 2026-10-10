import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { existsSync, statSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { diagnose } from "../diagnostics/parse.js";
import type { Services } from "../services.js";
import { clip, fail, guard, ok } from "./result.js";

export const analyzeCrashInput = {
  log: z.string().optional().describe("Pasted crash report, latest.log/debug.log excerpt or Gradle output."),
  path: z.string().optional().describe("Path to a crash report or log file."),
  projectDir: z.string().optional().describe("Use the newest crash report (else logs/latest.log) in the project's run directory."),
  runDir: z.string().optional().describe('Run directory relative to projectDir (default "run").'),
  limit: z.number().int().min(1).max(200).optional().describe("Findings per page (default 20, errors first)."),
  offset: z.number().int().min(0).optional().describe("Skip this many findings (paging)."),
};
type A = z.infer<z.ZodObject<typeof analyzeCrashInput>>;

async function newest(dir: string, filter: (f: string) => boolean): Promise<string | undefined> {
  if (!existsSync(dir)) return undefined;
  const files = (await readdir(dir)).filter(filter).map((f) => path.join(dir, f));
  return files.sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)[0];
}

export async function analyzeCrash(_services: Services, a: A) {
  let text = a.log;
  let origin = "pasted text";
  if (!text && a.path) {
    if (!existsSync(a.path)) return fail(`File not found: ${a.path}`);
    text = await readFile(a.path, "utf8");
    origin = a.path;
  }
  if (!text && a.projectDir) {
    const run = path.join(path.resolve(a.projectDir), a.runDir ?? "run");
    const crash = await newest(path.join(run, "crash-reports"), (f) => f.endsWith(".txt"));
    const latest = path.join(run, "logs", "latest.log");
    const file = crash && (!existsSync(latest) || statSync(crash).mtimeMs >= statSync(latest).mtimeMs - 60_000) ? crash : existsSync(latest) ? latest : crash;
    if (!file) return fail(`No crash report or logs/latest.log under ${run}.`);
    text = await readFile(file, "utf8");
    origin = file;
  }
  if (!text) return fail("Give log, path or projectDir.");
  const d = diagnose(text);
  const errors = d.findings.filter((f) => f.severity === "error");
  const head = `${d.source === "crash-report" ? "Crash report" : d.source === "gradle" ? "Gradle output" : d.source === "minecraft-log" ? "Minecraft log" : "Text"} (${origin}): ${d.summary}`;
  return ok(head, {
    origin,
    source: d.source,
    description: d.description,
    rootException: d.rootException,
    culprit: d.culprit,
    findings: [...errors, ...d.findings.filter((f) => f.severity !== "error")]
      .slice(a.offset ?? 0, (a.offset ?? 0) + (a.limit ?? 20))
      .map((f) => ({ ...f, message: clip(f.message, 300), evidence: f.evidence && f.evidence !== f.message ? clip(f.evidence, 200) : undefined })),
    ...(d.findings.length > (a.offset ?? 0) + (a.limit ?? 20) ? { more: `${d.findings.length - (a.offset ?? 0) - (a.limit ?? 20)} more finding(s): offset=${(a.offset ?? 0) + (a.limit ?? 20)}` } : {}),
    nextSteps: [
      ...(d.findings.some((f) => f.kind === "mixin_error") ? ["Run mixin_validate on the project to locate the bad injection statically."] : []),
      ...(d.findings.some((f) => f.kind === "compile_error") ? ["Use get_class / search_mc_source to find the current names for this version."] : []),
      ...(d.culprit && d.culprit.confidence !== "high" ? ["The culprit is a heuristic guess; confirm by removing that mod."] : []),
    ],
  });
}

export function registerCrashTools(server: McpServer, services: Services): void {
  server.registerTool(
    "analyze_crash",
    {
      title: "Analyze crash",
      description:
        "Parse a crash report, latest.log or Gradle output: root exception, likely culprit mod, Mixin failures (InvalidInjectionException, missing targets, @Shadow not found, overwrite conflicts, unsupported compatibilityLevel), missing/duplicate mod dependencies, wrong Java (class file versions), class-not-found/linkage errors, with suggested fixes.",
      inputSchema: analyzeCrashInput,
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    (a) => guard(() => analyzeCrash(services, a)),
  );
}
