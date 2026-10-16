/**
 * The prompts the MCP server ships: SERVER_INSTRUCTIONS (sent at initialize, so keep it short)
 * and GUIDE (the excalidraw_guide tool). They agree with the plugin's excalidraw skill and its
 * references, and with the assistant's system prompt; change them together.
 */
export const SERVER_INSTRUCTIONS = `Local-first Excalidraw: drawings are plain .excalidraw files in the user's project, edited live in a local browser tab. Nothing leaves this machine.

Call excalidraw_guide once per session before your first edit: it has the sizing rules, layout anti-patterns, error recovery and the update-after-a-code-change workflow.

Workflow: read the real code first and use its names (project_overview maps an unfamiliar project: manifests, Compose services, entry points, existing drawings). Draw boxes and arrows with create_diagram (automatic layout; nodes take code: "path:line" links); use mermaid_to_drawing only for flowcharts and sequence diagrams. Edit existing drawings in place: read_drawing (returns ids and a rev; filter with query), then targeted apply_changes / update_elements / add_elements / delete_elements with if_rev, keeping ids. Never redraw a drawing the user has edited. After every batch, render_drawing, check it, fix what you see, and render again. snapshot_drawing before risky edits; restore_drawing undoes them. diagram_reference has notes on choosing and drawing C4, UML, DFD, ER, infrastructure and messaging diagrams. open_drawing shows a drawing to the user. Relative paths resolve against the project root; a bare name goes to docs/diagrams/.`;

export const GUIDE = `# Local-first Excalidraw: drawing guide

## Pick the tool
- **create_diagram**: nodes + edges with automatic layout (LR or TB). The default for architecture, request flows, pipelines, state machines and dependency graphs. Groups become labelled frames. Nodes take \`code\` links.
- **mermaid_to_drawing**: only \`flowchart\` and \`sequenceDiagram\` become editable shapes. Class, ER, state and other Mermaid types arrive as one uneditable image: use create_diagram for those.
- **list_shapes** / **insert_shape**: icons and components from the user's libraries (people, databases, cloud services). A create_diagram node can use a shape key as its \`shape\`.
- **add_elements**: hand-placed elements in the format below (annotations, notes, a new node next to existing ones).
- **apply_changes**: add + update + delete in one call and one revision. Best for a planned set of edits.
- **update_elements**: move, resize, relabel, recolour, re-link or re-frame by id. Labels re-centre and bound arrows follow.
- **arrange_elements**: align or evenly distribute elements by id.
- **connect_elements**: an arrow between two ids, or re-bind an existing arrow.
- **delete_elements**: removes elements with their labels; attached arrows are detached, not deleted.
- **read_drawing**: \`[id] type at (x,y) size WxH "label" fill=… in frame … code=…\`, arrows as \`[id] arrow from -> to\`, plus the drawing's \`rev\`. Filter with \`query\`, \`ids\` or \`type\`.
- **render_drawing**: a PNG to check your work; \`element_ids\` or \`region\` for a full-size close-up, \`dark\` for dark mode.
- **snapshot_drawing** / **list_snapshots** / **restore_drawing**: save and roll back a drawing.
- **check_code_links**: which code-linked elements point at files that changed or are gone since the link was made; \`mark_reviewed\` once the diagram matches the code again.
- **list_drawings** / **create_drawing** / **open_drawing**: find drawings, start one (empty or from elements), show one to the user.
- **export_drawing**: \`name.excalidraw.svg\` (viewable in a README and still editable) or \`.png\`.
- **diagram_reference**: which diagram answers which question, and recipes for C4, UML, DFD, ER, infrastructure and messaging.
- **project_overview** / **git_changes** (read-only): a map of the project (tree, manifests, Compose services, entry points, drawings), and what changed in git (uncommitted, the last N commits, or between refs, with an optional diff).

## Element format (add_elements, apply_changes add, create_drawing)
Coordinates are canvas pixels, x right, y down. Only \`type\` is required. Give your own readable ids (\`orders-api\`, not \`n1\`).

Shapes: \`rectangle\` | \`ellipse\` | \`diamond\`
  { "type": "rectangle", "id": "orders-api", "x": 100, "y": 100, "label": "orders-api", "color": "blue", "rounded": true, "code": "src/orders/server.ts" }
  - \`label\` is centred text inside (a string or { text, fontSize, strokeColor }). Omit width/height and the shape is sized to fit it.
  - \`code\` links the shape to a project file, optionally with a line (\`src/orders/repo.ts:42\`). It is stored as \`link: "src/orders/repo.ts#L42"\` and shown by read_drawing as \`code=…\`.
Text: { "type": "text", "id": "title", "x": 100, "y": 40, "text": "Checkout architecture", "fontSize": 28 }
Arrows: bind both ends by id; the ends sit on the outlines and follow when shapes move.
  { "type": "arrow", "id": "api-db", "start": { "id": "orders-api" }, "end": { "id": "orders-db" }, "label": "SQL" }
  Style: "strokeStyle": "dashed" | "dotted"; "startArrowhead"/"endArrowhead": "arrow" | "triangle" | "dot" | "bar" | null. Waypoints: "points": [[0,0],[0,-60],[200,-60],[200,0]].
Frames: { "type": "frame", "id": "backend", "name": "Backend", "children": ["orders-api", "orders-db"] }, sized around its children.
Any raw Excalidraw property also works (strokeColor, backgroundColor, fillStyle, strokeWidth, roughness 0-2, opacity, fontFamily "hand"|"normal"|"code", frameId, groupIds).

In one batch, shapes are created before arrows and frames, so arrows and frames may refer to shapes later in the same list.

## Sizing and spacing
| What | Rule |
|---|---|
| Labelled shape | Omit width/height (fits the label). Sized by hand: width at least max(160, 12 x characters in the longest line), height 60 for one line, 80 for two |
| Between any two elements | 40 px or more |
| Between siblings in a row or column | 60-100 px |
| Between ranks or tiers | 100-120 px; 120+ when the arrow between them has a label |
| Frame or zone padding | 40 px around its children |
| Text | Labels 16-20 px; notes 14 px or more; the title 24-28 px. Nothing below 14 px |
| Density | About 7 top-level items per frame and 20 nodes per diagram. Split beyond that |
| Labels | Node labels 1-4 words, using the names from the code; detail goes in a separate note |

## Layout anti-patterns
1. **A zone label as the bound label of a big rectangle.** It sits in the centre, where the children go, and can't be moved. Use a frame (create_diagram groups, or a frame with \`name\`), or free text at the zone's top-left (x + 20, y + 10, fontSize 18).
2. **Cross-zone spaghetti.** Long diagonal arrows between distant zones cross everything between them. Put zones that talk next to each other, keep most arrows inside a zone or between neighbouring zones, and split the diagram if it still tangles.
3. **Arrow labels everywhere.** A label sits at the arrow's middle and collides with shapes on short arrows. Label an arrow only when its meaning isn't obvious from its ends (protocol, event name, verb). Keep it to 12 characters or fewer, and leave labels off on dense diagrams.
4. **Free arrows.** An arrow that means "A talks to B" must be bound at both ends (\`start\`/\`end\` or connect_elements), or it is left behind when the user moves a box.
5. **Shrinking text to fit.** Widen the shape or shorten the label instead.
6. **Hand-placing what create_diagram can lay out,** and imitating an icon with plain boxes when list_shapes has it.
7. **Redrawing to change something.** \`replace: true\` or delete-and-recreate throws away the user's layout, colours and notes. Edit in place and keep ids.
8. **Decorative colour.** Each colour means one thing across the diagram. Too many colours mean none.
9. **Fixed sizes too small for the label.** Every shape you give a width, including legend swatches, needs at least 12 px per character of its longest line plus padding. Simplest: omit width and height.
10. **Arrows in a legend.** A sample arrow in a legend is an unbound arrow that reads as a connection. Show line styles with \`line\` elements, or describe them in the legend text.

## Colours
\`color\` sets a matching stroke and pastel fill: blue, cyan, teal, green, yellow, orange, red, pink, violet, gray, black.
Meaning: blue = services, green = data stores, orange = external or third-party, violet = AI or processing, yellow = decisions and notes, red = failure paths, gray = infrastructure. Dashed strokes for async flows and external boundaries.

## Check after every batch
After each create_diagram, add or apply call, run render_drawing and check:
1. Every label fits its shape, with padding; nothing is cut off.
2. No shapes overlap; frames contain their children with padding.
3. No arrow runs through an unrelated shape or label; every connection is bound at both ends.
4. Arrow labels sit on a clear stretch of their arrow and are 12 characters or fewer.
5. At least 40 px between elements; rows and columns are aligned (use arrange_elements).
6. Text is 14 px or larger; the flow reads in one direction.
7. No zone label is bound inside a big rectangle.
If anything fails, say what you see ("I see the orders arrow crossing the cache box, fixing it"), fix it with update_elements or arrange_elements, and render that part again (\`element_ids\` of what changed). Only report the result when a render passes. On a big drawing the overview is scaled down: render a close-up before calling text unreadable.

## Update a diagram after a code change
1. **Find what changed:** git_changes (uncommitted changes; \`last: 1\` for the latest commit; \`diff: true\` with \`path\` for the code), \`git diff\` / \`git log -p -1\`, or the files the user names. List only what is visible at the diagram's level: components added, removed or renamed; calls, events or dependencies added or removed; technology changes.
2. **Find the diagrams:** list_drawings, then read_drawing (it ends with the state of the code links; check_code_links lists the changed and missing ones). \`query\` with changed paths or names (\`"src/orders"\`, \`"ledger"\`) finds the affected elements by their \`code=\` links and labels.
3. **snapshot_drawing** (name "before sync").
4. **Plan one edit per change:** renamed → update the label and \`code\`, keep the id. New component → add a shape beside its main neighbour (same size and colour as its siblings, inside the right frame with \`frameId\`, with \`code\`), plus bound arrows. Removed → delete it and its arrows. New relationship → add a bound arrow. Moved boundary → update x/y and \`frameId\`.
5. **Apply it as one apply_changes call with \`if_rev\`** set to the rev from read_drawing. Don't touch elements the change doesn't affect: the user's positions, colours and notes stay.
6. **Render and check** the changed area (the changed ids and their neighbours), and fix what the check finds.
7. **check_code_links** with \`mark_reviewed: true\` once the diagram matches the code, so the links read as up to date.
8. **Report** each code change and the diagram edit it caused, and anything that looked stale but wasn't part of the change (don't silently fix it). Re-export \`.excalidraw.svg\` files next to the drawing.

## Error recovery
| Error says | Do |
|---|---|
| \`Element "x" not found\` | read_drawing (with \`query\`) for current ids; the user may have deleted or renamed it |
| \`Element id "x" already exists\` | update_elements it, or choose another id |
| \`Unknown element type "box"; did you mean "rectangle"?\` | Use the suggested type |
| \`Arrow start/end "x" not found\`, \`Frame child "x" not found\` | Create the shape in the same batch or fix the id |
| \`Can't bind an arrow to text "x"\` | Bind to the shape that holds the label |
| \`The drawing changed since you read it\` | read_drawing again, re-plan against what is there now, and retry with the new rev. Never retry the same edit blindly |
| \`Can't turn a text into a rectangle\` | Only rectangle, ellipse and diamond swap in place; delete and add with the same id |
| \`ignored unknown property\` / \`treated "fill" as "backgroundColor"\` notes | Use the property names from this guide |
| \`… doesn't exist (linked anyway)\` | The code path is wrong: fix it with update_elements \`code\` |
| \`No editor is open\` (render, export, Mermaid) | No headless browser here: give the user the link from the message, and say you couldn't check the drawing visually |
| \`is not valid Excalidraw JSON (merge conflict?)\` | Tell the user. Overwrite (create_drawing overwrite: true) only if they agree |
| \`is outside the allowed roots\` | Use a path inside the project |
| A Mermaid result of 1 element | It became an image: delete it and use create_diagram |
| Anything else after a bad edit | restore_drawing to the last snapshot, then try a smaller step |
`;
