import crypto from "node:crypto";
import fs from "node:fs";
import type { IncomingMessage } from "node:http";
import path from "node:path";

/**
 * The browser may only talk to this origin. No CDNs, no analytics, no embeds.
 * 'wasm-unsafe-eval' is needed by Excalidraw's font subsetting (used when exporting SVG).
 */
export function contentSecurityPolicy(): string {
  return [
    "default-src 'none'",
    "script-src 'self' 'wasm-unsafe-eval'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "font-src 'self' data:",
    "connect-src 'self'",
    "worker-src 'self' blob:",
    "manifest-src 'self'",
    "frame-src 'none'",
    "child-src 'self' blob:",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
    "frame-ancestors 'none'",
  ].join("; ");
}

export const SECURITY_HEADERS: Record<string, string> = {
  "Content-Security-Policy": contentSecurityPolicy(),
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "Referrer-Policy": "no-referrer",
  "Cross-Origin-Opener-Policy": "same-origin",
  "Cross-Origin-Resource-Policy": "same-origin",
  "Permissions-Policy":
    "camera=(), microphone=(), geolocation=(), usb=(), payment=(), interest-cohort=()",
  "Cache-Control": "no-store",
};

export function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && crypto.timingSafeEqual(ab, bb);
}

/** Rejects requests whose Host header isn't ours (DNS rebinding). */
export function hostAllowed(req: IncomingMessage, allowed: Set<string>): boolean {
  const host = req.headers.host?.toLowerCase();
  return !!host && allowed.has(host);
}

/**
 * Browsers always send Origin on cross-origin requests and WebSocket upgrades.
 * Non-browser clients (the MCP server, the CLI) send none.
 */
export function originAllowed(req: IncomingMessage, allowedHosts: Set<string>): boolean {
  const origin = req.headers.origin;
  if (origin === undefined) return true;
  try {
    const u = new URL(origin);
    return u.protocol === "http:" && allowedHosts.has(u.host.toLowerCase());
  } catch {
    return false;
  }
}

export function parseCookies(req: IncomingMessage): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of (req.headers.cookie ?? "").split(";")) {
    const i = part.indexOf("=");
    if (i < 0) continue;
    out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

export function bearer(req: IncomingMessage): string | undefined {
  const h = req.headers.authorization;
  return h?.startsWith("Bearer ") ? h.slice(7).trim() : undefined;
}

export const DRAWING_EXT = ".excalidraw";

export class PathError extends Error {}

function isWithin(child: string, parent: string): boolean {
  const rel = path.relative(parent, child);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

function realpathOrNull(p: string): string | null {
  try {
    return fs.realpathSync.native(p);
  } catch {
    return null;
  }
}

/**
 * Resolves a drawing path and verifies that it - after following every symlink -
 * lives under one of the allowed roots and has an allowed extension.
 */
export function resolveSafePath(
  input: string,
  roots: string[],
  exts: string[] = [DRAWING_EXT],
): string {
  if (typeof input !== "string" || !input || input.includes("\0")) {
    throw new PathError("Invalid path");
  }
  if (!path.isAbsolute(input)) throw new PathError("Path must be absolute");
  const abs = path.resolve(input);
  if (!exts.some((e) => abs.toLowerCase().endsWith(e))) {
    throw new PathError(`Only ${exts.join(", ")} files are allowed`);
  }
  // Walk up to the nearest existing ancestor and canonicalise it.
  let existing = abs;
  const tail: string[] = [];
  while (realpathOrNull(existing) === null) {
    const parent = path.dirname(existing);
    if (parent === existing) throw new PathError("Path has no existing ancestor");
    tail.unshift(path.basename(existing));
    existing = parent;
  }
  const real = path.join(realpathOrNull(existing)!, ...tail);
  for (const root of roots) {
    const realRoot = realpathOrNull(root) ?? path.resolve(root);
    if (isWithin(real, realRoot)) return real;
  }
  throw new PathError(`Path is outside the allowed roots: ${input}`);
}
