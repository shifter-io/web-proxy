#!/bin/sh
# Real Redis store tests without a TCP listener, published ports or live traffic.
set -eu
fixture_dir=$(mktemp -d "${TMPDIR:-/tmp}/allowance-redis.XXXXXX")
container=""
cleanup() {
  if [ -n "$container" ]; then docker rm -f "$container" >/dev/null; fi
  rm -rf "$fixture_dir"
}
trap cleanup EXIT HUP INT TERM
chmod 777 "$fixture_dir"
container=$(docker run -d --rm --network none -v "$fixture_dir:/data" \
  redis:7.4-alpine@sha256:858f009f9709ce576febc734aa78b8f6d624b82571f9ddb6bda4377c833b3499 \
  redis-server --port 0 --save '' --appendonly no --protected-mode yes \
  --unixsocket /data/redis.sock --unixsocketperm 777)
attempt=0
until docker exec "$container" redis-cli -s /data/redis.sock ping >/dev/null 2>&1; do
  attempt=$((attempt + 1))
  [ "$attempt" -lt 30 ] || { echo 'Redis fixture did not become ready' >&2; exit 1; }
  sleep 1
done
if [ "$#" -eq 0 ]; then
  set -- cargo test --locked store::tests -- --include-ignored
fi
REDIS_TEST_URL="redis+unix://$fixture_dir/redis.sock" "$@"
