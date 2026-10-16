export const SERVER_INSTRUCTIONS = `Local-first Excalidraw: drawings are plain .excalidraw files in the user's project, edited live in a local browser tab. Nothing leaves this machine.

Workflow: create_diagram for boxes-and-arrows (automatic layout) or mermaid_to_drawing if Mermaid is more natural; add_elements / update_elements / delete_elements for precise edits; read_drawing to see what is there (ids, positions, labels); render_drawing to look at the result; open_drawing to show it to the user. Call excalidraw_guide once for the element format before hand-placing elements. Relative paths resolve against the project root; a bare name goes to docs/diagrams/.`;

export const GUIDE = `# Local-first Excalidraw - element guide

## Pick the right tool
- **create_diagram** - nodes + edges, laid out automatically (LR or TB). Best default for architecture, flows, pipelines, dependency graphs. Groups become labelled frames.
- **mermaid_to_drawing** - flowcharts / sequence / class diagrams from Mermaid source.
- **list_shapes** / **insert_shape** - reusable icons and components from the user's library and project \`.excalidrawlib\` files (AWS, Kubernetes, …). A create_diagram node can also use a shape key as its \`shape\`.
- **add_elements** - hand-placed elements in the simplified format below (annotations, callouts, sketches).
- **connect_elements** - an arrow from one element id to another; it stays attached when either moves.
- **update_elements** - move/resize/recolour/relabel by id, or swap a shape between rectangle, ellipse and diamond; labels stay centred and bound arrows follow.
- **delete_elements** - removes elements with their labels; arrows bound to them are detached.
- **read_drawing** - compact listing: \`[id] type at (x,y) size WxH "label" fill=...\`, arrows as \`[id] arrow from -> to\`.
- **render_drawing** - PNG of the drawing so you can check your work visually. Do this after non-trivial edits.
- **export_drawing** - writes \`name.excalidraw.svg\` (an SVG with the scene embedded: embed it in Markdown and it stays editable) or \`.png\`.

## Simplified element format (add_elements / create_drawing)
Coordinates are canvas pixels, x right, y down. Only \`type\` is required.

Shapes: \`rectangle\` | \`ellipse\` | \`diamond\`
  { "type": "rectangle", "id": "api", "x": 100, "y": 100, "width": 180, "height": 80,
    "label": "API server", "color": "blue", "rounded": true }
  - \`label\` puts centred text inside (string or { text, fontSize, strokeColor }).
  - Omit width/height when there is a label and the shape is sized to fit.

Text: { "type": "text", "x": 100, "y": 40, "text": "Title", "fontSize": 28 }

Arrows / lines: bind to shapes by id - endpoints are computed and follow the shapes when moved.
  { "type": "arrow", "start": { "id": "api" }, "end": { "id": "db" }, "label": "SQL" }
  Free arrows: { "type": "arrow", "x": 0, "y": 0, "points": [[0,0],[200,0],[200,100]] }
  Style: "strokeStyle": "dashed" | "dotted", "startArrowhead"/"endArrowhead": "arrow" | "triangle" | "dot" | "bar" | null

Frames: { "type": "frame", "name": "Backend", "children": ["api", "db"] } - sized around its children.

Any raw Excalidraw property also works (strokeColor, backgroundColor, fillStyle "hachure"|"cross-hatch"|"solid", strokeWidth, roughness 0-2, opacity, fontFamily "hand"|"normal"|"code", angle, link, groupIds).

## Colours
\`color\` sets a matching stroke + pastel fill: blue, cyan, teal, green, yellow, orange, red, pink, violet, gray, black.
Suggested meaning: blue = services/primary, green = data/success, yellow = notes/decisions, orange = external/async, red = errors/risk, violet = AI/processing, gray = infrastructure.

## Layout tips
- Typical node 160-220 x 70-90; leave 60-120 px gaps. Grid is 20 px.
- Put a title text ~60 px above the content.
- Prefer a few large, readable labels over many tiny ones; keep fontSize >= 16.
- add_elements with "placement": "right" or "below" shifts your batch next to existing content.
- After edits, call render_drawing and fix overlaps before telling the user you're done.
`;
