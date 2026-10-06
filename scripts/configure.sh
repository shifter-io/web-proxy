#!/bin/sh
# Materialize local, gitignored configuration. Existing files are never replaced.
set -eu
cd "$(dirname "$0")/.."
copy_example() {
  source_file=$1
  local_file=$2
  if [ ! -e "$local_file" ]; then
    (umask 077; cp "$source_file" "$local_file")
    printf 'Created local configuration: %s\n' "$local_file"
  fi
}
copy_example compose.example.yaml compose.yaml
copy_example compose.test.example.yaml compose.test.yaml
copy_example deploy/haproxy.example.cfg deploy/haproxy.cfg
copy_example tests/fixtures/credentials.example.toml tests/fixtures/credentials.toml
copy_example .env.example .env
mkdir -p artifacts
