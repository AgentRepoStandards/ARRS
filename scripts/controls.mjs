import { checkArchitecture, checkArchitectureGuard } from "../dist/core/architecture.js";
import { checkSecurity } from "../dist/core/security.js";
import { readConfig, scanFeatures } from "../dist/core/config.js";
import { testSkillPack } from "../dist/workflows/skills.js";
import { validate } from "../dist/core/schema.js";
import { readFileSync, readdirSync } from "node:fs";
const root = process.cwd();
const errors = [
  ...checkArchitecture(root),
  ...checkArchitectureGuard(root),
  ...checkSecurity(root),
  ...testSkillPack(root),
];
const featureReport = scanFeatures(root, readConfig(root));
if (Array.isArray(featureReport)) errors.push(...featureReport);
else if (featureReport.errors) errors.push(...featureReport.errors);
for (const path of readdirSync("schemas"))
  try {
    JSON.parse(readFileSync(`schemas/${path}`, "utf8"));
  } catch (error) {
    errors.push(`${path}: ${error.message}`);
  }
for (const [kind, file] of [
  ["config", "arrs.json"],
  ["architecture", ".agent/policies/architecture.json"],
  ["risk", ".agent/policies/risk.json"],
  ["exceptions", ".agent/policies/exceptions.json"],
])
  errors.push(...validate(kind, JSON.parse(readFileSync(file, "utf8"))));
if (errors.length) {
  console.error(errors.join("\n"));
  process.exitCode = 1;
} else
  console.log(
    "Architecture mutation guard, security, skills, configuration and schemas passed.",
  );
