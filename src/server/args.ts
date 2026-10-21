/**
 * Checks a model's tool arguments before the tool runs, in a way weaker models can recover from:
 * a tool's own `normalize` fixes common shape mistakes first, fields the schema doesn't know are
 * reported instead of silently dropped, and validation errors repeated across array items are
 * reported once with the indexes they apply to.
 */
import { z } from "zod";
import { closest } from "./scene.js";

export type ArgsCheck = { ok: true; data: Record<string, unknown>; notes: string[] } | { ok: false; error: string };

/** Runs `normalize`, validates against `input`, and lists the fields that were ignored. */
export function checkArgs(
  input: z.ZodRawShape,
  raw: unknown,
  normalize?: (args: Record<string, unknown>) => string[],
): ArgsCheck {
  const notes: string[] = [];
  if (raw && typeof raw === "object" && !Array.isArray(raw) && normalize) notes.push(...normalize(raw as Record<string, unknown>));
  const schema = z.object(input);
  const parsed = schema.safeParse(raw);
  if (!parsed.success) return { ok: false, error: `Invalid arguments: ${formatIssues(parsed.error.issues, schema)}${notes.length ? `\n${notes.join("\n")}` : ""}` };
  const unknown = unknownKeys(schema, raw, "");
  if (unknown.length) notes.push(`Ignored fields the tool doesn't have: ${unknown.join("; ")}.`);
  return { ok: true, data: parsed.data, notes };
}

type Def = { type: string; shape?: Record<string, z.ZodType>; catchall?: z.ZodType; element?: z.ZodType; innerType?: z.ZodType };
const defOf = (s: z.ZodType): Def => (s as unknown as { _zod: { def: Def } })._zod.def;

/** Strips optional, nullable and default wrappers. */
function unwrap(s: z.ZodType): z.ZodType {
  let cur = s;
  for (let d = defOf(cur); ["optional", "nullable", "default", "prefault", "readonly"].includes(d.type) && d.innerType; d = defOf(cur)) cur = d.innerType;
  return cur;
}

/** Paths of keys in `value` that `schema` would strip, each with a guess at the field meant. */
function unknownKeys(schema: z.ZodType, value: unknown, at: string): string[] {
  const d = defOf(unwrap(schema));
  if (d.type === "array" && d.element && Array.isArray(value)) {
    // Report a key once for all the items that share it, as validation errors are.
    const byKey = new Map<string, number[]>();
    value.forEach((v, i) => {
      for (const k of unknownKeys(d.element!, v, "")) byKey.set(k, [...(byKey.get(k) ?? []), i]);
    });
    return [...byKey].map(([k, is]) => `${at}${indexes(is)}${k.startsWith("[") ? "" : "."}${k}`);
  }
  if (d.type !== "object" || !d.shape || !value || typeof value !== "object" || Array.isArray(value)) return [];
  const loose = d.catchall && defOf(d.catchall).type !== "never";
  const out: string[] = [];
  for (const [k, v] of Object.entries(value)) {
    const child = d.shape[k];
    if (child) {
      out.push(...unknownKeys(child, v, at ? `${at}.${k}` : k));
    } else if (!loose) {
      const near = ALIASES[k] && ALIASES[k] in d.shape ? ALIASES[k] : closest(k, Object.keys(d.shape), 2);
      out.push(`${at ? `${at}.` : ""}${k}${near ? ` (did you mean \`${near}\`?)` : ""}`);
    }
  }
  return out;
}

/** Field names models reach for, mapped to what the schemas call them. */
const ALIASES: Record<string, string> = { type: "shape", source: "from", target: "to", text: "label", name: "label", kind: "relation" };

/** "[3]" for one index, "[0–10]" for a run, "[0, 2, 5]" otherwise. */
function indexes(is: number[]): string {
  if (is.length === 1) return `[${is[0]}]`;
  const run = is.every((v, i) => i === 0 || v === is[i - 1] + 1);
  return run ? `[${is[0]}–${is.at(-1)}]` : `[${is.join(", ")}]`;
}

/** One line per distinct problem, with the array indexes it applies to merged. */
function formatIssues(issues: z.core.$ZodIssue[], schema: z.ZodType): string {
  const groups = new Map<string, { path: (string | number)[]; message: string; idx: number[] }>();
  for (const iss of issues) {
    const firstIdx = iss.path.findIndex((p) => typeof p === "number");
    const shape = iss.path.map((p, i) => (i === firstIdx ? "#" : String(p)));
    const key = `${shape.join(".")}|${iss.message}`;
    const g = groups.get(key) ?? { path: iss.path as (string | number)[], message: iss.message, idx: [] };
    if (firstIdx >= 0) g.idx.push(iss.path[firstIdx] as number);
    groups.set(key, g);
  }
  return [...groups.values()]
    .map((g) => {
      let path = "";
      let seen = false;
      for (const p of g.path) {
        if (typeof p === "number" && !seen) {
          path += g.idx.length ? indexes(g.idx) : `[${p}]`;
          seen = true;
        } else path += typeof p === "number" ? `[${p}]` : path ? `.${p}` : p;
      }
      const missing = /received undefined/.test(g.message);
      const hint = missing ? describeAt(schema, g.path) : undefined;
      return `${path || "(arguments)"}: ${missing ? "missing" : g.message}${hint ? ` (${hint})` : ""}`;
    })
    .join("\n");
}

/** The schema's description of the field at `path`, if it has one. */
function describeAt(schema: z.ZodType, path: PropertyKey[]): string | undefined {
  let cur: z.ZodType | undefined = schema;
  for (const p of path) {
    if (!cur) return undefined;
    const d = defOf(unwrap(cur));
    if (typeof p === "number") cur = d.type === "array" ? d.element : undefined;
    else cur = d.type === "object" ? d.shape?.[String(p)] : undefined;
  }
  return cur?.description;
}
