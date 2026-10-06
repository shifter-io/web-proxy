#!/bin/sh
set -eu
cd "$(dirname "$0")/.."
if [ "$(uname -s)" = Darwin ]; then
  docker() { /bin/zsh -c 'exec "$@"' sh docker "$@"; }
fi
sh scripts/configure.sh
case "${1:-mock}" in
  mock) export SHIFTER_CREDENTIALS_FILE=./tests/fixtures/credentials.toml; docker compose --profile test -f compose.yaml -f compose.test.yaml up -d --build ;;
  live) docker compose -f compose.yaml up -d --build --remove-orphans ;;
  down) export SHIFTER_CREDENTIALS_FILE=./tests/fixtures/credentials.toml; docker compose --profile test -f compose.yaml -f compose.test.yaml down ;;
  *) echo 'Usage: sh scripts/stack.sh mock|live|down' >&2; exit 2 ;;
esac
