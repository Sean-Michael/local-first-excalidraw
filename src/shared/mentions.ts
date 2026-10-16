/**
 * @-mention syntax, shared by the chat panel and the daemon: `@src/orders/` (a folder),
 * `@src/a.ts`, `@src/a.ts:10-40` or `@src/a.ts#L10-L40` (a line range) and `@OrderRepository`
 * (a symbol). Pure functions, no I/O.
 */

export interface MentionQuery {
  /** What was typed before any line range. */
  target: string;
  /** 1-based, inclusive. */
  lines?: [number, number];
  /** Ends with `/`: only folders. */
  folder: boolean;
  /** Looks like an identifier rather than a path, so it may name a symbol. */
  symbol: boolean;
}

const RANGE = /(?::(\d+)(?:-(\d+))?|#L(\d+)(?:-L?(\d+))?)$/;
const IDENTIFIER = /^[A-Za-z_$][\w$]*(?:[.#:]{1,2}[A-Za-z_$][\w$]*)?$/;
/** Most lines a range mention attaches. */
export const MAX_MENTION_LINES = 400;

export function parseMentionQuery(q: string): MentionQuery {
  let target = q.trim().replace(/^@/, "");
  let lines: [number, number] | undefined;
  const m = RANGE.exec(target);
  if (m && m.index > 0) {
    const from = Number(m[1] ?? m[3]);
    const to = Number(m[2] ?? m[4] ?? from);
    if (from > 0) {
      const lo = Math.min(from, to || from);
      const hi = Math.max(from, to || from);
      lines = [lo, Math.min(hi, lo + MAX_MENTION_LINES - 1)];
      target = target.slice(0, m.index);
    }
  }
  const folder = target.endsWith("/");
  // A bare identifier names a symbol; anything with a slash or a file extension is a path.
  const symbol = !lines && !folder && IDENTIFIER.test(target) && !/\.(\w{1,5})$/.test(target);
  return { target, lines, folder, symbol };
}

/**
 * The @-tokens typed in a message, in order and without duplicates. A token starts at the
 * beginning of the text or after whitespace or an opening bracket (so e-mail addresses don't
 * count) and ends at whitespace; trailing punctuation is dropped.
 */
export function mentionTokens(text: string, max = 10): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(/(?:^|[\s([{"'`])@([^\s@]+)/g)) {
    const t = m[1].replace(/[),.;:!?'"`\]}]+$/, "");
    if (t && !out.includes(t)) out.push(t);
    if (out.length >= max) break;
  }
  return out;
}

/** How a mention reads in a chip and in the sent message's summary. */
export function mentionLabel(m: { kind: string; rel?: string; path: string; lines?: [number, number]; symbol?: string }): string {
  if (m.kind === "symbol" && m.symbol) return m.symbol;
  const name = (m.rel ?? m.path).replace(/\/+$/, "").split(/[\\/]/).pop() ?? m.path;
  if (m.kind === "folder") return `${name}/`;
  return m.lines ? `${name}:${m.lines[0]}-${m.lines[1]}` : name;
}
