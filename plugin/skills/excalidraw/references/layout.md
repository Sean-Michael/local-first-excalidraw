# Layout rules and the check after every batch

These are the same rules `excalidraw_guide` returns. The diagram-review skill's rubric uses the same numbers.

## Sizing and spacing

| What | Rule |
|---|---|
| Labelled shape | Omit width and height: the shape is sized to fit its label. Sized by hand: width at least max(160, 12 × characters in the longest line), height 60 for one line, 80 for two |
| Between any two elements | 40 px or more |
| Between siblings in a row or column | 60-100 px |
| Between ranks or tiers | 100-120 px; 120+ when the arrow between them has a label |
| Frame or zone padding | 40 px around its children |
| Text | Labels 16-20 px, notes 14 px or more, the title 24-28 px. Nothing below 14 px |
| Density | About 7 top-level items per frame and 20 nodes per diagram. Split beyond that |
| Labels | Node labels 1-4 words, using the names from the code. Detail goes in a separate text note |

## Layout anti-patterns

1. **A zone label as the bound label of a big rectangle.** It sits in the middle, where the children go, and can't be moved. Use a frame (`create_diagram` groups, or a frame element with `name`), or a free text element at the zone's top-left: x + 20, y + 10, `fontSize` 18.
2. **Cross-zone spaghetti.** Long diagonal arrows between distant zones cross everything in between. Place zones that talk to each other side by side, keep most arrows inside a zone or between neighbouring zones, and split the diagram if it still tangles.
3. **Arrow labels everywhere.** A label sits at the arrow's middle and collides with shapes on short arrows. Label an arrow only when its meaning isn't obvious from its ends (a protocol, an event name, a verb), keep it to 12 characters or fewer, and leave labels off on dense diagrams.
4. **Free arrows.** An arrow that means "A talks to B" must be bound at both ends (`start`/`end` in `add_elements`, or `connect_elements`). A free arrow stays behind when the user moves a box.
5. **Shrinking text to fit.** Widen the shape or shorten the label instead.
6. **Hand-placing what `create_diagram` can lay out,** and drawing an icon from plain boxes when `list_shapes` has it.
7. **Redrawing to change something.** `replace: true` or delete-and-recreate throws away the user's layout, colours and notes. Edit in place and keep ids.
8. **Decorative colour.** Each colour means one thing across the diagram.

## Colours

`color` sets a matching stroke and pastel fill. Blue = services, green = data stores, orange = external or third-party, violet = AI or processing, yellow = decisions and notes, red = failure paths, gray = infrastructure. Use dashed strokes for async flows and external boundaries.

## Check after every batch

After each `create_diagram`, `add_elements` or `apply_changes`, run `render_drawing` and go through:

1. Every label fits its shape with padding, and nothing is cut off.
2. No shapes overlap, and frames contain their children with padding.
3. No arrow runs through an unrelated shape or label, and every connection is bound at both ends (`read_drawing` shows `a -> b`, not coordinates).
4. Arrow labels sit on a clear stretch of their arrow and are 12 characters or fewer.
5. There are at least 40 px between elements, and rows and columns are aligned (`arrange_elements`).
6. Text is 14 px or larger, and the main flow reads in one direction.
7. No zone label is bound inside a big rectangle.

If anything fails, stop and say what you see, for example "I see the order.placed label sitting on the queue box, fixing it". Fix it with `update_elements` (move with `x`/`y`; labels and arrows follow) or `arrange_elements`, then render the changed part again with `element_ids`. Move on, or report to the user, only when a render passes.

On a big drawing the overview is scaled down, and `render_drawing` says how big the smallest text appears. Below about 10 px, render a close-up before calling text unreadable.
