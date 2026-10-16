import amqp from "amqplib";

/** A RabbitMQ (postbox-mq) channel with JSON publish/consume helpers. */
export interface QueueConnection {
  publish(queue: string, body: unknown): Promise<void>;
  consume<T>(queue: string, handler: (msg: T) => Promise<void>): Promise<void>;
}

export async function connectQueue(url: string): Promise<QueueConnection> {
  const conn = await amqp.connect(url);
  const ch = await conn.createChannel();
  await ch.prefetch(1);
  return {
    async publish(queue, body) {
      await ch.assertQueue(queue, { durable: true });
      ch.sendToQueue(queue, Buffer.from(JSON.stringify(body)), { persistent: true });
    },
    async consume(queue, handler) {
      await ch.assertQueue(queue, { durable: true });
      await ch.consume(queue, async (m) => {
        if (!m) return;
        try {
          await handler(JSON.parse(m.content.toString()));
          ch.ack(m);
        } catch {
          ch.nack(m, false, true);
        }
      });
    },
  };
}
