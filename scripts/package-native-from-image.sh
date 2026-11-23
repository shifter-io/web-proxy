#!/usr/bin/env bash
set -euo pipefail
image="$1"
commit="$2"
output="$3"
[[ "$commit" =~ ^[0-9a-f]{40}$ ]]
test "$(docker image inspect "$image" --format '{{index .Config.Labels "org.opencontainers.image.revision"}}')" = "$commit"
work=$(mktemp -d)
container=$(docker create "$image")
trap 'docker rm "$container" >/dev/null; rm -rf "$work"' EXIT
docker cp "$container:/usr/local/bin/shifter-web" "$work/shifter-web"
docker cp "$container:/app/web" "$work/web"
chmod 755 "$work/shifter-web"
printf 'commit=%s\nsource_modified=false\nimage=%s\n' "$commit" "$(docker image inspect "$image" --format '{{.Id}}')" > "$work/BUILD.txt"
(cd "$work"; find web -type f -print0 | sort -z | xargs -0 sha256sum > SHA256SUMS; sha256sum shifter-web BUILD.txt >> SHA256SUMS)
tar -czf "$output" -C "$work" .
sha256sum "$output"
