/**
 * What a tool call reads as in the chat panel: "Read a file · services/orders/src/server.ts"
 * instead of a tool name and an absolute path. Pure functions, so the page and the tests share them.
 */
import type { ToolPart } from "./chat.js";

/** Past-tense labels for finished (and running) calls. Every tool the assistant can call has one. */
export const TOOL_LABELS: Record<string, string> = {
  excalidraw_guide: "Read the element guide",
  diagram_reference: "Read the diagram notes",
  list_drawings: "Listed drawings",
  read_drawing: "Read the drawing",
  create_drawing: "Created a drawing",
  create_diagram: "Drew a diagram",
  add_elements: "Added elements",
  connect_elements: "Connected elements",
  update_elements: "Updated elements",
  delete_elements: "Deleted elements",
  apply_changes: "Applied changes",
  arrange_elements: "Arranged elements",
  snapshot_drawing: "Saved a snapshot",
  list_snapshots: "Listed snapshots",
  restore_drawing: "Restored a snapshot",
  mermaid_to_drawing: "Converted Mermaid",
  render_drawing: "Looked at the drawing",
  export_drawing: "Exported an image",
  open_drawing: "Opened the drawing",
  check_code_links: "Checked code links",
  list_shapes: "Looked up library shapes",
  insert_shape: "Inserted a library shape",
  project_overview: "Looked over the project",
  git_changes: "Checked what changed in git",
  list_files: "Listed files",
  search_files: "Searched files",
  outline_file: "Outlined a file",
  find_symbol: "Looked up a symbol",
  read_file: "Read a file",
  // Claude Code's own file tools.
  Read: "Read a file",
  Grep: "Searched files",
  Glob: "Listed files",
};

/** Labels for failed calls, so a failure never reads as "Drew a diagram". */
export const FAILED_LABELS: Record<string, string> = {
  create_drawing: "Couldn't create the drawing",
  create_diagram: "Couldn't draw the diagram",
  add_elements: "Couldn't add elements",
  connect_elements: "Couldn't connect elements",
  update_elements: "Couldn't update elements",
  delete_elements: "Couldn't delete elements",
  apply_changes: "Couldn't apply the changes",
  arrange_elements: "Couldn't arrange elements",
  restore_drawing: "Couldn't restore the snapshot",
  mermaid_to_drawing: "Couldn't convert Mermaid",
  insert_shape: "Couldn't insert the shape",
};

/** "find_symbol" -> "Find symbol", for a tool this file doesn't know (a newer daemon, say). */
const humanize = (name: string) => {
  const words = name.replace(/[_-]+/g, " ").trim();
  return words ? words[0].toUpperCase() + words.slice(1) : name;
};

export function toolLabel(part: Pick<ToolPart, "name" | "status">): string {
  const label = TOOL_LABELS[part.name] ?? humanize(part.name);
  return part.status === "error" ? (FAILED_LABELS[part.name] ?? `${label} (failed)`) : label;
}

/** The first line of an error, without the "Error:" / "Invalid arguments:" prefix. */
export function errorLine(result: string | undefined): string | undefined {
  const line = result?.replace(/^(Error|Invalid arguments|Not run):\s*/, "").split("\n").find((l) => l.trim());
  return line ? line.replace(/^✖\s*/, "").trim() : undefined;
}

const MAX_SEGMENTS = 3;

/**
 * A path short enough for a chip. An absolute path loses the folders it shares with the open
 * drawing (so a project file reads from the project down), and a long one keeps its last three
 * segments, since the file name is the part worth reading.
 */
export function shortPath(p: string, drawing?: string): string {
  const parts = p.split(/[\\/]/);
  const absolute = parts[0] === "" || /^[A-Za-z]:$/.test(parts[0]);
  let rest = parts.filter(Boolean);
  if (absolute && drawing) {
    const base = drawing.split(/[\\/]/).filter(Boolean).slice(0, -1);
    let i = 0;
    while (i < base.length && i < rest.length - 1 && base[i] === rest[i]) i++;
    rest = rest.slice(i);
  } else if (absolute) {
    rest = rest.slice(-2);
  }
  return rest.length > MAX_SEGMENTS ? `…/${rest.slice(-MAX_SEGMENTS).join("/")}` : rest.join("/");
}

const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? "" : "s"}`;

/** The grey detail beside a chip's label: what the call was about, or why it failed. */
export function toolSummary(p: ToolPart, drawing?: string): string {
  if (p.status === "error") return errorLine(p.result) ?? "";
  let args: Record<string, unknown> = {};
  try {
    const parsed: unknown = JSON.parse(p.args || "{}");
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) args = parsed as Record<string, unknown>;
  } catch {
    // partial or invalid
  }
  const pick = (k: string) => (typeof args[k] === "string" && args[k] ? String(args[k]) : undefined);
  // The open drawing is what every drawing tool acts on: naming it on each chip says nothing.
  const path = pick("path");
  const file = pick("file_path") ?? (path && p.name !== "add_elements" && path !== drawing && !drawing?.endsWith(`/${path}`) ? path : undefined);
  const detail =
    pick("pattern") ?? (file ? shortPath(file, drawing) : undefined) ?? pick("glob") ?? pick("title") ?? pick("label") ?? pick("name") ?? pick("query") ?? pick("topic") ?? pick("shape") ?? pick("dir");
  const list = (k: string) => (Array.isArray(args[k]) ? (args[k] as unknown[]).length : undefined);
  const changes = ["add", "update", "delete"].map((k) => (list(k) ? `${list(k)} ${k === "add" ? "added" : `${k}d`}` : "")).filter(Boolean);
  const count =
    list("nodes") !== undefined
      ? plural(list("nodes")!, "node")
      : changes.length
        ? changes.join(", ")
        : (["elements", "updates", "ids"].map(list).find((n) => n !== undefined)?.toString());
  return [detail, count].filter(Boolean).join(" · ");
}
