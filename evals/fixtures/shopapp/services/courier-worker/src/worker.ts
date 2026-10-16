import { connectQueue } from "@shopapp/queue";
import { PigeonpostMailer } from "./pigeonpostMailer.js";
import { orderConfirmation } from "./templates/orderConfirmation.js";

const queue = await connectQueue(process.env.AMQP_URL!);
const mailer = new PigeonpostMailer(process.env.PIGEONPOST_API_KEY!);

// One message at a time; failed sends are retried by RabbitMQ (nack + requeue).
await queue.consume("order-events", async (msg: { type: string; orderId: string; userId: string; totalCents: number }) => {
  if (msg.type !== "order.placed") return;
  const mail = orderConfirmation(msg.orderId, msg.totalCents);
  await mailer.send({ toUserId: msg.userId, ...mail });
});
