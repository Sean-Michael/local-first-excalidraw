import Redis from "ioredis";
import type { TokenCache } from "./tokenCache.js";

/** Session tokens in Redis (token-cache), expiring after the session TTL. */
export class RedisTokenCache implements TokenCache {
  private redis: Redis;

  constructor(url: string, private ttlSeconds: number) {
    this.redis = new Redis(url);
  }

  async put(token: string, userId: string) {
    await this.redis.set(`session:${token}`, userId, "EX", this.ttlSeconds);
  }

  async get(token: string) {
    return this.redis.get(`session:${token}`);
  }

  async revoke(token: string) {
    await this.redis.del(`session:${token}`);
  }
}
