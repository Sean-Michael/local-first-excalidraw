# Security model

The threats considered are malicious websites in your normal browser (CSRF, DNS rebinding, cross-site WebSocket hijacking), other users or processes on the machine, other hosts on your LAN, supply-chain or CDN compromise at runtime, and data leaving through the editor.

Out of scope: someone already running code as your user. They can read the token, just as they can read your drawings.

## Network

The daemon binds to loopback only (`127.0.0.1`). Requests whose `Host` isn't `localhost`, `127.0.0.1` or `[::1]` on the configured port are rejected, which stops DNS rebinding. Any request with a foreign `Origin` is rejected, and WebSocket upgrades require a same-origin `Origin`.

## Authentication

Local clients (the MCP server and the CLI) use a 256-bit bearer token in `~/.local-first-excalidraw/token` (mode 0600). Browsers get a single-use login code valid for two minutes, exchanged for an `HttpOnly; SameSite=Strict` session cookie. The token never appears in URLs.

Root registration, the agent operations API, login-code minting and shutdown accept only the bearer token. A browser session can't reach them.

## Filesystem

The daemon reads and writes only `*.excalidraw` files, and only under `~/Excalidraw` plus project roots that local clients register. Paths are canonicalised with `realpath`, so `..` and symlink escapes are refused. Registering `/` is refused. Exports are confined to the project root. Daemon state lives in `~/.local-first-excalidraw` (directory 0700, files 0600).

## Browser

The page runs under `default-src 'none'`. Scripts, styles, fonts and connections are allowed from `'self'` only, plus `'wasm-unsafe-eval'` for Excalidraw's font subsetting. `frame-src 'none'`, `frame-ancestors 'none'`, `no-referrer`, and same-origin COOP and CORP are set, and embeds are disabled. Excalidraw's built-in AI features, which call excalidraw.com, are off.

Editor code and fonts are bundled. The build strips Excalidraw's CDN fallback and fails if any CDN URL survives.

Links in Excalidraw's Help dialog and the library catalog open external sites, but only when you click them. Installing a library from the catalog is the only download the app makes.

## Assistant

The assistant is off by default. Model requests come from the daemon, never the page. API keys are write-only from the page, and changing an endpoint's URL drops its stored key so a key can't be redirected to another host.

The `claude` binary is found on `PATH` (or `LFX_CLAUDE_BIN`) and can't be set from the page, since that would let the page choose what to execute. Claude Code runs with `--restricted`, `--strict-mcp-config`, only this project's MCP server, and only the Read, Grep and Glob tools.

Project-file tools are read-only, stay inside the drawing's git repository, skip dependencies and `.gitignore`d paths, and refuse files that look like secrets (`.env*`, keys, credentials) even when asked for by name.

## Supply chain

Dependencies are pinned to exact versions and `.npmrc` sets `ignore-scripts=true`. Browser-only packages are devDependencies, so the runtime installs four packages: `@modelcontextprotocol/sdk`, `ws`, `zod` and `@anthropic-ai/sdk` (used only with the Anthropic API endpoint).

## Egress-isolated Docker

For a hard guarantee that the daemon can't reach the internet, run it in Docker:

```bash
LFX_WORKSPACE=~/code/my-repo docker compose up -d --build
```

```bash
docker compose exec lfx lfx url
```

The second command prints a sign-in link to open in your browser.

- `lfx`, the app container, is attached only to an `internal: true` network, so it has no route to the internet. It runs read-only, as a non-root user, with all capabilities dropped and `no-new-privileges`.
- `gateway` is the same image running a small TCP forwarder (`lfx proxy`). It publishes the UI on `127.0.0.1:7467` only.
- The workspace mount is the only place drawings can be read or written (`LFX_LOCK_ROOTS=1`).

In this mode the assistant can reach only endpoints inside the Docker network. The MCP client configuration for this setup is in [MCP server](mcp.md#any-other-client).
