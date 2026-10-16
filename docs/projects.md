# Drawings, projects and code

Drawings are `.excalidraw` files inside your project. This page covers managing them from the editor, and linking drawings to the code they describe.

## Managing drawings and projects

The drawing list (**All drawings** in the editor menu, or the daemon's home page) shows every drawing under the allowed roots, newest first.

| Action | Where | What happens |
|---|---|---|
| New drawing | The form at the top | Creates `name.excalidraw` in the chosen root. `sub/dir/name` creates the folders too. |
| New folder | The form at the top | Creates a folder in the chosen root, for **Move to folder**. |
| Rename | `⋯` on a row, or the editor menu | Renames the file in place. A tab that has the drawing open follows it to the new name. |
| Duplicate | `⋯` on a row, or the editor menu | Copies it next to itself as `name copy.excalidraw` (then `name copy 2`, and so on). From the editor, the copy opens in a new tab. |
| Move to folder | `⋯` on a row, or the editor menu | Moves it to another root or a folder under one. Open tabs follow it. |
| Move to trash | `⋯` on a row, or the editor menu | Moves the file to the system trash: `~/.Trash` on macOS, and `gio trash` or the XDG trash (`~/.local/share/Trash`) on Linux, so you can restore it from there. A tab that had it open shows **Restore it**, which writes it back. |

Names are refused if they would replace an existing file or leave the allowed roots. Set `LFX_TRASH_DIR` to send deleted drawings to a folder of your choosing instead (useful in containers, which have no system trash).

The macOS app's sidebar has **Rename…** and **Duplicate** in each drawing's context menu, next to **Move to Trash**.

### Git badges

When a root is inside a git repository, each drawing that differs from the last commit has a badge:

| Badge | Meaning |
|---|---|
| **M** | Modified since the last commit |
| **U** | Untracked: not in git yet |
| **S** | Staged for the next commit |
| **C** | Merge conflict |

The list asks git (`git status --porcelain`, with a 3 second time limit) when it opens, when the window regains focus, and every 10 seconds while it is visible. Without git, or outside a repository, there are no badges.

## Diagrams that reference code

Any element can point at a file in the project. Set its link (select it, then the link button or ⌘K) to a path relative to the project root, with an optional line:

```text
src/orders/repo.ts
src/orders/repo.ts#L42
src/orders/repo.ts:42
```

The project root is the git repository the drawing is in, or else the allowed root that contains it. Links with a scheme (`https://…`) or an absolute path stay ordinary links.

### Opening code

Hovering the link icon shows the path. Clicking it opens the file at that line in your code editor instead of a browser tab. The daemon refuses paths outside the project and files that look like secrets (`.env`, keys, credentials), the same rules the assistant's file tools follow.

The editor comes from `LFX_EDITOR`, else the `editor` key of `~/.local-first-excalidraw/editor.json` (`{"editor": "zed"}`), else VS Code:

| Value | Runs |
|---|---|
| `vscode` (default) | `code -g file:line`, or opens `vscode://file/…` when `code` isn't on `PATH` |
| `cursor` | `cursor -g file:line`, or `cursor://file/…` |
| `zed` | `zed file:line`, or `zed://file/…` |
| `idea`, `webstorm`, `pycharm`, `goland`, `jetbrains`, … | `idea --line N file` (the JetBrains launcher of that name) |
| `$EDITOR` | `$VISUAL` or `$EDITOR` with `+line file`. It must be a GUI editor: the daemon has no terminal. |
| A command with `{file}` and `{line}` | That command, split on spaces and run without a shell, for example `subl {file}:{line}` |
| Any other word | That command with `file:line` |

The daemon reads `LFX_EDITOR` from its own environment, and the macOS app starts the daemon without your shell's variables, so with the app use `editor.json`. It is read on every click. If a link opens the wrong editor, see [Troubleshooting](troubleshooting.md#code-links-open-the-wrong-editor).

### Staleness

When a code link is made, by you in the editor, by the assistant or by an MCP agent, the daemon records the linked file's content hash in the element (`customData.lfxCode`). Later checks compare the file with that hash:

| State | Meaning |
|---|---|
| ok | The file is unchanged since the link was made or last reviewed |
| changed | The file has changed |
| missing | The file is gone, or the line is past its end |
| unknown | The file didn't exist when the link was made, so there's nothing to compare |

The editor's top bar shows **3 links changed** (or missing) when any are stale, and checks again every 10 seconds and on focus. Click it to select those elements and bring them into view. Once the diagram matches the code again, the ✓ button next to it marks them as reviewed, which records the files' current hashes.

Agents see the same thing. `read_drawing` ends with a line such as `2 code links: 1 ok, 1 changed.` and lists the stale ones, and the `check_code_links` MCP tool reports every link. Called with `mark_reviewed: true` (optionally for some `ids`), it records the current hashes after the agent has updated the diagram.

## Agent edits in the editor

Edits from MCP agents (Claude Code, Cursor and others) and from the in-app assistant go on the canvas undo stack, so ⌘Z takes them back. When an agent changes a drawing you have open, the changed elements glow for a moment and a toast says, for example, **Claude Code edited 3 elements**, with **Select** to select them.

## Shortcuts and status

- ⇧⌘A (Ctrl+Shift+A elsewhere) shows or hides the assistant. [Keyboard shortcuts](shortcuts.md) lists the rest.
- The dot by the drawing's name is green while the tab is connected to the daemon. After 3 seconds without a connection, a banner says so; edits stay in the tab and are saved when it reconnects.
- Errors appear in a banner with a **Dismiss** button. Failures to load or save your personal shape library appear as a toast.
