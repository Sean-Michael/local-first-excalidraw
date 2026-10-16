import crypto from "node:crypto";
import type { TokenCache } from "./cache/tokenCache.js";

/** Creates an opaque session token and remembers which user it belongs to. */
export async function issueSession(cache: TokenCache, userId: string): Promise<string> {
  const token = crypto.randomBytes(32).toString("base64url");
  await cache.put(token, userId);
  return token;
}

export async function introspect(cache: TokenCache, token: string): Promise<string | null> {
  return cache.get(token);
}
