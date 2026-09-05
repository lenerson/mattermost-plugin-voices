# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](http://keepachangelog.com/en/1.0.0/)
and this project adheres to [Semantic Versioning](http://semver.org/spec/v2.0.0.html).

## 2.4.5 - 2026-09-05

### Changed
- The active room header no longer duplicates the **Delete** action, which remains available from the channel settings menu. Leaving now uses a compact red phone-hangup control instead of a text button.

## 2.4.4 - 2026-09-05

### Added
- Participant lists now show whether each user's microphone is enabled or muted, both inside a room and in the voice-channel directory.

### Changed
- The **Voice channels** heading remains visible while connected, with microphone and speaker controls placed beside the active room name.

### Fixed
- Speaker output starts enabled when joining a room, and its disabled state uses a slashed loudspeaker icon.

## 2.4.3 - 2026-09-04

### Fixed
- Showing the voice-channel settings gear no longer changes the row height or shifts its contents. The **Delete** menu now overlays the directory as a dropdown instead of expanding the row, while retaining the previous red action color.

## 2.4.2 - 2026-09-04

### Changed
- Channel deletion now lives in a contextual settings menu. Authorized users see a gear while hovering or focusing a voice-channel row and can select **Delete** from its popup menu.

## 2.4.1 - 2026-09-04

### Changed
- Selecting a voice channel's name and participant row now joins it directly. The separate **Join** button was removed, and the row remains accessible by keyboard.

### Fixed
- Leaving a voice channel clears the local state and applies the refreshed participant directory immediately instead of waiting for the next poll.
- WebRTC cleanup no longer blocks leaving when the swarm throws during close or omits its close callback.

## 2.4.0 - 2026-09-03

### Changed
- Creating a voice channel is restricted to system administrators. The **+ New** button and the name field are shown only to them, and `POST /v1/voice/rooms` refuses anyone else — hiding the button alone would restrict nothing, since the endpoint is reachable by any logged-in user. Everyone else sees the channel list as before and can join freely; when the list is empty they are told an administrator can create one, rather than being invited to do it themselves.

## 2.3.2 - 2026-09-03

### Changed
- Participants seen from outside a room are drawn exactly like the roster inside it: a green dot to the left of each name, one per line, instead of a comma-separated run of text. Both views now go through a single `renderRoster`, so they cannot drift apart again. The room row aligns its Join and delete buttons to the channel name rather than to the middle of a roster that is several lines tall.

## 2.3.1 - 2026-09-03

### Changed
- A loudspeaker icon sits to the left of every voice channel name, in the list and in the header of the room you are in, the way Discord marks a voice channel apart from a text one. The icon that used to sit on the occupants line is gone, since the channel is now labelled once rather than twice, and the name truncates around the icon instead of clipping it away.

## 2.3.0 - 2026-09-02

### Added
- Voice channels show who is in them without you having to join, as in Discord. Presence has to be server state: everyone inside a room already knows who else is there through the audio mesh, but those are precisely the people who do not need telling — somebody reading the sidebar has no connection to the room at all. Participants heartbeat to `POST /v1/voice/presence` and the entry expires if the heartbeat stops, so a browser that closes without leaving does not linger; leaving reports it explicitly, and a heartbeat for one room also clears any other, so moving rooms or reopening a tab leaves no ghost. `GET /v1/voice/rooms` carries the occupants, resolved to names on the server since a viewer who never opened the room has none of those profiles loaded.

### Changed
- The directory poll drops from 30s to 10s, now that it carries occupancy people expect to move in something close to real time.

## 2.2.3 - 2026-09-02

### Fixed
- Voice channel participants could be listed by raw user id. Two things fill the roster — the `connect` broadcast, which carries a name, and the swarm's own `peer` event, which does not — and the broadcast is lost outright for anyone who subscribed after it went out, since the broker keeps no history. Whoever the `peer` event reached first was left without a name and fell back to their id. Names now come from the Redux profile store, keyed by the swarm uuid, which is the Mattermost user id; the gossiped name is a fallback, and a display name is sent alongside the username for clients whose profile is not loaded locally.

### Changed
- The voice roster shows your own name rather than "You", so every row reads the same way.

## 2.2.2 - 2026-09-02

### Changed
- Joining a voice channel connects you straight away. Join only selected the room and left `audioOn` false, which is the flag the render pass watches before asking for the microphone and joining the swarm — so nothing happened until you also clicked the microphone icon, and the panel said so in a hint. Join now connects with the microphone live, as every other voice app does, and the hint reports the actual connection state instead of asking for a second click.

## 2.2.1 - 2026-09-02

### Fixed
- You could call yourself, and answering sat on "Connecting…" for ever, since there was nobody on the other end to negotiate with. Mattermost lets you open a DM with yourself, and that channel is named `id__id`, so both halves of the split matched and `getDirectMessagePeerUserId` handed back your own id as though it were a peer — which put you in the picker's own list and armed the channel-header button. A self-DM now resolves to no peer, `makeVideoCall` refuses a call to the current user outright, and an incoming ring claiming to come from yourself is ignored. Only the profile popover had guarded against this, by hiding its button.

## 2.2.0 - 2026-09-02

### Added
- Full screen for a call in progress, as in Discord or Teams: a button in the call toolbar, or a double-click on the video. Esc and F11 are respected, since the browser — not the button — is the source of truth for fullscreen state, and the call leaving the screen exits fullscreen rather than stranding the viewer on a black page. Video is letterboxed rather than cropped at full size.

### Fixed
- The call window was stuck at Bootstrap's default dialog width of roughly 600px no matter how large the browser window was. `dialogClassName` had always named a class nothing defined, because the plugin ships no stylesheet; the class is now defined alongside the component, and the window scales with the viewport.

## 2.1.5 - 2026-09-02

### Fixed
- Hanging up left the other side on "Connecting…" for ever. Losing the peer dispatched only `PEER_LOST`, which clears the remote stream but leaves `callAccepted` true — and the modal shows "Connecting…" for exactly `callAccepted && !callPeerStream`, so the call that was already over looked like one still being set up. A 1:1 call is finished once the peer goes, so the disconnect handler now ends it outright.

### Added
- Capture that quietly falls back to audio-only now says so, in the call itself rather than only on the connecting screen. The ladder succeeding is not an error, so nothing was reported — but someone who asked for video and got none has no way to tell a busy camera from a broken plugin.

## 2.1.4 - 2026-09-02

### Fixed
- The DM picker never opened. `getDirectChannels` was renamed out of mattermost-redux long before the pinned 11.6.0, which exports `getAllDirectChannels`; a named import that no longer exists is not a build error, it just resolves to undefined, so the call blew up at runtime inside `mapStateToProps` and took the whole picker out of the page. Both users of it are fixed — the picker, and `getDirectChannelIdForPeer`, whose failure was being swallowed by the invite-post `try/catch` and silently cost the in-DM call invite.
- The picker's `mapStateToProps` no longer lets a host selector take the component down: it degrades to an empty list and says so on the console. Host APIs drift between server versions and this ran inside Mattermost's own React tree.

### Added
- A test that checks every symbol the plugin imports from mattermost-redux against what the installed package exports, so the next rename fails in CI rather than at a user's screen.

## 2.1.3 - 2026-09-02

### Changed
- The handset button's tooltip is just "Start a voice call", in the channel header and the profile popover alike.

## 2.1.2 - 2026-09-02

### Fixed
- The handset and camera icons sat off centre in their round channel-header buttons. Three things stacked up: the glyph wrapper was an inline `span` carrying a hard-coded `top: -1px`, so each SVG sat on the text baseline rather than on the button's centre; the two icons have different intrinsic sizes (14x10 and 14x14), so one nudge could never suit both; and the handset path itself was drawn toward the top-left of its own viewBox. The wrapper is now a fixed 16x16 flex box that centres whatever it holds, and the handset path is symmetric about the centre of a 24x24 viewBox.

## 2.1.1 - 2026-09-02

### Fixed
- A camera switched on during a call could fail to appear on the other side. simple-peer emits `stream` only once per stream id, so a track added to a stream the far side already holds arrives as a bare `track` event — which nothing listened for. The modal's `<video>` kept the same `srcObject`, and `attachStream` skips a stream it believes unchanged, so the picture never showed. Both peer handlers now watch for a video track arriving on an established stream and re-dispatch the stream with fresh object identity; the local preview does the same when its own camera is added.

## 2.1.0 - 2026-09-02

### Added
- Two call buttons in the channel header, as in Discord: a handset that places a **voice** call and a camera that places a **video** call. The handset never opens the camera at all — not opened-then-muted, so no camera light — while the camera button behaves as before. The user profile popover offers the same pair.
- The call mode travels with the ring (`audioOnly` on the `call-${calleeId}` payload), so answering a voice call does not switch the callee's camera on either. A ring from an older client carries no flag and is treated as a video call.
- Video can still be turned on during a voice call. Since the camera was never opened, `videoToggle` now acquires it on demand and adds the track to the stream the peer already holds — `peer.addTrack(track, stream)` rather than a second `addStream`, which would replace the far side's reference and take the audio with it. simple-peer renegotiates on its own.

### Changed
- `icon.jsx` exports a rendered element per glyph from one `Glyph` component, instead of hard-coding the camera SVG.

## 2.0.8 - 2026-09-02

### Fixed
- Incoming calls could stop being announced after a tab had been open for a while, with nothing in the console to show for it. Two halves of the same problem: the SSE handler sent nothing on an idle stream, so a reverse proxy closed the connection (nginx defaults to a 60s read timeout) — and `call-${userId}`, the session-long listener, is idle by definition until somebody actually rings. On the client, `EventSource.onerror` then called `stream.push(null)`, which ends a Readable permanently: the browser quietly reconnected while every data handler stayed detached for the rest of the session. The server now sends an SSE comment frame every 25 seconds, and the client leaves the stream alone on error so the automatic reconnect can take effect.
- SSE responses set `X-Accel-Buffering: no`, since nginx buffers proxied responses by default and would hold signalling frames back until its buffer filled.

## 2.0.7 - 2026-09-01

### Fixed
- Cancelling an outgoing call left the other person's modal ringing indefinitely, as if the call were still coming in. `endCall()` was a plain action that only tore down local state; the callee was never told. Signalling had a `decline-${callerId}` channel for the callee refusing, but nothing for the caller giving up. The caller now broadcasts `cancel-${calleeId}`, and the callee listens for it from the moment it starts ringing (`webapp/src/utils/incomingCancelListen.js`). Only calls that never connected need this — once the peers are joined, the data channel closing already tells them.

## 2.0.6 - 2026-09-01

### Added
- A ringback tone for the caller. `startIncomingRing()` was only ever called from `receiveVideoCall`, so only the person being called heard anything — the caller watched a silent "Ringing…". The caller now hears the usual ringback (425 Hz, one second on, four off, quieter than the incoming ring), which stops the moment the call is answered, declined or cancelled.

### Fixed
- The incoming ring could be silent. `new AudioContext()` built before the page has seen a user gesture starts suspended, and nothing ever resumed it, so the failure was swallowed by the surrounding `try`. Both tones now resume the context before playing.

### Changed
- Ring tones are built by one `createRinger` factory, each with its own AudioContext, so stopping one cannot cut the other off mid-pulse. Pulses are scheduled on the audio clock instead of with `setTimeout`, so the cadence does not drift.

## 2.0.5 - 2026-09-01

### Fixed
- A call could end up with no media at all, not even audio, and hang on "Connecting…" for ever. `getUserMedia({video: true, audio: true})` is atomic, so anything that makes the camera unavailable — most easily two browsers on one machine competing for it — rejected the whole request; the handler then returned early, `peer.addStream()` was never reached, and the far side received nothing. Capture now falls back to audio-only, then video-only, before giving up, and reports what it actually got to both redux and the peer. The voice panel already did this; the 1:1 call path did not.
- When capture fails outright the modal says why — permission denied, no device, or the device being held by another application — instead of showing an endless spinner.

### Changed
- The identical `receivedHandshake` media block in the caller and callee paths is now one `captureAndShareMedia` helper.

## 2.0.4 - 2026-09-01

### Added
- A call that never establishes its peer connection now records a diagnostic through `utils/debug.js`. `webrtc-swarm` reports peers that connect and stays silent when ICE fails, so an unreachable peer was indistinguishable from one still negotiating. Twenty seconds after joining the swarm, if no peer has arrived, the diagnostic names the likely cause without logging TURN credentials (`webapp/src/utils/peerConnectionWatch.js`).

## 2.0.3 - 2026-09-01

### Added
- A **Start video call** button in the channel header (`registerChannelHeaderButtonAction`). In a 1:1 DM it rings the person you are talking to directly; anywhere else it opens the DM picker. Until now the only entry points were an item buried in the channel dropdown and the user profile popover, so direct messages had no visible call button at all.
- `GET`/`POST`/`DELETE /v1/voice/rooms`, a server-side voice channel directory kept in the plugin KV store (`server/voice_rooms.go`). Writes are compare-and-set so concurrent creates cannot lose each other.

### Fixed
- The plugin could end up permanently unable to place or receive a call. `loadConfig` gives up when the current user is not in the store yet, and `initialize()` fired it exactly once as the bundle loaded — if the webapp had not hydrated by then, nothing ever retried, so `configLoaded` stayed false for the whole session and `listenVideoCall`, `makeVideoCall` and the voice-room announce all bailed out at their first line. Bootstrapping now waits for the store to have both a current user and a `DiagnosticId` before loading the config.
- Voice channels were visible only to the person who created them. The directory lived in each browser's `localStorage` and was announced exactly once over the signal broker, which keeps no history — so unless a teammate happened to be subscribed at that precise moment, they never learned the room existed, and nobody could join. Rooms are now read from and written to the server, so everyone on the server sees the same list and it survives a reload, a restart, and being offline at creation time.
- Deleting a voice channel was unauthenticated in practice: any client could broadcast a delete for any room. The server now allows it only for whoever created the room, or a system admin, and the trash button is hidden from everyone else.

### Changed
- The error boundary names the component that failed through `utils/debug.js` while rendering `null`, preventing a plugin crash from blanking the Mattermost webapp.
- A failed registration in `initialize()` is reported through `utils/debug.js`, and the DM picker traces the click and its own render there as well — a picker that opens nothing previously left no trace to work from.

## 2.0.2 - 2026-08-31

### Fixed
- Webapp bundle crashed on load with `ReferenceError: process is not defined`, thrown by `readable-stream` (via `through2` / `webrtc-swarm`) while the bundle was still being evaluated — before `window.registerPlugin` ran. This took the whole Mattermost webapp down with it: blank screen in the desktop app, endless spinner on the web. webpack 5 dropped the automatic Node polyfills and the `process` shim was missing from `webpack.config.js` alongside the existing `buffer` / `util` / `stream` ones.
- Per-call signalling resources are now released when a call ends, is declined, or is rejected (`releaseCallResources`). Each `subscribe()` holds an open SSE connection and browsers cap concurrent connections per host, so calls were leaking connections that could starve the webapp's own requests.

### Changed
- Every component handed to the plugin registry is wrapped in an error boundary, and each registration in `initialize()` is isolated, so a crash inside the plugin can no longer blank the Mattermost webapp.
- `mapStateToProps` in the call modal, the DM picker, and the voice panel no longer assume the current user or the plugin's own store slice are hydrated.
- The `docker-make` / `podman-make` toolchain image was stuck on `golang:1.13` with Debian's packaged npm, which can no longer build this repo. It now tracks CI: the Go version from `go.mod` (1.25) plus Node 20 copied from the official image, with a `.dockerignore` so the build context stays small.

## 2.0.1 - 2026-05-23

### Added
- Voice channel deletion: channel creators can remove a voice channel for everyone from the sidebar.
- `darwin-arm64` plugin binary in `plugin.json` so the bundle loads on Apple Silicon Mattermost servers.
- Expanded README with architecture, configuration, build, deploy, and troubleshooting sections; marketplace plugin icon and CI/license/release/Mattermost badges.

### Changed
- Simplified the in-channel call-invite post UI.
- Audio/voice channel UX polish (`Better audio channel`).

### Fixed
- Restored CI after the Dependabot webpack 5 upgrade.

### Security
- Dependency bumps via Dependabot: `axios` 0.28.1 → 0.31.1, `qs` 6.15.1 → 6.15.2, `uuid`, `mattermost-redux`, `serialize-javascript`, `webpack`, `minimatch`, and `@typescript-eslint/{eslint-plugin,parser}`.

## 2.0.0 - 2026-05-05

### Added
- In-process plugin signal broker with HTTP `POST /v1/signal/publish` and SSE `GET /v1/signal/stream` endpoints (`server/signal_broker.go`, `server/signal_handlers.go`), replacing the external Signalhub dependency.
- Webapp `pluginSignalHub` adapter so existing webrtc-swarm clients talk to the plugin broker.
- Left sidebar header with "Video call…" entry point and a DM picker (`video_call_picker`) for starting 1:1 video calls.
- Channel-header popover "Start video call" button (`popover_video_call_button.jsx`).

### Changed
- Configuration surface reduced to STUN/TURN settings only; the Signalhub URL setting is gone (signalling is now plugin-hosted).
- ICE configuration is fetched from the plugin's `/v1/config` endpoint instead of being computed client-side.

### Removed
- External Signalhub dependency and the corresponding `SignalhubURL` plugin setting.

## 1.1.0 - 2026-05-05

### Added
- `min_server_version` bumped to **Mattermost 10.0.0+**.
- Shared `webapp/src/utils/iceServers.js` helper producing `urls`-style `RTCIceServer` entries.
- Redesigned 1:1 video call modal: dark theme, incoming / connecting / ringing states, remote video with picture-in-picture self preview, toolbar, and proper close handling.

### Changed
- Migrated the Go server from `github.com/mattermost/mattermost-server/v5` to `github.com/mattermost/mattermost/server/public` (v0.3.1).
- Switched manifest build tool to `public/model` and `os.WriteFile`; tests use `io.ReadAll`.
- Updated ESLint to `@babel/eslint-parser`; fixed the webpack Babel plugin name.
- Refreshed npm dependencies: `mattermost-redux` 5.33.x, `axios` 0.28.x, `tslib`, etc.
- Rewrote README around the modernised stack and current Mattermost plugin docs.

### Fixed
- `iceServers.concat` result no longer discarded when building the peer configuration.
- Audio/video track toggles hardened.
- Guard signalhub usage when the configured URL is unset; STUN-only defaults (no embedded TURN credentials).

### Removed
- Browser-inappropriate `wrtc` / `os` imports from the webapp bundle.
- Hard-coded `baatcheet.herokuapp.com` signalhub fallback.

## 0.0.1 - 2018-08-16

### Added
- Initial release.
