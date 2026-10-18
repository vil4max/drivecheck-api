#!/usr/bin/env python3
"""Requirement trace check: every approved requirement in specs/*/spec.md is cited by a test.

A test cites a requirement when its title starts with the ID (`test("REQ-PROVIDER-001 reads ...")`).
Exit 0 when the trace holds, 1 when it does not, 2 on a usage error. Rules:
specs/001-cached-api-and-status-page/plan.md, "Requirement trace check".
"""

from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path

REQ_HEADING = re.compile(r"^#{2,4}\s+(?P<id>REQ-[A-Z][A-Z0-9]*-\d{3})\b")
ANY_HEADING = re.compile(r"^#{1,6}\s")
STATUS_LINE = re.compile(r"^Status:\s*(?P<word>[A-Za-z]+)")
ANY_REF = re.compile(r"(?<![A-Za-z0-9])REQ-[A-Z][A-Z0-9]*-\d{3}(?![0-9])")
# Only IDs that open a title cite; one later in the title is prose.
LEADING_REFS = re.compile(r"^(?:REQ-[A-Z][A-Z0-9]*-\d{3}\s+)+")
TEST_CALL = re.compile(r"""\b(?:test|it)(?P<modifier>\.\w+)?\(\s*(?P<q>["'`])(?P<title>.*?)(?P=q)""")


def requirements(root: Path) -> tuple[dict[str, str], list[str]]:
    """Map each defined ID to its status word; also return errors for duplicate definitions."""
    found: dict[str, str] = {}
    where: dict[str, Path] = {}
    errors: list[str] = []
    for spec in sorted(root.glob("specs/*/spec.md")):
        current: str | None = None
        for line in spec.read_text(encoding="utf-8").splitlines():
            heading = REQ_HEADING.match(line)
            if heading:
                current = heading.group("id")
                if current in where:
                    errors.append(f"{current} is defined twice: {where[current]} and {spec}")
                where[current] = spec
                found[current] = ""
                continue
            if ANY_HEADING.match(line):
                current = None
                continue
            status = STATUS_LINE.match(line)
            if current and status and not found[current]:
                found[current] = status.group("word").lower()
    return found, errors


def cited_ids(title: str) -> list[str]:
    prefix = LEADING_REFS.match(title + " ")
    return ANY_REF.findall(prefix.group(0)) if prefix else []


def citing_tests(root: Path) -> tuple[dict[str, set[str]], dict[str, set[Path]]]:
    """Map each requirement to the test titles that cite it, and every mentioned ID to its files."""
    cited: dict[str, set[str]] = {}
    mentioned: dict[str, set[Path]] = {}
    for path in sorted((root / "tests").rglob("*.test.ts")):
        text = path.read_text(encoding="utf-8")
        for ref in ANY_REF.findall(text):
            mentioned.setdefault(ref, set()).add(path)
        for call in TEST_CALL.finditer(text):
            if call.group("modifier") in (".skip", ".todo"):
                continue
            title = call.group("title")
            for req_id in cited_ids(title):
                cited.setdefault(req_id, set()).add(title)
    return cited, mentioned


def passed_titles(report: Path) -> set[str]:
    """Titles of test cases that passed in a Vitest JSON report."""
    data = json.loads(report.read_text(encoding="utf-8"))
    passed: set[str] = set()
    failed: set[str] = set()
    for suite in data.get("testResults", []):
        for case in suite.get("assertionResults", []):
            title = case.get("title", "")
            if case.get("status") == "passed":
                passed.add(title)
            elif case.get("status") == "failed":
                failed.add(title)
    return passed - failed


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--root", type=Path, default=Path(__file__).resolve().parents[1])
    parser.add_argument(
        "--results",
        type=Path,
        help="Vitest JSON report; a citing test must also have run and passed",
    )
    args = parser.parse_args(argv)

    defined, errors = requirements(args.root)
    if not defined:
        print(f"spec-trace: no requirement found under {args.root / 'specs'}", file=sys.stderr)
        return 2

    cited, mentioned = citing_tests(args.root)
    if args.results is not None:
        if not args.results.is_file():
            print(f"spec-trace: no Vitest JSON report at {args.results}", file=sys.stderr)
            return 2
        passed = passed_titles(args.results)
        cited = {req: titles & passed for req, titles in cited.items()}

    for req_id in sorted(mentioned.keys() - defined.keys()):
        files = ", ".join(str(path.relative_to(args.root)) for path in sorted(mentioned[req_id]))
        errors.append(f"{req_id} is cited by a test but defined in no spec: {files}")

    for req_id in sorted(req for req, status in defined.items() if status == "approved"):
        if not cited.get(req_id):
            how = "a test that ran and passed" if args.results is not None else "a test"
            errors.append(f"{req_id} is approved but not cited by {how}")

    if errors:
        for error in errors:
            print(f"spec-trace: {error}", file=sys.stderr)
        return 1
    approved = sum(1 for status in defined.values() if status == "approved")
    print(f"spec-trace: OK, {len(defined)} requirements, {approved} approved, all approved cited")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
