import type { FastifyInstance } from "fastify";
import proxy from "@fastify/http-proxy";
import { requireSession } from "./authMiddleware.js";

export interface Upstreams {
  keymasterUrl: string;
  ledgerUrl: string;
}

/** Public routes. Everything except sign-in needs a valid session. */
export function registerRoutes(app: FastifyInstance, up: Upstreams) {
  // Sign-in and sign-out go straight to keymaster-auth.
  app.register(proxy, { upstream: up.keymasterUrl, prefix: "/auth", rewritePrefix: "/v1" });

  // Orders: check the session first, then forward with the user id attached.
  app.register(async (orders) => {
    orders.addHook("preHandler", requireSession(up.keymasterUrl));
    orders.register(proxy, {
      upstream: up.ledgerUrl,
      prefix: "/orders",
      rewritePrefix: "/v1/orders",
      replyOptions: { rewriteRequestHeaders: (req, headers) => ({ ...headers, "x-user-id": (req as any).userId }) },
    });
  });
}
