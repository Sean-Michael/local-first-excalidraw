import type { QueueConnection } from "@shopapp/queue";

export const ORDER_EVENTS_QUEUE = "order-events";

/** Publishes order lifecycle events to RabbitMQ (postbox-mq). */
export class OrderEventsPublisher {
  constructor(private queue: QueueConnection) {}

  async orderPlaced(e: { orderId: string; userId: string; totalCents: number }) {
    await this.queue.publish(ORDER_EVENTS_QUEUE, { type: "order.placed", ...e });
  }
}
