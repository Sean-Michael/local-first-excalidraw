# Choosing a diagram

Pick the diagram from the question being asked, not from habit. ISO/IEC/IEEE 42010 frames it this way: stakeholders have concerns, and a viewpoint decides which kind of view answers them. Kruchten's 4+1 views, the arc42 views and C4's levels are ready-made sets of viewpoints. Start with the reader and the question, then pick the cheapest diagram that answers it.

## Step 1: audience and question

| Audience | They usually ask | Usual diagrams |
|---|---|---|
| Business stakeholders, new joiners, other teams | What is it, who uses it, what does it depend on? | C4 system context, system landscape |
| Developers on the team | How is it built, where does this code live, what calls what? | C4 container, component, dependency graph, sequence, class |
| On-call, ops, platform | Where does it run, how does traffic flow, what fails over? | Deployment, infrastructure topology |
| Security, privacy, compliance | Where does sensitive data go, and which boundaries does it cross? | DFD with trust boundaries |
| Data engineers, DBAs | What's stored and how does it relate? | ER diagram |
| Product, process owners | What are the steps and decisions? | Activity diagram or flowchart, state machine |
| Strategy, architecture leads | What should we build, buy or outsource? | Wardley map |

## Step 2: question to diagram type

| The question is about… | Diagram | Reference |
|---|---|---|
| The system as a black box, with users and neighbours | C4 system context | `c4.md` |
| All systems in an organisation | C4 system landscape | `c4.md` |
| Deployable apps and data stores, and how they talk | C4 container | `c4.md` |
| Modules inside one app | C4 component, or a UML component/package diagram | `c4.md`, `uml-structure.md` |
| Import or call dependencies, layering, cycles | Dependency graph | `uml-structure.md` |
| Types and their relationships | UML class | `uml-structure.md` |
| The order of interactions in one scenario | Sequence, or C4 dynamic | `uml-behaviour.md` |
| Steps, decisions and parallel work in a process | Activity diagram or flowchart | `uml-behaviour.md` |
| The lifecycle of one thing (statuses) | State machine | `uml-behaviour.md` |
| What runs where, in one environment | Deployment (C4 or UML) | `c4.md`, `uml-structure.md` |
| Networks, subnets, clusters, traffic paths | Infrastructure topology | `infrastructure.md` |
| Data movement and trust levels, threats | DFD with trust boundaries | `data-flow-and-threat-models.md` |
| Stored data and relationships | ER diagram | `data-models.md` |
| Producers, topics, consumers, async failure paths | Messaging / event flow | `messaging-and-events.md` |
| Phases, milestones, schedule | Timeline / Gantt | below |
| A choice with several criteria, or a diagnosis | Decision tree | below |
| Brainstorming, breaking down a topic | Mind map | below |
| Evolution and sourcing of components | Wardley map | below |

## Step 3: level and size

- **One level per diagram.** For structure, choose the C4 level. For DFDs, choose the DFD level. If a part needs more detail, draw a second, zoomed-in diagram.
- **Small.** Aim for 5–20 elements. If it won't fit, the scope is too big or the question is too vague.
- **Several views beat one.** A context diagram plus a container diagram plus one sequence diagram for the trickiest flow covers most systems.

## Recipes for the less common types

### Timeline / Gantt

Use it for a roadmap, a migration plan, a release history, or an incident timeline. Mermaid `gantt` and `timeline` don't convert to editable elements here (they arrive as an image), so draw these by hand with `add_elements`:

- a horizontal line for the time axis
- one rectangle per phase, with width proportional to its duration and one row per workstream
- diamonds or text for milestones

```json add_elements
{
  "path": "docs/diagrams/migration-plan",
  "elements": [
    { "type": "text", "x": 0, "y": -60, "text": "Timeline: Postgres migration (Q1–Q2)", "fontSize": 28 },
    { "type": "line", "x": 0, "y": 0, "points": [[0, 0], [960, 0]] },
    { "type": "text", "x": 0, "y": 10, "text": "Jan", "fontSize": 16 },
    { "type": "text", "x": 320, "y": 10, "text": "Mar", "fontSize": 16 },
    { "type": "text", "x": 640, "y": 10, "text": "May", "fontSize": 16 },
    { "type": "rectangle", "id": "p1", "x": 0, "y": 50, "width": 300, "height": 50, "label": "Dual writes", "color": "blue" },
    { "type": "rectangle", "id": "p2", "x": 300, "y": 120, "width": 340, "height": 50, "label": "Backfill + verify", "color": "violet" },
    { "type": "rectangle", "id": "p3", "x": 640, "y": 190, "width": 200, "height": 50, "label": "Cut over reads", "color": "green" },
    { "type": "diamond", "id": "m1", "x": 820, "y": 260, "width": 60, "height": 60, "color": "red" },
    { "type": "text", "x": 890, "y": 278, "text": "Old DB off", "fontSize": 16 }
  ]
}
```

### Decision tree or flowchart

Use it for a triage guide, a "which option should I pick" chart, or an algorithm. Use `create_diagram` with `direction: "TB"`, diamonds for questions phrased as yes/no, and rectangles or ellipses for outcomes, with `yes`/`no` edge labels. The `decision-flow-control/*` library shapes give pre-drawn decision diamonds with yes/no exits. See `uml-behaviour.md` (Activity diagram).

### Mind map

Use it for brainstorming, mapping a topic, or the scope of a document. Mermaid `mindmap` arrives as an image, so use `create_diagram` with the central topic as an ellipse, edges to its branches, and `direction: "LR"`. The layered layout gives a tidy one-sided tree. Leave the edges unlabelled (in a mind map, the line means "part of"). Use one colour per main branch.

### Wardley map

Simon Wardley's maps put components on two axes:

- **Vertical:** the value chain, from the user need at the top down to less visible dependencies.
- **Horizontal:** evolution, from genesis through custom-built and product (or rental) to commodity (or utility).

Lines show dependencies, and arrows show expected movement. Use one to decide what to build, buy or outsource. Positions are judgements, not measurements. Draw it with `add_elements`:

- two axis lines with labels
- the four evolution stages as text along the bottom
- components as small labelled ellipses at hand-chosen x/y
- `arrow`s bound with `start`/`end` for dependencies
- a dashed arrow for evolution movement

There is no auto-layout for this, because position carries the meaning.

## Common mistakes

- **Drawing before deciding the question.** The result tries to show everything and answers nothing.
- **Using a sequence diagram for structure,** or a container diagram for behaviour.
- **One mega-diagram for all audiences.**
- **Using Mermaid types that become images.** Only `flowchart` and `sequenceDiagram` convert to editable elements. `classDiagram`, `erDiagram`, `stateDiagram`, `gantt`, `mindmap`, `timeline` and `C4Context` arrive as one image the user can't edit. Use `create_diagram` or `add_elements` instead.
- **Picking UML because it is "proper"** when the audience doesn't read UML. C4-style labelled boxes are usually clearer for mixed audiences.
