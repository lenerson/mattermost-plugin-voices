# Mattermost Plugin Voices

[![CI](https://github.com/lenerson/mattermost-plugin-voices/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/lenerson/mattermost-plugin-voices/actions/workflows/ci.yml)
[![License](https://img.shields.io/github/license/lenerson/mattermost-plugin-voices)](LICENSE)
[![Version](https://img.shields.io/github/v/tag/lenerson/mattermost-plugin-voices?sort=semver&label=version)](https://github.com/lenerson/mattermost-plugin-voices/tags)
[![Mattermost](https://img.shields.io/badge/Mattermost-10%2B-blue)](https://mattermost.com)

Peer-to-peer **voice and video calls** in direct messages, plus persistent **voice channels** in the Mattermost left sidebar. Media flows through browser WebRTC; the Go plugin provides signalling, room state, presence, and invitations without an external Signalhub service.

Targets **Mattermost 10+** (`min_server_version` in [`plugin.json`](plugin.json)). The Go server uses [`github.com/mattermost/mattermost/server/public`](https://pkg.go.dev/github.com/mattermost/mattermost/server/public).

> [!NOTE]
> This project started as a copy/fork of [niklabh/mattermost-plugin-webrtc-video](https://github.com/niklabh/mattermost-plugin-webrtc-video). It preserves the original Apache 2.0 license and the `mattermost-webrtc-video` plugin ID for compatibility, while maintaining and extending the plugin in this repository.

![WebRTC plugin screenshot](https://github.com/lenerson/mattermost-plugin-voices/raw/main/assets/screen.jpg)

## Features

### Direct voice and video calls

- Start an audio-only or video call from the **channel header** or **user profile popover**. Video calls are also available from the main menu, channel menu, and left sidebar.
- Pick a user from a DM picker; the callee gets an incoming-call modal with ringtone and browser notification.
- Mute the microphone, enable or disable the camera, use full screen, and end the call. Media capture falls back to audio-only when the camera is unavailable.
- A **call invite post** appears in the DM thread so both sides see call status in channel history.

Calls are limited to **1:1 direct messages**; group DMs and regular channels open the user picker instead of calling the entire channel.

### Voice channels (sidebar)

- System administrators can create named voice channels. The creator or any system administrator can delete one from its settings menu.
- Select a channel row to join it. All rooms remain visible, and joining another room fully disconnects the current one first.
- See participants and their microphone state without joining. Presence updates through Mattermost WebSocket events, with polling and expiring heartbeats as safeguards.
- Control the microphone and incoming audio independently. Join and leave tones are audible only to participants in the affected room.
- Invite any user who is not already in the destination room. The user receives a sound, a real-time prompt, and a direct message with **Accept** and **Decline** actions; invitations expire after five minutes.
- Active audio uses a peer-to-peer WebRTC mesh via [`webrtc-swarm`](https://github.com/tom-james-watson/webrtc-swarm).

## Architecture

```text
Browser A  <========= WebRTC media =========>  Browser B
    |                                               |
    +--- REST / SSE / Mattermost WebSocket events --+
                            |
                     Mattermost plugin (Go)
                       |                 |
              in-memory signalling   Mattermost KV
                                     rooms + presence
```

| Component | Role |
|-----------|------|
| **Plugin HTTP API** | Serves ICE configuration, signalling, voice rooms, presence, and invitations under `/v1/`. |
| **SSE stream** | Delivers WebRTC signalling messages to subscribed clients (`/v1/signal/stream`). |
| **Mattermost KV store** | Persists the voice-channel directory and expiring participant presence with atomic updates. |
| **WebSocket events** | Refresh presence and deliver targeted voice invitations in real time. |
| **STUN / TURN** | Configured in System Console; used by the browser for NAT traversal. |
| **Mattermost webapp** | Supplies React, Redux, PropTypes, and React Bootstrap at runtime (webpack externals). |

**Production limitations:** the signal broker is **in-memory inside the plugin process** and does not span multiple Mattermost app nodes. High-availability deployments need a shared signalling layer. Voice channels use a browser mesh rather than an SFU, so each participant's bandwidth and connection count grow with room size.

## Requirements

| Tool | Version |
|------|---------|
| Mattermost Server | 10.0.0+ |
| Go | See [`go.mod`](go.mod) (currently 1.25+) |
| Node.js | 20+ recommended (CI uses 20) |
| npm | Bundled with Node |

Supported plugin binaries: **linux/amd64**, **linux/arm64**, **darwin/amd64**, **darwin/arm64**, **windows/amd64**.

## Installation

1. Build the plugin bundle from source (see [Build](#build)). If a packaged release is published, download its `.tar.gz` asset; GitHub's automatically generated source archives are not installable plugin bundles.
2. In Mattermost: **System Console → Plugins → Plugin Management → Upload**.
3. Enable the plugin.

See also the [Mattermost plugin developer docs](https://developers.mattermost.com/integrate/plugins/) and [product documentation](https://docs.mattermost.com/).

## Configuration

**System Console → Plugins → WebRTC Video**

| Setting | Description |
|---------|-------------|
| **STUN server** | ICE server for NAT discovery. Format: `stun:host:port`. If unset, the client falls back to public Google STUN URLs. |
| **TURN server** | Relay for restrictive NATs. Format: `turn:host:port`. Strongly recommended for production. |
| **TURN username** | Optional credentials for your TURN server. |
| **TURN credential** | Optional password for your TURN server. |

Example STUN:

```text
stun:stun.l.google.com:19302
```

Run or subscribe to your own **TURN** service for reliable connectivity. Do not rely on third-party credentials embedded in documentation.

TURN settings are delivered to authenticated browsers because WebRTC needs them to establish connections. Use dedicated, limited credentials rather than reusing an administrative secret.

## Build

From the repository root:

```bash
make          # lint, test, and produce the release bundle
make dist     # build only (skip lint/test)
make deploy   # build and install to a dev server (see below)
```

Output: `dist/mattermost-webrtc-video-<version>.tar.gz`

The bundle retains the original `mattermost-webrtc-video` prefix because changing the plugin ID would make Mattermost treat it as a different plugin.

After changing the version in `plugin.json`, run `make apply` so `server/manifest.go` and `webapp/src/manifest.js` stay in sync.

### Make targets

| Target | Description |
|--------|-------------|
| `make` / `make all` | `check-style`, `test`, and `dist` |
| `make check-style` | Go fmt/vet/lint + ESLint |
| `make test` | Go unit tests + Jest |
| `make server` | Cross-compile Go plugin binaries |
| `make webapp` | Production webpack bundle |
| `make webapp-debug` | Unminified webpack bundle |
| `make deploy` | Upload bundle via API or copy to sibling `mattermost-server` |
| `make clean` | Remove build artifacts and `node_modules` |

### Deploy to a dev server

**Via Mattermost API** (set env vars, then `make deploy`):

```bash
export MM_SERVICESETTINGS_SITEURL=https://localhost:8065
export MM_ADMIN_USERNAME=admin
export MM_ADMIN_PASSWORD=your-password
make deploy
```

**Via filesystem** — if `../mattermost-server` exists, the bundle is extracted into its `plugins/` directory. Restart the server and enable the plugin manually.

## Development

```bash
cd webapp && npm install   # or: make webapp/.npminstall
make check-style           # lint
make test                  # unit tests
make webapp-debug          # faster rebuilds while iterating
```

`make test` runs `npm run fix` before Jest and can rewrite webapp files. Review the working tree after running it.

The webapp is bundled with **webpack 5**. React / Redux / PropTypes / React Bootstrap are **externals** provided by the Mattermost webapp at runtime — do not bundle them.

[`mattermost-redux`](https://www.npmjs.com/package/mattermost-redux) is pinned for selector compatibility with the host webapp. Keep it aligned with your Mattermost server version family.

### Project layout

```
plugin.json          Plugin manifest and settings schema
server/              Go API, signal broker, room/presence state, invitations
webapp/src/          React/Redux UI, WebRTC actions, events, and API clients
assets/              Images packaged with the plugin
build/               Manifest tooling and shared Make rules
dist/                Generated plugin bundle and unpacked build output
webapp/webpack.config.js
Makefile
```

### CI

GitHub Actions runs `make check-style` and `make test` on push/PR (see [`.github/workflows/ci.yml`](.github/workflows/ci.yml)).

## Troubleshooting

| Symptom | Likely cause |
|---------|----------------|
| Calls connect but no audio/video | Missing or misconfigured TURN; check browser console and ICE candidate logs. |
| `backend executable not found for environment: darwin/arm64` | Rebuild from a branch whose `plugin.json` includes `darwin-arm64`, then re-upload the bundle. |
| Signalling works on one node only | Expected with in-memory broker on multi-node Mattermost; see [Architecture](#architecture). |
| Plugin fails to load after upgrade | Confirm Mattermost meets `min_server_version` and upload a fresh bundle built for your OS/arch. |

Enable browser devtools and look for `[mattermost-webrtc-video]` debug output (see `webapp/src/utils/debug.js`).

## Contributing

Issues and pull requests are welcome on [GitHub](https://github.com/lenerson/mattermost-plugin-voices). Read [`AGENTS.md`](AGENTS.md) for repository structure, verification commands, branch naming, and commit conventions before contributing.

## License

[Apache License 2.0](LICENSE)

See [CHANGELOG.md](CHANGELOG.md) for the complete release history and the improvements made after the original project was forked.
