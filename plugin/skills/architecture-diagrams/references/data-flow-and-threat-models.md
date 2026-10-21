# Data flow diagrams and threat models
<!-- keywords: dfd, data flow diagram, data flow, threat model, threat modeling, stride, trust boundary, security, privacy, sensitive data, pii, attack surface -->

A data flow diagram (DFD) shows how data moves through a system: where it comes from, what transforms it, where it's stored and where it goes. With trust boundaries added, it's the standard starting point for threat modelling: Microsoft's SDL threat modelling and STRIDE, and the [OWASP threat modelling process](https://owasp.org/www-community/Threat_Modeling_Process).

**Use it when:**

- a security review, privacy assessment or compliance question (where does PII go?) needs answering
- you're designing an integration that crosses networks or organisations
- you're explaining a data pipeline

**Don't use it** for call order (use a sequence diagram) or for deployment topology (use an infrastructure diagram).

## Notation

The DFD elements, in the shapes most threat-modelling tools use:

| Element | Meaning | Classic shape | Excalidraw |
|---|---|---|---|
| External entity (interactor) | A person or system outside your control that sends or receives data | Rectangle | Rectangle, `color: "gray"`, dashed outline |
| Process | Code that transforms or routes data | Circle | Ellipse, `color: "blue"` |
| Data store | Data at rest: a database, file, cache or queue | Two parallel lines (open rectangle) | `software-architecture/database` shape, or a green rectangle |
| Data flow | Data in motion, in one direction | Arrow | Arrow labelled with *what data* and, if relevant, protocol |
| Trust boundary | Where the level of trust changes (internet vs. VPC, user vs. kernel, tenant vs. tenant, your org vs. a vendor) | Dashed line or box | Dashed red rectangle with a label |

DFDs come in levels:

- **Level 0** (context): the whole system as one process.
- **Level 1:** its main processes.
- **Level 2:** one process opened up.

Stay on one level per diagram, as with C4.

## Threat analysis with STRIDE

Each flow that crosses a trust boundary is a candidate for threats. STRIDE gives you the categories, and each one is the opposite of a security property:

| Threat | Violates | Typical targets |
|---|---|---|
| Spoofing | Authentication | External entities, processes |
| Tampering | Integrity | Data flows, data stores, processes |
| Repudiation | Non-repudiation | External entities, processes |
| Information disclosure | Confidentiality | Data flows, data stores, processes |
| Denial of service | Availability | Data flows, data stores, processes |
| Elevation of privilege | Authorisation | Processes |

The "typical targets" column follows Microsoft's STRIDE-per-element approach. Later versions of the Microsoft tool analyse each interaction that crosses a boundary instead. Either way, number the boundary-crossing flows so a threat table can refer to them ("F3: tampering, because webhook signatures aren't verified").

## Excalidraw recipe

1. Draw the elements and flows with `create_diagram`, `direction: "LR"`, from the untrusted side on the left to the most trusted on the right. Put a number on each flow that will cross a boundary.

```json create_diagram
{
  "path": "docs/diagrams/dfd-checkout",
  "direction": "LR",
  "title": "Data flow (level 1): checkout",
  "nodes": [
    { "id": "browser", "label": "Customer browser\n[External entity]", "color": "gray" },
    { "id": "api", "label": "Shop API\n[Process]", "shape": "ellipse", "color": "blue" },
    { "id": "stripe", "label": "Stripe\n[External entity]", "color": "gray" },
    { "id": "db", "label": "Orders DB\n[Data store]", "color": "green" },
    { "id": "logs", "label": "Log store\n[Data store]", "color": "green" },
    { "id": "webhook", "label": "Webhook handler\n[Process]", "shape": "ellipse", "color": "blue" },
    { "id": "ledger", "label": "Payments ledger\n[Data store]", "color": "green" }
  ],
  "edges": [
    { "from": "browser", "to": "api", "label": "F1 cart + card token [HTTPS]" },
    { "from": "api", "to": "stripe", "label": "F2 payment intent [HTTPS]" },
    { "from": "api", "to": "db", "label": "F3 order, email, address" },
    { "from": "api", "to": "logs", "label": "F4 request logs (no PII)" },
    { "from": "stripe", "to": "webhook", "label": "F5 payment event [HTTPS]" },
    { "from": "webhook", "to": "ledger", "label": "F6 payment status" }
  ]
}
```

2. Mark the external entities with a dashed outline as well, so "outside our control" isn't shown by colour alone. Use `update_elements` with `"strokeStyle": "dashed"`.
3. Run `read_drawing` to get positions, then add each trust boundary as a labelled dashed rectangle around the trusted elements. A rectangle with no fill doesn't hide anything under it. Work out the rectangle from the enclosed elements: x and y are their smallest x and y minus 40, and the width and height reach their largest right and bottom edges plus 40. The numbers below are placeholders. If an element that belongs outside the boundary sits inside that box, move it first with `update_elements`.

```json add_elements
{
  "path": "docs/diagrams/dfd-checkout",
  "elements": [
    { "type": "rectangle", "id": "tb-vpc", "x": 380, "y": 40, "width": 720, "height": 420, "strokeStyle": "dashed", "strokeColor": "#e03131", "strokeWidth": 2, "backgroundColor": "transparent" },
    { "type": "text", "x": 396, "y": 52, "text": "Trust boundary: production VPC", "fontSize": 16, "strokeColor": "#e03131" }
  ]
}
```

4. Optionally, add a threat table as a text note beside the diagram (`add_elements` with `placement: "right"`). Give one line per finding, in the form `F3 · Tampering · verify Stripe-Signature header · open`. A threat model also works well as a Markdown file next to the drawing, with the drawing embedded via `export_drawing`.

Use a frame (a `create_diagram` group) for a boundary only when it contains *every* element on its side and nothing else. A frame clips and owns its children, so boundaries that overlap or nest must be rectangles.

## Common mistakes

- **Flows labelled with verbs** ("calls"). Label them with the data (`"session token"`), because threats attach to data.
- **Missing the return flow** when the response carries sensitive data. Draw it as its own arrow.
- **Data stores shown as processes,** or a process writing to another process's store directly with nothing to show it.
- **No trust boundaries,** or boundaries that don't match a real change in privilege. Network zones, process or user isolation, tenant isolation and third parties are the usual ones.
- **Out of date.** A threat model is only valid for the design it drew. Keep it next to the code (`living-diagrams.md`) and revisit it when a flow crosses a new boundary.
- **Mixing DFD levels,** like a single function next to "Payment provider".
- **Flows that skip a layer of the layout.** `create_diagram` draws them straight through whatever sits in between. In the example, the webhook writes to its own ledger rather than back into the Orders DB (two layers away). When the real system shares a store, move the crossed node aside after rendering.
