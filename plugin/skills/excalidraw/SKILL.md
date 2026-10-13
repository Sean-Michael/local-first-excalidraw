---
name: excalidraw
description: Draw and edit Excalidraw diagrams that live as .excalidraw files in the project, using the local-first excalidraw MCP tools. Use when the user asks for a diagram, sketch, whiteboard, architecture/flow/sequence picture, or to view, update or export an existing .excalidraw or .excalidraw.svg file.
---

# Excalidraw diagrams (local-first)

Drawings are plain `.excalidraw` JSON files in the repo (default folder `docs/diagrams/`). A local daemon serves the real Excalidraw editor on `localhost`; when you change a drawing through the MCP tools the user's open tab updates instantly, and their edits are saved straight back to the file. Nothing is sent over the network.

## Choosing a tool

| Goal | Tool |
|------|------|
| Boxes and arrows (architecture, data flow, pipelines, dependency graphs, state machines) | `create_diagram`: nodes + edges, automatic layout |
| Sequence or class diagrams, or the user gave you Mermaid | `mermaid_to_drawing` |
| Annotations, callouts, free-form sketches, precise placement | `add_elements` (call `excalidraw_guide` once first) |
| Change existing elements | `read_drawing` to get ids, then `update_elements` / `delete_elements` |
| Check your work | `render_drawing` (returns a PNG you can look at) |
| Show the user | `open_drawing` |
| Put it in docs/README | `export_drawing` writes `name.excalidraw.svg`, which is viewable and still editable |

## Workflow

1. **Understand before drawing.** Read the relevant code or config so names and arrows are real, not guessed. Prefer the names used in the code.
2. **Draw** with the highest-level tool that fits. `create_diagram` tips:
   - `direction: "LR"` for pipelines/request flows, `"TB"` for hierarchies and decision flows.
   - Use `group` + `groups` for boundaries (services, trust zones, packages); groups become labelled frames.
   - Colours carry meaning: blue = services, green = data stores, orange = external/3rd-party, violet = AI/processing, yellow = decisions/notes, red = failure paths, gray = infra.
   - Diamonds for decisions, ellipses for actors/start/end, rectangles for everything else.
   - Keep labels short (1-4 words). Put details in a separate `text` note via `add_elements`.
3. **Render and inspect** with `render_drawing`. Fix overlaps, unreadable labels and arrows crossing boxes using `update_elements` (move with `x`/`y`; arrows and labels follow automatically).
4. **Show it**: `open_drawing` (or `create_diagram` with `open: true`), and tell the user the file path.
5. If the user wants it in documentation, `export_drawing` and add the returned Markdown image link.

## Editing an existing drawing

- Always `read_drawing` first; the user may have changed it by hand since you last looked. Ids are stable.
- Make targeted edits (`update_elements`, `add_elements` with `placement: "right"`/`"below"`, `delete_elements`) rather than recreating the drawing, so you don't discard the user's manual work.
- Use `create_diagram` with `replace: true` only when the user asks to start over.

## Rules

- Never fetch or reference remote assets (images, fonts, libraries) in drawings.
- Don't hand-edit `.excalidraw` JSON with file-edit tools when the MCP tools can do it. They keep labels, bindings and versions consistent, and the open editor syncs immediately. (Direct file edits are still picked up, but are easier to get wrong.)
- If a browser-backed tool (render, export, mermaid) says no editor is open and it couldn't open one, give the user the link from the error message.
