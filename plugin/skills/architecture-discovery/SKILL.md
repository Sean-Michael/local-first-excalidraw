---
name: architecture-discovery
description: Build an accurate model of a system's architecture from its code and configuration before drawing it (deployables, entrypoints, outbound calls, data stores, queues, external dependencies and trust boundaries, each with its source file), scoped to one C4 level. Use before drawing an architecture, C4, container, context, deployment or data-flow diagram of a codebase, when asked to "map", "reverse-engineer", "work out" or "inventory" how a system fits together, or when an existing diagram needs checking against the code.
---

# Architecture discovery

A diagram is only as true as the model behind it. This skill builds that model from the code, before anything is drawn: a table of elements and relationships, each traced to a file. The architecture-diagrams skill then turns the model into a drawing.

Guessing from folder names produces plausible fiction. Every element and arrow in the model must point at the line of code or config that proves it. Anything you can't prove goes on an open-questions list, not on the diagram.

Reference files in `references/` go deeper:

| File | Read it for |
|---|---|
| `where-to-look.md` | Files and code patterns that reveal deployables, servers, clients, queues and data stores, per ecosystem |
| `model-format.md` | The model table, an example from a real repo, and how it maps onto `create_diagram` |

## Procedure

1. **Scope.** Settle the question and the C4 level first (see *Scoping* below). The level decides how deep each step goes. If the user hasn't said, default to a container diagram of the whole repo and say so.
2. **Overview.** Call `project_overview` for the tree, manifests, Compose services and entry points. Read the README and any `docs/` architecture notes, but treat them as claims to check, not facts.
3. **Deployables.** Find everything that runs as its own process or is provisioned on its own: workspace packages with a start script or a Dockerfile, Compose services, Kubernetes Deployments/StatefulSets/CronJobs, Helm charts, Terraform resources (functions, databases, buckets, queues), serverless configs. Each becomes a candidate container. Libraries that are only imported (shared `packages/*` with no entrypoint) are not containers: note them as components of whoever imports them.
4. **Entrypoints.** For each deployable, find what starts it (`main`, `bin`, `CMD`, `start` script) and what it listens on: HTTP routes, gRPC services, queue consumers, cron schedules, CLI commands. That is its inbound interface.
5. **Outbound calls.** For each deployable, find what it calls: HTTP clients (`fetch`, axios, `requests`, `http.Client`) and their base URLs, cloud and vendor SDKs, database pools and ORMs, cache clients, queue publishers and consumers, proxies. Each is an arrow. Record the direction (who initiates), sync or async, the protocol, and the data it carries.
6. **Configuration.** Read env files, Compose `environment:`, Kubernetes ConfigMaps/Secrets, Helm values and Terraform outputs. Env vars such as `*_URL`, `*_HOST`, `*_API_KEY` and `DATABASE_URL` name the dependencies, and a hostname like `postgres://…@orders-db` tells you which container an arrow ends at. A key with no matching client in code is a question, not an arrow.
7. **Trust boundaries.** Mark where trust changes: the public edge (published ports, ingress, load balancers), authentication middleware, network policies and security groups, calls to third parties, and where secrets and personal data travel. These become boundary frames and are what the architecture-review skill checks.
8. **Record** each element and relationship in the model table (`model-format.md`): name, type, technology, responsibility, source file, and for relationships, direction, sync/async, protocol and data.
9. **Resolve ambiguity by asking.** When code and config disagree, a dependency is configured but never called, a hostname doesn't match any service, or the same thing has several names, list it under *Open questions* and ask the user before drawing. Don't pick silently. One short batch of questions beats a confidently wrong diagram.
10. **Hand off** (below).

Use the names from the code and config (service names, Compose keys, package names), not friendlier inventions. Where two names exist (a Compose key `shopapp-pg` for a Postgres image), keep the code name and put the technology in brackets.

## Scoping

Pick one C4 level and investigate only to that depth:

| Level | Elements you collect | Stop at |
|---|---|---|
| Context | The system as one box, the people who use it, external systems it calls or that call it | Deployables are invisible; only third parties and users matter |
| Container | Each deployable and data store, external systems, people | Inside a container, only its entrypoints and outbound clients |
| Component | Modules, classes or packages inside **one** container, and the containers and externals they touch | Other containers' internals |
| Deployment | Nodes (hosts, clusters, managed services), what runs on each, networks and environments | One environment per diagram |

For a component diagram, ask which container if it isn't obvious. For a large repo (more than ~12 deployables), offer a context diagram plus one container diagram per subsystem rather than one crowded picture.

## Handing off

When the model is complete and the open questions are answered:

1. Show the user the model table briefly (or the element count and any assumptions) so they can correct it before you draw.
2. Follow the architecture-diagrams skill: its decision procedure's *Investigate* step is done, so go straight to its recipe for your diagram type. Map each element to a node (`id` from the name, three-line label `"name\n[Type: technology]\nresponsibility"`, `code` set to its source file) and each relationship to an edge labelled with its verb and protocol. `model-format.md` shows the mapping.
3. Keep the model. Put it in the related doc or ADR, or summarise it in your reply, so the next update or an architecture review starts from it instead of re-reading the code.

## Checklist

- [ ] Scope and C4 level are written down.
- [ ] Every deployable from manifests, Dockerfiles, Compose, Kubernetes, Helm and Terraform is accounted for (as an element, or excluded with a reason).
- [ ] Every element has a name from the code, a type, a technology and a source file.
- [ ] Every relationship has a direction, sync/async, protocol and the file that makes the call.
- [ ] Every external dependency in config has a matching client in code (or an open question).
- [ ] Trust boundaries are identified.
- [ ] Open questions were asked, not guessed.
