# Living diagrams: keeping drawings in step with the code

A diagram that disagrees with the code is worse than no diagram, because readers trust it. Most architecture diagrams rot because nothing connects them to the code they describe, and redrawing them is expensive. This project keeps drawings as `.excalidraw` files in the repo, so they can live with the code: reviewed in the same pull request, linked to the files they describe, and updated element by element.

## Principles

- **Docs as code.** Keep documentation in the repo as plain text, review it in pull requests, and build it in CI ([Write the Docs: docs as code](https://www.writethedocs.org/guide/docs-as-code/)). An `.excalidraw` file is JSON, so it diffs. Its `name.excalidraw.svg` export renders on GitHub and reopens for editing.
- **Living documentation.** Cyrille Martraire's *Living Documentation* (2019) argues for documentation that is close to the code, generated or checked from it where possible, and curated by hand only for what the code can't say (intent, trade-offs, the big picture).
- **Model, not picture.** Structurizr and C4 tooling separate the model (elements and relationships) from the views. Here, the stable element ids play the role of the model: the same id means the same thing across edits.
- **Few diagrams, kept current.** One context diagram and one container diagram that are accurate beat twenty stale ones. Draw component and code diagrams only where they earn their upkeep.

## Linking nodes to code

Give every node that documents code a code link to its source: `code: "src/orders/repo.ts"` or `code: "src/orders/repo.ts:42"` on a `create_diagram` node, an `add_elements` shape or an `update_elements` entry (`code: null` removes it). The element's `link` then holds the project-relative path with an optional `#L<line>` (`src/orders/repo.ts#L42`), and `customData.lfxCode` records the file's hash, so a later check can tell the code changed. `read_drawing` shows it as `code=src/orders/repo.ts#L42`. Use project-relative paths:

| Node kind | Link to |
|---|---|
| Component or module | The file or directory (`src/server/scene.ts`) |
| Class or state machine | The declaration (`src/orders/status.ts:12`) |
| Container | Its entry point or deploy manifest (`src/server/daemon.ts`, `deploy/api.yaml`) |
| Infrastructure | The IaC resource file (`infra/alb.tf`) |
| Topic or queue | Where it's declared (`config/kafka/topics.yaml`) |

Set them while drawing:

```json create_diagram
{
  "path": "docs/diagrams/server-modules",
  "nodes": [
    { "id": "daemon", "label": "daemon", "code": "src/server/daemon.ts" },
    { "id": "tools", "label": "tools", "code": "src/server/tools.ts" },
    { "id": "scene", "label": "scene", "code": "src/server/scene.ts" }
  ],
  "edges": [{ "from": "daemon", "to": "tools" }, { "from": "tools", "to": "scene" }]
}
```

A tool result that says a linked file "doesn't exist" means the path is wrong: fix it before you finish.

Use node ids that match the code (`daemon`, `scene`, `orders-db`), not `n1`, `n2`. Ids are stable across edits, so later updates and diffs stay readable.

## Where diagrams live

- Put drawings in `docs/diagrams/` (the default), named after what they show: `c4-container.excalidraw`, `checkout-sequence.excalidraw`.
- Embed the export in the doc that explains it, using `export_drawing` and the returned Markdown link. Never embed a screenshot: it can't be edited or diffed.
- Arrange docs around a template like arc42 when the project has one:
  - context in section 3
  - building blocks (container and component diagrams) in section 5
  - runtime (sequence and dynamic diagrams) in section 6
  - deployment in section 7

## Architecture decision records

An ADR records one significant decision: the context, the decision, its status and its consequences. It is short, numbered, and kept in the repo (Michael Nygard, [Documenting Architecture Decisions](https://cognitect.com/blog/2011/11/15/documenting-architecture-decisions), 2011). Superseded ADRs stay, marked as superseded. Diagrams and ADRs support each other:

- **An ADR that changes structure** (new service, new datastore, new boundary) embeds or links the before and after diagrams. Draw the "after" as an update to the existing diagram, not a fresh one.
- **The diagram links to the ADR** that introduced an element. Use a small text note near it ("see ADR-0007"), or set the element's `link` to the ADR when it has no code yet.
- **Proposed changes** can be drawn in the same diagram as dashed elements, with an `orange` stroke, a `[proposed]` tag in the label, and a legend entry. When the ADR is accepted, make them solid.
- ADRs are immutable history, but diagrams describe the present. Don't freeze diagrams inside old ADRs. Link to the living diagram and, if needed, export a dated snapshot.

## Updating a diagram after a code change

Use this when the user asks to "update the diagram for this change", or when you change code that a diagram documents.

1. **Find affected diagrams.** Run `list_drawings`, then `read_drawing` on each likely one. Search them for `code=` paths and labels that match the changed files, modules, endpoints, topics or tables: `read_drawing` with `query` (`"src/orders"`, `"ledger"`) lists just the matching elements and their arrows.
2. **Read the diff** (`git diff main...HEAD -- <paths>`, or the files the user names). List the architectural changes only:
   - an element added, removed or renamed
   - a relationship added, removed or changed (a new call, a new protocol, sync becoming async)
   - an element that moved boundary (a new service, a module moved packages)
   - a technology changed (Postgres to DynamoDB)

   Ignore internal refactors that don't change anything visible at the diagram's level.
3. **Map each change to an edit,** and keep everything else untouched. Take a `snapshot_drawing` first, then make the edits as one `apply_changes` call with the `rev` from `read_drawing` as `if_rev`, so the update is one revision and fails cleanly if the user edited the drawing meanwhile:

   | Code change | Drawing edit |
   |---|---|
   | Renamed module, service or topic | `update`: the label and `code`. Keep the id. |
   | New element | `add`: a shape with explicit x/y next to its neighbours from `read_drawing` (inside its frame's bounds if it belongs in one, with `frameId`; widen the frame with `update` if needed), the same size and colour as its siblings, its `code` link, and arrows bound with `start`/`end` |
   | Removed element | `delete`: the element and the arrows attached to it (they only detach otherwise) |
   | New or changed relationship | `add` an arrow bound at both ends, or `update` an existing one (`label`, `strokeStyle`). `connect_elements` re-binds an existing arrow to new ends. |
   | Technology change | `update` the `[Container: Tech]` line of the label |
   | Moved between boundaries | `update` its x/y into the new boundary and its `frameId` to the new frame (the label follows). |

4. **Don't recreate the drawing.** `create_diagram` with `replace: true` throws away the user's manual layout, annotations and colours. Use it only when the user asks to start over, or when most of the elements change.
5. **Render and check** the changed region with `render_drawing` `element_ids` (the changed ids plus their neighbours). Then apply the diagram-review rubric to that area.
6. **Report** what changed in the diagram, mapped to the code change. Mention anything in the diagram that already looked out of date but wasn't part of this change, and don't silently fix it.
7. If the diagram is exported for docs, re-run `export_drawing` so the `.excalidraw.svg` matches, and include both files in the same commit as the code change.

## Checks that keep diagrams honest

- **In code review,** a pull request that adds a service, datastore, topic or external dependency should touch the container diagram. A pull request that adds a trust-boundary crossing should touch the DFD.
- **Spot-check the links.** Every `code=` path in `read_drawing` should exist. A missing file means the diagram describes something that's gone.
- **Spot-check the names.** Every label that names a module, table or topic should be greppable in the repo.

## Common mistakes

- Redrawing from scratch on every change, which loses manual layout and makes diffs unreadable.
- Diagrams stored outside the repo (wikis, slide decks), where nobody updates them with the code.
- Screenshots in docs instead of the editable `.excalidraw.svg` export.
- Labels that paraphrase code names ("Order handler" for `CheckoutController`). Nobody can trace them.
- One huge diagram that every change touches. Smaller, focused diagrams go stale less.
