# shopapp

A small online shop split into services. Everything runs with `docker compose up`.

| Service | What it does |
|---|---|
| `turnstile-gateway` | Public HTTP entry point. Checks the session with keymaster-auth, then forwards to the right service. |
| `keymaster-auth` | Sign-in, session tokens. Users live in Postgres, issued tokens are cached in Redis. |
| `ledger-orders` | Places orders: stores them in Postgres, charges the card through Paylode, publishes `order.placed`. |
| `courier-worker` | Consumes the `order-events` queue and sends confirmation emails through Pigeonpost. |

Shared code is in `packages/db` (Postgres pool and migrations) and `packages/queue` (RabbitMQ connection).
