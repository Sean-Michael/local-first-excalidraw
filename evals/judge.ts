/**
 * Optional LLM judge: renders the final drawing to PNG through the daemon and asks a fresh
 * `claude -p` to score it against the scenario's expected output.
 */
import fs from "node:fs";
import path from "node:path";
import { runClaude, summariseTranscript } from "./claude.js";
import type { EvalDaemon } from "./daemon.js";

export interface Judgement {
  readability?: number;
  correctness?: number;
  notes?: string;
  png?: string;
  error?: string;
  costUsd?: number;
}

/** Renders `drawing` to `out` (PNG). Throws if the daemon can't render (no editor, no headless). */
export async function renderPng(daemon: EvalDaemon, drawing: string, out: string): Promise<void> {
  const r = await daemon.op<{ data: string }>({ op: "render", path: drawing, opts: { format: "png", maxSize: 1600 } });
  fs.writeFileSync(out, Buffer.from(r.data, "base64"));
}

/** First {...} block in a reply, parsed. */
export function parseJudgeReply(text: string): { readability?: number; correctness?: number; notes?: string } {
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) throw new Error("no JSON in judge reply");
  const j = JSON.parse(m[0]);
  const score = (v: unknown) => (typeof v === "number" && v >= 1 && v <= 5 ? v : undefined);
  return { readability: score(j.readability), correctness: score(j.correctness), notes: typeof j.notes === "string" ? j.notes : undefined };
}

export async function judge(opts: {
  daemon: EvalDaemon;
  drawing: string;
  runDir: string;
  prompt: string;
  expected: string;
  model?: string;
  env: Record<string, string>;
}): Promise<Judgement> {
  const png = path.join(opts.runDir, "final.png");
  try {
    await renderPng(opts.daemon, opts.drawing, png);
  } catch (e) {
    return { error: `render failed: ${(e as Error).message}` };
  }
  // The image can't show code links or which shapes an arrow is attached to; the text listing can.
  const listing = path.join(opts.runDir, "final-listing.txt");
  let haveListing = false;
  try {
    const r = await opts.daemon.op<{ summary: string }>({ op: "read", path: opts.drawing });
    fs.writeFileSync(listing, r.summary);
    haveListing = true;
  } catch {
    // grade from the image alone
  }
  const question = [
    `You are grading a diagram an AI assistant drew. Look at the image with the Read tool: ${png}`,
    ...(haveListing
      ? [
          `Also read its text listing: ${listing}`,
          "Each line is one element: `[id] type at (x,y) size WxH \"label\"`, with `code=path#Lnn` when the element links to source code, and arrows as `[id] arrow from -> to` naming the elements they are attached to. Use it for what the image can't show: which code each node links to and which shapes each arrow connects.",
        ]
      : []),
    "",
    `The request was:\n${opts.prompt}`,
    "",
    `A good answer looks like:\n${opts.expected}`,
    "",
    "Element ids, and whether ids were kept from an earlier version of the drawing, are checked separately by deterministic graders: don't score them.",
    "",
    "Score two things from 1 (bad) to 5 (excellent):",
    "- readability (from the image): clear flow direction, no overlaps, legible labels, arrows easy to follow",
    "- correctness: shows what the request and the expected answer describe, with the right names, the right connections and, where asked for, code links",
    'Reply with only JSON: {"readability": n, "correctness": n, "notes": "one or two sentences"}',
  ].join("\n");
  const transcript = path.join(opts.runDir, "judge.jsonl");
  const args = [
    "-p", question,
    "--output-format", "stream-json", "--verbose",
    "--allowedTools", "Read",
    "--permission-mode", "dontAsk",
    "--strict-mcp-config", "--setting-sources", "project",
    "--no-session-persistence",
    ...(opts.model ? ["--model", opts.model] : []),
  ];
  const run = await runClaude(args, { cwd: opts.runDir, env: opts.env, transcriptFile: transcript, timeoutSec: 300 });
  const sum = summariseTranscript(fs.readFileSync(transcript, "utf8").split("\n"));
  if (!sum.finalText) return { png, error: `judge produced no answer (exit ${run.exitCode}${run.timedOut ? ", timed out" : ""})`, costUsd: sum.costUsd };
  try {
    return { png, ...parseJudgeReply(sum.finalText), costUsd: sum.costUsd };
  } catch (e) {
    return { png, error: (e as Error).message, notes: sum.finalText.slice(0, 300), costUsd: sum.costUsd };
  }
}
