#!/usr/bin/env python3
"""Report test times from JUnit XML against the CI time rules.

Usage: ci-timing.py --start FILE --out FILE [--title TEXT] JUNIT...

Reads JUnit XML from cargo-nextest and from `node --test --test-reporter=junit`. --start holds the
test step's start time in epoch seconds. Writes to $GITHUB_STEP_SUMMARY (stdout when unset), per
file, the tests, passed, failed and skipped counts, the slowest tests and the step's time, and the
same data as JSON to --out.

A test is its name under the path of its enclosing <testsuite> names (nextest: the test binary; node:
the parent tests). Node's report names no file, so a top-level test name must be unique across the
test files of one report; runs of the same test have their times summed.

Rules: a test over 60 s and a step over 90 s print a ::warning::. Exits 1 when a test took 90 s or
more, the step took over 240 s, or a JUnit file is missing, unreadable, not JUnit or holds no test.
Exits 2 on a usage error. Standard library only.
"""

import argparse
import json
import os
import sys
import time
import xml.etree.ElementTree as ET

WARN_TEST_SECONDS = 60
MAX_TEST_SECONDS = 90
GOAL_STEP_SECONDS = 90
MAX_STEP_SECONDS = 240
SLOWEST = 20
SLOW_HINT = "over 60 s: mark it slow (Rust: name starts with slow_; JS: move the file to tests/slow/)"


class TimingError(Exception):
    """A bad input: a missing, unreadable or invalid file."""


def command(kind, message):
    """Print a GitHub workflow command, escaped so a test name cannot inject another one."""
    text = message.replace("%", "%25").replace("\r", "%0D").replace("\n", "%0A")
    print(f"::{kind}::{text}")


def read_start(path):
    try:
        with open(path, encoding="utf-8") as handle:
            return float(handle.read().strip())
    except (OSError, ValueError) as error:
        raise TimingError(f"--start {path}: no epoch seconds ({error})") from error


def testcases(element, suites=()):
    """Yield (suite path, <testcase>) for every test under `element`, depth first."""
    for child in element:
        if child.tag == "testsuite":
            yield from testcases(child, suites + (child.get("name", ""),))
        elif child.tag == "testcase":
            yield " > ".join(suites), child


def read_junit(path):
    """Return {(suite, name): {"seconds", "states"}} for every <testcase> in a JUnit file."""
    try:
        root = ET.parse(path).getroot()
    except (OSError, ET.ParseError) as error:
        raise TimingError(f"{path}: missing, unreadable or not XML ({error})") from error
    if root.tag not in ("testsuites", "testsuite"):
        raise TimingError(f"{path}: not JUnit (root element <{root.tag}>)")
    tests = {}
    top = (root.get("name", ""),) if root.tag == "testsuite" else ()
    for suite, case in testcases(root, top):
        key = (suite, case.get("name", ""))
        try:
            seconds = float(case.get("time", "0"))
        except ValueError as error:
            raise TimingError(f"{path}: test {key[1]} has an invalid time") from error
        if case.find("failure") is not None or case.find("error") is not None:
            state = "failed"
        elif case.find("skipped") is not None:
            state = "skipped"
        else:
            state = "passed"
        test = tests.setdefault(key, {"seconds": 0.0, "states": set()})
        test["seconds"] += seconds
        test["states"].add(state)
    if not tests:
        raise TimingError(f"{path}: holds no test")
    return tests


def file_counts(path, tests):
    """Count each test once: failed if any run failed, skipped if every run was skipped."""
    counts = {"file": path, "tests": len(tests), "passed": 0, "failed": 0, "skipped": 0}
    for test in tests.values():
        states = test["states"]
        state = "failed" if "failed" in states else "skipped" if states == {"skipped"} else "passed"
        counts[state] += 1
    return counts


def collect(paths, start):
    data = {"step_seconds": round(time.time() - start, 1), "files": [], "slowest": [], "errors": []}
    timed = []
    for path in paths:
        try:
            tests = read_junit(path)
        except TimingError as error:
            data["errors"].append(str(error))
            continue
        data["files"].append(file_counts(path, tests))
        for (suite, name), test in tests.items():
            timed.append({"file": path, "suite": suite, "name": name, "seconds": round(test["seconds"], 3)})
    timed.sort(key=lambda test: -test["seconds"])
    data["slowest"] = timed[:SLOWEST]
    data["over_warn"] = [test for test in timed if test["seconds"] > WARN_TEST_SECONDS]
    return data


def cell(text):
    return str(text).replace("|", "\\|").replace("\n", " ")


def summary(data, title):
    lines = [f"### {cell(title)}", "", f"Test step: {data['step_seconds']} s", ""]
    lines += ["| File | Tests | Passed | Failed | Skipped |", "| --- | --- | --- | --- | --- |"]
    for row in data["files"]:
        lines.append(f"| {cell(row['file'])} | {row['tests']} | {row['passed']} | {row['failed']} | {row['skipped']} |")
    for error in data["errors"]:
        lines.append(f"| {cell(error)} | - | - | - | - |")
    lines += ["", f"Slowest {len(data['slowest'])} tests:", "", "| Seconds | Test | Suite | File |"]
    lines.append("| --- | --- | --- | --- |")
    for test in data["slowest"]:
        lines.append(f"| {test['seconds']} | {cell(test['name'])} | {cell(test['suite'])} | {cell(test['file'])} |")
    return "\n".join(lines) + "\n\n"


def check(data):
    """Print the rule warnings and errors; return True when a rule failed."""
    failed = bool(data["errors"])
    for error in data["errors"]:
        command("error", error)
    for test in data["over_warn"]:
        label = f"{test['name']} ({test['file']}) took {test['seconds']} s"
        if test["seconds"] >= MAX_TEST_SECONDS:
            command("error", f"{label}: {MAX_TEST_SECONDS} s or more fails; {SLOW_HINT}")
            failed = True
        else:
            command("warning", f"{label}: {SLOW_HINT}")
    step = data["step_seconds"]
    if step > MAX_STEP_SECONDS:
        command("error", f"the test step took {step} s, over the {MAX_STEP_SECONDS} s limit")
        failed = True
    elif step > GOAL_STEP_SECONDS:
        command("warning", f"the test step took {step} s, over the {GOAL_STEP_SECONDS} s goal")
    return failed


def write_outputs(data, title, out):
    destination = os.environ.get("GITHUB_STEP_SUMMARY")
    text = summary(data, title)
    if destination:
        with open(destination, "a", encoding="utf-8") as handle:
            handle.write(text)
    else:
        sys.stdout.write(text)
    with open(out, "w", encoding="utf-8") as handle:
        json.dump({"title": title, **data}, handle, indent=2)
        handle.write("\n")


def main(argv=None):
    parser = argparse.ArgumentParser(description="Report test times from JUnit XML.")
    parser.add_argument("--start", required=True, help="file holding the step's start in epoch seconds")
    parser.add_argument("--out", required=True, help="JSON output file")
    parser.add_argument("--title", default="Test times", help="summary heading")
    parser.add_argument("junit", nargs="+", help="JUnit XML files")
    args = parser.parse_args(argv)
    try:
        data = collect(args.junit, read_start(args.start))
        write_outputs(data, args.title, args.out)
    except (TimingError, OSError) as error:
        print(f"ci-timing: {error}", file=sys.stderr)
        return 1
    return 1 if check(data) else 0


if __name__ == "__main__":
    sys.exit(main())
