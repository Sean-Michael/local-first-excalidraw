# UML structure diagrams: class, component, deployment

Structure diagrams show what exists and how the parts depend on each other, independent of time. In Kruchten's 4+1 view model, class diagrams belong to the logical view, components and packages to the development view, and deployment to the physical view. For system-level structure, C4 container and component diagrams (`c4.md`) are usually easier for readers than strict UML. Reach for UML when the audience expects it, or when you need its precision (multiplicities, interfaces, inheritance).

## Class diagram

**Use it when** you're explaining a domain model, a design pattern, or the type relationships in one module. It suits code-level documentation for developers (C4 level 4).

**Don't use it** for a whole codebase. Keep it to one bounded context or package, at about 10 classes.

### Notation

- A class box has three compartments: name, attributes, and operations. Show only the members that matter to the question.
- Visibility: `+` public, `-` private, `#` protected, `~` package.
- Relationships:

  | Relationship | Line | Meaning |
  |---|---|---|
  | Association | Solid line, optional arrow | A uses or knows B |
  | Aggregation | Hollow diamond at the whole | Has, and parts can outlive the whole |
  | Composition | Filled diamond at the whole | Owns, and parts die with the whole |
  | Inheritance | Hollow triangle at the parent | Is a |
  | Realisation | Dashed line with a hollow triangle | Implements an interface |
  | Dependency | Dashed open arrow | Uses temporarily |

- Multiplicities go at the line ends: `1`, `0..1`, `*`, `1..*`.
- Stereotypes: `<<interface>>`, `<<abstract>>`, `<<enumeration>>`.

### Excalidraw recipe

Use `create_diagram`, one node per class. Separate the compartments with a rule line in the label. Keep the rule shorter than the longest text line. Boxes are sized from the measured text, and an over-long rule wraps onto a second line that overflows the box.

```json create_diagram
{
  "path": "docs/diagrams/order-classes",
  "direction": "TB",
  "title": "Class diagram: orders",
  "nodes": [
    { "id": "order", "label": "Order\n─────\n+id: string\n+status: OrderStatus\n─────\n+place()\n+cancel()", "color": "blue" },
    { "id": "stripe", "label": "StripeGateway", "color": "blue" },
    { "id": "lineitem", "label": "LineItem\n─────\n+sku: string\n+quantity: number", "color": "blue" },
    { "id": "gateway", "label": "«interface»\nPaymentGateway\n─────\n+charge(amount)", "color": "violet" }
  ],
  "edges": [
    { "from": "order", "to": "lineitem", "label": "contains 1 → 1..*" },
    { "from": "order", "to": "gateway", "label": "uses", "style": "dashed" },
    { "from": "stripe", "to": "gateway", "label": "implements", "style": "dashed" }
  ]
}
```

Then give the relationships their UML arrowheads. Excalidraw has `triangle_outline` (inheritance and realisation), `diamond` (composition), `diamond_outline` (aggregation) and `arrow` (association and dependency). `create_diagram` names each arrow `from->to`, adding `#n` for the n-th edge after the first:

```json update_elements
{
  "path": "docs/diagrams/order-classes",
  "updates": [
    { "id": "order->lineitem", "startArrowhead": "diamond", "endArrowhead": null },
    { "id": "stripe->gateway#2", "endArrowhead": "triangle_outline" }
  ]
}
```

Mermaid `classDiagram` is the standard text form, but in this build `mermaid_to_drawing` brings it in as one uneditable image (the result says "Converted Mermaid into 1 elements"). Use it only when the user wants Mermaid's own rendering.

Use the exact class and member names from the code. Link each class box to its file with `code` on the node (`"code": "src/orders/order.ts:12"`), or afterwards with `update_elements`.

### Common mistakes

- **Every field and getter shown.** Show what explains the design.
- **Aggregation and composition used interchangeably.** If you're unsure, use plain association.
- **Generated diagrams of a whole package.** These are unreadable. Pick the classes for one question.
- **Arrows pointing the wrong way.** Inheritance points at the parent. Dependency points at what is used.

## Component diagram (UML) and package / dependency graphs

**Use it when** you're showing how a system or container breaks down into replaceable parts with provided and required interfaces, or how modules and packages depend on each other (layering, cycles, what a change would affect).

### Notation

- A component is a rectangle with a `<<component>>` stereotype or the component icon.
- A lollipop is a provided interface. A socket is a required interface.
- Dependencies are dashed arrows from the user to the thing used.
- Packages are folders (tabbed rectangles) that group components.

### Excalidraw recipe

Use `create_diagram` with `direction: "TB"`, so dependencies point down: callers on top, foundations at the bottom. Put the interface name on the edge label rather than drawing lollipops. When every arrow means the same thing ("imports"), say so once in the title instead of labelling every edge.

Groups work well for architectural layers, as long as each group lines up with its layout layers. A group's frame is the bounding box of its members, so if a group shares a layer with another group's member, the frames overlap. Leave the top layer ungrouped, so the first frame's name doesn't collide with the title.

```json create_diagram
{
  "path": "docs/diagrams/server-modules",
  "direction": "TB",
  "title": "Module imports: src/server (arrow = imports, trimmed)",
  "nodes": [
    { "id": "cli", "label": "cli.ts", "color": "gray" },
    { "id": "daemon", "label": "daemon.ts", "color": "blue", "group": "procs" },
    { "id": "mcp", "label": "mcp.ts", "color": "violet", "group": "procs" },
    { "id": "store", "label": "store.ts", "color": "teal", "group": "libs" },
    { "id": "layout", "label": "layout.ts", "color": "teal", "group": "libs" },
    { "id": "tools", "label": "tools.ts", "color": "teal", "group": "libs" },
    { "id": "client", "label": "client.ts", "color": "teal", "group": "libs" },
    { "id": "scene", "label": "scene.ts", "color": "green", "group": "libs" }
  ],
  "groups": [
    { "id": "procs", "label": "Processes" },
    { "id": "libs", "label": "Libraries" }
  ],
  "edges": [
    { "from": "cli", "to": "daemon" },
    { "from": "cli", "to": "mcp" },
    { "from": "daemon", "to": "store" },
    { "from": "daemon", "to": "layout" },
    { "from": "mcp", "to": "tools" },
    { "from": "mcp", "to": "client" },
    { "from": "store", "to": "scene" },
    { "from": "layout", "to": "scene" },
    { "from": "tools", "to": "scene" }
  ]
}
```

Build the edge list from real imports, for example by grepping `from "./x.js"` and `import("./x.js")`. Never guess dependencies. This example leaves out `daemon.ts → scene.ts`: that edge skips a layer, so it would be drawn straight through `store.ts` or `layout.ts`. Say in the title when you trim edges like this. Make cycles visible: colour both nodes red and label the back edge `"cycle"`.

### Common mistakes

- **Dependencies drawn in both directions,** or upward against the layering, without being called out.
- **Unrelated modules in one picture.** Scope it to one package or layer boundary.
- **Arrows meaning "calls" in some places and "imports" in others.** Pick one meaning and say which in the title or legend.

## Deployment diagram (UML)

**Use it when** you're showing which artifacts run on which nodes (devices and execution environments) and how the nodes are connected. C4 deployment diagrams (`c4.md`) are the same idea with container instances.

### Notation

- Nodes are 3D boxes, `<<device>>` (hardware) or `<<executionEnvironment>>` (OS, container runtime, JVM), and they nest.
- Artifacts are documents or binaries `<<artifact>>` deployed on a node.
- Communication paths are lines between nodes, labelled with the protocol.

### Excalidraw recipe

Excalidraw frames don't nest. Use one `create_diagram` group per innermost node, named with its full path and stereotype, such as `"web-01 › Docker [executionEnvironment]"`. Then draw the outer nodes as dashed rectangles with `add_elements`, as in the C4 deployment recipe in `c4.md`. The artifacts are the nodes, labelled with the artifact name and version (`"shop-api.jar\n[artifact] v2.3"`). Label the communication paths with protocol and port: `"HTTPS :443"`, `"PostgreSQL :5432"`.

### Common mistakes

- **Logical components drawn as deployment nodes.**
- **No environment named.** Is this prod or staging?
- **Nesting shown only by position,** with no boundary or label.
- **Missing infrastructure that matters to the question:** a load balancer, a NAT gateway, a firewall.
