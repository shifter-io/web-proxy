# syntax=docker/dockerfile:1
FROM node:24-bookworm-slim@sha256:d6aa754f16b3197301076f047b5def2f02ea1dbbc2ca920407d46d7ec7f87b20 AS web
WORKDIR /build
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts --omit=dev
COPY scripts/vendor.mjs scripts/vendor.mjs
COPY scripts/compat scripts/compat
COPY web web
RUN node scripts/vendor.mjs

FROM rust:1.94.1-bookworm@sha256:6ae102bdbf528294bc79ad6e1fae682f6f7c2a6e6621506ba959f9685b308a55 AS build
WORKDIR /build
COPY Cargo.toml Cargo.lock ./
COPY src src
RUN --mount=type=cache,target=/usr/local/cargo/registry \
    --mount=type=cache,target=/usr/local/cargo/git \
    --mount=type=cache,target=/build/target \
    cargo build --release --locked && cp target/release/shifter-web /shifter-web

FROM debian:bookworm-slim@sha256:f06537653ac770703bc45b4b113475bd402f451e85223f0f2837acbf89ab020a
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates curl \
    && rm -rf /var/lib/apt/lists/* && useradd --uid 10001 --create-home app
WORKDIR /app
COPY --from=build /shifter-web /usr/local/bin/shifter-web
COPY --from=web /build/web /app/web
USER 10001
ENV WEB_DIR=/app/web
ENTRYPOINT ["shifter-web"]
