#!/usr/bin/env bash
# Prefetches the pinned Redis image of the store tests (tests/redis-image.sh) as an OCI image
# archive that `docker load` accepts: $CI_CACHE_DIR/web-proxy/tools/redis-<index digest>.tar, with
# a .complete marker. Prints "redis image: prefetched PATH" when it was already there, otherwise
# "redis image: installed now PATH"; exits non-zero on any failure.
#
# The nightly CI image build runs it with no argument from a fresh clone of main, as a user that
# may write only $CI_CACHE_DIR/web-proxy, with HOME=$CI_CACHE_DIR/web-proxy and no Docker. The
# rust-test part of .github/scripts/ci-run.sh runs it as the fallback for images built without it.
#
# No Docker, so it uses the registry API v2 with an anonymous token: Docker Hub first, and
# public.ecr.aws (the same digests) only if Docker Hub fails; one attempt each, no retry. Every
# body is checked against its sha256 digest before use, so the bytes are the pinned image whichever
# registry sent them. The archive is built in a temporary folder and renamed into place.
# REGISTRY_URL, MIRROR_URL and AUTH_URL (the Docker Hub token service) override the endpoints.
set -euo pipefail
: "${CI_CACHE_DIR:?is not set}"
# shellcheck source=../../tests/redis-image.sh
. "$(dirname "$0")/../../tests/redis-image.sh"
registry=${REGISTRY_URL:-https://registry-1.docker.io}
mirror=${MIRROR_URL:-https://public.ecr.aws}
auth=${AUTH_URL:-https://auth.docker.io/token}
tools="$CI_CACHE_DIR/web-proxy/tools"
archive="$tools/$REDIS_ARCHIVE_NAME"
index_types=application/vnd.oci.image.index.v1+json,application/vnd.docker.distribution.manifest.list.v2+json
manifest_types=application/vnd.oci.image.manifest.v1+json,application/vnd.docker.distribution.manifest.v2+json

if [ -f "$archive.complete" ] && [ -f "$archive" ]; then
  echo "redis image: prefetched $archive"
  exit 0
fi

# get URL TOKEN ACCEPT DIGEST OUT: one GET, then the body's sha256 must be DIGEST.
get() {
  curl -fsSL --connect-timeout 10 --max-time 120 -H "Authorization: Bearer $2" -H "Accept: $3" \
    -o "$5" "$1" || return 1
  if [ "sha256:$(sha256sum "$5" | cut -d ' ' -f 1)" != "$4" ]; then
    echo "redis image: digest mismatch for $4 from $1" >&2
    return 1
  fi
}

# download BASE REPO TOKEN_URL DIR: the linux/amd64 image from one registry into DIR as an OCI
# image layout. Called in a condition, so every step checks its own status.
download() {
  local base=$1 repo=$2 dir=$4 token manifest blob blobs list
  token=$(curl -fsS --connect-timeout 10 --max-time 30 "$3" | jq -er .token) || return 1
  blobs="$dir/blobs/sha256"
  mkdir -p "$blobs" || return 1
  get "$base/v2/$repo/manifests/$REDIS_INDEX_DIGEST" "$token" "$index_types" "$REDIS_INDEX_DIGEST" \
    "$dir/image-index.json" || return 1
  manifest=$(jq -er '[.manifests[] | select(.platform.os == "linux" and .platform.architecture == "amd64")
    | .digest][0] // empty' "$dir/image-index.json") || return 1
  get "$base/v2/$repo/manifests/$manifest" "$token" "$manifest_types" "$manifest" \
    "$blobs/${manifest#sha256:}" || return 1
  list=$(jq -er '.config.digest, .layers[].digest' "$blobs/${manifest#sha256:}") || return 1
  for blob in $list; do
    get "$base/v2/$repo/blobs/$blob" "$token" '*/*' "$blob" "$blobs/${blob#sha256:}" || return 1
  done
  # The layout's own index names the one manifest; docker load reads the image name from it.
  jq -n --arg digest "$manifest" --argjson size "$(wc -c < "$blobs/${manifest#sha256:}")" \
    --arg type "$(jq -r '.mediaType // "application/vnd.oci.image.manifest.v1+json"' "$blobs/${manifest#sha256:}")" \
    --arg name "docker.io/$REDIS_LOCAL_IMAGE" --arg tag "$REDIS_TAG" \
    '{schemaVersion: 2, mediaType: "application/vnd.oci.image.index.v1+json",
      manifests: [{mediaType: $type, digest: $digest, size: $size,
        platform: {os: "linux", architecture: "amd64"},
        annotations: {"io.containerd.image.name": $name, "org.opencontainers.image.ref.name": $tag}}]}' \
    > "$dir/index.json" || return 1
  rm -f "$dir/image-index.json"
  echo '{"imageLayoutVersion":"1.0.0"}' > "$dir/oci-layout"
}

mkdir -p "$tools"
work=$(mktemp -d "$tools/.redis.XXXXXX")
trap 'rm -rf "$work"' EXIT
hub_token="$auth?service=registry.docker.io&scope=repository:$REDIS_REPO_HUB:pull"
mirror_token="$mirror/token/?scope=repository:$REDIS_REPO_MIRROR:pull"
if ! download "$registry" "$REDIS_REPO_HUB" "$hub_token" "$work/layout"; then
  echo "redis image: $registry failed; trying $mirror" >&2
  rm -rf "$work/layout"
  if ! download "$mirror" "$REDIS_REPO_MIRROR" "$mirror_token" "$work/layout"; then
    echo "redis image: download failed from $registry and $mirror" >&2
    exit 1
  fi
fi
tar -cf "$work/image.tar" -C "$work/layout" oci-layout index.json blobs
rm -f "$archive.complete"
mv -f "$work/image.tar" "$archive"
touch "$archive.complete"
echo "redis image: installed now $archive"
