---
name: excalidraw
description: Draw, edit and keep up to date Excalidraw diagrams that live as .excalidraw files in the project, with the local-first excalidraw MCP tools. Use when the user asks for a diagram, sketch, whiteboard, or an architecture, flow, sequence or dependency picture of the code; to view, change, tidy or export an existing .excalidraw or .excalidraw.svg file; or to update diagrams after a code change ("sync the diagrams", "the architecture diagram is out of date").
---

# Excalidraw diagrams (local-first)

Drawings are plain `.excalidraw` JSON files in the repo (default folder `docs/diagrams/`). A local daemon serves the real Excalidraw editor on `localhost`. Changes you make through the MCP tools appear in the user's open tab at once, and their edits are saved straight back to the file. Nothing is sent over the network.

To pick the right kind of diagram (C4, sequence, state, ER, deployment, data flow), use the architecture-diagrams skill or the `diagram_reference` tool. For a readability pass on a finished drawing, use the diagram-review skill.

## Tools

| Goal | Tool |
|---|---|
| Boxes and arrows (architecture, request flow, pipeline, state machine, dependencies) | `create_diagram`: nodes + edges, automatic layout; nodes take `code` links |
| A flowchart or sequence diagram, or the user gave you Mermaid | `mermaid_to_drawing` (only `flowchart` and `sequenceDiagram` stay editable) |
| Icons: people, databases, cloud services | `list_shapes`, then a shape key as a node `shape` or `insert_shape` |
| Look at what is there | `read_drawing` (ids, labels, `code=` links and a `rev`; `query` to find elements) |
| A planned set of edits | `apply_changes` (add + update + delete in one revision, with `if_rev`) |
| One kind of edit | `update_elements`, `add_elements`, `delete_elements`, `connect_elements`, `arrange_elements` |
| Check your work | `render_drawing` (`element_ids` or `region` for a close-up) |
| Undo a risky edit | `snapshot_drawing` before, `restore_drawing` after |
| Show the user / put it in docs | `open_drawing` / `export_drawing` (`name.excalidraw.svg`, still editable) |

Call `excalidraw_guide` once per session before your first edit. It has the element format, the sizing table and the error recovery table.

## New diagram

1. **Read the code first,** so every box and arrow is real. Use the names from the code, and note the file each node comes from.
2. **Draw with `create_diagram`.** `direction: "LR"` for request flows and pipelines, `"TB"` for hierarchies and decisions. Groups for real boundaries (a system, a trust zone, a package). Give each node a readable `id` and a `code` link (`"services/orders/src/server.ts"`, or `"…/repo.ts:42"`). Labels of 1-4 words. Edge labels only when the meaning isn't obvious, 12 characters or fewer.
3. **Check after every batch** (below), then `open_drawing` and tell the user the file path.

## Existing diagram

- `read_drawing` first: the user may have edited it by hand. Keep its `rev` and pass it as `if_rev` to your writes.
- Make targeted edits that keep ids. Never `replace: true`, and never delete-and-recreate, unless the user asks to start over: it throws away their layout, colours and notes.
- To place a new node, take its neighbour's position from `read_drawing` and leave 60-100 px between them, in the same frame (`frameId`), at the same size and colour as its siblings.

## After a code change

When the code changed and a diagram should follow (`/excalidraw:sync`, "update the diagram"), follow [references/update-after-code-change.md](references/update-after-code-change.md). In short: diff, `read_drawing` with `query` (and `check_code_links`) to find the affected elements by `code=` link and label, `snapshot_drawing`, one `apply_changes` with `if_rev` that keeps ids, render and check, `check_code_links` with `mark_reviewed`, then report each code change and the edit it caused.

## Check after every batch

After each create, add or apply, `render_drawing` and check that labels fit, nothing overlaps, every connection is bound at both ends and crosses no unrelated shape, arrow labels are short and clear, gaps are at least 40 px, and text is at least 14 px. If something fails, say what you see ("I see the queue label overflowing its box, fixing it"), fix it, and render that part again. Report only after a render passes. Details and the layout anti-patterns: [references/layout.md](references/layout.md).

## When a tool fails

Read the error: it names the problem. The common ones (stale `rev`, unknown id, no editor for rendering, Mermaid that became an image) and what to do are in [references/error-recovery.md](references/error-recovery.md).

## Rules

- Never fetch or reference remote assets (images, fonts, libraries) in drawings.
- Don't hand-edit `.excalidraw` JSON with file-edit tools. The MCP tools keep labels, bindings and versions consistent, and the open editor syncs at once.
- If rendering needs an editor and none could be opened, give the user the link from the error message.
