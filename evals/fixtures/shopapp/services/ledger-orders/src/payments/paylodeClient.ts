/** Thin client for the Paylode payments API (an external card processor). */
export interface Charge {
  id: string;
  status: "succeeded" | "failed";
  failureCode?: string;
}

export class PaylodeClient {
  constructor(private baseUrl: string, private apiKey: string) {}

  async createCharge(req: { amountCents: number; paymentMethodId: string; idempotencyKey: string }): Promise<Charge> {
    const res = await fetch(`${this.baseUrl}/charges`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${this.apiKey}`,
        "idempotency-key": req.idempotencyKey,
        "content-type": "application/json",
      },
      body: JSON.stringify({ amount: req.amountCents, currency: "usd", payment_method: req.paymentMethodId }),
    });
    const body = (await res.json()) as { id: string; status: string; failure_code?: string };
    return { id: body.id, status: body.status === "succeeded" ? "succeeded" : "failed", failureCode: body.failure_code };
  }

  async refund(chargeId: string): Promise<void> {
    await fetch(`${this.baseUrl}/refunds`, {
      method: "POST",
      headers: { authorization: `Bearer ${this.apiKey}`, "content-type": "application/json" },
      body: JSON.stringify({ charge: chargeId }),
    });
  }
}
