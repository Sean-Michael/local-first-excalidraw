# Development

Requires Node 20+. The macOS app also needs Xcode 15+.

## Build and test

```bash
npm ci
```

```bash
npm run build      # vite (editor) + tsc (daemon, MCP server, CLI)
npm test           # node:test unit and integration tests
npm run typecheck
```

The headless rendering tests start a daemon on a random port with temporary state and render through Chrome or Chromium. They need `npm run build` first (for the editor bundle) and skip themselves, with a note, when no browser is found; set `LFX_BROWSER` to point at one.

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
| `plugin/` | The Claude Code plugin: MCP config, skills (with their references and evals), commands |
| `macos/` | SwiftUI app and its build script |
| `test/` | Unit tests, and integration tests (`daemon.test.ts`) that start a real daemon on a random port with a temporary state directory |
| `evals/` | Eval harness, scenarios and fixture project ([Evals](evals.md)) |
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

For each release, move the `unreleased` entries in [CHANGELOG.md](../CHANGELOG.md) under the new version and date, bump the version (`npm version patch --no-git-tag-version`) and the plugin's version in `plugin/.claude-plugin/plugin.json`, commit it to `main`, and run:

```bash
SIGN_IDENTITY="Developer ID Application: <Name> (<TEAMID>)" NOTARY_PROFILE=lfx-notary macos/build-app.sh --release --publish
```

The script checks the certificate, the notary profile and the git state before building. It signs with hardened runtime, notarizes and staples the app, and creates the GitHub release `v<version>` with the zip. Then it writes the new sha256 into `Casks/local-first-excalidraw.rb` and pushes that commit.

Without `--publish`, it stops after writing the zip and updating the cask. Without the two variables, the build is ad-hoc signed and only suitable for your own Mac.

### Releasing from GitHub Actions

The **Release** workflow runs the same script on a macOS runner. It runs the typecheck and tests, imports the certificate into a throwaway keychain, and saves the notary profile. Then it runs `macos/build-app.sh --release --publish`. Start it from **Actions → Release → Run workflow** on `main`, after the changelog and version commit is pushed. With **publish** unchecked, it builds, signs and notarizes but publishes nothing, and keeps the zip as a workflow artifact. That run is a safe way to check the secrets.

It needs one repository variable and four secrets (**Settings → Secrets and variables → Actions**):

| Name | Kind | Value |
|---|---|---|
| `APPLE_TEAM_ID` | variable | Your 10-character Apple team ID |
| `MACOS_CERT_P12` | secret | The Developer ID Application certificate and its private key, exported from Keychain Access as `.p12` and base64-encoded: `base64 -i cert.p12 \| pbcopy` |
| `MACOS_CERT_PASSWORD` | secret | The password you set when exporting the `.p12` |
| `APPLE_ID` | secret | The Apple ID email used for notarization |
| `APPLE_APP_PASSWORD` | secret | An app-specific password for that Apple ID, from [account.apple.com](https://account.apple.com) → Sign-In and Security → App-Specific Passwords |

The workflow picks the `Developer ID Application: … (<APPLE_TEAM_ID>)` identity from the certificate. It commits the cask update as the user who started the run and pushes it with the workflow's token. If `main` is protected, allow GitHub Actions to push to it.

## Regenerating the screenshots and diagrams

The diagrams in `docs/diagrams/` are ordinary drawings. Edit them in the app or through `lfx mcp`, then export each with the `export_drawing` tool (format `svg`) so the `.excalidraw.svg` next to it stays in sync.
