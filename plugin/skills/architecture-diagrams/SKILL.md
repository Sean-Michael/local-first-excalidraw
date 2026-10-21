---
name: architecture-diagrams
description: Choose and draw the right software architecture or design diagram with the local-first excalidraw MCP tools, in its real notation. Covers C4 (system context, container, component, deployment, dynamic), all 14 UML diagrams (structural - class, object, package, component, composite structure, deployment; behavioural - use case, activity, state machine, sequence, communication, interaction overview, timing), ER data models, data flow and threat models with trust boundaries, infrastructure and network topology, and messaging and event flows. Use when the user asks for any of these by name ("a UML class diagram", "use case diagram for an ATM", "ERD"), for "a UML diagram" of something, an architecture diagram or system design, or to "document how X works" or "show how X fits together".
---

# Architecture diagrams

A diagram answers one question for one audience. Decide both before you draw. This skill picks the diagram type and maps it onto the drawing tools; the excalidraw skill covers the tools themselves, and the diagram-review skill covers readability. The architecture-discovery skill builds the model of a codebase that a diagram is drawn from, and the architecture-review skill critiques the system a finished diagram shows.

Reference files in `references/` go deeper. Read the one for your diagram type before drawing:

| File | Read it for |
|---|---|
| `choosing-a-diagram.md` | The full question-to-diagram table, including flowcharts, mind maps, timelines and Wardley maps |
| `uml-overview.md` | The 14 UML diagram types, which question each answers, what to draw for a vague "UML diagram", and how UML symbols map onto the drawing tools |
| `c4.md` | System context, container, component, landscape, dynamic and deployment diagrams |
| `uml-structure.md` | Class, object, package, component, composite structure and UML deployment diagrams |
| `uml-behaviour.md` | Use case, activity, state machine, sequence, communication, interaction overview and timing diagrams |
| `data-flow-and-threat-models.md` | DFDs, trust boundaries, STRIDE |
| `data-models.md` | Entity-relationship diagrams |
| `infrastructure.md` | Cloud, network and cluster topology |
| `messaging-and-events.md` | Queues, topics, sagas, Enterprise Integration Patterns |
| `visual-principles.md` | Gestalt, legends, colour accessibility, reading direction |
| `living-diagrams.md` | Linking nodes to code, ADRs, updating a diagram after a code change |

## Decision procedure

1. **Audience.** Who will read it? Non-technical people need people and systems, not technology. Developers need containers, protocols and names that match the code. Operators need nodes, networks and environments. Security reviewers need data flows and trust boundaries.
2. **Question.** Write the question the diagram answers as one sentence, such as "What does checkout depend on?", "What happens when a payment fails?" or "Where does customer data cross the network?". If you can't, ask the user. If you have two questions, draw two diagrams.
3. **Type.** Pick from the question:

   | Question | Diagram | Tool |
   |---|---|---|
   | What is the system and who or what uses it? | C4 system context | `create_diagram` |
   | Which apps and data stores make up the system, and how do they talk? | C4 container | `create_diagram` with a group as the system boundary |
   | What's inside one service or app? | C4 component (or package dependency graph) | `create_diagram` |
   | In what order do things happen for one scenario? | Sequence (or C4 dynamic) | `mermaid_to_drawing` `sequenceDiagram` |
   | What states can X be in, and what moves it between them? | State machine | `create_diagram` LR |
   | What are the steps and decisions in a process? | Activity / flowchart | `create_diagram` TB with diamonds, or Mermaid `flowchart` |
   | What runs where, in which environment? | C4 / UML deployment | `create_diagram` groups per node, plus outer boundary rectangles |
   | What does the network look like? | Infrastructure topology | `create_diagram` with network and system-design library shapes |
   | Where does sensitive data flow and cross trust levels? | DFD with trust boundaries | `create_diagram` plus dashed boundary rectangles |
   | What are the entities and how do they relate? | ER diagram | `create_diagram` with crow's-foot `relation`s (`one-to-many`, …) |
   | What are the types and their relationships in this code or domain? | UML class | `create_diagram` with `attributes`/`operations` and edge `relation`s |
   | What does one concrete case look like (these objects, these values)? | UML object | `create_diagram`, `relation: "association"` |
   | How is the code organised into packages or layers? | UML package (or dependency graph) | `create_diagram` TB, `relation: "dependency"` |
   | Who uses the system, for what goals? | UML use case | `create_diagram` LR, a group as the system boundary, `include`/`extend` relations |
   | Who talks to whom, in what numbered order? | UML communication | `create_diagram`, numbered `message` edges |
   | Who publishes and who consumes which events? | Messaging / event flow | `create_diagram` with channels as nodes |
   | What depends on what? | Dependency graph | `create_diagram` TB |

   When the user names a family but not a type ("a UML diagram of an online store"), choose the best fit and say which: a class diagram for a domain, activity for a process, sequence for one scenario, use case for who does what. `uml-overview.md` has the full table.

4. **Level.** For structure, pick one C4 level and stay on it: context (systems and people), container (deployable apps and data stores), component (modules inside one container), or code (classes, rarely worth drawing by hand). Most teams need only context and container diagrams.
5. **Investigate.** Read the code, config, infrastructure files and existing docs so every box and arrow is real. Use the names from the code. Note the file each node comes from (see `living-diagrams.md`). For a diagram of a codebase, follow the architecture-discovery skill: it finds the deployables, entrypoints, outbound calls and trust boundaries and hands back a model table to draw from.
6. **Draw, then review.** Draw with the recipe below, then `render_drawing` and follow the diagram-review skill. If the user wants the design itself critiqued (risks, failure modes, coupling), use the architecture-review skill on the finished drawing.

## Recipes

**C4 context or container.** Use `create_diagram`, `direction: "LR"` (or `"TB"` when people sit on top). Put the system's containers in one group, labelled `"<System> [Software System]"`, which becomes the boundary frame. Use ellipses for people (`stick-figures/stick-man` only with a one-line label). Write each label as three lines: `"Name\n[Container: Technology]\nWhat it does"`. Write each edge label as a verb phrase plus protocol, such as `"Reads orders from [SQL/TCP]"`. Use `software-architecture/database` for a data store when it makes it clearer. Use one colour per element kind, with external systems in gray or orange and a dashed outline. See `c4.md` for a complete call.

**Sequence or dynamic.** Use `mermaid_to_drawing` with `sequenceDiagram`. Declare `actor` and `participant` lines in reading order. Use solid arrows (`->>`) for calls and dashed arrows (`-->>`) for replies. Use `alt`/`opt`/`loop` for branches, and a `Note` for anything that needs explaining. Keep it to one scenario and about 12 messages. For a C4 dynamic diagram in collaboration style, use `create_diagram` with numbered edge labels (`"1. Submits order"`).

**State machine.** Use `create_diagram` LR, with one node per enum value, `shape: "initial"` (●) for the initial pseudostate, and `shape: "final"` (◉) or a tagged, coloured state for final states. Label each transition `event [guard] / action`.

**Activity or flowchart.** Use `create_diagram` `direction: "TB"`, with `shape: "initial"` (●) for the start, `shape: "final"` (◉) for each end, rounded rectangles for actions, diamonds for decisions and `shape: "bar"` for fork/join. Label the decision edges with guards: `[valid]`/`[invalid]`. Give each branch its own end node. Use groups for swimlanes only when each lane is a run of consecutive steps (see the layout rules below). For lanes that interleave, use Mermaid `flowchart` with `subgraph` lanes.

**Deployment.** Excalidraw frames don't nest. Give each innermost deployment node (a pod, a VM, a database server) a `create_diagram` group, and name it with its path, such as `"eks-prod › api pod [Kubernetes]"`. Draw the outer nodes (region, VPC, cluster) as dashed rectangles with `add_elements`, sized from `read_drawing` bounds, and put a text label in each top-left corner. Draw one diagram per environment. See `c4.md` and `infrastructure.md`.

**Data flow / threat model.** Use `create_diagram` `direction: "LR"`, with external entities as rectangles (`color: "gray"`), processes as ellipses (`color: "blue"`) and data stores as `software-architecture/database` or green rectangles. Label every edge with the data it carries (`"card number"`, `"session cookie"`). Then add each trust boundary as a dashed red rectangle with a label (`add_elements`, `strokeStyle: "dashed"`, `backgroundColor: "transparent"`), and number the flows that cross it so threats can refer to them. See `data-flow-and-threat-models.md`.

**ER.** Use `create_diagram`, with each entity's name as `label` and its keys and the 3-6 columns that matter as `attributes` (`"id PK"`, `"customer_id FK"`). Give each edge a crow's-foot `relation` (`one-to-one`, `one-to-many`, `one-to-one-or-many`, `many-to-many`) and a label with a verb plus cardinality.

**Messaging.** Use `create_diagram` LR. Draw the topics and queues as their own nodes (`software-architecture/event-bus-or-pipeline` or `system-design-components/message-queue`), so producers point at the channel and the channel points at consumers. Make async edges dashed and label them with the event or command name. Draw dead-letter queues in red. See `messaging-and-events.md`.

**Class.** Use `create_diagram` TB. Give each class node `attributes` and `operations` (with visibility and types: `"-id: UUID"`, `"+place(): void"`) and a `stereotype` for interfaces, abstract classes and enumerations. Give every edge a `relation`: `inheritance` (child to parent), `realization` (class to interface), `composition` / `aggregation` (whole to part), `association`, or `dependency`, with multiplicities in the label (`"1 — 1..*"`). Include only the classes and members that answer the question. Object diagrams use the same nodes, labelled `name : Class`, with attribute values.

**Use case.** Use `create_diagram` LR. Put the use cases (ellipses, verb phrases) in a group named after the system: its frame is the system boundary. Keep the actors outside it (`stick-figures/stick-man` or ellipses), joined to their use cases with `relation: "association"`, and use `relation: "include"` / `"extend"` between use cases.

**Other UML diagrams.** Package, component, composite structure, communication, interaction overview and timing diagrams have recipes in `uml-structure.md` and `uml-behaviour.md`.

Only Mermaid `flowchart` and `sequenceDiagram` become editable elements. Everything else (`classDiagram`, `erDiagram`, `stateDiagram`, `gantt`, `mindmap`, `timeline`, `C4Context`, …) arrives as one uneditable image, and the result says "Converted Mermaid into 1 elements". When that happens, delete the image and build the diagram with `create_diagram` or `add_elements` instead.

**How `create_diagram` lays things out.** The examples in `references/` are shaped around these rules:

- **Layers.** Nodes go in layers along the flow.
- **Long edges.** An edge that skips a layer is drawn straight, through whatever sits in between. Prefer edges between neighbouring layers. Otherwise render and move the crossed node with `update_elements`.
- **Back edges.** These cut across the diagram too. Leave them out unless they matter.
- **Groups.** A group's frame is the bounding box of its members. It reads correctly only when the members fill a run of consecutive layers that no other node shares. Leave the first layer ungrouped, or the frame's name collides with the title.
- **Library shapes.** These put the label under the icon, so keep it to one or two short lines.
- **Arrow ids.** Arrows are named `from->to`, with `#n` added for the n-th edge after the first. Use those ids to restyle arrows afterwards.

Library keys above are the built-in defaults. Confirm them with `list_shapes` (the user may have renamed or disabled a library). If a key isn't there, fall back to a primitive shape.

## Conventions

- **Title.** Every diagram has one, stating the type and scope: `"Container diagram: Checkout"`. Pass `title` to `create_diagram`, or add a text element at fontSize 28 for Mermaid output.
- **Legend.** Add one whenever colour, line style, shape or icons carry meaning. Use a small `add_elements` batch with `placement: "right"`: one sample shape per element kind and one sample arrow per line style, each labelled. See `visual-principles.md` for a JSON template.
- **Colour.** The excalidraw skill's palette meaning applies (blue = services, green = data stores, orange = external, violet = AI/processing, yellow = notes, red = failure or risk, gray = infra). Never let colour be the only signal: pair it with shape, stroke style or a text tag.
- **Relationships.** Each arrow is one direction and one relationship, labelled with intent (`"Sends invoices using"`, not `"uses"`), plus a protocol at container level. Draw request/response as one arrow in the direction of the request, unless the reply carries the point of the diagram.
- **Edits.** Once the user has touched a drawing, edit it with `update_elements` / `add_elements` / `delete_elements`, and don't recreate it.

## Pre-flight checklist

Before you show the diagram, check that:

- [ ] The title names the diagram type and scope.
- [ ] It answers the one question you wrote down, for the audience you chose.
- [ ] Every element is at one level of abstraction (no classes in a container diagram, no load balancers in a context diagram).
- [ ] Every element has a name, a type, and a technology where relevant. Names match the code, config or infrastructure.
- [ ] Every arrow has one direction and a label giving its intent (and protocol at container level). No unlabelled arrows between boxes.
- [ ] Boundaries (system, trust zone, deployment node) are drawn and labelled.
- [ ] There's a legend if colour, shape, line style or icons mean anything, and no meaning is carried by colour alone.
- [ ] Acronyms are explained, or common for this audience.
- [ ] There are at most ~7±2 items per boundary. Otherwise split it or zoom out a level.
- [ ] Rendered and checked against the diagram-review rubric.
- [ ] Nodes link to their source (`code` on the node) where the diagram documents code, and the drawing path is mentioned in the related doc or ADR.
