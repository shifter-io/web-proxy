#!/usr/bin/env bash
# Decide which CI jobs a change needs. Usage: changed-scope.sh <event-name> < changed-file-list
# Prints exactly three lines: rust=<true|false>, node=<true|false>, audit=<true|false>.
# Rules:
# - Any event other than pull_request runs everything.
# - A pull_request with no changed file runs everything (fail safe).
# - node runs unless every changed file is documentation (docs/, .cursor/, README, ENGINEERING,
#   AGENTS, LICENSE and the documentation renderers).
# - rust runs for src/, .cargo/, .github/, Cargo manifests, Rust toolchain files and the Dockerfile.
# - audit runs for .github/ and the npm manifests.
set -euo pipefail

if [ "$#" -lt 1 ]; then
  echo "usage: changed-scope.sh <event-name> < changed-file-list" >&2
  exit 2
fi
event=$1

docs_re='^(docs/|\.cursor/)|^(README\.md|ENGINEERING\.md|AGENTS\.md|LICENSE|scripts/render-readme\.py|scripts/generate-readme-header\.py)$'
rust_re='^(src/|\.cargo/|\.github/)|^(Cargo\.toml|Cargo\.lock|rust-toolchain|rust-toolchain\.toml|Dockerfile)$'
audit_re='^\.github/|^(package\.json|package-lock\.json)$'

rust=false
node=false
audit=false
files=0
while IFS= read -r f || [ -n "$f" ]; do
  if [ -z "$f" ]; then
    continue
  fi
  files=$((files + 1))
  if ! [[ $f =~ $docs_re ]]; then
    node=true
  fi
  if [[ $f =~ $rust_re ]]; then
    rust=true
  fi
  if [[ $f =~ $audit_re ]]; then
    audit=true
  fi
done

if [ "$event" != pull_request ] || [ "$files" -eq 0 ]; then
  rust=true
  node=true
  audit=true
fi

printf 'rust=%s\nnode=%s\naudit=%s\n' "$rust" "$node" "$audit"
