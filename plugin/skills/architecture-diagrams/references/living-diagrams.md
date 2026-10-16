# Living diagrams: keeping drawings in step with the code

A diagram that disagrees with the code is worse than no diagram, because readers trust it. Most architecture diagrams rot because nothing connects them to the code they describe, and redrawing them is expensive. This project keeps drawings as `.excalidraw` files in the repo, so they can live with the code: reviewed in the same pull request, linked to the files they describe, and updated element by element.

## Principles

- **Docs as code.** Keep documentation in the repo as plain text, review it in pull requests, and build it in CI ([Write the Docs: docs as code](https://www.writethedocs.org/guide/docs-as-code/)). An `.excalidraw` file is JSON, so it diffs. Its `name.excalidraw.svg` export renders on GitHub and reopens for editing.
- **Living documentation.** Cyrille Martraire's *Living Documentation* (2019) argues for documentation that is close to the code, generated or checked from it where possible, and curated by hand only for what the code can't say (intent, trade-offs, the big picture).
- **Model, not picture.** Structurizr and C4 tooling separate the model (elements and relationships) from the views. Here, the stable element ids play the role of the model: the same id means the same thing across edits.
- **Few diagrams, kept current.** One context diagram and one container diagram that are accurate beat twenty stale ones. Draw component and code diagrams only where they earn their upkeep.

## Linking nodes to code

Give every node that documents code a `link` to its source. `read_drawing` shows it as `link=…`, and Excalidraw shows it as a clickable link. Use project-relative paths, with an optional line number:

| Node kind | Link to |
|---|---|
| Component or module | The file or directory (`src/server/scene.ts`) |
| Class or state machine | The declaration (`src/orders/status.ts:12`) |
| Container | Its entry point or deploy manifest (`src/server/daemon.ts`, `deploy/api.yaml`) |
| Infrastructure | The IaC resource file (`infra/alb.tf`) |
| Topic or queue | Where it's declared (`config/kafka/topics.yaml`) |

`create_diagram` nodes don't take a link yet, so add the links right after drawing:

```json update_elements
{
  "path": "docs/diagrams/server-modules",
  "updates": [
    { "id": "daemon", "link": "src/server/daemon.ts" },
    { "id": "tools", "link": "src/server/tools.ts" },
    { "id": "scene", "link": "src/server/scene.ts" }
  ]
}
```

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

1. **Find affected diagrams.** Run `list_drawings`, then `read_drawing` on each likely one. Search the summaries for `link=` paths and labels that match the changed files, modules, endpoints, topics or tables.
2. **Read the diff** (`git diff main...HEAD -- <paths>`, or the files the user names). List the architectural changes only:
   - an element added, removed or renamed
   - a relationship added, removed or changed (a new call, a new protocol, sync becoming async)
   - an element that moved boundary (a new service, a module moved packages)
   - a technology changed (Postgres to DynamoDB)

   Ignore internal refactors that don't change anything visible at the diagram's level.
3. **Map each change to an edit,** and keep everything else untouched:

   | Code change | Drawing edit |
   |---|---|
   | Renamed module, service or topic | `update_elements` the label (and `link`). Keep the id. |
   | New element | `add_elements` with explicit x/y next to its neighbours from `read_drawing` (inside its frame's bounds if it belongs in one; widen the frame with `update_elements` if needed), then `connect_elements` its relationships |
   | Removed element | `delete_elements` (bound arrows detach, so delete them too) |
   | New or changed relationship | `connect_elements` with a label. Relabel or restyle an existing arrow with `update_elements` (`label`, `strokeStyle`). |
   | Technology change | Update the `[Container: Tech]` line of the label |
   | Moved between boundaries | Move it with `update_elements` x/y into the new boundary. Frame membership doesn't follow position, so check `read_drawing` (`in frame …`). If it's wrong, tell the user, who can drag it in. |

4. **Don't recreate the drawing.** `create_diagram` with `replace: true` throws away the user's manual layout, annotations and colours. Use it only when the user asks to start over, or when most of the elements change.
5. **Render and check** the changed region with `render_drawing` `element_ids` (the changed ids plus their neighbours). Then apply the diagram-review rubric to that area.
6. **Report** what changed in the diagram, mapped to the code change. Mention anything in the diagram that already looked out of date but wasn't part of this change, and don't silently fix it.
7. If the diagram is exported for docs, re-run `export_drawing` so the `.excalidraw.svg` matches, and include both files in the same commit as the code change.

## Checks that keep diagrams honest

- **In code review,** a pull request that adds a service, datastore, topic or external dependency should touch the container diagram. A pull request that adds a trust-boundary crossing should touch the DFD.
- **Spot-check the links.** Every `link=` path in `read_drawing` should exist. A missing file means the diagram describes something that's gone.
- **Spot-check the names.** Every label that names a module, table or topic should be greppable in the repo.

## Common mistakes

- Redrawing from scratch on every change, which loses manual layout and makes diffs unreadable.
- Diagrams stored outside the repo (wikis, slide decks), where nobody updates them with the code.
- Screenshots in docs instead of the editable `.excalidraw.svg` export.
- Labels that paraphrase code names ("Order handler" for `CheckoutController`). Nobody can trace them.
- One huge diagram that every change touches. Smaller, focused diagrams go stale less.
