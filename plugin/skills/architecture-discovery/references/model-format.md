# The model

Two tables and a list. Keep them in your notes while you investigate, show them to the user before drawing, and keep them with the diagram afterwards.

## Elements

| Column | Content |
|---|---|
| Name | The name from the code or config (Compose key, package name, class name) |
| Type | Person, Software System, Container (web app, API, worker, database, cache, broker, bucket, function), Component, or Deployment Node |
| Technology | Language/framework or product and version where known (`Node.js / Fastify`, `Postgres 16`) |
| Responsibility | One short phrase: what it does |
| Scope | Inside the system, or external |
| Source | The file that proves it exists (Dockerfile, compose service, server entrypoint, Terraform resource) |

## Relationships

| Column | Content |
|---|---|
| From → To | Who initiates → who receives |
| Intent | A verb phrase (`Checks session with`, `Publishes order.placed to`) |
| Style | sync or async |
| Protocol | HTTP/JSON, gRPC, SQL/TCP, AMQP, Redis, SMTP, … |
| Data | What it carries, especially anything sensitive (credentials, card data, personal data) |
| Source | The file (and line) that makes the call |

## Open questions

Anything you couldn't prove from the code: configured but unused dependencies, unmatched hostnames, ambiguous names, environments that differ. Ask before drawing.

## Example: the shopapp fixture at container level

Elements:

| Name | Type | Technology | Responsibility | Scope | Source |
|---|---|---|---|---|---|
| Shopper | Person | | Browses and places orders | external | `README.md` |
| turnstile-gateway | Container: API gateway | Node.js / Fastify | Public entry point, checks sessions, proxies | inside | `services/turnstile-gateway/src/server.ts` |
| keymaster-auth | Container: API | Node.js / Fastify | Sign-in, session tokens | inside | `services/keymaster-auth/src/server.ts` |
| ledger-orders | Container: API | Node.js / Fastify | Places orders, charges cards | inside | `services/ledger-orders/src/server.ts` |
| courier-worker | Container: worker | Node.js | Sends order confirmation emails | inside | `services/courier-worker/src/worker.ts` |
| shopapp-pg | Container: database | Postgres 16 | users, orders, order_items | inside | `docker-compose.yml`, `packages/db/src/pool.ts` |
| token-cache | Container: cache | Redis 7 | Live session tokens | inside | `services/keymaster-auth/src/cache/redisTokenCache.ts` |
| postbox-mq | Container: broker | RabbitMQ 3.13 | `order-events` queue | inside | `packages/queue/src/amqp.ts` |
| Paylode | Software System | HTTPS API | Card processor | external | `services/ledger-orders/src/payments/paylodeClient.ts` |
| Pigeonpost | Software System | HTTPS API | Transactional email | external | `services/courier-worker/src/pigeonpostMailer.ts` |

Relationships (excerpt):

| From → To | Intent | Style | Protocol | Data | Source |
|---|---|---|---|---|---|
| turnstile-gateway → keymaster-auth | Checks session with | sync | HTTP/JSON | bearer token | `turnstile-gateway/src/authMiddleware.ts` |
| turnstile-gateway → ledger-orders | Forwards orders to | sync | HTTP/JSON | order, `x-user-id` | `turnstile-gateway/src/routes.ts` |
| ledger-orders → Paylode | Charges cards through | sync | HTTPS | amount, payment method, API key | `ledger-orders/src/payments/paylodeClient.ts` |
| ledger-orders → postbox-mq | Publishes order.placed to | async | AMQP | order id, user id, total | `ledger-orders/src/events/orderEventsPublisher.ts` |
| postbox-mq → courier-worker | Delivers order-events to | async | AMQP | same | `courier-worker/src/worker.ts` |

`packages/db` and `packages/queue` are libraries, not containers: they show up as the arrows from their importers to `shopapp-pg` and `postbox-mq`.

Trust boundaries: the public edge at turnstile-gateway (the only published port, 8080); downstream services trust the `x-user-id` header the gateway sets; Paylode and Pigeonpost are third parties reached with API keys from the environment.

## Mapping to `create_diagram`

- Element → node: `id` is the name; `label` is `"name\n[Type: technology]\nresponsibility"`; `code` is the source file; colour by type (blue services, green data stores, gray brokers, orange externals).
- Inside elements → one group labelled `"<system> [Software System]"`, which becomes the boundary frame. Externals and people stay outside.
- Relationship → edge: `label` is intent plus protocol, shortened for the drawing (`"order.placed [AMQP]"`). Async edges are dashed (set `strokeStyle` with `update_elements` after layout).
- A broker is a node in the middle (`ledger-orders → postbox-mq → courier-worker`), not a label on a direct arrow.
- Trust boundaries go on as dashed rectangles afterwards (see the architecture-diagrams skill's data-flow recipe).
