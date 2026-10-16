# Drawings, projects and code

Drawings are `.excalidraw` files inside your project. This page covers managing them from the editor, and linking drawings to the code they describe.

## Managing drawings and projects

### The sidebar

The editor has a sidebar of drawings on the left, organised by your project's real folders, like a code editor's file explorer. It shows one tree per root (each folder you added, or the project an agent registered); a root inside another root shows once, inside the outer one. Folders appear when they contain drawings. Empty folders you made with **New folder…** appear too, so you can fill them. Other folders, such as `src/`, stay hidden until you press the folder button next to the filter, which shows every folder.

- ⌘B (Ctrl+B) or the sidebar button shows and hides it. Drag its right edge to resize it. The width, whether it's open, which folders are expanded and the folder toggle are remembered in the browser.
- **Recent** at the top lists the last 8 drawings you opened.
- The filter matches the drawing's name and its folders below the root, so `flows` finds every drawing in a `flows/` folder.
- The open drawing is highlighted, and its folders expand to show it.
- Click a drawing to open it. Switching drawings this way keeps the sidebar and the assistant panel; the assistant switches to the new drawing's chats. Back and forward work as usual.
- Drag a drawing onto a folder or root to move it there.
- The tree updates by itself when drawings are created, renamed, moved or deleted, whether by you, an agent, git or the Finder.

The drawing list (**All drawings** in the editor menu, the **Drawings** title in the sidebar, or the daemon's home page) shows the same tree full width, with each drawing's last change, and a form to create a drawing.

### Actions

Right-click a row, or use its `⋯` button, for these. The editor menu has the drawing ones for the open drawing.

| Action | On | What happens |
|---|---|---|
| New drawing | The form on the drawing list, or **New drawing here…** on a folder | Creates `name.excalidraw` there and opens it. `sub/dir/name` creates the folders too. |
| New folder… | A folder or root | Creates a folder inside it. `a/b` creates nested folders. |
| Rename… (F2) | A drawing | Renames the file in place. A tab that has the drawing open follows it to the new name. |
| Rename folder… (F2) | A folder (not a root) | Renames the folder. Tabs with drawings inside it open follow them. |
| Duplicate | A drawing | Copies it next to itself as `name copy.excalidraw` (then `name copy 2`, and so on) and opens the copy. |
| Move to folder… | A drawing | Moves it to another root or a folder under one. Open tabs follow it. Dragging does the same. |
| Reveal in Finder | A drawing or folder (macOS) | Shows it in the Finder. |
| Move to trash | A drawing | Moves the file to the system trash: `~/.Trash` on macOS, and `gio trash` or the XDG trash (`~/.local/share/Trash`) on Linux, so you can restore it from there. A tab that had it open shows **Restore it**, which writes it back. |

Names are refused if they would replace an existing file or leave the allowed roots. Set `LFX_TRASH_DIR` to send deleted drawings to a folder of your choosing instead (useful in containers, which have no system trash).

### How the tree stays current

The daemon tells open tabs (over their WebSocket) and the macOS app (over `GET /api/events`, a server-sent event stream) when the set of drawings and folders changes. It looks only while something is listening: on macOS and Windows with a recursive file watch on each root, and on Linux with a bounded rescan every 2 seconds, plus a rescan after every rename, move, trash and new drawing it makes itself. Edits to an existing drawing don't count as a change to the set.

### macOS app

The app's sidebar is a native folder tree with the same grouping: roots as sections, folders as disclosure groups, the filter in the search field. A drawing's context menu has **Rename…**, **Duplicate**, **Move To**, **Move to Trash** and **Show in Finder**; a folder's has **New Drawing Here…**, **New Folder…**, **Rename Folder…** and **Show in Finder**. The editor inside the app hides the web sidebar.

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
