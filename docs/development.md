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

For each release, move the `unreleased` entries in [CHANGELOG.md](../CHANGELOG.md) under the new version and date, bump the version (`npm version patch --no-git-tag-version`) and the plugin's version in `plugin/.claude-plugin/plugin.json`, commit it to `main`, and push. The Release workflow (below) takes it from there. To release from your Mac instead, run:

```bash
SIGN_IDENTITY="Developer ID Application: <Name> (<TEAMID>)" NOTARY_PROFILE=lfx-notary macos/build-app.sh --release --publish
```

The script checks the certificate, the notary profile and the git state before building. It signs with hardened runtime, notarizes and staples the app, and creates the GitHub release `v<version>` with the zip. Then it writes the new sha256 into `Casks/local-first-excalidraw.rb` and pushes that commit.

Without `--publish`, it stops after writing the zip and updating the cask. Without the two variables, the build is ad-hoc signed and only suitable for your own Mac.

### Releasing from GitHub Actions

The **Release** workflow does the whole release by itself. When a push to `main` changes `package.json` to a version that has no GitHub release yet, it runs the typecheck and tests on a macOS runner, signs and notarizes the app, and runs `macos/build-app.sh --release --publish`. So a release is: update the changelog, bump the version in `package.json` and `plugin/.claude-plugin/plugin.json`, and push. Pushes that leave the version alone, or that change it to one that's already released, don't start a build.

You can also start it from **Actions → Release → Run workflow** on `main`. With **publish** unchecked, it builds, signs and notarizes but publishes nothing, and keeps the zip as a workflow artifact. That run is a safe way to check the secrets.

The secrets live in the `release` environment (**Settings → Environments → release**), which only `main` can use. The IDs are repository variables (**Settings → Secrets and variables → Actions → Variables**):

| Name | Where | Value |
|---|---|---|
| `APPLE_TEAM_ID` | repository variable | The 10-character Apple team ID in the certificate name |
| `APPSTORE_KEY_ID` | repository variable | The App Store Connect API key's ID (the `XXXXXXXXXX` in `AuthKey_XXXXXXXXXX.p8`) |
| `APPSTORE_ISSUER_ID` | repository variable | The issuer ID shown above the key list in App Store Connect → Users and Access → Integrations |
| `MACOS_CERT_P12` | `release` environment secret | The Developer ID Application certificate and its private key, exported from Keychain Access as `.p12`, base64-encoded |
| `MACOS_CERT_PASSWORD` | `release` environment secret | The password you set when exporting the `.p12` |
| `APPSTORE_API_KEY` | `release` environment secret | The contents of `AuthKey_<APPSTORE_KEY_ID>.p8`. The key needs the Developer role or higher |

To export the certificate, open Keychain Access, find **Developer ID Application: …** in the login keychain, expand it so its private key is selected too, and choose **Export** as `.p12`. Then set the secrets from a terminal:

```bash
base64 -i Certificates.p12 | gh secret set MACOS_CERT_P12 --env release
```

```bash
gh secret set MACOS_CERT_PASSWORD --env release
```

```bash
gh secret set APPSTORE_API_KEY --env release < ~/.appstoreconnect/private_keys/AuthKey_<APPSTORE_KEY_ID>.p8
```

The workflow picks the `Developer ID Application: … (<APPLE_TEAM_ID>)` identity from the certificate. It commits the cask update as the user who pushed the version bump, and pushes it with the workflow's token, which doesn't start another run. If `main` is protected, allow GitHub Actions to push to it.

## Regenerating the screenshots and diagrams

The diagrams in `docs/diagrams/` are ordinary drawings. Edit them in the app or through `lfx mcp`, then export each with the `export_drawing` tool (format `svg`) so the `.excalidraw.svg` next to it stays in sync.
