#!/usr/bin/env bash
# Whole-tree repository policy for tracked files; needs no credentials or network.
# Checks:
# 1. No tracked file is excluded by .gitignore (local configuration, secrets, keys, artifacts).
# 2. No tracked text holds a private key block.
# 3. No tracked text holds an absolute home-directory path.
# 4. Every workflow runs-on line names a self-hosted CI pool label, the dispatch size input with a
#    ci-8cpu, ci-16cpu or ci-32cpu default, or ubuntu-latest in the two Maestro workflows only.
# 5. No workflow uses pull_request_target.
# 6. Every workflow action is a local path or pinned to a full commit SHA.
# Prints every finding, one ::error:: line per failed check, and exits 1 if any check failed.
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"

failed=0
fail() {
  echo "::error::$1"
  failed=1
}

if git ls-files --cached --ignored --exclude-standard | grep .; then
  fail "tracked files match .gitignore; untrack them (git rm --cached) or fix the ignore rules"
fi

if git grep -nIE -e '-----BEGIN ([A-Z0-9]+ )*PRIVATE KEY-----' -- . ':!.github/scripts/repo-policy.sh'; then
  fail "tracked text contains a private key block"
fi

if git grep -nIE -e '/(Users|home)/[A-Za-z0-9._-]+/' -- . ':!.github/scripts/repo-policy.sh'; then
  fail "tracked text contains an absolute home-directory path"
fi

# Bracket expressions keep the literal $ { } | . portable across regex engines.
pool_re='^[[:space:]]*runs-on: \[self-hosted, ci-(2|4|8|16|32)cpu\][[:space:]]*$'
size_re="^[[:space:]]*runs-on: \[self-hosted, \"[$][{][{] inputs[.]size [|][|] 'ci-(8|16|32)cpu' [}][}]\"\][[:space:]]*$"
github_re='^[[:space:]]*runs-on: ubuntu-latest[[:space:]]*$'
while IFS=: read -r file line text; do
  if [[ $text =~ $pool_re || $text =~ $size_re ]]; then
    continue
  fi
  case "$file" in
    .github/workflows/maestro-policy.yml | .github/workflows/maestro-queue.yml)
      if [[ $text =~ $github_re ]]; then
        continue
      fi
      ;;
  esac
  fail "$file:$line: runs-on must be [self-hosted, ci-Ncpu] (N = 2, 4, 8, 16 or 32), [self-hosted, \"\${{ inputs.size || 'ci-Ncpu' }}\"] (N = 8, 16 or 32), or ubuntu-latest in maestro-policy.yml and maestro-queue.yml"
done < <(git grep -nE -e 'runs-on:' -- '.github/workflows/')

if git grep -nF -e 'pull_request_target' -- '.github/workflows/'; then
  fail "workflows must not use pull_request_target"
fi

if git grep -nE -e 'uses:' -- '.github/workflows/' \
  | grep -vE ':[[:space:]]*(-[[:space:]]+)?uses: (\./[^[:space:]]+|[^[:space:]@]+@[0-9a-f]{40})([[:space:]]+#.*)?[[:space:]]*$'; then
  fail "every action must be a local ./ path or pinned to a full 40-character commit SHA"
fi

if [ "$failed" -ne 0 ]; then
  exit 1
fi
echo "repository policy: all checks passed"
