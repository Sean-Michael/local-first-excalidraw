# Messaging and event-driven architecture
<!-- keywords: messaging, events, event-driven, event driven, queue, topic, pub/sub, publish subscribe, kafka, rabbitmq, sqs, sns, saga, choreography, orchestration, dead letter queue, async, enterprise integration patterns -->

Asynchronous systems are hard to read from code, because the coupling sits in topic names and configuration rather than in calls. A messaging diagram makes producers, channels and consumers explicit.

**Use it when** you're explaining:

- event-driven services or pub/sub fan-out
- work queues and retries
- dead-letter handling
- sagas and process managers
- CDC pipelines
- "what happens after an `OrderPlaced` event?"

## Vocabulary: Enterprise Integration Patterns

Gregor Hohpe and Bobby Woolf's *Enterprise Integration Patterns* (2003, [enterpriseintegrationpatterns.com](https://www.enterpriseintegrationpatterns.com/patterns/messaging/toc.html)) named the building blocks. It also has its own icon set. You don't need the icons, but use the names, because they're precise:

- **Message channel.** A **point-to-point channel** (a queue) delivers each message to exactly one consumer. A **publish-subscribe channel** (a topic) delivers a copy to every subscriber.
- **Message kinds.**
  - A **command message** asks for something to be done (`ChargeCard`).
  - An **event message** announces that something happened (`OrderPlaced`, past tense).
  - A **document message** carries data.
  - **Request-reply** uses a return address and a **correlation identifier**.
- **Routing.**
  - A **content-based router** picks a destination by content.
  - A **message filter** drops unwanted messages.
  - A **recipient list** sends to a computed set of destinations.
  - A **splitter** and an **aggregator** break a message up and combine messages.
  - **Scatter-gather** sends to many and collects their replies.
  - A **process manager** coordinates multi-step flows (a saga orchestrator).
- **Transformation.**
  - A **message translator** converts formats.
  - A **content enricher** adds missing data.
  - A **claim check** stores a big payload elsewhere and sends a reference.
  - A **canonical data model** gives everyone one shared format.
- **Endpoints.**
  - **Competing consumers** share one queue.
  - A **durable subscriber** gets what it missed while offline.
  - An **idempotent receiver** handles duplicate deliveries safely.
  - A **polling consumer** or **event-driven consumer** describes how a service receives.
- **Reliability and operations.**
  - A **dead letter channel** holds messages that can't be delivered.
  - An **invalid message channel** holds messages that can't be understood.
  - **Guaranteed delivery** persists messages until they arrive.
  - A **wire tap** copies messages for inspection.

## Notation

- **Channels are first-class nodes.** Draw each topic or queue as its own shape, named exactly as in config (`orders.placed.v1`), with its technology (`[Kafka topic]`, `[SQS queue]`).
- **Producers and consumers** are services (C4 containers), and their edges are labelled with the message name. Use solid edges for synchronous calls and dashed edges for asynchronous messages. Say which in the legend.
- **Fan-out** is one topic with several consumer edges. **Competing consumers** is one queue with a consumer labelled `×N`.
- **Failure paths:** retry topics and dead-letter queues are drawn in red with a dashed edge labelled with the condition (`"after 5 attempts"`).
- **Sagas:**
  - With **choreography**, draw a chain of events through topics.
  - With **orchestration**, draw a process-manager node that sends commands and receives replies.
  - Show compensation steps (`RefundPayment`) as red dashed edges.
- **Ordering:** for one end-to-end scenario, number the edges (`"1. OrderPlaced"`), or use a sequence diagram with the broker as a participant (`uml-behaviour.md`).

## Excalidraw recipe

`create_diagram`, `direction: "LR"`, producers on the left → channels in the middle → consumers on the right:

```json create_diagram
{
  "path": "docs/diagrams/order-events",
  "direction": "LR",
  "title": "Event flow: order placed",
  "nodes": [
    { "id": "api", "label": "Shop API\n[Container: Node.js]", "color": "blue" },
    { "id": "placed", "label": "orders.placed.v1\n[Kafka topic]", "shape": "software-architecture/event-bus-or-pipeline" },
    { "id": "billing", "label": "Billing\n[Container: Go]", "color": "blue" },
    { "id": "shipping", "label": "Shipping\n[Container: Go]", "color": "blue" },
    { "id": "email", "label": "Notifier ×3\n[Container: Lambda]", "color": "blue" },
    { "id": "dlq", "label": "orders.placed.dlq\n[Kafka topic]", "color": "red" }
  ],
  "edges": [
    { "from": "api", "to": "placed", "label": "publishes OrderPlaced", "style": "dashed" },
    { "from": "placed", "to": "billing", "label": "OrderPlaced", "style": "dashed" },
    { "from": "placed", "to": "shipping", "label": "OrderPlaced", "style": "dashed" },
    { "from": "placed", "to": "email", "label": "OrderPlaced", "style": "dashed" },
    { "from": "email", "to": "dlq", "label": "after 5 failed attempts", "style": "dotted" }
  ]
}
```

If the library shape isn't available, use `system-design-components/message-queue`, or a rectangle with `color: "teal"`.

Don't put the topics in a "Kafka cluster" group here. The main topic and the DLQ sit in different layers with the consumers between them, and a group's frame is the bounding box of its members, so the consumers would appear inside the cluster. Name the broker in each topic's label instead (`[Kafka topic]`). If you need the cluster boundary, draw it in a separate infrastructure diagram.

For a large estate with many topics, a matrix (producers × topics × consumers) in Markdown can be clearer than a picture. Draw the diagram for one flow at a time.

## Common mistakes

- **Producer drawn straight to consumer,** hiding the broker. Readers then assume a synchronous call and a coupling that isn't there.
- **One "Event bus" box that everything points to,** which says nothing about who consumes what. Name the topics.
- **Commands and events mixed up** (`SendEmail` on a topic everyone subscribes to). Name events in the past tense and commands in the imperative.
- **No failure path.** Retries, DLQs and compensations are often the reason the diagram is needed.
- **Async and sync edges that look the same.**
- **Topic names that don't match the config,** so nobody can grep for them. Link the channel node to where it's declared.
