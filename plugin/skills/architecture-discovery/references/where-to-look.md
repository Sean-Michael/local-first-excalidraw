# Where to look

Signals that reveal each kind of element, roughly in the order the procedure uses them. Search with patterns (`grep`, `rg`) rather than reading every file, then open the hits.

## Deployables

| Source | What it tells you |
|---|---|
| `package.json` `workspaces`, `pnpm-workspace.yaml`, `lerna.json`, `nx.json`, `turbo.json` | The packages. A package with a `start`/`main`/`bin` or its own Dockerfile is a deployable; one that is only imported is a library |
| `go.work`, `Cargo.toml` `[workspace]`, Maven `<modules>`, Gradle `settings.gradle` `include`, `*.sln` | The same for other ecosystems. Look for `main` packages, `[[bin]]`, `Application` classes, `Program.cs` |
| `Dockerfile`, `*.Dockerfile`, `Containerfile` | One image per file. `CMD`/`ENTRYPOINT` names the entrypoint, `EXPOSE` the port |
| `docker-compose*.yml`, `compose*.yaml` | Every service is a container (images such as `postgres`, `redis`, `rabbitmq` are data stores or brokers). `depends_on` and `environment` hint at arrows; `ports` marks the public edge |
| Kubernetes manifests (`Deployment`, `StatefulSet`, `CronJob`, `Job`, `Service`, `Ingress`) | Workloads, their images, exposed services and ingress hosts |
| Helm `Chart.yaml`, `values*.yaml`, `templates/` | The same, with environment differences in the values files. `dependencies:` lists bundled data stores |
| Terraform / OpenTofu / Pulumi / CDK | Managed services: `aws_db_instance`, `aws_lambda_function`, `aws_sqs_queue`, `google_pubsub_topic`, `azurerm_servicebus_*`, buckets, CDNs. These are containers too, even with no code in the repo |
| `serverless.yml`, `template.yaml` (SAM), `vercel.json`, `netlify.toml`, `fly.toml`, `Procfile` | Functions and processes, with their triggers |

## Entrypoints and servers

| Look for | Means |
|---|---|
| `listen(`, `createServer`, `Fastify(`, `express()`, `new Hono`, `app.run`, `uvicorn`, `FastAPI(`, `Flask(`, `http.ListenAndServe`, `@SpringBootApplication`, `WebApplication.CreateBuilder` | An HTTP server. Collect the routes (`app.get/post`, `@app.route`, `@GetMapping`, router files) at component level; at container level the prefix is enough |
| `.proto` with `service`, `grpc.Server`, `@GrpcService` | A gRPC server |
| `consume(`, `subscribe(`, `@KafkaListener`, `@RabbitListener`, `@SqsListener`, `on("message"`, Celery `@task`, BullMQ `new Worker` | A queue or topic consumer: an inbound async arrow |
| `cron`, `schedule`, `CronJob`, `setInterval` at top level, `@Scheduled` | A scheduled job |
| `commander`, `yargs`, `click`, `cobra` | A CLI, usually not a container unless it runs as a service |

## Outbound calls

| Look for | Arrow to |
|---|---|
| `fetch(`, `axios`, `got`, `ky`, `requests.`, `httpx`, `http.Client`, `RestTemplate`, `WebClient`, `HttpClient` | Whatever the base URL resolves to. Follow it to the env var and from there to the Compose or Kubernetes service name |
| `@fastify/http-proxy`, `http-proxy-middleware`, nginx/Envoy/Traefik config | A gateway forwarding to the upstreams it names |
| Vendor SDKs (`stripe`, `@aws-sdk/*`, `@google-cloud/*`, `twilio`, `@sendgrid/*`, `openai`, `@anthropic-ai/sdk`) | That external system (or managed service) |
| `pg`, `mysql2`, `mongodb`, `prisma`, `typeorm`, `sequelize`, `knex`, `drizzle`, `SQLAlchemy`, `gorm`, JDBC URLs | A database. Note which tables each service touches (migrations, repositories), so shared databases show up |
| `ioredis`, `redis`, `memcached` | A cache or session store |
| `amqplib`, `kafkajs`, `@aws-sdk/client-sqs`, `@google-cloud/pubsub`, `nats`, `bullmq`; `publish(`, `send(`, `produce(`, `sendToQueue` | A broker. Record the queue or topic name and the message type; the channel is its own node |
| `S3Client`, `@google-cloud/storage`, `fs` on a mounted volume | Object or file storage |

Shared libraries hide calls: a `packages/queue` wrapper means every importer of it talks to the broker. Trace imports of internal packages back to the deployables that use them.

## Configuration

- `.env.example`, `.env.*`, Compose `environment:`, `env_file:`, ConfigMaps, Secrets, Helm values, `config/*.yaml`, `appsettings*.json`, `application*.yml`.
- `*_URL`, `*_HOST`, `*_ENDPOINT`, `*_DSN` say where something connects. The hostname in the value usually matches a Compose service or Kubernetes Service name.
- `*_API_KEY`, `*_SECRET`, `*_TOKEN` name third parties and mark secrets crossing a boundary.
- Defaults in code (`process.env.X ?? "http://localhost:7001"`) tell you the port and sometimes the intended peer.

## Trust boundaries

- **Public edge:** published `ports`, `Ingress`, load balancers, API gateways, CDN config, `0.0.0.0` listeners with a published port.
- **Authentication:** middleware or hooks that check tokens (`preHandler`, `@UseGuards`, `Depends(get_current_user)`), and which routes skip them.
- **Identity propagation:** headers a gateway adds (`x-user-id`) that downstream services trust without checking.
- **Network:** NetworkPolicies, security groups, VPCs and subnets, private vs public endpoints.
- **Third parties:** every outbound call to a domain you don't run, and what data it sends (card tokens, emails, personal data).
- **Secrets:** where keys are injected and which processes hold them.

## Common traps

- A dependency in `package.json` that nothing imports. Check for an import before drawing an arrow.
- `depends_on` without a client. It's start-up ordering, not proof of a call.
- Two services pointed at the same `DATABASE_URL`. That's one data store shared by both, not two.
- Feature-flagged or dead clients. Check that the code path is reachable, and ask when unsure.
- Generated clients (OpenAPI, gRPC stubs) live far from the code that calls them. Search for the client class, not just the HTTP library.
