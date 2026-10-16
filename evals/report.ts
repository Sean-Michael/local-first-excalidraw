/** summary.md for a results directory. */
import type { TranscriptSummary } from "./claude.js";
import type { Grade } from "./grade.js";
import type { Judgement } from "./judge.js";

export interface RunResult {
  scenario: string;
  run: number;
  model?: string;
  startedAt: string;
  wallMs: number;
  exitCode: number | null;
  timedOut: boolean;
  /** Graded drawing, relative to the project. */
  drawing?: string;
  drawings: string[];
  /** The run's temporary project directory (gone unless --keep), for resolving absolute links. */
  projectRoot: string;
  projectFiles: string[];
  grade: Grade;
  judge?: Judgement;
  transcript: Omit<TranscriptSummary, "toolCalls"> & { toolCalls: { name: string; error?: string }[] };
  stderr?: string;
  error?: string;
}

const pct = (n: number) => `${Math.round(n * 100)}%`;
const esc = (s: string) => s.replace(/\|/g, "\\|").replace(/\n/g, " ");

export function summaryMarkdown(title: string, runs: RunResult[]): string {
  const out: string[] = [`# ${title}`, ""];
  const passed = runs.filter((r) => r.grade.pass).length;
  const cost = runs.reduce((s, r) => s + (r.transcript.costUsd ?? 0) + (r.judge?.costUsd ?? 0), 0);
  out.push(`${passed}/${runs.length} runs passed every check. Total cost $${cost.toFixed(2)}.`, "");
  out.push("| Scenario | Run | Result | Score | Failed checks | Tool calls (MCP) | Tool errors | Turns | Cost | Time | Judge |");
  out.push("|---|---|---|---|---|---|---|---|---|---|---|");
  for (const r of runs) {
    const t = r.transcript;
    const total = Object.values(t.toolCounts).reduce((a, b) => a + b, 0);
    const mcp = Object.entries(t.toolCounts).filter(([k]) => k.startsWith("mcp__")).reduce((a, [, b]) => a + b, 0);
    const failed = r.grade.checks.filter((c) => !c.pass).map((c) => c.name).join(", ") || "-";
    const j = r.judge ? (r.judge.error ? `error` : `R${r.judge.readability ?? "?"} C${r.judge.correctness ?? "?"}`) : "-";
    out.push(
      `| ${r.scenario} | ${r.run} | ${r.error ? "ERROR" : r.grade.pass ? "pass" : "FAIL"} | ${pct(r.grade.score)} | ${esc(failed)} | ${total} (${mcp}) | ${t.toolErrors.length} | ${t.turns ?? "-"} | ${t.costUsd !== undefined ? `$${t.costUsd.toFixed(2)}` : "-"} | ${Math.round(r.wallMs / 1000)}s${r.timedOut ? " (timeout)" : ""} | ${j} |`,
    );
  }
  out.push("");
  for (const r of runs) {
    out.push(`## ${r.scenario} #${r.run}`, "");
    if (r.error) out.push(`Error: ${r.error}`, "");
    out.push(`Drawing: ${r.drawing ?? "(none)"}${r.drawings.length > 1 ? ` (also: ${r.drawings.filter((d) => d !== r.drawing).join(", ")})` : ""}. Model: ${r.model ?? "default"}.`, "");
    out.push("| Check | Result | Detail |", "|---|---|---|");
    for (const c of r.grade.checks) out.push(`| ${c.name} | ${c.pass ? "pass" : "FAIL"} | ${esc(c.detail)} |`);
    out.push("");
    const tools = Object.entries(r.transcript.toolCounts).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k.replace(/^mcp__excalidraw__/, "")} ${v}`);
    out.push(`Tools: ${tools.join(", ") || "none"}.`);
    if (r.transcript.skillsUsed.length) out.push(`Skills: ${r.transcript.skillsUsed.join(", ")}.`);
    if (r.transcript.toolErrors.length) {
      out.push("", "Tool errors:");
      for (const e of r.transcript.toolErrors.slice(0, 8)) out.push(`- ${e.name}: ${esc(e.error.slice(0, 200))}`);
    }
    if (r.transcript.permissionDenials.length) out.push("", `Permission denials: ${r.transcript.permissionDenials.length}.`);
    if (r.judge) out.push("", r.judge.error ? `Judge: ${r.judge.error}` : `Judge: readability ${r.judge.readability}, correctness ${r.judge.correctness}. ${r.judge.notes ?? ""}`);
    out.push("");
  }
  return out.join("\n");
}
