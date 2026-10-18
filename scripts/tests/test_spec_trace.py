"""Contract tests for scripts/spec-trace.py."""

from __future__ import annotations

import importlib.util
import json
import tempfile
import unittest
from contextlib import redirect_stderr, redirect_stdout
from io import StringIO
from pathlib import Path

SCRIPT = Path(__file__).resolve().parents[1] / "spec-trace.py"
spec = importlib.util.spec_from_file_location("spec_trace", SCRIPT)
spec_trace = importlib.util.module_from_spec(spec)
spec.loader.exec_module(spec_trace)

SPEC = """# Spec

### REQ-API-001 — Approved one

Status: approved

### REQ-API-002 — Proposed one

Status: proposed
"""


class SpecTraceTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        (self.root / "specs" / "001-x").mkdir(parents=True)
        (self.root / "specs" / "001-x" / "spec.md").write_text(SPEC, encoding="utf-8")
        (self.root / "tests").mkdir()

    def tearDown(self) -> None:
        self.tmp.cleanup()

    def run_trace(self, tests: str, report: dict | None = None) -> int:
        (self.root / "tests" / "a.test.ts").write_text(tests, encoding="utf-8")
        argv = ["--root", str(self.root)]
        if report is not None:
            path = self.root / "report.json"
            path.write_text(json.dumps(report), encoding="utf-8")
            argv += ["--results", str(path)]
        with redirect_stdout(StringIO()), redirect_stderr(StringIO()):
            return spec_trace.main(argv)

    def test_passes_when_every_approved_requirement_is_cited(self) -> None:
        self.assertEqual(self.run_trace('test("REQ-API-001 does it", () => {});'), 0)

    def test_fails_when_an_approved_requirement_is_only_mentioned_later_in_a_title(self) -> None:
        self.assertEqual(self.run_trace('test("does it like REQ-API-001", () => {});'), 1)

    def test_fails_on_an_undefined_id(self) -> None:
        tests = 'test("REQ-API-001 a", () => {});\ntest("REQ-API-009 b", () => {});'
        self.assertEqual(self.run_trace(tests), 1)

    def test_ignores_skipped_tests(self) -> None:
        self.assertEqual(self.run_trace('test.skip("REQ-API-001 later", () => {});'), 1)

    def test_with_a_report_the_citing_test_must_have_passed(self) -> None:
        tests = 'test("REQ-API-001 does it", () => {});'
        failed = {"testResults": [{"assertionResults": [{"title": "REQ-API-001 does it", "status": "failed"}]}]}
        passed = {"testResults": [{"assertionResults": [{"title": "REQ-API-001 does it", "status": "passed"}]}]}
        self.assertEqual(self.run_trace(tests, failed), 1)
        self.assertEqual(self.run_trace(tests, passed), 0)


if __name__ == "__main__":
    unittest.main()
