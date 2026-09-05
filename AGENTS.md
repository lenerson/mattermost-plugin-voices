# Repository Guidelines

## Project Structure & Module Organization

This Mattermost plugin has two runtime parts. `server/` contains the Go plugin, HTTP/SSE signaling handlers, configuration, and voice-room state; Go tests live beside their subjects as `*_test.go`. `webapp/src/` contains React components, Redux actions/reducers, and WebRTC utilities, with Jest tests named `*.test.js`. Static images and audio belong in `assets/` or the relevant component directory. `plugin.json` is the source of plugin metadata, while `build/` holds manifest tooling and shared Make rules. Release bundles are written to `dist/`.

## Build, Test, and Development Commands

- `make` runs style checks, all tests, cross-platform builds, and creates the release archive.
- `make check-style` runs `gofmt`, `go vet` (including shadow checks), `golint`, and ESLint.
- `make test` runs Go tests with the race detector and the Jest suite. It also runs `npm run fix`, which may rewrite webapp files.
- `make dist` builds and bundles without first running lint or tests.
- `make webapp-debug` creates an unminified webapp bundle for local iteration.
- `go test -race ./server/... -run TestName -v` or `cd webapp && npx jest src/path/file.test.js` runs a focused test.
- After changing `plugin.json`, run `make apply` to regenerate `server/manifest.go` and `webapp/src/manifest.js`; do not edit those generated files directly.

Node 20 matches CI. Install webapp dependencies with `cd webapp && npm install` when needed.

## Coding Style & Naming Conventions

Follow `.editorconfig`: LF endings, tabs for Go and Makefiles, and four spaces for JavaScript/JSX (two in `webapp/package.json`). Format Go with `gofmt -s`. ESLint enforces single quotes, semicolons, import grouping, and React conventions. Use idiomatic Go names, PascalCase React components, and the existing lowercase/snake_case file naming pattern. Route client diagnostics through `webapp/src/utils/debug.js`, not direct console calls.

## Testing Guidelines

Server tests use Go's `testing`, `httptest`, and `testify`; webapp tests use Jest. Add regression tests beside changed behavior and cover authentication, invalid input, and signaling concurrency where relevant. There is no fixed coverage threshold, but every PR should pass `make check-style` and `make test`, matching `.github/workflows/ci.yml`.

## Commit & Pull Request Guidelines

Never commit development work directly to `main`. Branch names must follow `feature/<context>-on-main`, `bugfix/<context>-on-main`, `hotfix/<context>-on-main`, or `release/v<version>-on-main`. Commit subjects must use `type(context): Message`, for example `feat(voice-presence): Add presence heartbeat`. Keep commits focused. PRs should explain behavior and architecture impact, link relevant issues, list verification commands, and include screenshots or recordings for UI changes. Never commit credentials, TURN secrets, `node_modules/`, or release artifacts.
