---
description: Update the Excalidraw diagrams for the current code changes
argument-hint: [drawing path, commit or range]
---

Update the Excalidraw diagrams in this project so they match the current code changes. $ARGUMENTS

Use the excalidraw skill's "after a code change" workflow (references/update-after-code-change.md):

1. Find what changed. If I named a commit or range above, use it; otherwise use uncommitted changes (`git status`, `git diff`), and if there are none, the last commit (`git show --stat HEAD`). List only the changes a diagram would show: components added, removed or renamed, new or removed calls and events, technology changes.
2. Find the drawings that describe that code (`list_drawings`, then `read_drawing` with `query` for the changed paths and names). If I named a drawing above, only update that one.
3. `snapshot_drawing` each one, then bring it up to date with one `apply_changes` call using the `rev` from `read_drawing` as `if_rev`. Keep every existing id, leave my layout, colours and notes alone, and set `code` links on new nodes.
4. Render and check each changed drawing, fix what the check finds, and re-export any `.excalidraw.svg` next to it.
5. Tell me, per drawing, each code change and the edit it caused. If no diagram needed changing, say so and why.
