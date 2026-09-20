# AGENTS.md

PairDrop: vanilla-JS PWA + Node signaling server for peer-to-peer file transfer. Fork of Snapdrop.

## Build / test / lint
- There is **no** build step, test suite, linter, or typechecker. Do not look for one or add one without asking.
- `package.json` scripts are only: `start` = `node server/index.js`, `start:prod` = `node server/index.js --rate-limit --auto-restart`.
- Verify changes with:
  - `node --check <file>` for every touched server/client `.js` file
  - `bash -n pairdrop-cli/pairdrop` for the CLI
  - `PORT=3999 node server/index.js` then `curl localhost:3999/healthz`
  - JSON edits: `node -e "JSON.parse(require('fs').readFileSync('public/lang/en.json'))"`
- Runtime: ESM (`"type": "module"`), `engines: node >= 18`; `.npmrc` has `engine-strict=true` so installs fail on older Node.

## Architecture
- `server/index.js` — config parsing (env + CLI), process/SIGINT handlers; `server/server.js` — Express static + `/config` + `/healthz`; `server/ws-server.js` — signaling/rooms; `server/peer.js`; `server/helper.js`.
- Server state is **in-memory only**, no DB. Room maps are prototype-less (`Object.create(null)`) and all client-controlled ids are regex-validated — keep this invariant.
- Client is plain globals loaded by `<script defer>` in `index.html`: `localization.js` -> `persistent-storage.js` -> `ui-main.js` -> `main.js`. `main.js` (`class PairDrop`) then dynamically loads `browser-tabs-connector.js`, `util.js`, `network.js`, `ui.js`, and `libs/*`. Load/definition order matters; classes are global, not modules.
- **`$` = `document.getElementById`; `$$` = `document.querySelector` (first match only, NOT querySelectorAll).** `Events` is a `CustomEvent` wrapper over `window`.
- Config is via env vars and CLI flags (`--rate-limit`, `--auto-restart`, `--localhost-only`, `--include-ws-fallback`); full list in `docs/host-your-own.md`.

## Client asset rules (easy to miss)
- `public/service-worker.js` precaches an explicit `relativePathsToCache` list and is **cache-first**. When adding/removing/renaming a client asset, update that list and bump `cacheVersion` (manual) or clients keep stale files.
- New UI strings: add the key to `public/lang/en.json` (fallback) and use `data-i18n-key` / `data-i18n-attrs` / `Localization.getTranslation`. New locale files also need `Localization.supportedLocales` and the SW precache list.
- `Localization.escapeHTML` escapes `& < >` but **not quotes**; do not interpolate it into HTML attributes.

## Secrets / files never to commit or add to Docker context
- `rtc_config.json`, `turnserver.conf`, `ssl/`, `certs/`, `.pairdrop-cli-config*`, `ecosystem.config.cjs`. These are in `.gitignore` and `.dockerignore` — keep it that way; `rtc_config.json` may hold live TURN credentials.

## Docker / ops
- `Dockerfile` pins `alpine:3.22`, installs prod deps with `npm ci --omit=dev`, runs as unprivileged `node`, healthchecks `/healthz`. `docker build .` must stay reproducible.
- `--auto-restart` respawns via `process.argv`; `uncaughtException` intentionally `exit(1)`s so the process manager restarts.

## Repo-specific context
- The maintained audit/backlog lives in `docs/code-improvement-recommendations.md` (append addenda; don't rewrite history). Read it before large changes.
- `CONTRIBUTING.md` sets a hard product bias: radical simplicity, stability first, don't add features that complicate the main flow.
- `pairdrop-cli/pairdrop` is bash; its `.pairdrop-cli-config` is parsed line-by-line with a strict `KEY=value` pattern.
- Tests/verification in this repo are manual; document repro steps when you change behavior.
