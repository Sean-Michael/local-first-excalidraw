# Troubleshooting

Most problems show up as a message from `lfx`, the MCP server or the editor. This page lists the common ones, what causes them and what to do. Paths assume the default state directory, `~/.local-first-excalidraw` (`LFX_STATE_DIR` changes it).

## Logs

A daemon started in the background, by `lfx open`, an MCP client or the macOS app, writes its output to `~/.local-first-excalidraw/daemon.log`. A daemon you run with `lfx serve` writes to the terminal instead.

```bash
tail -n 50 ~/.local-first-excalidraw/daemon.log
```

`lfx status` prints the running daemon's version, process id, allowed roots, open editors, and the state of the headless browser (`headless.mode`, `browser`, `connected` and, after a failed launch, `failed`).

## The daemon won't start, or the port is in use

| Message | Cause and fix |
|---|---|
| ``Port 7467 is already in use (is the daemon already running? try `lfx status`).`` | `lfx serve` found something listening on the port. If `lfx status` shows a daemon, it's already running and you don't need another. Otherwise another program has the port: stop it, or pick another port with `LFX_PORT`. |
| `Port in use by something else at http://127.0.0.1:7467` | A client found a server on the port that isn't this daemon. Free the port or set `LFX_PORT` for every client and the daemon. |
| `Daemon failed to start; see …/daemon.log` | The background daemon didn't answer within about 6 seconds. The end of `daemon.log` says why. |
| `The daemon failed to start. See …/daemon.log` | The same, from the macOS app, which shows the end of the log under the message. **Try Again** retries. |
| `Daemon is still running (pid N); see …/daemon.log.` | `lfx stop` asked the daemon to exit and it was still answering five seconds later. Check the log, or end the process yourself with `kill N`. |

`LFX_PORT` and `LFX_STATE_DIR` must match between the daemon and its clients. A client with a different port starts a second daemon; one with a different state directory has a different token and can't authenticate.

## Version mismatch after an upgrade

Each client checks the daemon's version before using it.

- A daemon that an `lfx` command or an MCP client started on its own (marked with `LFX_ON_DEMAND`) is replaced by the next client of a newer version. You see `Replacing daemon v0.1.1 with v1.0.0.` and nothing else to do.
- Any other daemon, one you started with `lfx serve`, the macOS app's, or one newer than the client, isn't replaced. The client stops with a message such as ``Daemon v0.1.1 is running at http://127.0.0.1:7467, but this client is v1.0.0. Run `lfx stop` (or quit the app that started it) and try again.``

`lfx status` flags the same thing with `"versionMismatch": true` and `Version mismatch: daemon v…, client v…`. To fix it, stop the old daemon and let the next client start the new one:

```bash
lfx stop
```

If the macOS app is open and started the daemon, quit the app instead. If you turned on **Keep the daemon running after quitting**, quit the app and run `lfx stop`. The macOS app itself doesn't compare versions: it uses whatever daemon is already running, so stop an old one before opening a newly upgraded app.

Don't set `LFX_ON_DEMAND` yourself. It tells clients they may stop and replace the daemon.

## The sign-in link expired

The browser page says **Link expired**: "This sign-in link was already used or has expired." Sign-in links are single-use and valid for two minutes, so a link from scrollback, a reloaded tab or a link opened twice no longer works. Get a new one:

```bash
lfx open docs/diagrams/architecture.excalidraw
```

`lfx url` prints the link instead of opening a browser. **Sign in required** means the browser has no session, or its session has expired; the same commands fix it. The MCP server prints a fresh link, valid for two minutes, when it can't open a browser itself.

## Render, export or Mermaid fails

Rendering, exporting, Mermaid conversion and shape previews need a real browser. The daemon uses an open tab of the drawing, else a headless browser it starts itself ([Headless rendering](configuration.md#headless-rendering)).

| Message | Cause and fix |
|---|---|
| `No editor is open. … Headless rendering needs a Chromium-family browser: install Chrome/Chromium or set LFX_BROWSER.` | No Chrome, Chromium, Edge or Brave was found. Install one, or set `LFX_BROWSER` to its binary (for example `/Applications/Google Chrome.app/Contents/MacOS/Google Chrome`, or `chromium` on `PATH`). With `LFX_HEADLESS=off`, open the drawing in a tab first. |
| `No Chrome or Chromium found for headless rendering. Install Chrome/Chromium or set LFX_BROWSER.` | The same, with `LFX_HEADLESS=always`. |
| `The headless browser did not connect in time; see the daemon log` | The browser started but its page didn't connect within 30 seconds. The usual cause is an editor bundle older than the daemon: in a source checkout, run `npm run build`. |
| `The headless browser exited before it connected; see the daemon log` | The browser crashed or refused to start. `daemon.log` has its output (`Headless browser failed to start: …`). In containers and as root on Linux it runs with `--no-sandbox`; elsewhere, check that the binary in `LFX_BROWSER` runs. |
| `Headless rendering is unavailable: …` | A launch failed with `LFX_HEADLESS=always`. |

After a failed launch the daemon doesn't try headless again for five minutes. In that time `LFX_HEADLESS=auto` falls back to an open tab (or the MCP server opens your browser), and `lfx status` shows the reason under `headless.failed`. Restart the daemon to try again sooner.

`LFX_HEADLESS`, `LFX_BROWSER` and `LFX_HEADLESS_IDLE_MIN` are read by the daemon when it starts. Setting them for a client has no effect on a daemon that's already running: `lfx stop` it first, or for the macOS app's daemon, quit the app and start the daemon with `lfx serve` from a shell that has the variables.

Mermaid other than `flowchart` and `sequenceDiagram` converts to a single image, not editable shapes. That's expected; use `create_diagram` for those.

## "not valid Excalidraw JSON" after a merge conflict

A drawing that doesn't parse, most often because a merge left git conflict markers in it, is refused rather than overwritten:

```text
docs/diagrams/api.excalidraw is not valid Excalidraw JSON (merge conflict?): <the parser's error>. It has git conflict markers. Fix the file, or replace it with create_drawing overwrite: true.
```

MCP tools get this as HTTP 422, and the editor shows it in its error banner. To recover:

- Resolve the conflict in git, for example by taking one side (`git checkout --ours docs/diagrams/api.excalidraw` or `--theirs`) and redrawing what the other side added, then reload the tab. Excalidraw files are hard to merge by hand.
- Or have an agent replace the file with `create_drawing` and `overwrite: true`. That discards the file's contents, so do it only when you don't need them.

## Deleted elements come back

The daemon remembers recently deleted element ids in `tombstones.json` in the state directory, so a tab that was open before a restart can't bring deleted elements back when it saves. The record is limited:

- It covers deletions from the last 7 days, up to 2000 per drawing.
- It started with 1.0.0. Elements deleted under an older daemon aren't in it.
- Deleting the state directory, or using a different `LFX_STATE_DIR`, loses it.

If something you deleted reappears, delete it again and reload any other tab that has the drawing open. A tab that was open across a long disconnection is the usual source.

## Code links open the wrong editor

Clicking a code link runs the editor set by `LFX_EDITOR`, else the `editor` key in `~/.local-first-excalidraw/editor.json`, else VS Code. The full list of values is in [Opening code](projects.md#opening-code).

- The daemon reads `LFX_EDITOR` from its own environment, so changing it needs a daemon restart. `editor.json` is read on every click, so no restart is needed there: `{"editor": "zed"}`.
- A `code`, `cursor` or `zed` command that isn't on the daemon's `PATH` (or in `/usr/local/bin`, `/opt/homebrew/bin` or `/snap/bin`) falls back to the editor's URL scheme (`vscode://`, `cursor://`, `zed://`), which opens whichever app has registered it.
- `$EDITOR` must be a GUI editor; the daemon has no terminal. If neither `VISUAL` nor `EDITOR` is set in the daemon's environment, the click fails with `LFX_EDITOR is $EDITOR, but neither VISUAL nor EDITOR is set`.
- `Could not start …` means the configured command wasn't found or couldn't run.
- Links with a scheme (`https://…`) or an absolute path are ordinary links and open in the browser.

## The Claude Code assistant asks for `/login` (Bedrock, Vertex, proxies)

The assistant runs `claude` with the daemon's environment. If you set up Claude Code through environment variables (`CLAUDE_CODE_USE_BEDROCK`, `AWS_PROFILE`, `AWS_REGION`, `CLAUDE_CODE_USE_VERTEX`, `ANTHROPIC_BASE_URL`, …) and they're missing, `claude` falls back to Anthropic sign-in and reports that `/login` is required.

- Apps opened from Finder or the Dock don't get your shell's variables. To work around that, the macOS app runs your `$SHELL` once as an interactive login shell when it starts the daemon and copies the variables it exports. Anything in `~/.zprofile` or `~/.zshrc` should reach `claude`.
- An already-running daemon keeps the environment it started with. Quit the app, run `lfx stop` if you keep the daemon running, and open the app again.
- If your shell takes more than 5 seconds to start, the app gives up and uses its own environment; the system log shows `lfx: … took longer than 5s`. Put the variables in the `env` block of `~/.claude/settings.json` instead, where Claude Code reads them no matter how it was started.
- While the app reads your environment, `LFX_RESOLVING_SHELL_ENV=1` is set, so rc files can skip slow or interactive steps. `LFX_NO_SHELL_ENV=1` turns the lookup off.

## The MCP server can't see the project

The MCP server works in one project root: `--root DIR` or `LFX_PROJECT_ROOT` if set, else the first `file://` root the MCP client declares, else `$CLAUDE_PROJECT_DIR`, else its working directory. Relative paths and bare names resolve against it.

Signs that it picked the wrong one: `list_drawings` shows nothing or someone else's drawings, or a tool fails with `Path is outside the allowed roots: … Allowed roots: …`.

- Pass the root explicitly: `claude mcp add excalidraw -- lfx mcp --root /path/to/project`, or set `LFX_PROJECT_ROOT` in the client's MCP config.
- Clients that don't declare roots start the server in some other directory; `--root` fixes that too.
- The server registers its root with the daemon for the daemon's lifetime only. It registers it again automatically if the daemon restarted, so this error after a restart should clear on the next call.
- With `LFX_LOCK_ROOTS=1` (the Docker setup), extra roots are refused, so the project has to be inside one of `LFX_ROOTS`.

`lfx roots` lists the folders the daemon currently allows, and `lfx roots remove DIR` forgets one you added.

## Tracing shows nothing

Tracing is off unless the process has `OTEL_EXPORTER_OTLP_ENDPOINT` (or `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT`) or `LFX_TRACE_FILE` set. See [Tracing](tracing.md).

- The variables must be in the daemon's environment. A daemon already running ignores them; start it with `lfx serve` and the variables set. The macOS app's daemon doesn't see your shell's variables.
- Only http/protobuf OTLP is supported, not gRPC. Use the receiver's HTTP port (4318 for most collectors, 6006 for Phoenix).
- `OTEL_SDK_DISABLED=true`, or `OTEL_TRACES_EXPORTER=none` for the OTLP exporter, turns it off.
- When the assistant runs Claude Code, `OTEL_EXPORTER_OTLP_HEADERS` isn't passed to its `lfx mcp`, so if your receiver needs headers, the drawing tools in those replies aren't traced.
