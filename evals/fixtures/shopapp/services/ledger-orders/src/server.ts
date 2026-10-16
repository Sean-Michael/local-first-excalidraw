import Fastify from "fastify";
import { createPool } from "@shopapp/db";
import { connectQueue } from "@shopapp/queue";
import { OrderEventsPublisher } from "./events/orderEventsPublisher.js";
import { PaylodeClient } from "./payments/paylodeClient.js";
import { placeOrder, type PlaceOrderInput } from "./placeOrder.js";
import { OrderRepository } from "./repo/orderRepository.js";

const app = Fastify({ logger: true });
const orders = new OrderRepository(createPool(process.env.DATABASE_URL!));
const paylode = new PaylodeClient(process.env.PAYLODE_BASE_URL!, process.env.PAYLODE_API_KEY!);
const events = new OrderEventsPublisher(await connectQueue(process.env.AMQP_URL!));

app.post("/v1/orders", async (req, reply) => {
  const userId = req.headers["x-user-id"] as string;
  const result = await placeOrder({ orders, paylode, events }, userId, req.body as PlaceOrderInput);
  return reply.code(result.ok ? 201 : 402).send(result);
});

app.get("/v1/orders/:id", async (req) => orders.findById((req.params as { id: string }).id));

app.listen({ port: 7002, host: "0.0.0.0" });
