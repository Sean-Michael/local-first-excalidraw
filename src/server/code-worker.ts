/** Runs one regular-expression file search off the main thread (see searchFiles in code.ts). */
import { parentPort, workerData } from "node:worker_threads";
import { CodeError, searchFilesSync, type SearchOptions } from "./code.js";

const { root, opts } = workerData as { root: string; opts: SearchOptions };
try {
  parentPort!.postMessage({ text: searchFilesSync(root, opts) });
} catch (e) {
  parentPort!.postMessage({ error: (e as Error).message, code: e instanceof CodeError });
}
