# PairDrop — Code Improvement Recommendations

> **Status:** Proposals only — no code changed. For review before implementation.
> **Date:** 2026-09-20
> **Scope:** `server/*`, `public/scripts/*`, `public/service-worker.js`, `public/index.html`, `Dockerfile`, `docker-compose*.yml`, `ecosystem.config.cjs`, `package.json`
> **Method:** Static inspection + subagent exploration. No test suite exists in repo (`**/*test*` → no files), so verification steps below are manual / proposed repro scripts.
> **Priority order:** P0 (correctness/crash/XSS) → P1 (hardening/reliability) → P2 (performance/memory/UX).

---

## P0 — Fix first (correctness / crash / XSS)

### 1. [bug] `server/peer.js:197-207` — `add/removeRoomSecret` use `in` + `delete` on Array
- **Location:** `server/peer.js` class `Peer`, methods `addRoomSecret` / `removeRoomSecret`
- **Problem:** `roomSecret in this.roomSecrets` checks array *indices* (`"0".."n"`), not values, so `add` always pushes duplicates. `delete this.roomSecrets[roomSecret]` never matches a value, and if it did would leave a hole without shrinking `length`.
- **Evidence:** `this.roomSecrets = []` (line 28). `_leaveAllSecretRooms` iterates by `peer.roomSecrets.length`. Duplicates cause repeated join/leave and `peer-joined`/`peer-left` storms; holes cause `_leaveSecretRoom(peer, undefined)` no-ops and room leaks.
- **Impact:** High severity, high confidence. Room leak, ghost peers, growing `_rooms` map.
- **Recommendation (minimal, safe):**
  ```js
  addRoomSecret(roomSecret) {
      if (!this.roomSecrets.includes(roomSecret)) this.roomSecrets.push(roomSecret);
  }
  removeRoomSecret(roomSecret) {
      this.roomSecrets = this.roomSecrets.filter(s => s !== roomSecret);
  }
  ```
  Also iterate over a copy in `_leaveAllSecretRooms` (see #6) so future mutation during iteration cannot skip entries.
- **Verification:** Unit repro: `p.addRoomSecret('x'); p.addRoomSecret('x'); assert(length===1)`; `remove('x'); assert(length===0)`; join/leave same secret twice → single `peer-left`.

### 2. [bug] `server/ws-server.js:445-450` — `_send` checks wrong `readyState`, no guard
- **Location:** `server/ws-server.js` `PairDropWsServer._send`
- **Problem:** Checks `this._wss.readyState !== OPEN` (the *server* object), never `peer.socket.readyState`. `peer.socket.send()` on a closing/closed socket throws, aborting mid-broadcast in loops (`_notifyPeers`, `_deleteSecretRoom`).
- **Evidence:** Current code:
  ```js
  if (this._wss.readyState !== this._wss.OPEN) return;
  message = JSON.stringify(message);
  peer.socket.send(message);
  ```
  No `try/catch`, no per-socket check. `ws` per-socket open constant is `WebSocket.OPEN === 1`.
- **Impact:** High — one dead peer breaks fan-out to healthy peers; triggers `uncaughtException` log spam.
- **Recommendation:** Check per-socket state and swallow send errors:
  ```js
  import { WebSocket } from "ws";
  _send(peer, message) {
      if (!peer || peer.socket.readyState !== WebSocket.OPEN) return;
      try { peer.socket.send(JSON.stringify(message)); } catch (e) { /* optionally console.warn */ }
  }
  ```
- **Verification:** Connect 3 clients, kill one TCP abruptly, trigger `_notifyPeers`; assert no throw and other two still notified.

### 3. [bug] `server/ws-server.js:273-288` — `_onRegenerateRoomSecret` crashes on unknown secret
- **Location:** `server/ws-server.js` `_onRegenerateRoomSecret`
- **Problem:** `for (const peerId in this._rooms[oldRoomSecret])` with no existence check. A spoofed/expired `roomSecret` throws `TypeError: Cannot convert undefined or null to object`.
- **Evidence:** No validation, unlike `_onRoomSecrets` regex filter. Client event `regenerate-room-secret` is peer-controlled (`public/scripts/network.js:14`).
- **Impact:** High — any client can spam exceptions; interacts badly with log-only `uncaughtException` handler and faulty auto-restart (see #9).
- **Recommendation:**
  ```js
  const room = this._rooms[oldRoomSecret];
  if (typeof oldRoomSecret !== 'string' || !room) return;
  ```
- **Verification:** Send `{type:'regenerate-room-secret', roomSecret:'nope'}` via `wscat`; server stays clean, no exception log.

### 4. [bug] `server/server.js:57-64` — catch-all redirect shadows `GET /`
- **Location:** `server/server.js` `PairDropServer` constructor
- **Problem:** `app.use((req,res)=>res.redirect(301,'/'))` is registered *before* `app.get('/')`, so Express matches the redirect first and `GET /` is dead code. `res.sendFile('index.html')` also uses a relative path (would throw `ENOENT` if reached) and the "Serving client files" log is misplaced inside a request handler.
- **Evidence:** Read order lines 57 vs 61. Currently masked by `express.static` serving `/` via `index.html`, so latent.
- **Recommendation:** Move catch-all after all routes; fix or delete dead handler:
  ```js
  app.get('/', (req, res) => res.sendFile(path.join(publicPathAbs, 'index.html')));
  // last:
  app.use((req, res) => res.redirect(301, '/'));
  ```
- **Verification:** `curl -i /nonexistent → 301 /`; `curl -i / → 200 text/html` with no loop; temporarily disable static to prove `/` still serves.

### 5. [bug/security] `public/scripts/ui.js:1578-1600` — stored XSS via paired-device names (+ text-receive path)
- **Location:** `public/scripts/ui.js` `EditPairedDevices` render; also `ReceiveTextDialog` (~line 2128+)
- **Problem:** `$pairedDevice.innerHTML = \`...${display_name}...${device_name}...\`` interpolates peer-controlled strings with no escaping. Names originate from peer (`sendDisplayName`) and are persisted via `PersistentStorage`. Second instance builds `<a href="${link}">` via `innerHTML` from peer text.
- **Evidence:** Direct read; `localization.js` has `escapeHTML` but it is not used here.
- **Impact:** High — malicious paired peer → script execution when victim views Paired Devices / receives text.
- **Recommendation:** Use `textContent` / `createElement`, or run values through existing `escapeHTML()` before interpolation. Same for link building.
- **Verification:** Pair with `display_name='<img src=x onerror=alert(1)>'`; open EditPaired → assert no execution, literal text shown.

---

## P1 — Hardening / reliability

### 6. [hardening] `server/ws-server.js:21-25` — no `close` handler; keep-alive only, too chatty
- **Location:** `server/ws-server.js` `_onConnection`, `_keepAlive`, `_cancelKeepAlive`
- **Problem:** Only `message` + `onerror` are wired; never `close`. Browser close / network drop leaves `Peer` in all `_rooms` until the keep-alive timeout fires (code: `5 * 1000ms`; comment says 10s — mismatch). Per-peer `setTimeout(1000)` means O(N) 1s timers and a `ping` every second per client.
- **Impact:** Medium — 5s ghost peers, timer/CPU overhead at scale.
- **Recommendation:** Add idempotent `socket.on('close', () => this._disconnect(peer))`; guard `_disconnect` against double-call; increase ping to 20–30s with 60s timeout.
- **Verification:** Open/close 50 sockets; assert `Object.keys(_rooms)` drops immediately with no timer pile-up.

### 7. [hardening] `server/ws-server.js:163-167,202-228,253-266` — unvalidated `roomSecretsDeleted` / `pairKey` / `publicRoomId`
- **Location:** `_onRoomSecretsDeleted`, `_onPairDeviceJoin`, `_onJoinPublicRoom`
- **Problem:** `_onRoomSecretsDeleted` does `message.roomSecrets.length` with no `Array.isArray` check → `TypeError` on `{}`. `pairKey` / `publicRoomId` / `createIfInvalid` are trusted as strings; `createIfInvalid` lets anyone mint arbitrary public room IDs.
- **Impact:** Medium — crash/log spam, room-ID enumeration (6-digit pair keys ≈ 1M, 5-letter room IDs ≈ 11M).
- **Recommendation:** Guard `Array.isArray(message.roomSecrets)`; regex-check `pairKey /^[0-9]{6}$/`, `publicRoomId /^[a-z]{5}$/`; return early otherwise. Consider whether `createIfInvalid` should remain.
- **Verification:** Fuzz WS with `{roomSecrets:{}}`, `{pairKey:123}`, `{publicRoomId:'../../../'}`; assert no exceptions, invalid-type responses.

### 8. [hardening] `server/index.js:42-43` — `JSON.parse(readFileSync(RTC_CONFIG))` unchecked
- **Location:** `server/index.js` config bootstrap
- **Problem:** Missing file / bad JSON crashes boot with a raw stack. `parseInt(IPV6_LOCALIZE) || false` also silently coerces `NaN`.
- **Impact:** Medium — confusing ops failures.
- **Recommendation:** `try/catch` with `console.error("Failed to load RTC_CONFIG ...") + process.exit(1)`; validate parsed shape (`iceServers` array).
- **Verification:** `RTC_CONFIG=/tmp/bad.json node server/index.js` → clean error, exit 1.

### 9. [hardening] `server/index.js:20-31,156-174` — `uncaughtException` continues on corrupt state; broken auto-restart
- **Location:** `server/index.js` process handlers
- **Problem:** Base handler only logs and continues (unsafe — state may be corrupt). Auto-restart path does `process.argv.shift()` which mutates argv and drops the `node` binary path, so respawn fails or recurses.
- **Impact:** Medium — silent corruption; restart never works as intended.
- **Recommendation:** Log + `process.exit(1)` and let Docker/PM2 restart; fix respawn to `spawn(process.argv[0], process.argv.slice(1), ...)`. Note `ENTRYPOINT ["npm","start"]` as PID1 needs `tini` or proper init (see #12).
- **Verification:** Throw inside a WS handler; assert process exits 1 and orchestrator restarts it.

### 10. [hardening] `server/server.js` + `server/peer.js:44-53` — no security headers; spoofable proxy IP; rate-limit off by default
- **Location:** `server/server.js` Express setup; `server/peer.js` `_setIP`; `docker-compose.yml`
- **Problem:** No `helmet` (CSP, `X-Content-Type-Options`, `frame-ancestors`), no `Cache-Control`, no `compression`. `app.set('trust proxy', conf.rateLimit)` (e.g. `5`) trusts 5 hops — a spoofed `X-Forwarded-For` bypasses rate-limiting and creates bogus `peer.ip` rooms (`peer.js` takes first entry blindly). Compose ships `RATE_LIMIT=false`.
- **Impact:** Medium — fingerprinting/clickjacking hardening gap; IP-room confusion.
- **Recommendation:** Add minimal headers middleware (or `helmet`), `app.disable('x-powered-by')`; take explicit hop count from env, validate `X-Forwarded-For` IP format; consider defaulting `RATE_LIMIT=true`. Fix `dev/nginx/default.conf` to forward `Host,X-Real-IP,X-Forwarded-For,Forwarded-Proto` (currently only `Connection/Upgrade`).
- **Verification:** `curl -I /` shows headers; request with `X-Forwarded-For: garbage` does not create bogus IP room; `/ip` debug endpoint returns real client IP behind proxy.

### 11. [hardening] `public/scripts/network.js:29-63,134-135` — fragile WS bootstrap
- **Location:** `public/scripts/network.js` `ServerConnection._getConfig`, message dispatch
- **Problem:** `_getConfig` retries every 1s forever, never rejects, no backoff/jitter. `JSON.parse(xhr.responseText)` and later `JSON.parse(wsmsg)` without `try/catch`, plus no `peers[peerId]` existence check — one malformed/spoofed frame can kill the client.
- **Impact:** Medium — endless hot loop on outage; client DoS.
- **Recommendation:** Exponential backoff + max retries + UI error state; wrap all parses in `try/catch`, drop and `console.warn` on unknown `sender.id`.
- **Verification:** Serve 500 on `/config` and assert backoff; inject bad WS frame and assert client survives.

### 12. [hardening] `Dockerfile`, `docker-compose*.yml`, `.dockerignore`, `.github/workflows`, secrets handling
- **Location:** `Dockerfile`, `.dockerignore`, `docker-compose.yml`, `docker-compose-dev.yml`, `docker-compose-coturn.yml`, `ecosystem.config.cjs`, `rtc_config.json`, `.github/workflows/*`, `pairdrop-cli/*`, `dev/openssl/create.sh`
- **Problem:**
  - `FROM alpine:latest` + unpinned `nodejs/npm`; runs as `root` (no `USER node`); `ENTRYPOINT ["npm","start"]` with no `tini`; no `cap_drop/read_only` limits.
  - `.dockerignore` omits only `.github,.git*,.idea,dev,docs,licenses,node_modules,pairdrop-cli,*.md,*.yml,Dockerfile,rtc_config_example.json,turnserver_example.conf` — does **not** exclude `rtc_config.json`, `turnserver*.conf`, `ssl/`, `ecosystem.config.cjs`, `.pairdrop-cli-config` → `COPY . .` can bake live TURN creds (on-disk `rtc_config.json` currently contains a live `turn:` credential on port 80, file mode `644`).
  - Compose: obsolete `version: "3"`, unpinned `latest` images, no `healthcheck/resources`, `RATE_LIMIT=false` default, `dev` nginx mounts read-write, `FQDN=localhost` hardcoded, `create.sh` not `+x`, missing proxy headers (see #10), coturn UDP `10000-20000` on `0.0.0.0`.
  - Workflows: `zip-release.yml` uses mutable `actions/checkout@master`, broad `contents:write`, zip exclusions miss `.pairdrop-cli-config`; `docker-image.yml` lacks `permissions:`/scan/SBOM; `dependabot.yml` covers `npm` weekly only, not `docker`.
  - `pairdrop-cli` shell: `export "$(grep -v '^#' $config_path | xargs)"` (word-splitting/injection), predictable `TMPDIR=/tmp/pairdrop-cli-temp` (no `mktemp`, symlink race), scripts not `+x`, config created `644`.
- **Impact:** Medium (supply-chain + secret-leak risk; insecure defaults).
- **Recommendation:** Pin `alpine:3.x@sha256:…` and packages, add `USER node` + `tini`, extend `.dockerignore` (`rtc_config.json`, `turnserver*.conf`, `ssl/`, `ecosystem.config.cjs`, `.pairdrop-cli-config`), use `:ro` mounts, pin image tags, set `RATE_LIMIT=true` default, tighten workflow pins/permissions, use `mktemp` and `chmod 600` for CLI config/temp.
- **Verification:** Reproducible `docker build --no-cache`; image layer scan shows no `rtc_config.json`; `gh workflow view` passes; `ls -l` shows `600` secrets.

---

## P2 — Performance / memory / UX

### 13. [performance] Whole-file buffering + O(n²) base64 + uncapped zip
- **Location:** `public/scripts/network.js:1285-1313,560-664` (`FileDigester`, `_onFileHeader`), `public/scripts/util.js:453-471,567-584` (`arrayBufferToBase64`, `decodeBase64Files`)
- **Problem:** `FileDigester._buffer.push(chunk)` retains the entire file in RAM (only iOS has a 200MB guard). `arrayBufferToBase64` string `+=` in a loop is O(n²) and freezes on MBs over WS fallback. `decodeBase64Files` does `atob` on the whole zip with no entry-count/size cap and uses unsanitized `entry.filename` (`../` traversal) in `new File([blob], name)`.
- **Impact:** Medium — desktop OOM / UI freeze on large transfers; zip-bomb DoS.
- **Recommendation:** Hash incrementally / avoid full-file string concat (chunked `String.fromCharCode.apply` 32k slices or `Blob`), enforce a desktop size cap with user warning, cap zip entries/total bytes, sanitize filenames with `basename`.
- **Verification:** Transfer ~500MB file; monitor DevTools Memory / RSS — no freeze; feed zip with `../evil` entry → safely sanitized; oversized zip rejected.

### 14. [performance/bug] `RTCPeer._send` has no `readyState`/backpressure handling
- **Location:** `public/scripts/network.js:213-217,903-906`
- **Problem:** Calls `refresh()` then `channel.send` immediately with no `readyState === 'open'` check and no `bufferedAmount` queue; WS `send()` path drops silently when disconnected. Large/early sends throw `InvalidStateError`.
- **Impact:** Medium — flaky large transfers.
- **Recommendation:** Check `channel.readyState === 'open'`, queue unsent chunks and flush on `bufferedAmountLow` / `onopen`; surface errors to UI instead of silent drop.
- **Verification:** Send ~100MB immediately after `peer-joined`; assert no exception and progress advances.

### 15. [performance] Leak-prone object URLs, `FileReader`, IndexedDB churn
- **Location:** `public/scripts/ui.js:955,1033,1084,1094,1180`, `public/scripts/network.js:1235-1283` (`FileChunker`), `public/scripts/persistent-storage.js:60-306`, `public/scripts/browser-tabs-connector.js:23-51`, `public/scripts/ui.js:2617-2630,2396-2398`
- **Problem:** `URL.createObjectURL` never `revokeObjectURL` (previews, single/multi downloads, share thumbs); `innerHTML` clears leak the blobs. `FileChunker` uses a single `FileReader` with no `onerror/onabort`/cancel. `persistent-storage.js` opens a new `indexedDB.open` per op, never `db.close()`, and only handles `DBOpenRequest.onerror` (missing `transaction/request.onerror`, swallows to `[]`). `BroadcastChannel` never `close()`d; `JSON.parse(localStorage)` unguarded; `removeEventListener` with a fresh closure never unregisters; per-notification `serviceWorker` listeners accumulate.
- **Impact:** Medium — memory growth on repeated transfers; silent storage failures.
- **Recommendation:** Central `revokeObjectURL` on dialog close / re-render; add `reader.onerror/onabort` + cancel; cache a single `db` promise and add `transaction.onerror`; guard `JSON.parse`, fix `splice(-1)` path, `bc.close()` on unload, use stable listener refs.
- **Verification:** Receive 20 images; assert `URL.createObjectURL` count / heap stable in DevTools Memory; force IndexedDB error → visible error, not empty-list silent success.

### 16. [enhancement] Observability / DX, low-risk
- **Location:** `server/*`, `package.json`, `ecosystem.config.cjs`
- **Problem:** Bare `console.log` everywhere, no levels; no `/healthz` or metrics; `debugMode` dumps full `conf` including RTC creds to stdout; `engines: node>=15` allows EOL Node; `npm audit` shows fixable moderates (`qs`/`body-parser` via `express`).
- **Impact:** Low — ops visibility; dependency hygiene.
- **Recommendation:** Add `/healthz` (no auth) + minimal structured logging; redact `credential` in debug dumps; add `npm run lint`, raise `engines` (e.g. `>=20`), run `npm audit fix` (`express→4.22.3`, `ws→8.21.3`).
- **Verification:** `curl /healthz → 200`; logs JSON-parseable; `npm audit` clean; `node --check` passes.

### 17. [enhancement] Service-worker staleness + Share-Target URL building
- **Location:** `public/service-worker.js:1-66,153-188,212-258`
- **Problem:** Cache-first is correct for offline but version bump is manual (`v1.11.2`). Share-target `evaluateRequestData` builds `?share_target=text&title=&text=&url=` by string concat with `encodeURI` (not `encodeURIComponent`) → truncation/injection; IndexedDB error path resolves bare URL, silently losing shared files.
- **Impact:** Low — stale clients; broken shares.
- **Recommendation:** Auto-bump cache on build (or hash manifest), build query with `URLSearchParams`, surface share-save errors to the user.
- **Verification:** Share large text via Share Target; assert URL parses; simulate IDB failure → user-visible error.

---

## Suggested implementation order (for later build phase)

1. P0 #1, #2, #3 + small repro scripts.
2. P0 #4, #5.
3. P1 #6–#11 (close handler, input validation, config parse, headers/proxy).
4. P2 #13–#15 (streaming caps, backpressure, object-URL/IDB hygiene).
5. P1 #12 + P2 #16–#17 (Docker/pins/secrets, health/logging, service-worker).

## Open questions for reviewers

1. May new (tiny) dependencies be added (e.g. `helmet`), or must the server stay zero-extra-deps with hand-rolled headers?
2. Can `engines` be raised to `node >= 20` and Alpine/images pinned, or must old runtimes keep working?
3. Are default-behavior changes acceptable (`RATE_LIMIT=true`, longer keep-alive intervals), or must 100% backward compatibility be preserved?

---

# Addendum — implementation round (P0 + P1), 2026-09-20

Scope approved by the maintainer: **all P0 and P1 items**, new dependencies allowed
(`helmet`, `compression` added), keep-alive interval may change.
All changes below are implemented in the working tree; nothing was committed.

## 1. Status of the original findings

| # | Original finding | Status | Note |
|---|------------------|--------|------|
| 1 | `Peer.add/removeRoomSecret` (`in`/`delete` on Array) | **Fixed** | `peer.js`: `includes`/`indexOf`+`splice`; `_leaveAllSecretRooms` iterates a copy |
| 2 | `_send` checks `this._wss.readyState` (always `undefined`) | **Fixed** | `ws-server.js`: per-socket `WebSocket.OPEN` check, `try/catch`, `bufferedAmount` cap |
| 3 | `_onRegenerateRoomSecret` "crashes on unknown secret" | **Corrected + hardened** | `for…in` over `undefined` is a legal no-op (verified: no throw). Real issue is missing validation → now validated; handler is a no-op for unknown secrets |
| 4 | Catch-all redirect shadows `GET /` | **Fixed** | `server.js`: `/` handler (absolute `sendFile`) registered before the catch-all; startup log moved out of the request path |
| 5 | Stored XSS in `EditPairedDevicesDialog` | **Fixed** | `ui.js`: names run through `Localization.escapeHTML` before `innerHTML` |
| 6 | No `close` handler, chatty keep-alive | **Fixed + extended** | see §2 (this was worse than described: permanent ghost peers) |
| 7 | Unvalidated `roomSecretsDeleted` / `pairKey` / `publicRoomId` | **Fixed** | plus prototype-pollution fix (§2) |
| 8 | `JSON.parse(readFileSync(RTC_CONFIG))` unchecked | **Fixed** | `parseRtcConfig()` with read/parse/shape errors → clear message + `exit(1)` |
| 9 | `uncaughtException` continues; broken auto-restart | **Fixed** | single handler: log → `exit(1)`; respawn uses `process.argv[0]` + `process.argv.slice(1)` |
| 10 | No security headers; spoofable proxy IP; rate-limit off by default | **Partly fixed** | `helmet` (CSP incl. `worker-src blob:` for zip.js/heic2any, no HSTS/upgrade-insecure-requests so plain-http LAN instances keep working), `compression`, `x-powered-by` disabled, `trust proxy` split into `TRUST_PROXY`; nginx dev config now forwards `Host`/`X-Real-IP`/`X-Forwarded-For`/`X-Forwarded-Proto`. `RATE_LIMIT` default left as-is (compose/docs concern) |
| 11 | Fragile client WS bootstrap | **Fixed** | `network.js`: `JSON.parse` guarded in `_onMessage` and `_getConfig`, exponential backoff (max 5 attempts, ≤30 s) + user-visible error, `createIfInvalid` no longer lost on retry |
| 12 | Docker/secrets/workflow/CLI hygiene | **Partly fixed** | `.dockerignore` now excludes `rtc_config.json`, `turnserver.conf`, `ssl/`, `certs/`, `ecosystem.config.cjs`, `.pairdrop-cli-config*`; `Dockerfile` pins `alpine:3.22`, adds an unprivileged `node` user, healthcheck now targets `/healthz`. Workflows, image pinning and `pairdrop-cli` quoting remain open (P2) |
| 13–18 | P2 items | **Not implemented** | deferred, see §4 |

## 2. New findings found while implementing (higher impact than the original #6)

### N1 [bug/security] Prototype pollution through client-controlled room ids
- `_rooms` / `_roomSecrets` were plain objects keyed by `publicRoomId`, `signal.roomId` and `pairKey`.
- Repro (before): `{"type":"join-public-room","publicRoomId":"__proto__","createIfInvalid":true}` wrote the
  attacker's `Peer` onto `Object.prototype` → afterwards **new clients saw that peer in every room**
  (verified: it appeared in the IP room and in a freshly created public room it never joined).
  `{"type":"pair-device-join","pairKey":"__proto__"}` threw `TypeError … reading 'id'` (uncaught).
- Fix: `Object.create(null)`, `Object.hasOwn`, strict format validation (`secret`, `public-id`, `pairKey`).

### N2 [bug] Ghost peers that never disappear (worse than "5 s lingering")
- No `close` listener **and** `_keepAliveTimers` keyed by `peer.id`: a reconnecting client reusing its
  `peer_id` (clients keep it in `sessionStorage`) cancelled the previous session's timer, so that session
  was never timed out and stayed in rooms it was never re-joined to.
- Repro (before): peer creates a public room, reloads (new socket, same `peer_id`), old socket terminated →
  **11 s later** (≫ 5 s timeout) a fresh client joining that room still saw the dead peer.
- Fix: `socket.on('close')`, idempotent `_disconnect` (`peer.disconnected`), keep-alive state stored on the
  `Peer` instance.

### N3 [hardening] WebSocket frame size
- `ws` defaults to a 100 MB `maxPayload`. Now `1 MB` (ws-fallback chunks are 64 KB); oversized frames are
  rejected with 1009 and logged.

### N4 [hardening] Secret leakage through the debug dump
- `DEBUG_MODE=true` logged the full config, including TURN `credential`s — this deployment runs PM2 with
  `DEBUG_MODE=true` (`ecosystem.config.cjs`), so the credential was in the logs.
- Fix: `redactConf()` replaces `credential`/`username` with `<redacted>` (verified in `pm2 logs`).

## 3. Behaviour changes to be aware of

| Change | Before | After |
|--------|--------|-------|
| Ping interval / timeout | 1 s ping, 5 s timeout (comment said 10 s) | 30 s ping, 90 s timeout (per-peer timers, not per-id) |
| `RATE_LIMIT` semantics | value doubles as `trust proxy` hop count (e.g. `5`), `max` hardcoded 1000 | `RATE_LIMIT` only enables; `RATE_LIMIT_MAX` (default 1000), `RATE_LIMIT_WINDOW_MS` (default 5 min), `TRUST_PROXY` (default `1` when rate limiting is on, else `false`) |
| `uncaughtException` | log and continue | log and `exit(1)` (restart by Docker/systemd/pm2); `--auto-restart` respawn fixed |
| HTTP headers | none | `helmet` + `compression`, no `X-Powered-By`, `/healthz` added |
| WS messages | any shape accepted | `pairKey` `/^[0-9]{6}$/`, public ids `/^[a-z]{5}$/`, secrets `/^[\x00-\x7F]{64,256}$/`, arrays must be arrays |

`TRUST_PROXY=1` is correct behind a single reverse proxy that **appends** to `X-Forwarded-For`
(`proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for` — now set in `dev/nginx/default.conf`).
Instances exposed directly should set `TRUST_PROXY=false`, otherwise a spoofed `X-Forwarded-For`
still selects the rate-limit bucket.

## 4. Verification performed (manual, no test suite exists)

Run against a throwaway instance (`PORT=3999 node server/index.js`):
- Fuzz frames (`pairKey:"__proto__"`, `room-secrets-deleted` without array, `roomSecrets:"str"`,
  `publicRoomId:"__proto__" | "../../../etc" | "ABCDEFG"`, `regenerate-room-secret:"nope"`,
  unknown type, non-object JSON): **0 uncaught exceptions** (2 before), no room pollution.
- Oversized frame (2 MB): rejected (1009), server keeps serving.
- Graceful `close()` → `peer-left` broadcast immediately (was: up to 5 s).
- Reload/ghost repro → public room empty after terminate (was: ghost forever).
- Pairing, persisted-secret rejoin, secret regeneration, secret-room deletion, public-room
  create/join/leave: all behave as before.
- `curl`: `/` 200, `/nope` → 301 `/`, `/healthz` 200 `ok`, gzip applied for `/scripts/ui.js`,
  CSP/HSTS/X-Content-Type-Options as documented above; rate limit with `RATE_LIMIT_MAX=3`
  returns 429 from the 4th request with `RateLimit-*` headers.
- `node --check` passes for all touched server and client scripts.

Not verified: real browser end-to-end (WebRTC transfer, HEIC/zip blob workers under CSP,
service worker). Recommended before release: open the app, pair two devices, transfer a file,
receive a text, and check the console for CSP violations.

## 5. Remaining backlog (P2, not implemented)

1. `#13` streaming/size caps: `FileDigester` whole-file buffering, `arrayBufferToBase64` O(n²), zip bomb guards.
2. `#14` `RTCPeer._send` `readyState`/backpressure handling.
3. `#15` object-URL revocation, `FileReader` error handling, IndexedDB connection reuse and
   transaction error handling, `BroadcastChannel.close()`.
4. `#16` `/healthz` metrics + leveled/structured logging (partly done), `engines: node >= 20`, `npm audit fix`.
5. `#17` service-worker share target (`URLSearchParams` instead of `encodeURI` + raw values) and
   surfaced IndexedDB errors.
6. `#12` remainder: pin workflow actions, `permissions:` in workflows, dependabot for docker,
   `pairdrop-cli` config parsing (`export "$(grep … | xargs)"`) and temp dir (`mktemp -d`, `chmod 600`).
7. Document the new env vars (`RATE_LIMIT_MAX`, `RATE_LIMIT_WINDOW_MS`, `TRUST_PROXY`, `/healthz`) in
   `docs/host-your-own.md`.

## 6. Answers to the open questions

1. Dependencies: **allowed** — `helmet` and `compression` are now used.
2. `engines`/image pinning: base image pinned to `alpine:3.22`; `engines` left untouched (not in scope).
3. Behaviour defaults: keep-alive interval changed (1 s → 30 s, timeout 90 s); `RATE_LIMIT` default
   unchanged; `trust proxy` now defaults to 1 hop instead of the rate-limit value.

---

# Addendum 2 — P2 backlog (memory, robustness, tooling), 2026-09-20

## Implemented

| # | Item | Change |
|---|------|--------|
| 13a | O(n²) base64 encoding | `util.js: arrayBufferToBase64` converts in 32 KB chunks (`String.fromCharCode.apply`) instead of concatenating per byte |
| 13b | Zip bomb / path traversal | `util.js: decodeBase64Files` caps entries (1000), per-entry and total uncompressed size (2 GB) and strips paths from entry names via `sanitizeZipFilename` |
| 14 | `RTCPeer._send` | `network.js`: sends only when `channel.readyState === 'open'`, refreshes and drops otherwise, wraps `send` in `try/catch` (no more `InvalidStateError` in the transfer loop) |
| 15a | Object URL leaks | `ui.js`: `ReceiveFileDialog` tracks preview/zip/download URLs and revokes them when the dialog is hidden; `util.js: getThumbnailAsDataUrl` revokes its URL in a `finally` |
| 15b | `FileReader` errors | `network.js: FileChunker` handles `error`/`abort` instead of stalling the transfer silently |
| 15c | IndexedDB churn & silent failures | `persistent-storage.js`: one shared connection (`_getDb`, `_withObjectStore`), `transaction.onerror`/`onabort` and per-request `onerror` reject instead of hanging; `db.onversionchange` closes the connection so another tab can upgrade; the v4→v5 migration now uses the upgrade transaction directly (it previously opened a second connection which is blocked by the very transaction it runs in) |
| 15d | `BroadcastChannel` | `browser-tabs-connector.js`: closed on `pagehide`; `JSON.parse(localStorage…)` guarded, `removePeerIdFromLocalStorage` tolerates a missing/empty list |
| 17 | Share target | `service-worker.js`: query built with `URLSearchParams` (values with `&`, `=`, `#` no longer truncate/inject); IndexedDB failures resolve `?share_target=files-error`, surfaced as a notification (new `notifications.share-target-files-error` key in `public/lang/en.json`) |
| 12 | Workflows / CLI | `zip-release.yml`: `actions/checkout` pinned to a SHA, `.pairdrop-cli-config*` excluded from the zip; `docker-image.yml`: `permissions: contents: read`; `dependabot.yml`: `docker` + `github-actions` ecosystems; `pairdrop-cli/pairdrop`: config parsed line by line with a strict `KEY=value` pattern (no `export "$(grep … | xargs)"`), config written `chmod 600`, temp dir created `mkdir -m 700` |
| 16 | Dependencies | `npm audit fix` (express 4.22.3 → 0 vulnerabilities), `engines: node >= 18` |
| — | Docs | `docs/host-your-own.md`: `RATE_LIMIT` documented as enable-flag only, new `RATE_LIMIT_MAX`, `RATE_LIMIT_WINDOW_MS`, `TRUST_PROXY` and `/healthz` sections; the "find the right hop count" instructions now use `TRUST_PROXY` |

## Verification

- `node --check` for all server/client scripts, `bash -n pairdrop-cli/pairdrop`, `en.json` and `package.json` parse.
- Config parser exercised with a crafted file: valid `DOMAIN` exported, malformed `INVALID KEY=oops` ignored.
- Full websocket regression (fuzz, pairing, secret rooms, public rooms, close cleanup, reload) with the new client code and `express@4.22.3`: 0 uncaught exceptions, no ghost peers, `__proto__` room ids rejected.
- PM2 `PairDrop` on :3000 restarted with the final code: `/` 200, `/healthz` 200.

## Deliberately not changed

- `FileDigester` (`network.js`) still buffers a whole received file in memory to build a `File`.
  Streaming to disk / a size cap would change UX and needs a product decision.
- No structured/log-level logging framework was introduced; `console.*` is kept.
- No test framework was added; verification remains manual (see the repro commands in this file).

## Recommended before release

1. Manual browser pass: pair two devices, send/receive files and text, open a public room,
   share files/text into the PWA via the OS share target, and check the console for CSP errors.
2. `docker build` to confirm the non-root user and the reduced build context work in CI.
3. Rotate the TURN credential in `rtc_config.json` — it was logged in the clear by earlier
   versions with `DEBUG_MODE=true`.
