import Fastify from "fastify";
import { createPool } from "@shopapp/db";
import { RedisTokenCache } from "./cache/redisTokenCache.js";
import { UserRepository } from "./repo/userRepository.js";
import { issueSession, introspect } from "./tokens.js";

const app = Fastify({ logger: true });
const users = new UserRepository(createPool(process.env.DATABASE_URL!));
const cache = new RedisTokenCache(process.env.REDIS_URL!, Number(process.env.SESSION_TTL_SECONDS ?? 3600));

app.post("/v1/login", async (req, reply) => {
  const { email, password } = req.body as { email: string; password: string };
  const user = await users.verifyPassword(email, password);
  if (!user) return reply.code(401).send({ error: "bad credentials" });
  return { token: await issueSession(cache, user.id) };
});

app.post("/v1/introspect", async (req, reply) => {
  const { token } = req.body as { token: string };
  const userId = await introspect(cache, token);
  if (!userId) return reply.code(401).send({ error: "expired" });
  return { userId };
});

app.post("/v1/logout", async (req) => {
  const { token } = req.body as { token: string };
  await cache.revoke(token);
  return { ok: true };
});

app.listen({ port: 7001, host: "0.0.0.0" });
