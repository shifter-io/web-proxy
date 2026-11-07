# CI parts: run the parts of one CI job at the same time, each with its own log and exit status.
# A bash library: source it (it works under set -euo pipefail), declare parts, then call parts_wait.
#   part NAME CMD...           runs CMD in the background. It writes $CI_EVIDENCE/parts/NAME.log
#                              (stdout and stderr), NAME.time (start and end, epoch seconds) and
#                              NAME.rc (exit status, written last). CMD runs under set -eo pipefail,
#                              so a failure inside a pipeline or a function fails the part.
#   part_after DEP NAME CMD... runs CMD as part NAME once part DEP ended with status 0. When DEP
#                              failed or ended without a result, NAME is "not run: DEP failed".
#                              When DEP was skipped, NAME is skipped too.
#   part_skip NAME RULE        records NAME as "skipped: RULE"; RULE names the file that holds it.
#   parts_wait                 waits for every part, reports each declared part in declaration
#                              order, prints each failed part's log in a ::group:: and appends the
#                              table to $GITHUB_STEP_SUMMARY (stdout when unset). Returns 1 when a
#                              part failed, had no result or was not run; otherwise 0.
# CMD may be a shell function defined before the call. Status notes (skipped, not run) are kept in
# NAME.note. Names are letters, digits, dot, underscore and dash.
# Call part and part_after as plain commands, never after ||, && or if (bash then ignores set -e
# inside CMD), and CMD must not set an EXIT trap (the part records its status in one). parts_wait
# waits for every background job of the shell, so start no other background job before it.

CI_PARTS_NAMES=()
CI_PARTS_PIDS=()

_ci_parts_dir() {
  if [ -z "${CI_EVIDENCE:-}" ]; then
    echo "ci-parts: CI_EVIDENCE must be set to the evidence directory" >&2
    return 2
  fi
  mkdir -p "$CI_EVIDENCE/parts"
  echo "$CI_EVIDENCE/parts"
}

# _ci_part_declare DIR NAME: checks NAME, removes its old files and adds it to the declared list.
_ci_part_declare() {
  local name=$2 known
  if ! [[ $name =~ ^[A-Za-z0-9][A-Za-z0-9._-]*$ ]]; then
    echo "ci-parts: invalid part name '$name'" >&2
    return 2
  fi
  for known in "${CI_PARTS_NAMES[@]}"; do
    if [ "$known" = "$name" ]; then
      echo "ci-parts: part '$name' is declared twice" >&2
      return 2
    fi
  done
  rm -f "$1/$name.log" "$1/$name.time" "$1/$name.rc" "$1/$name.note"
  CI_PARTS_NAMES+=("$name")
}

# _ci_part_write FILE TEXT: writes through a temporary file, so a reader never sees a partial file.
_ci_part_write() {
  echo "$2" > "$1.tmp"
  mv -f "$1.tmp" "$1"
}

# _ci_part_end STATUS: the part's EXIT trap; records the end time, then the exit status.
_ci_part_end() {
  date +%s >> "$_ci_part_base.time"
  _ci_part_write "$_ci_part_base.rc" "$1"
}

# _ci_part_body DIR NAME CMD...: runs inside the part's background subshell.
_ci_part_body() {
  _ci_part_base=$1/$2
  shift 2
  date +%s > "$_ci_part_base.time"
  trap '_ci_part_end "$?"' EXIT
  set -eo pipefail
  "$@" > "$_ci_part_base.log" 2>&1
}

part() {
  local d name=${1:-}
  if [ "$#" -lt 2 ]; then
    echo "ci-parts: usage: part NAME CMD..." >&2
    return 2
  fi
  d=$(_ci_parts_dir) || return 2
  _ci_part_declare "$d" "$name" || return 2
  shift
  (_ci_part_body "$d" "$name" "$@") &
  CI_PARTS_PIDS+=("$!")
}

part_skip() {
  local d
  if [ "$#" -ne 2 ] || [ -z "$2" ]; then
    echo "ci-parts: usage: part_skip NAME RULE" >&2
    return 2
  fi
  d=$(_ci_parts_dir) || return 2
  _ci_part_declare "$d" "$1" || return 2
  _ci_part_write "$d/$1.note" "skipped: $2"
  CI_PARTS_PIDS+=("")
}

# _ci_part_alive PID: true while PID runs; a finished child the shell has not reaped yet is a zombie.
_ci_part_alive() {
  local stat
  stat=$(ps -o stat= -p "$1") || return 1
  [[ $stat != Z* ]]
}

# _ci_part_dep_passed DIR DEP PID: waits until DEP has a result or its process is gone; true when
# DEP ended with status 0.
_ci_part_dep_passed() {
  while ! [ -e "$1/$2.rc" ] && ! [ -e "$1/$2.note" ] && _ci_part_alive "$3"; do
    sleep 0.2
  done
  [ -e "$1/$2.rc" ] && [ "$(cat "$1/$2.rc")" = 0 ]
}

part_after() {
  local d dep=${1:-} name=${2:-} pid="" note i
  if [ "$#" -lt 3 ]; then
    echo "ci-parts: usage: part_after DEP NAME CMD..." >&2
    return 2
  fi
  d=$(_ci_parts_dir) || return 2
  for i in "${!CI_PARTS_NAMES[@]}"; do
    if [ "${CI_PARTS_NAMES[$i]}" = "$dep" ]; then
      pid=${CI_PARTS_PIDS[$i]:--}
    fi
  done
  if [ -z "$pid" ]; then
    echo "ci-parts: part_after $name: part '$dep' is not declared before it" >&2
    return 2
  fi
  if [ "$pid" = - ]; then
    note=$(cat "$d/$dep.note")
    part_skip "$name" "$dep is ${note}"
    return
  fi
  _ci_part_declare "$d" "$name" || return 2
  shift 2
  (
    if _ci_part_dep_passed "$d" "$dep" "$pid"; then
      _ci_part_body "$d" "$name" "$@"
    else
      _ci_part_write "$d/$name.note" "not run: $dep failed"
    fi
  ) &
  CI_PARTS_PIDS+=("$!")
}

# _ci_part_result DIR NAME: prints "STATUS<TAB>SECONDS"; STATUS starts with passed, failed, no
# result, not run or skipped.
_ci_part_result() {
  local base=$1/$2 status seconds=- times
  if [ -e "$base.note" ]; then
    status=$(cat "$base.note")
  elif [ -e "$base.rc" ]; then
    status=$(cat "$base.rc")
    if [ "$status" = 0 ]; then status=passed; else status="failed (exit $status)"; fi
  else
    status="no result (crashed or killed)"
  fi
  if [ -e "$base.time" ]; then
    mapfile -t times < "$base.time"
    if [ "${#times[@]}" -ge 2 ]; then seconds=$((times[1] - times[0])); fi
  fi
  printf '%s\t%s\n' "$status" "$seconds"
}

parts_wait() {
  local d name result status seconds failed=0 table
  d=$(_ci_parts_dir) || return 2
  wait
  table=$'| Part | Result | Seconds |\n| --- | --- | --- |\n'
  for name in "${CI_PARTS_NAMES[@]}"; do
    result=$(_ci_part_result "$d" "$name")
    status=${result%$'\t'*}
    seconds=${result##*$'\t'}
    echo "part $name: $status (${seconds} s)"
    table+="| $name | $(sed 's/|/\\|/g' <<< "$status") | $seconds |"$'\n'
    if [[ $status == passed || $status == skipped:* ]]; then continue; fi
    failed=1
    if [ -e "$d/$name.log" ]; then
      echo "::group::$name failed"
      cat "$d/$name.log"
      echo "::endgroup::"
    fi
  done
  if [ -n "${GITHUB_STEP_SUMMARY:-}" ]; then
    printf '%s' "$table" >> "$GITHUB_STEP_SUMMARY"
  else
    printf '%s' "$table"
  fi
  return "$failed"
}
