/**
 * The drawing tree shown in the sidebar and on the drawing list: drawings grouped by root and
 * by their real folders. Pure functions, so the web page and the tests share them.
 */

export interface TreeInput {
  roots: string[];
  drawings: { path: string; root: string; mtime?: number }[];
  /** Folders under the roots; `empty` ones (nothing inside at all) show even without drawings. */
  folders: { path: string; root: string; empty?: boolean }[];
}

export interface TreeOptions {
  /** Show every folder, not just those with drawings (or empty ones the user made). */
  showAll?: boolean;
  /** Keep only drawings whose path below the root contains this (case-insensitive). */
  filter?: string;
}

export interface DrawingNode {
  kind: "drawing";
  path: string;
  name: string;
  /** Path below the root, with forward slashes. */
  rel: string;
  root: string;
  mtime?: number;
}

export interface FolderNode {
  kind: "folder";
  path: string;
  name: string;
  rel: string;
  root: string;
  /** A root itself: always shown, never renamed. */
  isRoot: boolean;
  children: TreeNode[];
  /** Drawings anywhere below. */
  count: number;
}

export type TreeNode = FolderNode | DrawingNode;

/** The separator a root is spelled with: backslash for a Windows path, else slash. */
export const sepOf = (root: string) => (root.includes("\\") && !root.includes("/") ? "\\" : "/");

const relOf = (root: string, p: string) => p.slice(root.length).replace(/^[\\/]+/, "").replace(/\\/g, "/");

export const displayName = (p: string) => p.split(/[\\/]/).pop()!.replace(/\.excalidraw$/, "");

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });

function sortNodes(nodes: TreeNode[]): void {
  nodes.sort((a, b) => (a.kind !== b.kind ? (a.kind === "folder" ? -1 : 1) : collator.compare(a.name, b.name) || collator.compare(a.path, b.path)));
  for (const n of nodes) if (n.kind === "folder") sortNodes(n.children);
}

/** Builds one folder tree per root: folders first, then drawings, each by name. */
export function buildTree(input: TreeInput, opts: TreeOptions = {}): FolderNode[] {
  const needle = opts.filter?.trim().toLowerCase() ?? "";
  // A root inside another root (a project and its docs/ folder, say) shows once, inside the outer one.
  const inside = (p: string, r: string) => p === r || p.startsWith(r + sepOf(r));
  const outer = (r: string) => input.roots.filter((o) => inside(r, o)).sort((a, b) => a.length - b.length)[0] ?? r;
  const tops = new Map<string, FolderNode>();
  for (const root of input.roots) {
    if (outer(root) !== root || tops.has(root)) continue;
    tops.set(root, { kind: "folder", path: root, name: root, rel: "", root, isRoot: true, children: [], count: 0 });
  }
  const seen = new Set<string>();

  /** The folder node for `rel` under `root`, creating it and its parents. */
  const folderAt = (root: FolderNode, rel: string): FolderNode => {
    let node = root;
    if (!rel) return node;
    const sep = sepOf(root.path);
    let sofar = "";
    for (const part of rel.split("/")) {
      sofar = sofar ? `${sofar}/${part}` : part;
      let next = node.children.find((c): c is FolderNode => c.kind === "folder" && c.name === part);
      if (!next) {
        next = { kind: "folder", path: root.path + sep + sofar.split("/").join(sep), name: part, rel: sofar, root: root.path, isRoot: false, children: [], count: 0 };
        node.children.push(next);
      }
      node = next;
    }
    return node;
  };

  for (const d of input.drawings) {
    const root = tops.get(outer(d.root));
    if (!root || seen.has(d.path)) continue;
    seen.add(d.path);
    const rel = relOf(root.path, d.path);
    if (needle && !rel.toLowerCase().includes(needle)) continue;
    const dir = rel.includes("/") ? rel.slice(0, rel.lastIndexOf("/")) : "";
    // Count the drawing on every folder from the root down.
    const parts = dir ? dir.split("/") : [];
    for (let i = 0; i <= parts.length; i++) folderAt(root, parts.slice(0, i).join("/")).count++;
    folderAt(root, dir).children.push({ kind: "drawing", path: d.path, name: displayName(d.path), rel, root: root.path, mtime: d.mtime });
  }

  for (const f of input.folders) {
    const root = tops.get(outer(f.root));
    if (!root) continue;
    const rel = relOf(root.path, f.path);
    if (!rel) continue;
    if (!(opts.showAll || f.empty) || (needle && !rel.toLowerCase().includes(needle))) continue;
    folderAt(root, rel);
  }

  const out = [...tops.values()];
  for (const r of out) sortNodes(r.children);
  return out;
}

/** The folders to expand so `file` is visible: its root and every folder down to it. */
export function ancestorFolders(root: string, file: string): string[] {
  const sep = sepOf(root);
  const rel = relOf(root, file);
  const parts = rel.split("/").slice(0, -1);
  const out = [root];
  for (let i = 1; i <= parts.length; i++) out.push(root + sep + parts.slice(0, i).join(sep));
  return out;
}

export interface Row {
  node: TreeNode;
  depth: number;
  /** The folder this row sits in; undefined for a root. */
  parent?: string;
}

/** The rows on screen, in order: folders' children only when the folder is expanded. */
export function visibleRows(tree: FolderNode[], expanded: (path: string) => boolean): Row[] {
  const rows: Row[] = [];
  const walk = (n: TreeNode, depth: number, parent?: string) => {
    rows.push({ node: n, depth, parent });
    if (n.kind === "folder" && expanded(n.path)) for (const c of n.children) walk(c, depth + 1, n.path);
  };
  for (const r of tree) walk(r, 0);
  return rows;
}
