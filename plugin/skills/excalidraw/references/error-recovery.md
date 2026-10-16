# Error recovery

Tool errors name the problem. Fix the cause and retry once; don't repeat the same call.

| Error says | Do |
|---|---|
| `Element "x" not found` | `read_drawing` (with `query`) for the current ids. The user may have deleted or renamed it |
| `Element id "x" already exists; use update_elements to change it` | Update it instead, or choose another id |
| `Unknown element type "box"; did you mean "rectangle"?` | Use the suggested type |
| `Arrow start "x" not found`, `Arrow end "x" not found`, `Frame child "x" not found` | Create the shape in the same batch, or fix the id |
| `Can't bind an arrow to text "x"` | Bind to the shape that holds the label, not the label |
| `The drawing changed since you read it (you had rev …)` | The user (or another agent) edited it. `read_drawing` again, re-plan against what is there now, and retry with the new rev |
| `Can't turn a text into a rectangle: only rectangle, ellipse and diamond can be swapped` | Delete it and add the new shape with the same id |
| Notes like `ignored unknown property "fillColor"` or `treated "fill" as "backgroundColor"` | Use the property names from `excalidraw_guide` |
| `… doesn't exist (linked anyway)` | The `code` path is wrong: fix it with `update_elements` `code` |
| `Pass either align or distribute`, `Distribute needs at least three separate elements` | Fix the `arrange_elements` call |
| `No editor is open …` (render, export, Mermaid) | Headless rendering isn't available here. Give the user the link from the message, carry on without rendering, and say you couldn't check the result visually |
| `… is not valid Excalidraw JSON (merge conflict?)` | Tell the user. Overwrite with `create_drawing` `overwrite: true` only if they agree |
| `… is outside the allowed roots` | Use a path inside the project |
| `Converted Mermaid into 1 elements` | It became an image: delete it and draw with `create_diagram` |
| `No snapshot "x"` | `list_snapshots` for the ids and names |
| A bad result you can't fix in place | `restore_drawing` to the last snapshot, then try a smaller step |
