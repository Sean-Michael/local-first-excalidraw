import fs from "node:fs";
import path from "node:path";
import type { El } from "../src/server/scene.js";

export const el = (id: string, type: string, x: number, y: number, w: number, h: number, extra: Partial<El> = {}): El =>
  ({ id, type, x, y, width: w, height: h, version: 3, versionNonce: 7, isDeleted: false, groupIds: ["g1"], index: "a1", ...extra }) as El;

/** A database icon: a box with a cap, its label bound inside, and an internal arrow. */
export const database = (): El[] => [
  el("body", "rectangle", 100, 120, 80, 60, { boundElements: [{ id: "lbl", type: "text" }, { id: "inner", type: "arrow" }] }),
  el("cap", "ellipse", 100, 100, 80, 30),
  el("lbl", "text", 120, 140, 40, 20, { text: "DB", containerId: "body", fontSize: 20 }),
  el("inner", "arrow", 110, 130, 20, 0, { points: [[0, 0], [20, 0]], startBinding: { elementId: "body", focus: 0, gap: 1 }, endBinding: { elementId: "gone", focus: 0, gap: 1 } }),
];

export function writeLibraries(root: string, personal: string) {
  fs.mkdirSync(path.join(root, "design"), { recursive: true });
  fs.writeFileSync(
    path.join(root, "design", "infra.excalidrawlib"),
    JSON.stringify({ type: "excalidrawlib", version: 2, libraryItems: [{ id: "1", status: "published", name: "Database", elements: database() }, { id: "2", status: "published", name: "Message Queue", elements: [el("q", "rectangle", 0, 0, 120, 40)] }] }),
  );
  fs.writeFileSync(personal, JSON.stringify({ libraryItems: [{ id: "p", status: "unpublished", elements: [el("star", "diamond", 5, 5, 50, 50)] }] }));
}
