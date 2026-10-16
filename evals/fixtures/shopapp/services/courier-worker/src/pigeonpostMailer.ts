/** Sends transactional email through the Pigeonpost HTTP API (external). */
export class PigeonpostMailer {
  constructor(private apiKey: string) {}

  async send(m: { toUserId: string; subject: string; html: string }) {
    const res = await fetch("https://api.pigeonpost.example/v1/messages", {
      method: "POST",
      headers: { "x-api-key": this.apiKey, "content-type": "application/json" },
      body: JSON.stringify({ recipient_ref: m.toUserId, subject: m.subject, html: m.html }),
    });
    if (!res.ok) throw new Error(`Pigeonpost rejected the message: ${res.status}`);
  }
}
