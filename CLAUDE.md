# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

Mattermost plugin (`mattermost-webrtc-video`): Go server + React webapp bundle. Peer-to-peer WebRTC video calls in 1:1 DMs, plus sidebar voice channels, with signalling hosted by the plugin itself (HTTP POST + SSE) instead of an external signalhub.

## Commands

```bash
make                # check-style + test + dist (release bundle in dist/)
make dist           # apply + server + webapp + bundle, no lint/test
make webapp-debug   # unminified webpack build; fastest inner loop
make deploy         # dist + upload via API (MM_SERVICESETTINGS_SITEURL / MM_ADMIN_USERNAME / MM_ADMIN_PASSWORD) or copy into ../mattermost-server/plugins
make apply          # regenerate server/manifest.go + webapp/src/manifest.js from plugin.json
```

Tests and lint:

```bash
go test -race ./server/...                                        # all Go tests
go test -race ./server/... -run TestSignalBrokerTopicIsolation -v  # one Go test
cd webapp && npx jest                                             # webapp tests only
cd webapp && npx jest src/manifest.test.js                        # one webapp test file
cd webapp && npm run lint                                         # eslint (no writes)
make check-style                                                  # gofmt -s, go vet, vet+shadow, golint, eslint
```

Gotchas:
- `make test` runs `npm run fix` (eslint `--fix`) **before** jest, so it rewrites webapp sources. Use `npx jest` directly when you don't want that.
- `make check-style` does `go install golang.org/x/lint/golint@latest` plus the `shadow` vettool — it needs network access and `$GOPATH/bin` on PATH. The shadow pass means shadowed variables fail CI.
- CI (`.github/workflows/ci.yml`) is exactly `make check-style` + `make test`, on the Go version from `go.mod` and Node 20.

Version bumps: edit `plugin.json` only, then `make apply`. `server/manifest.go` and `webapp/src/manifest.js` are generated (`linguist-generated`) — never hand-edit. `webapp/package.json`'s `version` is separate and kept in sync manually.

## Architecture

### Signalling model

There is no external broker. `server/plugin.go` `ServeHTTP` exposes exactly four paths via a `switch` on `r.URL.Path` (no router — new endpoints go in that switch):

| Route | Purpose |
|---|---|
| `GET /v1/config` | STUN/TURN settings for the client |
| `GET/POST/DELETE /v1/voice/rooms` | voice channel directory (KV-backed, see below) |
| `POST /v1/signal/publish` | `{topic, payload}` → fan-out |
| `GET /v1/signal/stream?topic=` | SSE frames (`data: <json>`) |

- Auth is only "is the `Mattermost-User-Id` header present" (`isUserAuthenticated`). There is **no per-topic authorization**: any logged-in user who knows a topic string can publish to or subscribe to it. Topic strings embed the server `DiagnosticId` and user IDs, which is the only namespacing.
- `signalBroker` (`server/signal_broker.go`) is an in-memory `map[topic][]chan []byte` with 64-buffered channels and a non-blocking send (messages are **dropped** for slow subscribers). It is per-process: multi-node / HA Mattermost breaks signalling.
- The broker is created lazily by `sync.Once` in `getSignal()`; there is no `OnActivate` hook.
- Config follows the standard Mattermost clone-under-lock pattern (`server/configuration.go`): treat the struct from `getConfiguration()` as immutable; `Clone()` + `setConfiguration()` to change it.

### Webapp entry and state

`webapp/src/index.js` registers: the reducer, a main-menu action, a channel-header menu action, `registerPopoverUserActionsComponent`, two root components (call modal + DM picker), the left sidebar header, and a custom post type `custom_webrtc_video_invite`. Plugin state lives at `state['plugins-mattermost-webrtc-video']` and is read everywhere as `` getState()[`plugins-${pluginId}`] ``.

### pluginSignalHub — the signalhub shim

`webapp/src/utils/pluginSignalHub.js` implements the signalhub interface `webrtc-swarm` expects — `subscribe(channel)` returning a Node `Readable` that emits `open`/`data`, plus `broadcast(channel, msg, cb)` and `close(cb)` — on top of the plugin's SSE + POST routes. Any change here must preserve that shape or `webrtc-swarm` breaks.

Topic naming: the hub app name is `mattermost-webrtc-video-${DiagnosticId}`, optionally suffixed `-call-${userId}` or `-voice-${roomId}`; the wire topic is `${appName}/${channel}`. Channels in use:

- `call-${calleeId}` — ring the callee (`{callerId, callId}`)
- `accept-${calleeId}` / `decline-${callerId}` — call setup on the base hub
- `all` — `webrtc-swarm`'s own SDP/ICE exchange

### 1:1 call flow (`webapp/src/actions/index.js`)

`loadConfig` (dispatched at plugin init) → `listenVideoCall` subscribes `call-<self>` for the session. The caller's `makeVideoCall` posts the in-DM invite post, broadcasts `call-<peer>`, and attaches a decline listener; the callee's `receiveVideoCall` rings (Web Audio, `utils/callRing.js`) and browser-notifies; `acceptCall` broadcasts `accept-<self>` and joins a swarm on its own call hub, while the caller's `listenAccept` joins the swarm on the callee's hub. Media is **not** captured on connect: peers first exchange app-level `sendHandshake`/`receivedHandshake` over the data channel, and `audioToggle`/`videoToggle` are likewise data-channel messages mirrored into redux (`callPeerAudioOn` / `callPeerVideoOn`). Module-level `gStream` / `cPeer` singletons mean one active call at a time by design.

Video calls are intentionally 1:1 DM only. DM peer resolution cannot rely on `channel.teammate_id` — `utils/dmPeer.js` falls back to splitting the DM `channel.name` (`id__id`).

### Voice channels

UI is entirely inside `webapp/src/components/modals/audio_group_call/audio_group_call.jsx` (component-local state, not redux; mounted by the left sidebar header). Audio is a `webrtc-swarm` mesh on a per-room hub.

The room directory is **server state**, in the plugin KV store under the single key `voice_rooms` (`server/voice_rooms.go`), reached through `webapp/src/utils/voiceRoomsApi.js`. The whole directory is one JSON value, so listing is one `KVGet`; writes go through `mutateVoiceRooms`, which is a compare-and-set retry loop, and every endpoint answers with the full directory so create/delete need no follow-up GET. Only the room's creator or a system admin may delete one.

It used to be gossiped over a `voice-room-announce` channel and cached in `localStorage`. That could not work: the broker keeps no history, so a room announced once was invisible to everyone not subscribed at that exact instant. Nothing pushes directory changes now either — the panel polls every `DIRECTORY_POLL_MS` while mounted.

### CSRF, always

Mattermost sets `Mattermost-User-Id` on cookie-auth POSTs only after CSRF passes. Every POST to `/plugins/...` or `/api/v4/...` must send `X-Requested-With: XMLHttpRequest` plus `X-CSRF-Token` from the `MMCSRF` cookie, with `withCredentials`. Use `mattermostApiRequest()` (`utils/mattermostApi.js`) or the hub's `broadcast` — not bare `axios.post`. SSE via `EventSource` is cookie-only (GET).

## Build constraints

- webpack `externals`: `react`, `redux`, `react-redux`, `prop-types`, `react-bootstrap` are supplied by the host webapp at runtime — never bundle them, and avoid deps that pull their own React.
- `webrtc-swarm` comes from a GitHub fork (`tom-james-watson`) and is Node-flavored; the `buffer` / `util` / `stream-browserify` / `process` fallbacks and the `ProvidePlugin` entries in `webpack.config.js` exist solely for it. webpack 5 ships no automatic Node polyfills, and these libraries touch the shimmed globals at *module scope* — a missing one throws while the bundle is still being evaluated, before `window.registerPlugin` runs, which blanks the entire Mattermost webapp rather than just breaking the plugin.
- `mattermost-redux` is pinned (11.6.0) for selector compatibility with the host webapp; bump it only alongside a target server version.
- `import {id as pluginId} from 'manifest'` resolves through webpack `resolve.modules: ['src']`. Jest has **no** `moduleDirectories` config, so tests must use relative imports (see `src/manifest.test.js`).
- `make server` cross-compiles five binaries; that set must stay in sync with `plugin.json`'s `server.executables`, or the bundle fails to load on the missing platform.

## Conventions

- Go: tabs, `gofmt -s`, shadow-clean; the server is `package main`, tests in `server/*_test.go` using `testify` + `httptest`.
- Webapp: 4-space indent, single quotes (JSX included), Mattermost-style eslint config in `webapp/.eslintrc.json`.
- All client logging goes through `utils/debug.js` (`DEBUG` constant, currently `true`), not `console.log` directly.
