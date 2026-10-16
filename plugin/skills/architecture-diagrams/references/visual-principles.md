# Visual principles for technical diagrams

A diagram works when the reader can answer its question without the author in the room. These principles come from perception research (Gestalt psychology), information design (Edward Tufte) and the practice of architecture documentation (C4, arc42, ISO/IEC/IEEE 42010). The diagram-review skill turns them into a checklist for a rendered drawing. This file explains why the checks exist and how to design for them from the start.

## One diagram, one question, one audience

ISO/IEC/IEEE 42010 frames architecture description like this:

- **Stakeholders** have **concerns**.
- A **viewpoint** is the set of conventions for answering a set of concerns: notation, model kinds and level.
- A **view** is one diagram or set of diagrams that follows a viewpoint for a particular system.

Kruchten's 4+1 view model (logical, process, development, physical, plus scenarios), arc42's context, building block, runtime and deployment views, and C4's levels are all ready-made sets of viewpoints.

In practice:

- **Write the question first** ("How does a webhook reach the database?"). Everything that doesn't help answer it is noise.
- **Name the audience.** Executives, new developers, on-call engineers and auditors need different diagrams of the same system.
- **Use several simple diagrams,** each consistent with the others, rather than one diagram that tries to show everything.

## One level of abstraction

Every element in a diagram should be the same kind of thing at the same zoom level: all systems, or all containers, or all components. A box for "Payments platform" next to a box for `validateCard()` forces the reader to keep switching scale, and hides how big things really are. If one area needs more detail, draw a second diagram zoomed into it, and refer to it by name.

## Gestalt principles

These are how readers group things before they read a single label:

- **Proximity:** things close together are read as related. Gaps between groups should be clearly bigger than gaps within them. `create_diagram` groups handle this, so put related nodes in the same group.
- **Similarity:** things that look alike (shape, colour, size, line style) are read as the same kind. So one visual encoding per element kind, used consistently: every database a cylinder, every external system dashed and gray.
- **Enclosure (common region):** a boundary around elements is the strongest grouping cue. Use frames and boundary rectangles for real boundaries only (system, trust zone, deployment node, team), never decoration.
- **Continuity:** the eye follows smooth lines and straight paths. Keep the main flow in one direction with few bends and crossings, and line up nodes in the same rank.
- **Connectedness:** a line between two things binds them more strongly than colour or proximity. That's why an unlabelled arrow still says "these are related". Make sure it says *how*.
- **Figure and ground:** keep fills pale and the background plain, so labels and arrows stand out.

## Reading direction

Readers in left-to-right languages start top-left. Put the entry point (the user, the trigger, the client) there:

- **Left to right** (`direction: "LR"`) for request paths, pipelines, data flows and event flows.
- **Top to bottom** (`"TB"`) for hierarchies, layering (callers above dependencies), decision flows and state lifecycles.
- **Back edges** (retries, replies, compensation) are the exception. Make them look different: dashed, or a different colour as well as a label.

## Titles, labels and legends

- **Title:** the diagram type and scope ("Container diagram: Checkout"), at the largest font size.
- **Node labels:**
  - name
  - type and technology for architecture diagrams, as `"Name\n[Container: Tech]\nresponsibility"`
  - the names used in the code
- **Edge labels:** intent in the direction of the arrow, plus protocol where it matters. Data names on DFDs, and message names on event flows.
- **Legend (key):** needed whenever shape, colour, line style, arrowhead or icon carries meaning. The C4 review checklist asks whether the reader understands every colour, shape, icon, border style, line style and arrowhead. Here's a legend template that sits to the right of the diagram:

```json add_elements
{
  "path": "docs/diagrams/c4-container-shop",
  "placement": "right",
  "elements": [
    { "type": "rectangle", "id": "lg-svc", "x": 0, "y": 0, "width": 180, "height": 50, "label": "Container (ours)", "color": "blue", "rounded": true },
    { "type": "rectangle", "id": "lg-ext", "x": 0, "y": 70, "width": 180, "height": 50, "label": "External system", "color": "gray", "strokeStyle": "dashed" },
    { "type": "rectangle", "id": "lg-db", "x": 0, "y": 140, "width": 180, "height": 50, "label": "Data store", "color": "green" },
    { "type": "arrow", "id": "lg-sync", "x": 0, "y": 230, "points": [[0, 0], [110, 0]] },
    { "type": "text", "id": "lg-sync-t", "x": 124, "y": 218, "text": "sync call", "fontSize": 16 },
    { "type": "arrow", "id": "lg-async", "x": 0, "y": 270, "points": [[0, 0], [110, 0]], "strokeStyle": "dashed" },
    { "type": "text", "id": "lg-async-t", "x": 124, "y": 258, "text": "async message", "fontSize": 16 },
    { "type": "frame", "id": "legend", "name": "Legend", "children": ["lg-svc", "lg-ext", "lg-db", "lg-sync", "lg-sync-t", "lg-async", "lg-async-t"] }
  ]
}
```

Include only the entries the diagram actually uses.

## Colour

- **Meaning, not decoration.** Each colour means one thing across the diagram, and across the set of diagrams. The project palette convention: blue = services, green = data stores, orange = external/async, violet = AI/processing, yellow = notes/decisions, red = failure/risk/security boundary, gray = infrastructure/external.
- **Never colour alone.** About 1 in 12 men and 1 in 200 women have some colour-vision deficiency, and diagrams get printed in grayscale. Pair every colour distinction with a second cue: shape, stroke style (dashed or dotted), an icon, or a text tag like `[external]`.
- **Avoid red against green** as the only contrast. Blue against orange is the safest pair. The Okabe-Ito palette (orange `#E69F00`, sky blue `#56B4E9`, bluish green `#009E73`, yellow `#F0E442`, blue `#0072B2`, vermillion `#D55E00`, reddish purple `#CC79A7`) was designed to stay distinguishable under the common colour-vision deficiencies. Use it for `strokeColor` when you need more than a few categories.
- **Pale fills under dark text.** The palette `color` names give pastel fills, so text contrast holds in light and dark renders. Check dark mode with `render_drawing` `dark: true` when the diagram goes in a README.
- **Few colours.** 3–5 categories at most. More than that, and readers stop decoding colour.

## Ink and clutter

Tufte's "data-ink" idea, applied lightly: spend ink on things that carry meaning, and erase the rest.

- **No 3D, shadows, gradients or decorative icons.** Use an icon only when it is faster to recognise than a word (a person, a database, a cloud vendor's service), and label it anyway.
- **Avoid repetition.** Prefer one labelled arrow to five parallel ones. Prefer "×3" to three identical boxes, unless redundancy is the point.
- **Notes go outside boxes.** Keep node labels short, and put caveats in a separate text note.
- **Mind the density.** Aim for about 7±2 items per boundary and 20 or fewer per diagram. Beyond that, split the diagram or zoom out a level.
- **Keep Excalidraw's hand-drawn style.** It signals "a sketch for discussion", which suits architecture. Use `roughness: 0` and `fontFamily: "normal"` only when the user wants a formal look.

## Sketching vs. diagrams as code

- **Whiteboard-style sketching** (Excalidraw's home turf) is best for exploring and discussing options. It's fast, informal and invites changes. You get layout freedom and annotations, but nothing keeps it in sync with the code.
- **Diagrams as code** (Mermaid, PlantUML, Structurizr DSL for C4, D2, Graphviz) are best for diagrams that must stay accurate. They're text you can diff and review in pull requests, and they can be generated from the code or model. Layout is automatic, and annotations are harder.
- **This project sits in between.** The `.excalidraw` file is JSON in the repo, so it diffs and reviews like code. `create_diagram` and `mermaid_to_drawing` generate it from a model, and people refine it by hand. Treat the generated structure as the source of truth for *what* is there, and the hand edits as layout and annotation. See `living-diagrams.md` for keeping it in step with the code.

## Common mistakes

- **No title or legend.** The reader has to guess the scope and the encodings.
- **Several questions in one diagram,** giving a "big ball of boxes".
- **Levels of abstraction mixed.**
- **Colour as the only signal.** Inconsistent colour meaning across diagrams in the same doc.
- **Arrows that run in every direction,** with no clear entry point.
- **Icons without labels.** Unexplained acronyms.
- **Decoration:** shadows, 3D, dense fills and logos that carry no information.
