#!/usr/bin/env bash
# Open one issue when a scheduled or main run is red. Usage: report-red.sh TITLE
# If an open issue titled exactly TITLE exists, prints "already open: #N" and changes nothing (no
# comment, no label). Otherwise creates one issue titled TITLE whose body names the run.
# Needs GH_TOKEN, GITHUB_REPOSITORY, GITHUB_SERVER_URL, GITHUB_RUN_ID, GITHUB_SHA, GITHUB_REF_NAME
# and GITHUB_EVENT_NAME, plus gh and jq. Exits non-zero when one is missing or gh fails.
set -euo pipefail

if [ "$#" -ne 1 ] || [ -z "$1" ]; then
  echo "usage: report-red.sh TITLE" >&2
  exit 2
fi
title=$1

for var in GH_TOKEN GITHUB_REPOSITORY GITHUB_SERVER_URL GITHUB_RUN_ID GITHUB_SHA GITHUB_REF_NAME \
  GITHUB_EVENT_NAME; do
  if [ -z "${!var:-}" ]; then
    echo "report-red.sh: $var must be set" >&2
    exit 2
  fi
done

open=$(gh issue list -R "$GITHUB_REPOSITORY" --state open --search "in:title $title" \
  --json number,title --limit 100)
number=$(jq -r --arg title "$title" 'map(select(.title == $title)) | first | .number // empty' <<< "$open")
if [ -n "$number" ]; then
  echo "already open: #$number"
  exit 0
fi

run_url="$GITHUB_SERVER_URL/$GITHUB_REPOSITORY/actions/runs/$GITHUB_RUN_ID"
body="A $GITHUB_EVENT_NAME run failed.

- Run: $run_url
- Event: $GITHUB_EVENT_NAME
- Ref: $GITHUB_REF_NAME
- Commit: ${GITHUB_SHA:0:7}

The run's job summary lists the failed parts. This never blocks pull requests."
gh issue create -R "$GITHUB_REPOSITORY" --title "$title" --body "$body"
