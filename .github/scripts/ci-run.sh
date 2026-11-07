#!/usr/bin/env bash
# Run every CI part at the same time on this server (ci.yml, step "Checks and tests in parallel").
# Uses .github/scripts/ci-parts.sh: each part has its own log and status, the job summary gets the
# parts table and the script exits 1 when a part failed, had no result or was not run.
# Needs, from the workflow's Scope and Tools steps:
#   SCOPE_RUST, SCOPE_NODE, SCOPE_AUDIT  true or false (.github/scripts/changed-scope.sh)
#   MODE                                 fast (pull requests: slow tests left out) or full
#   NEXTEST_PROFILE                      ci (fast) or full (.config/nextest.toml)
#   EVENT                                the GitHub event name
#   ACTIONLINT                           the verified actionlint binary
#   CI_EVIDENCE, RUNNER_TEMP             evidence and scratch directories
# A part that does not run is recorded as skipped with the rule that skipped it.
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"

for var in SCOPE_RUST SCOPE_NODE SCOPE_AUDIT MODE NEXTEST_PROFILE EVENT ACTIONLINT CI_EVIDENCE \
  RUNNER_TEMP; do
  if [ -z "${!var:-}" ]; then
    echo "ci-run.sh: $var must be set" >&2
    exit 2
  fi
done

# shellcheck source=.github/scripts/ci-parts.sh
. .github/scripts/ci-parts.sh

docs_rule="only documentation changed (.github/scripts/changed-scope.sh)"
rust_rule="no Rust input changed (.github/scripts/changed-scope.sh)"
package_rule="package files did not change (.github/scripts/changed-scope.sh)"
audit_rule="dependency audits run on PRs that change package files, on dispatch and nightly"
audit_rule+=" (maestro-nightly), never in the queue or the 6-hour run: a new advisory must not stop merges"

# The renderer rewrites files that other parts read, so it works on its own copy of HEAD.
docs() {
  local tree="$RUNNER_TEMP/docs"
  git worktree add --detach "$tree" HEAD
  cd "$tree"
  python3 scripts/render-readme.py
  if ! git diff --exit-code -- docs/readme.html docs/engineering.html; then
    echo "::error::docs/readme.html or docs/engineering.html is stale; run python3 scripts/render-readme.py and commit the result"
    return 1
  fi
}

node_test() {
  local files=(tests/*.test.mjs)
  if [ "$MODE" = full ]; then
    shopt -s nullglob
    files+=(tests/slow/*.test.mjs)
  fi
  node --test --test-timeout=90000 \
    --test-reporter=spec --test-reporter-destination=stdout \
    --test-reporter=junit --test-reporter-destination="$CI_EVIDENCE/node-junit.xml" "${files[@]}"
}

part policy bash .github/scripts/repo-policy.sh
part docs docs
part actionlint "$ACTIONLINT"

if [ "$SCOPE_RUST" = true ]; then
  part fmt cargo fmt --check
  part clippy cargo clippy --all-targets --locked --target-dir target/clippy -- -D warnings
  part rust-test cargo nextest run --locked --profile "$NEXTEST_PROFILE" --target-dir target/test
else
  rule=$rust_rule
  if [ "$SCOPE_NODE" != true ]; then rule=$docs_rule; fi
  part_skip fmt "$rule"
  part_skip clippy "$rule"
  part_skip rust-test "$rule"
fi

if [ "$SCOPE_NODE" = true ]; then
  part npm-ci npm ci --ignore-scripts --no-audit --no-fund --prefer-offline
  # vendor rewrites web/runtime/vendor/, which the tests read, so it runs after them.
  part_after npm-ci node-test node_test
  part_after node-test vendor node scripts/vendor.mjs
else
  part_skip npm-ci "$docs_rule"
  part_skip node-test "$docs_rule"
  part_skip vendor "$docs_rule"
fi

if [ "$EVENT" != pull_request ] && [ "$EVENT" != workflow_dispatch ]; then
  part_skip npm-audit "$audit_rule"
elif [ "$SCOPE_AUDIT" = true ]; then
  part npm-audit npm audit --audit-level=high --package-lock-only
elif [ "$SCOPE_NODE" != true ]; then
  part_skip npm-audit "$docs_rule"
else
  part_skip npm-audit "$package_rule"
fi

parts_wait
