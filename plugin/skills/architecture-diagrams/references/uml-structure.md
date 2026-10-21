# UML structure diagrams: class, object, package, component, composite structure, deployment
<!-- keywords: class diagram, uml class, domain model, classes, attributes, operations, methods, inheritance, generalization, realization, interface, abstract class, aggregation, composition, association, multiplicity, object diagram, instance diagram, snapshot, package diagram, namespace, layers, module dependencies, dependency graph, import graph, component diagram, provided interface, required interface, composite structure, ports, parts, connectors, deployment diagram, uml deployment, node, device, execution environment, artifact -->

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

Use `create_diagram` with `direction: "TB"`, one node per class. Give the class name as `label`, its members as `attributes` and `operations` (the compartment rules are added for you), and `stereotype` for interfaces, abstract classes and enumerations. Give every edge a `relation`, so it gets the UML arrowhead and line style:

- `inheritance` from the child to the parent (hollow triangle at the parent; the parent is laid out above its children)
- `realization` from the class to the interface it implements (dashed, hollow triangle)
- `composition` from the whole to the part (filled diamond at the whole): the part can't exist without it
- `aggregation` from the whole to the part (hollow diamond): the part can exist on its own
- `association` (plain line) or `directed-association` (open arrow) for "knows about"
- `dependency` (dashed, open arrow) for "uses for a moment" (a parameter, a local variable)

Put multiplicities at the ends they belong to: `startLabel` beside the `from` end and `endLabel` beside the `to` end (`"1"`, `"0..*"`, or a role and multiplicity such as `"items 1..*"`). Keep `label` for the association's name, if any. Each end label is grouped with the class at that end, so it moves with the box.

```json create_diagram
{
  "path": "docs/diagrams/order-classes",
  "direction": "TB",
  "title": "Class diagram: orders",
  "nodes": [
    { "id": "gateway", "label": "PaymentGateway", "stereotype": "interface", "operations": ["+charge(amount: Money): Receipt"], "color": "violet" },
    { "id": "order", "label": "Order", "attributes": ["-id: UUID", "-status: OrderStatus"], "operations": ["+place(): void", "+cancel(): void"], "color": "blue" },
    { "id": "stripe", "label": "StripeGateway", "operations": ["+charge(amount: Money): Receipt"], "color": "blue" },
    { "id": "lineitem", "label": "LineItem", "attributes": ["-sku: string", "-quantity: int"], "color": "blue" },
    { "id": "status", "label": "OrderStatus", "stereotype": "enumeration", "attributes": ["PENDING", "PAID", "CANCELLED"], "color": "gray" }
  ],
  "edges": [
    { "from": "order", "to": "lineitem", "relation": "composition", "startLabel": "1", "endLabel": "1..*" },
    { "from": "order", "to": "status", "relation": "association" },
    { "from": "order", "to": "gateway", "relation": "dependency", "label": "uses" },
    { "from": "stripe", "to": "gateway", "relation": "realization" }
  ]
}
```

To change an arrow afterwards, `create_diagram` names each arrow `from->to`, adding `#n` for the n-th edge after the first. Excalidraw's arrowheads are `triangle_outline` (inheritance and realisation), `diamond` (composition), `diamond_outline` (aggregation) and `arrow` (association and dependency):

```json update_elements
{
  "path": "docs/diagrams/order-classes",
  "updates": [{ "id": "order->lineitem", "startArrowhead": "diamond_outline" }]
}
```

Mermaid `classDiagram` is the standard text form, but in this build `mermaid_to_drawing` brings it in as one uneditable image (the result says "Converted Mermaid into 1 elements"). Use it only when the user wants Mermaid's own rendering.

Use the exact class and member names from the code. Link each class box to its file with `code` on the node (`"code": "src/orders/order.ts:12"`), or afterwards with `update_elements`.

### Common mistakes

- **Plain arrows for every relationship.** In a class diagram the arrowhead is the meaning: give every edge a `relation`.
- **Every field and getter shown.** Show what explains the design.
- **Aggregation and composition used interchangeably.** If you're unsure, use plain association.
- **Generated diagrams of a whole package.** These are unreadable. Pick the classes for one question.
- **Arrows pointing the wrong way.** Inheritance points at the parent. Dependency points at what is used.

## Object diagram

**Use it when** a class diagram is too abstract to follow: to show a concrete example of the objects that exist at one moment (a test fixture, a tricky configuration, a bug's state), or to check a class diagram against a real case.

### Notation

- An object box is named `instanceName : ClassName`, underlined in strict UML. An anonymous object is `: ClassName`.
- Below the name, the attribute values that matter: `name = "Alice"`, `status = PAID`.
- Links are plain lines between objects: instances of the class diagram's associations. There are no multiplicities, because every link is one actual link.

### Excalidraw recipe

Use `create_diagram`, one node per object. Put `instance : Class` as the label and the values as `attributes`. Use `relation: "association"` for the links, labelled with the role if it helps:

```json create_diagram
{
  "path": "docs/diagrams/alice-orders",
  "direction": "LR",
  "title": "Object diagram: Alice's orders",
  "nodes": [
    { "id": "alice", "label": "alice : Customer", "attributes": ["name = \"Alice\"", "tier = GOLD"], "color": "blue" },
    { "id": "o1", "label": "o1 : Order", "attributes": ["status = PAID"], "color": "blue" },
    { "id": "o2", "label": "o2 : Order", "attributes": ["status = PENDING"], "color": "blue" },
    { "id": "line", "label": ": OrderItem", "attributes": ["quantity = 1"], "color": "blue" },
    { "id": "book", "label": "dune : Product", "attributes": ["title = \"Dune\""], "color": "blue" }
  ],
  "edges": [
    { "from": "alice", "to": "o1", "relation": "association" },
    { "from": "alice", "to": "o2", "relation": "association" },
    { "from": "o1", "to": "line", "relation": "association" },
    { "from": "line", "to": "book", "relation": "association" }
  ]
}
```

### Common mistakes

- **Class names with no instance names,** which make it a class diagram.
- **Multiplicities on links.**
- **A whole system's objects.** Show the handful that explain the case.

## Package diagram

**Use it when** you're showing how code is organised into packages, namespaces, modules or layers, and which depend on which: to check the layering, find cycles, or see what a change would affect.

### Notation

- A package is a folder: a rectangle with a small tab on its top-left, the name on the tab or in the body.
- A package can contain classes and other packages.
- A dashed arrow with an open head is a dependency, pointing from the package that uses to the package used. `«import»` (public import), `«access»` (private import) and `«merge»` are stereotyped dependencies.

### Excalidraw recipe

Use `create_diagram` with `direction: "TB"`, so dependencies point down. For packages with their contents shown, make each package a group (its frame is the folder) with a few member nodes. For packages shown as one box, use a node with `stereotype: "package"`. Make every dependency `relation: "dependency"`, with `label: "«import»"` if that distinction matters.

```json create_diagram
{
  "path": "docs/diagrams/layers",
  "direction": "TB",
  "title": "Package diagram: layered web app",
  "nodes": [
    { "id": "web", "label": "web", "stereotype": "package", "color": "blue" },
    { "id": "domain", "label": "domain", "stereotype": "package", "color": "violet" },
    { "id": "persistence", "label": "persistence", "stereotype": "package", "color": "green" }
  ],
  "edges": [
    { "from": "web", "to": "domain", "relation": "dependency", "label": "«import»" },
    { "from": "persistence", "to": "domain", "relation": "dependency", "label": "«import»" }
  ]
}
```

The second edge shows dependency inversion: `persistence` implements interfaces that `domain` owns. Draw what the code really imports.

## Component diagram (UML) and module / dependency graphs

**Use it when** you're showing how a system or container breaks down into replaceable parts with provided and required interfaces, or how modules and packages depend on each other (layering, cycles, what a change would affect).

### Notation

- A component is a rectangle with a `<<component>>` stereotype or the component icon.
- A lollipop is a provided interface. A socket is a required interface.
- Dependencies are dashed arrows from the user to the thing used (`relation: "dependency"`).
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

## Composite structure diagram

**Use it when** you need to show the inside of one class or component at run time: the parts it's built from, the ports through which it talks to the outside, and the connectors that wire the parts together. It's rare outside embedded and systems engineering. A C4 component diagram usually serves a software audience better.

### Notation

- The outer box is the classifier. Inside it, parts are boxes named `role : Type`.
- Ports are small squares on the border. Connectors are lines between parts or from a part to a port.
- Interfaces on ports use the lollipop (provided) and socket (required) symbols.

### Excalidraw recipe

Put the parts in one `create_diagram` group: its frame is the classifier. Give the group the classifier's name. Add each port with `add_elements` as a small square (20×20) straddling the frame's edge, with a text label, and bind arrows to it with `connect_elements`.

## Deployment diagram (UML)

**Use it when** you're showing which artifacts run on which nodes (devices and execution environments) and how the nodes are connected. C4 deployment diagrams (`c4.md`) are the same idea with container instances.

### Notation

- Nodes are 3D boxes, `<<device>>` (hardware) or `<<executionEnvironment>>` (OS, container runtime, JVM), and they nest.
- Artifacts are documents or binaries `<<artifact>>` deployed on a node.
- Communication paths are lines between nodes, labelled with the protocol.

### Excalidraw recipe

Excalidraw frames don't nest. Use one `create_diagram` group per innermost node, named with its full path and stereotype, such as `"web-01 › Docker «executionEnvironment»"`. For a node that holds a single artifact, a node with `stereotype: "device"` (or `"executionEnvironment"`) is simpler than a group. Then draw the outer nodes as dashed rectangles with `add_elements`, as in the C4 deployment recipe in `c4.md`. The artifacts are the nodes, with `stereotype: "artifact"` and the artifact name and version as the label (`"shop-api.jar v2.3"`). Label the communication paths with protocol and port: `"HTTPS :443"`, `"PostgreSQL :5432"`.

### Common mistakes

- **Logical components drawn as deployment nodes.**
- **No environment named.** Is this prod or staging?
- **Nesting shown only by position,** with no boundary or label.
- **Missing infrastructure that matters to the question:** a load balancer, a NAT gateway, a firewall.
