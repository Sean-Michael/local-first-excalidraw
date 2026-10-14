---
name: diagram-review
description: Look at a rendered Excalidraw diagram and fix what makes it hard to read, using the local-first excalidraw MCP tools. Use when asked to review, audit, polish, clean up or "make readable" a diagram or .excalidraw file, when a diagram looks cluttered or confusing, and after drawing anything non-trivial. Needs a model that can see images.
---

# Diagram review

A diagram is an interface: someone has to find the start, follow the flow and read every label without help. Judge it by looking at the rendered picture, not the JSON. Coordinates tell you where things are, not whether they read well.

## Method

1. **Read first.** `read_drawing` for ids, positions, labels, frames and arrows. Note what the diagram is meant to explain (title, frames, the user's request).
2. **Overview render.** `render_drawing` with no targeting. Answer the questions under *Composition* from this picture. The tool reports the scale and how big the smallest text appears. Below about 10px, don't judge text legibility from the overview.
3. **Close-ups.** Render each frame or cluster with `element_ids` (a frame id brings its children; a shape brings its label and attached arrows) or with a `region` taken from `read_drawing` coordinates. Go through *Legibility* and *Connections* for each one.
4. **Dark mode.** If the diagram will be shown in docs or a README, render once with `dark: true` and check *Colour*.
5. **Fix** with `update_elements` (move with `x`/`y`, resize, relabel, recolour; labels re-centre and bound arrows re-route), `connect_elements` to bind free arrows, and `delete_elements` for clutter. Make targeted edits and keep ids. Never recreate the drawing to fix layout, because that throws away the user's manual work.
6. **Re-render the parts you changed** and repeat. Fixes cause new problems (a moved box now covers an arrow). Stop when a full pass finds nothing above *minor*.
7. **Report** in a few lines: what you fixed, and anything you left alone on purpose.

Don't ask permission for clear readability fixes. Ask before changing meaning: removing elements, renaming things to names that aren't in the code, or reorganising the structure.

## Rubric

Rate each finding as **blocker** (it misleads or can't be read), **major** (it slows the reader down noticeably) or **minor** (polish). Fix blockers and majors. Fix minors when it's cheap.

### Composition
- **Entry point:** it's obvious where to start, usually top-left or a clearly marked actor/start node.
- **One direction:** the main flow runs one way (left to right for pipelines and requests, top to bottom for hierarchies and decisions). Back-edges are the exception, and they look different (dashed or a different colour).
- **Grouping by proximity:** related things sit closer to each other than to unrelated things. A gap that looks equal on both sides makes membership ambiguous. Frames or groups mark real boundaries (service, trust zone, package), not decoration.
- **Alignment:** nodes in the same rank share a centre line or edge. Ragged near-alignments (off by 5–20px) look like mistakes, so snap them.
- **Balance:** no large empty quadrant next to a cramped one, and no stray element far away from everything else.
- **Density:** about 7±2 top-level items per frame. Past that, split into frames or a second diagram, or collapse detail into one node with a note.

### Legibility
- **Size:** in the export (scale 1), body labels are at least 16px and secondary notes at least 14px. A frame title or the diagram title is the largest text.
- **Fit:** labels don't touch or overflow their container. Leave at least ~12px of padding. Widen the shape rather than shrinking the font.
- **Length:** node labels are 1–4 words and use the names from the code. Put longer detail in a separate text note, not in the box.
- **No collisions:** no text is covered by a shape, an arrow or another label. Arrow labels sit on a clear stretch of their arrow.
- **Consistent type:** one font family and at most three sizes, and the same kind of element always uses the same size.

### Connections
- **Bound:** every arrow that means "A talks to B" is bound at both ends (`read_drawing` shows `a -> b`, not coordinates). Fix free-floating ends with `connect_elements`.
- **Through nothing:** arrows don't pass through unrelated shapes or labels. Move nodes first. Reroute only when moving doesn't work.
- **Few crossings:** reorder nodes within a rank to remove crossings. A crossing that can't be avoided should be at a clear angle, not a near-parallel overlap.
- **Readable direction:** arrowheads are visible (not hidden under a shape), and parallel arrows between the same pair are spread apart or merged into one labelled arrow.
- **Labelled when ambiguous:** if the meaning of an edge isn't obvious from its two ends, label it (`calls`, `writes`, `events`).

### Colour
- **Meaning, not decoration:** each colour means one thing across the whole diagram. The excalidraw skill's convention is blue = services, green = data stores, orange = external, violet = AI/processing, yellow = decisions/notes, red = failure paths, gray = infra. If colours are used, there's a legend or the meaning is obvious.
- **Contrast:** text stays readable on its fill in both light and dark renders. Pale fills with dark text are safe. Saturated fills under small text are not.
- **Not colour alone:** important distinctions (failure path, external system) also show through shape, stroke style or a label.

## Out of scope

Whether the diagram is *correct* (the right components and arrows) is a separate question. Flag anything that looks wrong compared with the code, but don't rewrite the content during a readability pass unless asked.
