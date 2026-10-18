#!/usr/bin/env node
/**
 * Writes plugin/skills/<skill>/evals/evals.json from evals/scenarios.json, in the common
 * skill-eval shape (prompt, expected_output, files). Run after editing scenarios.json:
 *
 *   npm run evals:skills
 */
import fs from "node:fs";
import path from "node:path";
import { loadScenarios, REPO_ROOT, skillEvals } from "./scenarios.js";

export const SKILLS = ["excalidraw", "diagram-review", "architecture-discovery", "architecture-review"] as const;

export const skillEvalsPath = (skill: string) => path.join(REPO_ROOT, "plugin", "skills", skill, "evals", "evals.json");

export const renderSkillEvals = (skill: (typeof SKILLS)[number]) => JSON.stringify(skillEvals(loadScenarios(), skill), null, 2) + "\n";

if (process.argv[1] && path.resolve(process.argv[1]).endsWith(path.join("evals", "skill-evals.js"))) {
  for (const skill of SKILLS) {
    const file = skillEvalsPath(skill);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, renderSkillEvals(skill));
    console.log(`Wrote ${path.relative(REPO_ROOT, file)}`);
  }
}
