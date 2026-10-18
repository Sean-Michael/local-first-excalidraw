# Checks

For each check: what to look for on the diagram, how to confirm it in code or config, how to rate it, and the usual fixes. Default severities assume a production system that handles money or personal data. Lower them for internal tools and prototypes, and say why.

## Single points of failure

**On the diagram:** one box that every critical flow passes through: a single database, broker, cache, gateway or auth service, with no replica, cluster, failover or fallback shown.

**Confirm:** Compose files show one container, but production may differ. Look for Helm `replicaCount`, Kubernetes `replicas`, HPAs, managed-service settings (`multi_az`, `replicas`, cluster modes) in Terraform, and Redis Sentinel/Cluster or RabbitMQ quorum queues. Check whether callers degrade gracefully when it's down (cached answers, queued writes) or fail hard.

**Severity:** high when a stateful store or the auth path has one instance and every request needs it; medium for stateless services with one replica (easy to scale, but nothing says it is); low when the outage only delays background work.

**Fixes:** replicas or a managed HA offering; health checks and failover; a degraded mode (serve from cache, accept and queue); keep the session check off the database's critical path.

## Synchronous call chains

**On the diagram:** a path of solid (sync) arrows three or more hops long that one user request waits on, or a sync call to a third party inside a request.

**Confirm:** follow the request through the code. Check every hop for a timeout (`AbortSignal.timeout`, client `timeout` options), retries with backoff, and a circuit breaker. A `fetch` with no timeout waits as long as the socket does. Count what happens per request: an auth introspection call on every request is a hop.

**Severity:** high when a third-party call or a chain of three or more hops has no timeouts (one slow dependency exhausts the caller's connections); medium when timeouts exist but the chain multiplies latency and availability (three 99.9% services in series give about 99.7%); low for short internal chains with timeouts.

**Fixes:** timeouts and circuit breakers on every hop; cache or verify tokens locally (signed tokens) instead of calling auth per request; move work that doesn't need to finish before the reply onto a queue; parallelise independent calls.

## Shared databases

**On the diagram:** two or more services with arrows to the same data store.

**Confirm:** read the migrations and repositories. Which tables does each service read and write? A foreign key from one service's table to another's (`orders.user_id references users(id)`) couples their schemas and deploys. Same connection string, same user and password for both services means neither can be isolated.

**Severity:** medium when services write to tables owned by another or share foreign keys; low when they use separate schemas in one server (an operational SPOF, not a coupling problem; note it under SPOF instead).

**Fixes:** one owner per table, others go through its API or events; separate schemas or databases with separate credentials; replace cross-service foreign keys with ids checked at the application level.

## Messaging reliability

**On the diagram:** a queue or topic with consumers, no dead-letter queue drawn, and nothing saying how failures are retried.

**Confirm:**
- **Consumer retries:** what happens when the handler throws? `nack(requeue=true)` with no limit loops forever on a poison message and blocks the queue (with `prefetch(1)`, everything behind it waits). Look for a retry count, a delay, and a DLQ or dead-letter exchange.
- **Idempotency:** at-least-once delivery means duplicates. Does the handler dedupe by message id, or is its side effect (an email, a charge, an insert) safe to repeat?
- **Publisher dual write:** does the service commit to its database and then publish, as two steps? A crash between them loses the event (or publishes for a rolled-back change). Look for a transactional outbox or publisher confirms.
- **Ordering:** does the consumer assume order the broker doesn't guarantee?

**Severity:** high when a poison message can block the queue or a non-idempotent side effect can repeat (double charge, duplicate email at scale); medium for a lost event on crash in the dual write; low for missing monitoring of queue depth.

**Fixes:** bounded retries with backoff, then a DLQ with an alert; an idempotency key per message stored by the consumer; a transactional outbox; publisher confirms.

## Sensitive data across trust boundaries

**On the diagram:** arrows that cross a trust boundary (the public edge, the system boundary, a third party), and what they carry. Without drawn boundaries, infer them: the public entry point, the internal network, each external system.

**Confirm:**
- What crosses: passwords, session tokens, card data or payment tokens, personal data (email, address), API keys. Check request bodies and logs (`logger: true` may log bodies or headers).
- Internal hops that trust identity from a header (`x-user-id`) without verifying it. Anything that can reach the service directly can impersonate any user.
- Plain HTTP between services, shared secrets in env defaults, credentials committed in Compose files.
- Which personal data goes to third parties, and whether it needs to (a user id instead of an email).

**Severity:** high for credentials or card data unencrypted, logged, or trusted without verification across a boundary (identity headers on a reachable network included); medium for personal data sent to a third party without need, or internal traffic unencrypted; low for missing documentation of the boundary.

**Fixes:** verify identity at each service (signed tokens, mTLS) or lock the network so only the gateway can reach them; TLS on internal hops; minimise data sent out; redact logs; secrets from a secret store.

## Cyclic dependencies

**On the diagram:** a loop of arrows: A → B → A, or a longer cycle, synchronous or through events (A publishes, B consumes and calls A back).

**Confirm:** check that both directions are real calls in code, not a request/response drawn twice. Check package imports for cycles at component level.

**Severity:** high for a synchronous cycle (deadlock and cascading failure risk, neither side can deploy or start alone); medium for an event cycle that can loop; low for a cycle only in compile-time imports.

**Fixes:** invert one direction with an event; extract the shared part into a third service or library; merge the two if they always change together.

## Also worth a line

Raise these when you see them, usually low or medium: no observability (no tracing across hops), a stateful service that can't scale horizontally (in-memory sessions), a missing rate limit at the public edge, a chatty boundary (N calls per request), and a diagram that disagrees with the code.
