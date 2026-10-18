/**
 * Eval scenarios: what to ask Claude Code, how to prepare the project first, and what the
 * resulting drawing has to look like. The data lives in evals/scenarios.json.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** The repository root, from dist/evals/ (compiled) or evals/ (source). */
export const REPO_ROOT = (() => {
  let dir = path.dirname(fileURLToPath(import.meta.url));
  while (!fs.existsSync(path.join(dir, "evals", "scenarios.json"))) {
    const up = path.dirname(dir);
    if (up === dir) throw new Error("Can't find evals/scenarios.json above " + fileURLToPath(import.meta.url));
    dir = up;
  }
  return dir;
})();

/** Any of these spellings counts (case-insensitive, punctuation ignored). */
export type Synonyms = string[];

export interface EdgeSpec {
  from: Synonyms;
  to: Synonyms;
  /** Accept the arrow in either direction. */
  undirected?: boolean;
  /** Also accept a path through up to this many intermediate elements (e.g. a decision node). Default 0. */
  via?: number;
}

export interface Checks {
  /** Each entry must match some text in the drawing. */
  requiredLabels?: Synonyms[];
  /** Each entry must match the name of some frame (a boundary or group). */
  requiredFrames?: Synonyms[];
  /** No text in the drawing may match any of these. */
  forbiddenLabels?: string[];
  /** Arrows bound to elements whose labels match. */
  requiredEdges?: EdgeSpec[];
  minShapes?: number;
  minArrows?: number;
  /** Share of arrows bound at both ends (0..1). */
  minBoundRatio?: number;
  maxOverlaps?: number;
  /** Labels wider or taller than their container. */
  maxOverflow?: number;
  minFontSize?: number;
  /** Share of the baseline's elements (shapes, arrows, frames, free text) still present. */
  minIdPreservation?: number;
  /** Elements whose listed properties must be unchanged from the baseline, and texts that must remain. */
  preserve?: { ids?: string[]; props?: string[]; texts?: string[] };
  /** Elements carrying a `link` to a file in the project. */
  links?: { minLinked?: number; allExist?: boolean };
  /** Metrics that must be better than the baseline's. */
  improve?: { overlaps?: boolean; boundRatio?: boolean; minFontSize?: boolean; overflow?: boolean };
}

/** One daemon operation run before the agent starts (same ops the MCP tools use). */
export interface SetupStep {
  op: string;
  path?: string;
  /** For op "diagram": a graph object, or the name of one in `graphs`. */
  graph?: unknown;
  /** For op "move": element id and offset. */
  id?: string;
  dx?: number;
  dy?: number;
  [k: string]: unknown;
}

export interface Scenario {
  id: string;
  title: string;
  /** The plugin skill this scenario exercises (for the skill evals.json files). */
  skill: "excalidraw" | "diagram-review" | "architecture-discovery" | "architecture-review";
  prompt: string;
  expected_output: string;
  files: string[];
  fixture: string;
  setup?: SetupStep[];
  /** Commit the drawings the setup made, so they are part of the project's history. */
  commitSetup?: boolean;
  /** A patch from evals/fixtures/<fixture>.patches/, applied and committed after setup. */
  patch?: string;
  /** Drawing to grade (relative to the project). Default: the most recently changed one. */
  drawing?: string;
  timeoutSec?: number;
  checks: Checks;
}

export interface ScenarioFile {
  graphs: Record<string, unknown>;
  scenarios: Scenario[];
}

export function loadScenarios(file = path.join(REPO_ROOT, "evals", "scenarios.json")): ScenarioFile {
  const data = JSON.parse(fs.readFileSync(file, "utf8")) as ScenarioFile;
  const seen = new Set<string>();
  for (const s of data.scenarios) {
    if (seen.has(s.id)) throw new Error(`Duplicate scenario id ${s.id}`);
    seen.add(s.id);
    for (const step of s.setup ?? []) {
      if (typeof step.graph === "string" && !data.graphs[step.graph]) throw new Error(`${s.id}: unknown graph ${step.graph}`);
    }
  }
  return data;
}

/** The prior-art evals.json shape (prompt, expected_output, files) for one skill. */
export function skillEvals(data: ScenarioFile, skill: Scenario["skill"]) {
  return {
    skill_name: skill,
    generated_from: "evals/scenarios.json (run them with `npm run evals`)",
    evals: data.scenarios
      .filter((s) => s.skill === skill)
      .map((s, i) => ({
        id: i,
        name: s.id,
        prompt: s.prompt,
        expected_output: s.expected_output,
        files: s.files,
        // The prompt assumes a prepared project; the harness does the preparing.
        ...(s.setup?.length || s.patch ? { setup: `Needs a prepared project: npm run evals -- --scenario ${s.id}` } : {}),
      })),
  };
}
