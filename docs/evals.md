# Evals

The eval harness measures how well Claude Code, with this project's MCP server and plugin skills, does real diagramming work against a codebase: drawing an architecture, tracing a request, keeping a diagram current after a code change, adding to a drawing without undoing the user's edits, and cleaning up a messy drawing.

Each run drives `claude -p` against a fresh copy of a fixture project and grades the drawing it leaves behind. Runs cost money (they use your Claude Code login), so they are manual and not part of `npm test`.

## Running

```bash
npm run build                                  # the daemon serves the editor from dist/web
npm run evals -- --list                        # scenario ids
npm run evals -- --scenario arch-overview      # one scenario, one run
npm run evals -- --scenario arch-overview,mermaid --runs 3 --model sonnet
npm run evals                                  # everything (expensive)
```

| Option | Meaning |
|---|---|
| `--scenario ID[,ID]` | Only these scenarios. Repeatable. Default: all |
| `--via claude\|assistant` | Who does the work: `claude -p` over MCP with the plugin (default), or the daemon's in-app assistant ([below](#via-the-in-app-assistant)) |
| `--model NAME` | Passed to `claude --model` (or set as the assistant endpoint's model). Default: Claude Code's own choice |
| `--runs N` | Runs per scenario (default 1). Models vary from run to run, so compare several |
| `--judge` | Also render the result to PNG and have a second `claude -p` score it (see below) |
| `--timeout SEC` | Per-run limit (default: the scenario's `timeoutSec`, else 900) |
| `--max-budget-usd N` | Passed to `claude`: stop a run once it has spent this much |
| `--out DIR` | Where results go (default `evals/results/<timestamp>/`) |
| `--keep` | Keep each run's temporary project and daemon state, for poking at afterwards |
| `--regrade DIR` | Re-grade saved results with the current graders, without running the agent |

`npm run evals` exits non-zero when any run fails a check. Set `CLAUDE_BIN` to use a different `claude` executable.

## What a run does

1. Copies `evals/fixtures/<fixture>/` to a temporary directory, runs `git init` and commits it.
2. Starts its own daemon with a random `LFX_PORT` (20000-40000), a temporary `LFX_STATE_DIR`, `LFX_NO_BROWSER=1` and `LFX_HEADLESS=always`. It never touches your normal daemon or state.
3. Runs the scenario's `setup` steps against that daemon. These are the same operations the MCP tools use (`diagram`, `add`, `update`, plus `move` for a user dragging an element), so starting drawings are made by the tools rather than written by hand. The drawings are committed, and a snapshot is kept as the baseline.
4. Applies and commits the scenario's `patch` from `evals/fixtures/<fixture>.patches/`, if it has one.
5. Runs Claude Code in the project:

   ```
   claude -p "<prompt>" --output-format stream-json --verbose
     --mcp-config <tmp>/mcp.json --strict-mcp-config
     --plugin-dir <tmp>/plugin --setting-sources project
     --permission-mode dontAsk --allowedTools mcp__excalidraw Read Grep Glob Skill TodoWrite "Bash(git log:*)" …
     --no-session-persistence [--model X]
   ```

   The MCP config starts `node dist/src/server/cli.js mcp --root <project>` with the same isolated environment. The plugin is a copy of `plugin/` without its `.mcp.json`, so only the isolated server is configured. `--setting-sources project` keeps your own settings, hooks and plugins out of the run. Anything not on the allowed list (file edits, other shell commands) is denied, and the denials are recorded.
6. Grades the drawing (the scenario's `drawing`, or else the most recently changed `.excalidraw` file), stops the daemon and deletes the temporary directory.

### Via the in-app assistant

`--via assistant` tests the in-app assistant's path instead: its system prompt, its context block (mentions, linked code) and the tools it gets. Steps 1 to 4 are the same. Then:

5. Before the daemon starts, the harness writes its `ai.json`: the assistant on, project file access on, and one Claude Code endpoint (which uses your `claude` login, with `--model` as its model). The daemon also writes a trace (`LFX_TRACE_FILE`) to the run's directory.
6. The harness connects to the daemon's WebSocket as an editor tab would (bearer token, same-origin `Origin`), opens the scenario's `drawing` (or `docs/diagrams/<scenario>.excalidraw`), and sends the prompt as a chat message. It records every chat event in `transcript.jsonl` and waits for the turn to end, stopping it after the time limit.
7. The drawing is graded the same way. Tool counts come from the chat events (drawing and code tools count as MCP tools); cost and turns come from the turn's span in `trace.jsonl`.

```bash
npm run evals -- --via assistant --scenario arch-overview,code-change-update --runs 1
```

The plugin's skills and commands aren't loaded in this mode; the assistant's own system prompt and `excalidraw_guide` take their place. Tests for the assistant's tool loop with other endpoints (Ollama, OpenAI-compatible, Anthropic) use a scripted fake model instead of a real one; see `test/code-search.test.ts`.

Rendering (`render_drawing`, `export_drawing`) and Mermaid conversion need an editor tab, or headless rendering where the daemon supports it (`LFX_HEADLESS`). Without either, those tool calls fail. The failures show up as tool errors in the report, and the agent has to manage without them.

## Scenarios

They live in `evals/scenarios.json`. Each has the common skill-eval fields (`prompt`, `expected_output`, `files`) plus what the harness needs: `fixture`, `setup`, `patch`, `drawing` and `checks`. `graphs` holds the reference diagram that setup steps draw.

| Id | Tests |
|---|---|
| `arch-overview` | Architecture diagram from the code, with the real service names and calls |
| `c4-container` | A C4 container diagram: a person outside a frame for the system boundary, containers labelled with their technology, external systems outside |
| `request-flow` | The place-order path, from the gateway to the confirmation email, including the declined-card branch |
| `code-change-update` | After a commit adds `stockroom-inventory`: the existing diagram gains the node and its edges, and keeps at least 80% of its ids |
| `sync-after-change` | The same commit, driven by the `/excalidraw:sync` command on a diagram with code links: the new node is linked to its source and 90% of ids are kept |
| `code-change-remove` | After Redis is replaced by an in-memory cache: Redis is gone and every node's code link points at a file that exists |
| `code-change-webhook` | After a Paylode webhook endpoint is added: an edge from Paylode back into the system |
| `preserve-manual-edits` | Adding a node to a drawing the user has moved, recoloured and annotated by hand, without undoing any of it |
| `readability-review` | A deliberately messy drawing (overlaps, unbound arrows, 8px text, overflowing labels) given to the diagram-review skill |
| `mermaid` | Converting a Mermaid flowchart: nodes, edge directions, bound arrows |
| `code-links` | Architecture whose nodes link to the files that implement them |
| `reference-code-mention` | `@services/ledger-orders/ Explain and diagram how an order's payment status changes`: a state diagram with the real statuses (pending, paid, payment_failed) and none the code doesn't have |
| `discover-containers` | The architecture-discovery skill: a container diagram built from a model of the code, with shared packages kept as libraries and every element linked to the file that proves it |
| `discover-component-scope` | A component diagram of ledger-orders that stays inside that one container |
| `review-architecture` | The architecture-review skill on the reference diagram: red severity notes for single points of failure and the queue consumer's endless requeue, with every original element left exactly where it was |
| `review-trust-boundaries` | A security-focused review: a note on the trusted `x-user-id` header, again without moving the user's elements |

The fixture, `evals/fixtures/shopapp/`, is a small TypeScript shop: `turnstile-gateway`, `keymaster-auth`, `ledger-orders` (with the `PaylodeClient` for an external card processor and an `OrderRepository` over Postgres `shopapp-pg`), `courier-worker` consuming the `order-events` queue on `postbox-mq` and mailing through Pigeonpost, Redis `token-cache`, all wired in `docker-compose.yml`. The names are unusual on purpose, so a check for them shows that the agent read the code and didn't guess.

The `evals/evals.json` file in each skill folder under `plugin/skills/` holds the same scenarios in the plain skill-eval shape. After editing `scenarios.json`, regenerate them with `npm run evals:skills`. A unit test fails if they drift.

## Checks

The graders in `evals/grade.ts` are deterministic and read only the `.excalidraw` JSON. Label matching ignores case, punctuation and camelCase, and accepts any of a list of synonyms.

| Check | Passes when |
|---|---|
| `finite` | No element has a NaN or infinite coordinate, size or point. Always on |
| `required-labels` | Each synonym list matches some text (bound labels, free text, frame names) |
| `required-frames` | Each synonym list matches the name of some frame (a system or trust boundary) |
| `forbidden-labels` | None of these match any text |
| `required-edges` | For each edge, an arrow is bound from an element whose label matches `from` to one matching `to`. `undirected` and double-headed arrows match either way. Library icons are named by their caption |
| `min-shapes`, `min-arrows` | At least this many shapes or arrows |
| `bound-arrows` | At least this share of arrows are bound at both ends |
| `overlaps` | At most this many colliding pairs: shapes that partly overlap, free text crossing a shape's edge, or free text on free text. A shape entirely inside another counts as a container, and parts of one group (a library icon) don't count |
| `text-fit` | At most this many labels whose estimated size is bigger than their container's usable area (about 70% of an ellipse, half a diamond) |
| `min-font` | The smallest text is at least this size |
| `id-preservation` | At least this share of the baseline's shapes, arrows, frames and free text still exist with the same ids. Catches "redrew it from scratch" |
| `user-edits` | The listed baseline elements still exist with the listed properties unchanged (1px tolerance on numbers), and the listed texts are still there |
| `links` | At least `minLinked` elements link to files in the project (relative, absolute, `file://` or `vscode://file/`, with an optional `#L12` or `:12`), and with `allExist`, none link anywhere else |
| `improves` | The chosen metrics (overlaps, bound-arrow share, smallest font, overflow) are better than the baseline's, or already perfect |

`text-fit` uses a label's stored size when it was measured with real fonts (by the editor or the Mermaid converter). Labels at exactly the width the server clamps to (the container's width minus 20) are estimated with the metrics the server uses for layout, which run wide for the hand-drawn font, so `text-fit` errs towards reporting an overflow.

### LLM judge

With `--judge`, the harness renders the final drawing to PNG through the run's daemon and asks a separate `claude -p` (allowed only the Read tool) to score readability and correctness from 1 to 5 against `expected_output`, replying in JSON. Along with the picture it gets the drawing's text listing (`final-listing.txt`, the `read_drawing` summary), so it can check code links and which shapes each arrow connects, which the image can't show. It is told that ids are checked by the deterministic graders. The judge's score is reported but doesn't affect pass/fail. If rendering isn't available, the judge is skipped and the report says why.

## Reading results

Each invocation writes `evals/results/<timestamp>/` (ignored by git):

| File | Contents |
|---|---|
| `summary.md` | One table row per run (pass/fail, score, failed checks, tool calls, tool errors, turns, cost, time, judge), then the detail of every check, the tools and skills used, tool errors and permission denials |
| `<scenario>-<n>/result.json` | Everything in the summary for that run, plus the full grade and metrics |
| `<scenario>-<n>/transcript.jsonl` | Claude Code's stream-json transcript |
| `<scenario>-<n>/command.json` | The exact `claude` arguments |
| `<scenario>-<n>/baseline.excalidraw`, `final.excalidraw` | The graded drawing before and after. Open them with `lfx open` |
| `<scenario>-<n>/drawings/` | Every drawing in the project after the run |
| `<scenario>-<n>/daemon.log` | The isolated daemon's log |
| `<scenario>-<n>/final.png`, `judge.jsonl` | With `--judge` |

The score is the share of checks passed. A run passes only if every check passes. When a check looks wrong rather than the agent, fix the grader and use `--regrade` on the saved results instead of paying for new runs.

## Adding a scenario

1. Add an entry to `evals/scenarios.json`. Name real identifiers from the fixture in `requiredLabels` and `requiredEdges`, and keep synonyms specific enough that they can't match by accident.
2. For a code change, make the change in a copy of the fixture and save it as a git-style patch in `evals/fixtures/shopapp.patches/` (paths prefixed `a/` and `b/`, new files from `/dev/null`).
3. Run `npm run evals:skills` and `npm test`. The tests check that patches apply and that the reference graph passes `arch-overview`'s checks.
4. Run the new scenario once to see that the checks pass for a good answer and fail for a bad one.
