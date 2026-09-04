# Build toolchain for the plugin bundle, used by ./docker-make and ./podman-make.
# Go builds the server binaries, Node builds the webapp; both track what CI uses
# (the Go version from go.mod, Node 20).

FROM node:20-bookworm-slim AS node

FROM golang:1.25-bookworm

# make and a C toolchain for the build; git for the webrtc-swarm GitHub dependency.
RUN apt-get update \
    && apt-get install -y --no-install-recommends build-essential git \
    && rm -rf /var/lib/apt/lists/*

# Node comes from the official image — Debian's packaged npm is far too old for
# this webapp, and both images are bookworm so the glibc matches.
COPY --from=node /usr/local/bin/node /usr/local/bin/node
COPY --from=node /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/npm
RUN ln -s /usr/local/lib/node_modules/npm/bin/npm-cli.js /usr/local/bin/npm \
    && ln -s /usr/local/lib/node_modules/npm/bin/npx-cli.js /usr/local/bin/npx

WORKDIR /src

CMD ["/bin/sh"]
