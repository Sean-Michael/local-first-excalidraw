/**
 * JSON with comments and trailing commas, as in VS Code's settings.json. Errors carry a
 * line and column, which WebKit's JSON.parse doesn't report.
 */

export class JsoncError extends Error {
  constructor(
    message: string,
    readonly offset: number,
    readonly line: number,
    readonly column: number,
  ) {
    super(`${message} (line ${line}, column ${column})`);
  }
}

export function parseJsonc(text: string): unknown {
  let i = 0;

  const fail = (msg: string, at = i): never => {
    const before = text.slice(0, at);
    const line = before.split("\n").length;
    throw new JsoncError(msg, at, line, at - before.lastIndexOf("\n"));
  };

  const skip = () => {
    for (;;) {
      const c = text[i];
      if (c === " " || c === "\t" || c === "\n" || c === "\r") i++;
      else if (c === "/" && text[i + 1] === "/") {
        while (i < text.length && text[i] !== "\n") i++;
      } else if (c === "/" && text[i + 1] === "*") {
        const end = text.indexOf("*/", i + 2);
        if (end < 0) fail("Unterminated comment");
        i = end + 2;
      } else return;
    }
  };

  const string = (): string => {
    const start = i++;
    let out = "";
    for (;;) {
      const c = text[i];
      if (c === undefined || c === "\n") fail("Unterminated string", start);
      if (c === '"') {
        i++;
        return out;
      }
      if (c === "\\") {
        const e = text[i + 1];
        const map: Record<string, string> = { '"': '"', "\\": "\\", "/": "/", b: "\b", f: "\f", n: "\n", r: "\r", t: "\t" };
        if (e === "u") {
          const hex = text.slice(i + 2, i + 6);
          if (!/^[0-9a-fA-F]{4}$/.test(hex)) fail("Invalid unicode escape");
          out += String.fromCharCode(parseInt(hex, 16));
          i += 6;
        } else if (e in map) {
          out += map[e];
          i += 2;
        } else fail("Invalid escape in string");
      } else {
        out += c;
        i++;
      }
    }
  };

  const value = (): unknown => {
    skip();
    const c = text[i];
    if (c === "{") {
      i++;
      const obj: Record<string, unknown> = {};
      skip();
      if (text[i] === "}") return i++, obj;
      for (;;) {
        skip();
        if (text[i] === "}") return i++, obj; // trailing comma
        if (text[i] !== '"') fail("Expected a property name in double quotes");
        const key = string();
        skip();
        if (text[i] !== ":") fail(`Expected ":" after "${key}"`);
        i++;
        obj[key] = value();
        skip();
        if (text[i] === ",") i++;
        else if (text[i] === "}") return i++, obj;
        else fail('Expected "," or "}"');
      }
    }
    if (c === "[") {
      i++;
      const arr: unknown[] = [];
      for (;;) {
        skip();
        if (text[i] === "]") return i++, arr;
        arr.push(value());
        skip();
        if (text[i] === ",") i++;
        else if (text[i] !== "]") fail('Expected "," or "]"');
      }
    }
    if (c === '"') return string();
    const m = /^(?:-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?|true|false|null)/.exec(text.slice(i, i + 64));
    if (!m) fail(c === undefined ? "Unexpected end of file" : `Unexpected ${JSON.stringify(c)}`);
    i += m![0].length;
    const w = m![0];
    return w === "true" ? true : w === "false" ? false : w === "null" ? null : Number(w);
  };

  const result = value();
  skip();
  if (i < text.length) fail("Unexpected text after the end of the settings");
  return result;
}

export type TokenKind = "key" | "string" | "number" | "literal" | "comment" | "punct" | "space";

/** Splits JSONC into tokens for syntax colouring. Never throws, even on broken input. */
export function tokenize(text: string): { kind: TokenKind; text: string }[] {
  const re = /(\/\/[^\n]*|\/\*[\s\S]*?(?:\*\/|$))|("(?:[^"\\\n]|\\.)*"?)(\s*:)?|(-?\d[\d.eE+-]*)|(true|false|null)\b|([{}[\],:])|(\s+|[^\s"{}[\],:/]+|\/)/g;
  const out: { kind: TokenKind; text: string }[] = [];
  for (const m of text.matchAll(re)) {
    if (m[1]) out.push({ kind: "comment", text: m[1] });
    else if (m[2]) {
      out.push({ kind: m[3] ? "key" : "string", text: m[2] });
      if (m[3]) out.push({ kind: "punct", text: m[3] });
    } else if (m[4]) out.push({ kind: "number", text: m[4] });
    else if (m[5]) out.push({ kind: "literal", text: m[5] });
    else if (m[6]) out.push({ kind: "punct", text: m[6] });
    else out.push({ kind: "space", text: m[0] });
  }
  return out;
}
