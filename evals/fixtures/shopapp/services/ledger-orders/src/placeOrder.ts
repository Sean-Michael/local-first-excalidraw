import type { OrderEventsPublisher } from "./events/orderEventsPublisher.js";
import type { PaylodeClient } from "./payments/paylodeClient.js";
import type { OrderRepository } from "./repo/orderRepository.js";

export interface PlaceOrderInput {
  items: { sku: string; quantity: number; unitPriceCents: number }[];
  paymentMethodId: string;
}

export interface Deps {
  orders: OrderRepository;
  paylode: PaylodeClient;
  events: OrderEventsPublisher;
}

/**
 * The checkout path:
 * 1. save the order as `pending` in Postgres
 * 2. charge the card through Paylode
 * 3. mark it `paid` (or `payment_failed`)
 * 4. publish `order.placed` so courier-worker emails the receipt
 */
export async function placeOrder(deps: Deps, userId: string, input: PlaceOrderInput) {
  const totalCents = input.items.reduce((s, i) => s + i.quantity * i.unitPriceCents, 0);
  const order = await deps.orders.insertPending(userId, input.items, totalCents);

  const charge = await deps.paylode.createCharge({
    amountCents: totalCents,
    paymentMethodId: input.paymentMethodId,
    idempotencyKey: order.id,
  });
  if (charge.status !== "succeeded") {
    await deps.orders.markPaymentFailed(order.id, charge.failureCode);
    return { ok: false, orderId: order.id, reason: charge.failureCode };
  }

  await deps.orders.markPaid(order.id, charge.id);
  await deps.events.orderPlaced({ orderId: order.id, userId, totalCents });
  return { ok: true, orderId: order.id };
}
