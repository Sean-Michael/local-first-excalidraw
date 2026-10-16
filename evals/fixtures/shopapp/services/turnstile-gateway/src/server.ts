import Fastify from "fastify";
import { registerRoutes } from "./routes.js";

const app = Fastify({ logger: true });

registerRoutes(app, {
  keymasterUrl: process.env.KEYMASTER_URL ?? "http://localhost:7001",
  ledgerUrl: process.env.LEDGER_URL ?? "http://localhost:7002",
});

app.listen({ port: 8080, host: "0.0.0.0" });
