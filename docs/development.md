# Development

Requires Node 20+. The macOS app also needs Xcode 15+.

## Build and test

```bash
npm ci
```

```bash
npm run build      # vite (editor) + tsc (daemon, MCP server, CLI)
npm test           # node:test unit tests
npm run typecheck
```

`npm run dev:web` runs Vite for the editor alone. To run the daemon from your checkout without touching your normal state, give it its own port and state directory:

```bash
LFX_PORT=7468 LFX_STATE_DIR=/tmp/lfx-dev node dist/src/server/cli.js serve
```

```bash
LFX_PORT=7468 LFX_STATE_DIR=/tmp/lfx-dev node dist/src/server/cli.js url docs/diagrams/architecture.excalidraw
```

## Layout

| Path | Contents |
|---|---|
| `src/server/` | Daemon, document store and merge, auto-layout, tool registry, MCP server, code search, libraries, security helpers, CLI |
| `src/server/ai/` | Assistant agent loop, providers, settings |
| `src/shared/` | Chat types and the JSONC parser, used by both server and page |
| `src/web/` | Editor, chat panel, settings, Shapes view, drawing list |
| `libraries/` | Built-in `.excalidrawlib` files and their manifest |
| `plugin/` | The Claude Code plugin: MCP config, skill, commands |
| `macos/` | SwiftUI app and its build script |
| `test/` | Unit tests |
| `docs/diagrams/` | The diagrams in these docs, as editable `.excalidraw` files |

[About the architecture](architecture.md) explains how the pieces fit.

## macOS app

```bash
macos/build-app.sh --install
```

This builds `build/Local Excalidraw.app` (Apple silicon, macOS 14+) with the `lfx` runtime bundled inside, and copies it to `/Applications`. Without `--install` it only builds.

## Releases

One-time setup:

1. Create a **Developer ID Application** certificate. In Xcode, go to Settings → Accounts → Manage Certificates → +. Only the team's Account Holder can do this.
2. Save notarization credentials:

   ```bash
   xcrun notarytool store-credentials lfx-notary --apple-id <you> --team-id <TEAMID>
   ```

For each release, bump the version (`npm version patch --no-git-tag-version`), commit it to `main`, and run:

```bash
SIGN_IDENTITY="Developer ID Application: <Name> (<TEAMID>)" NOTARY_PROFILE=lfx-notary macos/build-app.sh --release --publish
```

The script checks the certificate, the notary profile and the git state before building. It signs with hardened runtime, notarizes and staples the app, and creates the GitHub release `v<version>` with the zip. Then it writes the new sha256 into `Casks/local-first-excalidraw.rb` and pushes that commit.

Without `--publish`, it stops after writing the zip and updating the cask. Without the two variables, the build is ad-hoc signed and only suitable for your own Mac.

## Regenerating the screenshots and diagrams

The diagrams in `docs/diagrams/` are ordinary drawings. Edit them in the app or through `lfx mcp`, then export each with the `export_drawing` tool (format `svg`) so the `.excalidraw.svg` next to it stays in sync.
