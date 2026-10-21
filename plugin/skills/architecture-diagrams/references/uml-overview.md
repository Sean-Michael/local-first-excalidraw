# UML: the 14 diagram types
<!-- keywords: uml, unified modeling language, uml diagram, which uml diagram, types of uml diagrams, structural diagram, behavioural diagram, behavioral diagram, static diagram, dynamic diagram, interaction diagram, uml notation, uml symbols, stereotype, multiplicity, 4+1 view -->

UML (Unified Modeling Language) is a standard visual language for describing software. It isn't a programming language and it isn't a process: it's a shared vocabulary of boxes, lines and arrowheads whose meanings are fixed, so a reader who knows UML can read any team's diagram. UML 2 has 14 diagram types in two families. Structural diagrams show what exists, independent of time. Behavioural diagrams show what happens: how the parts act and interact over time.

Use this page to work out which UML diagram the user means, then read the detailed notes: `uml-structure` for structural diagrams and `uml-behaviour` for behavioural ones.

## Which UML diagram answers which question

| Family | Diagram | The question it answers | Core notation | Draw it with |
|---|---|---|---|---|
| Structural | **Class** | What types exist, what they hold and do, and how they relate? | Boxes with name / attributes / operations compartments; association, aggregation ◇, composition ◆, inheritance ▷, realisation (dashed ▷), dependency (dashed →); multiplicities | `create_diagram` nodes with `attributes`/`operations`, edges with `relation` |
| Structural | **Object** | What does a concrete snapshot of instances look like at one moment? | Boxes named `instance : Class` (underlined in strict UML), attribute values `name = "Alice"`, plain links | `create_diagram`, `relation: "association"` |
| Structural | **Package** | How is the code organised into namespaces or layers, and which depend on which? | Tabbed folders; dashed dependency arrows, `«import»` / `«access»` | `create_diagram` with groups as packages, `relation: "dependency"` |
| Structural | **Component** | Which replaceable parts make up the system, and through which interfaces do they talk? | `«component»` boxes, provided (lollipop) and required (socket) interfaces, dependencies | `create_diagram`, interface names on edges |
| Structural | **Composite structure** | What is inside one class or component: its parts, ports and connectors? | A classifier box containing part boxes, ports as small squares on the border, connectors | Frame for the classifier, `add_elements` for ports |
| Structural | **Deployment** | Which artifacts run on which hardware or execution environments? | 3D nodes `«device»` / `«executionEnvironment»`, `«artifact»`s, communication paths labelled with protocols | Groups per node, `stereotype` on nodes |
| Structural | Profile | How is UML itself extended for a domain? | Stereotype definitions | Rarely drawn; explain in text |
| Behavioural | **Use case** | Who uses the system and for what goals? Where is the system's boundary? | Stick-figure actors outside a system boundary box; use cases as ellipses inside; association lines, `«include»`, `«extend»`, generalisation | Frame for the boundary, ellipse nodes, `relation: "include"` / `"extend"` |
| Behavioural | **Activity** | What are the steps, decisions and parallel branches of a process? | ● initial node, ◉ final node, rounded actions, ◇ decision/merge with `[guards]`, fork/join bars, swimlanes | `create_diagram` TB, or Mermaid `flowchart` |
| Behavioural | **State machine** | What states can one thing be in, and which events move it between them? | Rounded states, ● initial pseudostate, ◉ final state, transitions `event [guard] / action` | `create_diagram` LR |
| Behavioural (interaction) | **Sequence** | In what order do participants exchange messages in one scenario? | Lifelines across the top, time flows down; solid calls, dashed replies; `alt` / `opt` / `loop` / `par` fragments | `mermaid_to_drawing` `sequenceDiagram` |
| Behavioural (interaction) | **Communication** | Who talks to whom, and in what numbered order? | Objects placed freely, links, numbered messages `1: placeOrder()`, `1.1: reserve()` | `create_diagram`, numbers in edge labels |
| Behavioural (interaction) | **Interaction overview** | How do several interactions combine into a larger flow? | An activity diagram whose nodes are `sd` / `ref` interaction frames | `create_diagram` TB, frames as nodes |
| Behavioural (interaction) | **Timing** | How do states or values change against a time axis, and with what deadlines? | Lifelines as horizontal state tracks, time running left to right, duration constraints | `add_elements` by hand |

## When the request is vague

- **"A UML diagram of X" with no type.** Pick from what X is. For a domain or data model ("e-commerce", "library system", "hotel booking"), draw a **class diagram** of its main concepts. For a process ("checkout", "onboarding"), draw an **activity diagram**. For one scenario between parties ("login", "payment"), draw a **sequence diagram**. For features and users ("what can a customer do"), draw a **use case diagram**. Say which type you chose in one sentence and offer the others; don't stop to ask.
- **"UML" plus a codebase.** Read the code first. Class diagrams use the real class, field and method names. Sequence diagrams use the real calls. State machines use the real enum values.
- **"Architecture diagram" or "system design".** That usually isn't UML. Use C4 (`c4`) unless the user says UML. UML component and deployment diagrams are the UML equivalents.

## Notation in this editor

Excalidraw has no UML palette, but the drawing tools map onto the notation:

| UML element | How to draw it |
|---|---|
| Class box with compartments | A `create_diagram` node with `label` (the name), `attributes` and `operations` (lists of strings), and `stereotype` for `«interface»`, `«abstract»` or `«enumeration»`. The rule lines are added for you. Visibility: `+` public, `-` private, `#` protected, `~` package. Members: `name: Type`, `op(param: Type): Return` |
| Association, aggregation, composition | Edge `relation: "association"` (plain line), `"aggregation"` (hollow diamond at `from`, the whole), `"composition"` (filled diamond at `from`, the whole) |
| Inheritance / generalisation | Edge `relation: "inheritance"` from the child to the parent: a hollow triangle at the parent. The parent is laid out above (TB) or left of (LR) its children |
| Realisation (implements) | Edge `relation: "realization"` from the class to the interface: dashed with a hollow triangle |
| Dependency, `«import»`, `«use»` | Edge `relation: "dependency"`: dashed with an open arrow; put a stereotype in `label` if it matters |
| Multiplicity, role name | Edge `startLabel` (beside `from`) and `endLabel` (beside `to`): `"1"`, `"0..*"`, or a role and multiplicity `"items 1..*"`. Not in the middle `label` |
| Stereotype | `«name»` above the element name: the node's `stereotype` field |
| Actor | `stick-figures/stick-man` library shape with a one-line label, or an ellipse labelled with the role |
| Use case | An ellipse node inside a group (the group's frame is the system boundary, named after the system) |
| `«include»` / `«extend»` | Edge `relation: "include"` (from the base use case to the included one) or `"extend"` (from the extension to the base). Both are dashed and labelled for you |
| Initial node ● / final node ◉ | A small ellipse node with `color: "black"` and a short label (`"start"`, `"end"`), or an empty label. Don't use a big labelled ellipse saying "Start checkout" |
| Decision / merge ◇ | A diamond node; label each outgoing edge with a guard in brackets: `[paid]`, `[declined]` |
| Fork / join bar | A thin black rectangle node (`label: " "`, `color: "black"`), or a note that the branches run in parallel |
| Lifeline, message, fragment | Mermaid `sequenceDiagram` through `mermaid_to_drawing` |
| Node / device / execution environment | A group or node with `stereotype: "device"` or `"executionEnvironment"`; artifacts as nodes with `stereotype: "artifact"` |
| Package | A group (frame) named after the package, or a node with `stereotype: "package"` when it holds nothing |
| Note | A yellow rectangle near the element (`add_elements`), joined by a dashed `line` |

ER diagrams aren't UML, but they use the same edges: `relation: "one-to-many"` and the other crow's-foot relations (see `data-models`).

## Common mistakes

- **Drawing boxes-and-arrows and calling it UML.** If the user asked for UML, use its notation: compartments, the right arrowheads, stereotypes, guards in brackets.
- **Every arrow drawn the same.** In UML, the line style and arrowhead are the meaning. A plain arrow for inheritance or composition is wrong.
- **Mixing diagram types.** Don't put states in an activity diagram or classes in a deployment diagram.
- **Too much at once.** About 10 classes, 12 messages or 15 states per diagram. Split by package, scenario or object.
- **Arrows pointing the wrong way.** Inheritance and realisation point at the parent or interface. Dependency points at what is used. Composition and aggregation diamonds sit at the whole.
