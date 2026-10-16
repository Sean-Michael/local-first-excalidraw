# Updating a diagram after a code change

Use this when the code changed and a diagram documents it: `/excalidraw:sync`, "update the architecture diagram for this commit", or after you changed code yourself. The goal is a diagram that matches the code again, with the smallest edit that gets there. The user's layout, colours and notes stay.

## 1. Find what changed

- Uncommitted work: `git status` and `git diff`. The last commit: `git log -1 --stat` and `git show`. A branch: `git diff main...HEAD --stat`, then the relevant files.
- Write down only what is visible at the diagram's level:
  - a component (service, module, datastore, queue, external API) added, removed or renamed
  - a call, event, read/write or dependency added or removed
  - a component that moved boundary (into another service, package or trust zone)
  - a technology change (Redis replaced by an in-memory cache)
- Ignore refactors that don't change anything at that level.

## 2. Find the affected diagrams and elements

- `list_drawings`, then `read_drawing` on each candidate. Keep each drawing's `rev`.
- `read_drawing` with `query` finds elements by label and by `code=` link: try the changed paths (`"services/ledger-orders"`) and names (`"ledger"`). The matches come with the arrows attached to them.
- Map each change to elements: by `code=` link first, then by label. When nothing matches, find the element the new component talks to most; the new node goes beside it.

## 3. Snapshot

`snapshot_drawing` with `name: "before sync"`, so `restore_drawing` can undo the whole update.

## 4. Plan one edit per change

| Code change | Edit (in `apply_changes`) |
|---|---|
| Renamed component | `update`: `label` and `code`. Keep the id |
| New component | `add`: a shape with an id from the code, x/y beside its main neighbour (60-100 px gap, same row or column, inside the same frame with `frameId`), the same size and colour as its siblings, and a `code` link |
| New relationship | `add`: an arrow with `start` and `end` ids; a label only if the meaning isn't obvious (12 characters or fewer) |
| Removed component | `delete`: the shape and the arrows attached to it (they detach otherwise) |
| Removed relationship | `delete`: the arrow |
| Changed relationship | `update` the arrow's `label` or `strokeStyle` (dashed for async) |
| Moved boundary | `update`: x/y into the new frame and `frameId`; the label follows |
| Technology change | `update` the label (`[Container: Tech]` line) and `code` |
| Code link to a file that's gone | `update` `code` to the new file, or `code: null` |

Don't touch anything the change doesn't affect, even if you'd lay it out differently. If something looks stale but isn't part of this change, mention it in the report instead of fixing it.

## 5. Apply it in one call

```json apply_changes
{
  "path": "docs/diagrams/architecture.excalidraw",
  "if_rev": "<rev from read_drawing>",
  "delete": ["token-cache"],
  "add": [
    { "type": "rectangle", "id": "stockroom-inventory", "x": 760, "y": 420, "width": 200, "height": 70, "label": "stockroom-inventory", "color": "blue", "code": "services/stockroom-inventory/src/server.ts" },
    { "type": "arrow", "id": "orders-inventory", "start": { "id": "ledger-orders" }, "end": { "id": "stockroom-inventory" }, "label": "reserve" }
  ],
  "update": [{ "id": "keymaster-auth", "label": "keymaster-auth\n(in-memory sessions)" }]
}
```

Deletes run first, then adds, then updates, all in one revision. If the call fails, nothing changed: read the error and fix the batch. If it says the drawing changed since you read it, the user edited it: `read_drawing` again and re-plan.

## 6. Render and check

`render_drawing` with `element_ids` set to the changed ids and their neighbours, then the whole drawing. Go through the check in [layout.md](layout.md). New nodes often land on top of something: move them with `update_elements` and align them with `arrange_elements`.

## 7. Report

One line per code change and the diagram edit it caused ("Added stockroom-inventory, called by ledger-orders, writes to shopapp-pg"). Then anything you weren't sure of and anything stale you left alone. If the drawing has an exported `.excalidraw.svg` next to it, re-run `export_drawing` so the two match.
