# Road to v1.0.0

The thesis: an interactive canvas where you keep using Excalidraw with AI in the loop, plus native file and project management, like an IDE for diagrams. You can reference a codebase and the diagrams together.

As of 0.1.1, the sync, assistant and MCP core work well. The "IDE" half is thin: drawings don't link to code, file management is just create and trash, there is no git awareness, and the agent can't render without opening the user's browser. Below is the gap list from a full review, grouped into workstreams. Each workstream ships on its own branch and is validated before it merges.

## WS1: Core correctness (scene, layout, ops)

- [x] Self-loop or coincident-centre arrows write NaN points to the file (`scene.ts` `boundaryPoint`). Draw a loop, and assert that coordinates are finite before applying.
- [x] `create_diagram replace:true` clears the drawing and lays it out in two writes, so a failed layout leaves an empty file. Make it one atomic op.
- [x] Moving a frame or a library-shape anchor leaves its children or group members behind. Move them by the same offset.
- [x] Unknown element types (`{type:"box"}`) are saved. Reject them with a "did you mean" error.
- [x] There is no way to bind an existing free arrow. Let `connect_elements` take an existing arrow `id` and re-route it, as the review skill expects.
- [x] Layout:
  - Long edges cut through intermediate ranks. Add dummy nodes or waypoints.
  - Group frames can overlap or enclose non-members.
  - Self-loops are dropped silently.
  - Parallel and opposite edges are drawn on top of each other.
- [x] A drawing with invalid JSON (for example git conflict markers) wedges every op with HTTP 500. Return a 422 with a clear message, and let `overwrite` recover it.
- [x] Deleted elements come back after a daemon restart if a stale tab saves them. Persist recent tombstones in a sidecar.
- [x] `layoutGraph` throws plain `Error`, which becomes a 500. Use `SceneError`.

## WS2: Daemon lifecycle and security

- [ ] An old daemon is silently reused after an upgrade. Compare versions in `ensure()` and restart it or refuse, and have `lfx status` flag the mismatch.
- [ ] MCP roots with spaces keep `%20` in the path. Use `fileURLToPath`.
- [ ] Secret refusal gaps:
  - `.git/config`, `.kube/config`, `.docker/config.json`, `*.tfvars`, `.envrc` and `.vault-token` aren't refused.
  - The Claude Code provider's Read/Grep/Glob bypass `isSecretFile`.
- [ ] A model-supplied regex can hang the daemon. Bound the work or run it with a timeout.
- [ ] Editor RPCs aren't rejected when their tab closes, so callers wait the full 30 s.
- [ ] Smaller fixes:
  - `lfx stop` prints "Stopped." even when the daemon is still running.
  - Token creation races with a concurrent reader.
  - `writeFileAtomic` doesn't fsync, leaves its temp file on failure, and resets permissions to 0644.
  - A malformed `%` escape in a static path returns 500.
  - The PNG export's temp file name isn't unique.
  - The 403 for a path outside the roots doesn't name the allowed roots.

## WS3: Headless rendering

- [x] Render, export and Mermaid need a browser tab, and with none open, a read-only `render_drawing` opens the user's browser. Add a headless editor: the daemon launches a local Chromium-family browser with `--headless` against itself, on demand. This is used for agents and CI, and keeps the user's browser from popping open. Make it configurable, and document the result.

## WS4: Agent skills, prompts and tools

- [ ] Rewrite the excalidraw skill, the review skill, `guide.ts`, the MCP server instructions and the assistant system prompt as one coherent set, drawing on prior art (yctimlin/mcp_excalidraw):
  - layout anti-patterns
  - a quality checklist after every batch
  - sizing rules
  - arrow-label discipline
  - zone labels as free text
  - an explicit "update existing diagram after a code change" workflow
  - error recovery
- [ ] New tools:
  - snapshots (`snapshot_drawing` / `restore_drawing`)
  - find elements by label (a `read_drawing` filter)
  - align and distribute
  - a batch `apply` (create + update + delete in one revision)
  - read-modify-write safety: `read_drawing` returns a revision, and writes take `if_rev`
- [ ] A convention for linking diagram nodes to code: `link: "src/foo.ts:42"`, which `read_drawing` shows and `create_diagram` nodes accept as `code`.
- [ ] Skill evals (`plugin/skills/*/evals/evals.json`) in the same shape as the prior art.
- [x] Diagram knowledge: an `architecture-diagrams` skill. It picks the diagram for the audience and question (C4, UML behaviour and structure, DFD and threat models, ER, infrastructure, messaging), and has per-topic reference files in `references/` that a future tool can serve to the in-app assistant.

## WS5: IDE for diagrams

- [x] Code links: clicking an element's code link opens the file at that line in the user's editor (`vscode://` or `$EDITOR`) instead of treating it as a URL.
- [x] Staleness: record the content hash of each linked file, show which nodes point at changed or missing code, and expose this to agents (`check_drawing` / in `read_drawing`).
- [x] File management: rename, duplicate, move and delete (to the system trash) drawings from the web UI.
- [x] MCP-agent edits go on the undo stack and are highlighted briefly so you can see what changed. Today only the in-app assistant's edits are undoable.
- [x] Revert reports when it was partial ("kept N you edited").
- [x] Git awareness: modified and untracked badges in the drawing list.
- [x] A shortcut to toggle the assistant in the web UI. Surface library load and save failures. Show a banner when offline.

## WS6: End-to-end tests, evals and CI

- [ ] Daemon integration tests over HTTP and WebSocket: Host/Origin checks, bearer-only endpoints, the no-editor 409, and MCP over stdio end to end.
- [ ] An eval harness that drives Claude Code (`claude -p`) against a fixture codebase through `lfx mcp` and the plugin skills, in an isolated daemon (its own port and state dir, headless rendering). Scenarios:
  1. Architecture diagram from a codebase
  2. Request-flow diagram for one path through the code
  3. Responding to a code change: apply a patch that adds a service, then ask for the diagram to be updated. Ids should be kept and only the delta drawn.
  4. Editing an existing diagram that has manual user edits, without destroying them
  5. A readability review of a deliberately messy drawing
  6. Mermaid conversion
  7. Code-linked nodes, then staleness after a change
- [ ] Graders:
  - Deterministic: expected component names present, arrows bound at both ends, no overlapping shapes, labels fit, ids preserved, no NaN.
  - An optional LLM judge on the rendered PNG.
- [ ] A results report, saved under `evals/results/`.
- [ ] GitHub Actions: typecheck, build and unit/integration tests on push. Evals stay manual, because they need a Claude login.

## WS7: Release

- [ ] CHANGELOG.
- [ ] Docs:
  - a troubleshooting page
  - a shortcuts reference
  - a "diagrams that reference code" guide
  - the revert caveats
- [ ] Sync the plugin.json version with package.json.
- [ ] Bump to 1.0.0.

## Later (post-1.0)

- Folder tree, recents, tabs or multiple windows in the macOS app
- Full-text search inside drawings
- Compare with HEAD (ghost and highlight diff view)
- `@file:10-40` and element-level mentions
- An in-app update check
- Pushing file-list changes over the WebSocket
