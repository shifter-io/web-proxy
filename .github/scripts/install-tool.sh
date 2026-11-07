#!/usr/bin/env bash
# Install a pinned release tarball into the runner cache and print the path of one file in it.
# Usage: install-tool.sh NAME VERSION SHA256 URL MEMBER
# The tarball at URL must have the SHA-256 SHA256. It is unpacked once into
# $CI_CACHE_DIR/web-proxy/tools/NAME-VERSION: into a temporary folder first, marked .complete, then
# renamed into place, so the cache never holds a partial folder. MEMBER is the file to print, relative
# to that folder (for example cargo-audit-x86_64-unknown-linux-musl-v0.22.2/cargo-audit).
# Runs on x86_64 Linux only; needs curl, sha256sum and tar.
set -euo pipefail

if [ "$#" -ne 5 ]; then
  echo "usage: install-tool.sh NAME VERSION SHA256 URL MEMBER" >&2
  exit 2
fi
name=$1 version=$2 sha256=$3 url=$4 member=$5
: "${CI_CACHE_DIR:?the runner must set CI_CACHE_DIR}"
if [ "$(uname -sm)" != "Linux x86_64" ]; then
  echo "install-tool.sh: $name is pinned for x86_64 Linux, not $(uname -sm)" >&2
  exit 1
fi

tools="$CI_CACHE_DIR/web-proxy/tools"
dest="$tools/$name-$version"
# A folder without .complete or without MEMBER is a leftover; replace it.
if ! [ -e "$dest/.complete" ] || ! [ -x "$dest/$member" ]; then
  rm -rf "$dest"
  mkdir -p "$tools"
  tmp=$(mktemp -d "$tools/.tmp.XXXXXX")
  trap 'rm -rf "$tmp"' EXIT
  curl -fsSL --retry 3 -o "$tmp/archive.tgz" "$url"
  echo "$sha256  $tmp/archive.tgz" | sha256sum --check --quiet - >&2
  mkdir "$tmp/x"
  tar -xzf "$tmp/archive.tgz" -C "$tmp/x" "$member"
  touch "$tmp/x/.complete"
  # A parallel run may rename its own copy first; then use that one.
  mv -T "$tmp/x" "$dest" 2>/dev/null || [ -e "$dest/.complete" ]
fi
if ! [ -x "$dest/$member" ]; then
  echo "install-tool.sh: $dest/$member is missing or not executable" >&2
  exit 1
fi
echo "$dest/$member"
