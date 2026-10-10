// Usage: node scripts/gen-sample.mjs <outDir> <loader> <mcVersion> [mappings]
import { createServices } from "../dist/services.js";
import { planProject, writeProject } from "../dist/generator/index.js";

const [outDir, loader, mcVersion, mappings] = process.argv.slice(2);
const services = createServices();
const plan = await planProject(services, {
  modId: "ffnsample", modName: "FFN Sample", package: "com.example.ffnsample",
  author: "FFN", version: "1.0.0", mcVersion, loader, mappings,
});
await writeProject(plan, outDir, { overwrite: true });
console.log(JSON.stringify({ outDir, versions: plan.context.versions, java: plan.context.profile.java, warnings: plan.warnings }, null, 1));
