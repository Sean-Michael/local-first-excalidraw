import type { FastifyReply, FastifyRequest } from "fastify";

/** Asks keymaster-auth whether the bearer token is a live session. */
export function requireSession(keymasterUrl: string) {
  return async (req: FastifyRequest, reply: FastifyReply) => {
    const token = req.headers.authorization?.replace(/^Bearer /, "");
    if (!token) return reply.code(401).send({ error: "missing token" });
    const res = await fetch(`${keymasterUrl}/v1/introspect`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token }),
    });
    if (!res.ok) return reply.code(401).send({ error: "invalid session" });
    const { userId } = (await res.json()) as { userId: string };
    (req as any).userId = userId;
  };
}
