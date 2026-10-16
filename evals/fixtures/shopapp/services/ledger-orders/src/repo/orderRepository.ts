import type { Pool } from "@shopapp/db";

export interface OrderRow {
  id: string;
  user_id: string;
  status: "pending" | "paid" | "payment_failed";
  total_cents: number;
  paylode_charge_id: string | null;
}

/** Orders and order_items tables. */
export class OrderRepository {
  constructor(private pool: Pool) {}

  async insertPending(userId: string, items: { sku: string; quantity: number; unitPriceCents: number }[], totalCents: number) {
    const client = await this.pool.connect();
    try {
      await client.query("begin");
      const { rows } = await client.query<OrderRow>(
        "insert into orders (user_id, status, total_cents) values ($1, 'pending', $2) returning *",
        [userId, totalCents],
      );
      for (const i of items) {
        await client.query("insert into order_items (order_id, sku, quantity, unit_price_cents) values ($1, $2, $3, $4)", [rows[0].id, i.sku, i.quantity, i.unitPriceCents]);
      }
      await client.query("commit");
      return rows[0];
    } catch (e) {
      await client.query("rollback");
      throw e;
    } finally {
      client.release();
    }
  }

  async markPaid(id: string, chargeId: string) {
    await this.pool.query("update orders set status = 'paid', paylode_charge_id = $2 where id = $1", [id, chargeId]);
  }

  async markPaymentFailed(id: string, code?: string) {
    await this.pool.query("update orders set status = 'payment_failed', failure_code = $2 where id = $1", [id, code ?? null]);
  }

  async findById(id: string) {
    const { rows } = await this.pool.query<OrderRow>("select * from orders where id = $1", [id]);
    return rows[0] ?? null;
  }
}
