/**
 * Summarises the in-app assistant's saved chats, one row per reply: the model, how many tool
 * calls it made, how many failed, how many of those repeated an earlier failed call word for
 * word, how many source files it read, and how the reply ended. For comparing models on the same
 * prompt without turning tracing on.
 *
 *   npm run chats -- [--since HOURS] [--json] [FILTER]
 *
 * FILTER keeps chats whose drawing path, prompt or model contains it. Chats live in
 * $LFX_STATE_DIR/chats (default ~/.local-first-excalidraw/chats).
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

interface Part {
  type: string;
  name?: string;
  args?: string;
  status?: string;
  result?: string;
  text?: string;
}

interface Row {
  updated: string;
  drawing: string;
  model: string;
  prompt: string;
  calls: number;
  failed: number;
  repeats: number;
  reads: number;
  status: string;
  errors: string[];
}

const READS = new Set(["read_file", "outline_file", "Read"]);

function rows(dir: string, sinceMs: number): Row[] {
  const out: Row[] = [];
  const files = fs.existsSync(dir)
    ? fs.readdirSync(dir, { recursive: true, encoding: "utf8" }).filter((f) => f.endsWith(".json") && path.basename(f) !== "open.json")
    : [];
  for (const f of files) {
    const file = path.join(dir, f);
    if (fs.statSync(file).mtimeMs < sinceMs) continue;
    let chat: { path?: string; updated?: number; items?: { kind: string; text?: string; endpoint?: string; status?: string; parts?: Part[] }[] };
    try {
      chat = JSON.parse(fs.readFileSync(file, "utf8"));
    } catch {
      continue;
    }
    let prompt = "";
    for (const it of chat.items ?? []) {
      if (it.kind === "user") prompt = it.text ?? "";
      if (it.kind !== "assistant") continue;
      const tools = (it.parts ?? []).filter((p) => p.type === "tool");
      const failed = tools.filter((p) => p.status === "error");
      const seen = new Set<string>();
      let repeats = 0;
      for (const p of failed) {
        const key = `${p.name} ${p.args}`;
        if (seen.has(key)) repeats++;
        seen.add(key);
      }
      out.push({
        updated: new Date(chat.updated ?? 0).toISOString().slice(0, 16).replace("T", " "),
        drawing: path.basename(chat.path ?? "?"),
        model: (it.endpoint ?? "?").replace(/^.* · /, ""),
        prompt,
        calls: tools.length,
        failed: failed.length,
        repeats,
        reads: tools.filter((p) => READS.has(p.name ?? "")).length,
        status: it.status ?? "?",
        errors: [...new Set(failed.map((p) => (p.result ?? "").split("\n")[0].slice(0, 100)))],
      });
    }
  }
  return out.sort((a, b) => a.updated.localeCompare(b.updated));
}

function main() {
  const args = process.argv.slice(2);
  let hours = 24;
  let json = false;
  let filter = "";
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--since") hours = Number(args[++i]);
    else if (args[i] === "--json") json = true;
    else if (args[i] === "-h" || args[i] === "--help") {
      console.log("Usage: npm run chats -- [--since HOURS] [--json] [FILTER]");
      return;
    } else filter = args[i].toLowerCase();
  }
  const dir = path.join(process.env.LFX_STATE_DIR ?? path.join(os.homedir(), ".local-first-excalidraw"), "chats");
  const found = rows(dir, Date.now() - hours * 3_600_000).filter(
    (r) => !filter || [r.drawing, r.prompt, r.model].some((s) => s.toLowerCase().includes(filter)),
  );
  if (json) {
    console.log(JSON.stringify(found, null, 2));
    return;
  }
  if (!found.length) {
    console.log(`No assistant replies in ${dir} from the last ${hours} hours${filter ? ` matching "${filter}"` : ""}.`);
    return;
  }
  console.log("| Updated (UTC) | Drawing | Model | Calls | Failed | Repeats | Files read | End | Prompt |");
  console.log("|---|---|---|---|---|---|---|---|---|");
  for (const r of found) {
    const prompt = r.prompt.replace(/\s+/g, " ").replace(/\|/g, "\\|").slice(0, 60);
    console.log(`| ${r.updated} | ${r.drawing} | ${r.model} | ${r.calls} | ${r.failed} | ${r.repeats} | ${r.reads} | ${r.status} | ${prompt} |`);
  }
  const errs = found.filter((r) => r.errors.length);
  if (errs.length) {
    console.log("\nErrors:");
    for (const r of errs) for (const e of r.errors) console.log(`- ${r.model}, ${r.drawing}: ${e}`);
  }
}

main();
