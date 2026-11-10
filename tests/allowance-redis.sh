#!/bin/sh
# Real Redis store tests without a TCP listener, published ports or live traffic.
# REDIS_IMAGE (default: the pin in tests/redis-image.sh) and REDIS_PULL (docker run --pull, default
# missing) let CI run the image it loaded from the server's cache with --pull never.
set -eu
. "$(dirname "$0")/redis-image.sh"
image=${REDIS_IMAGE:-redis:$REDIS_TAG@$REDIS_INDEX_DIGEST}
pull=${REDIS_PULL:-missing}
fixture_dir=$(mktemp -d "${TMPDIR:-/tmp}/allowance-redis.XXXXXX")
container=""
cleanup() {
  if [ -n "$container" ]; then docker rm -f "$container" >/dev/null; fi
  rm -rf "$fixture_dir"
}
trap cleanup EXIT HUP INT TERM
# The image hands /data to its redis user, under rootless Docker another host user. Mounting a
# subfolder keeps $fixture_dir ours, so cleanup can still remove it from a sticky /tmp.
socket_dir="$fixture_dir/redis"
mkdir "$socket_dir"
chmod 777 "$socket_dir"
echo "redis fixture: docker run --pull $pull --network none $image" >&2
container=$(docker run -d --rm --pull "$pull" --network none -v "$socket_dir:/data" "$image" \
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
REDIS_TEST_URL="redis+unix://$socket_dir/redis.sock" "$@"
