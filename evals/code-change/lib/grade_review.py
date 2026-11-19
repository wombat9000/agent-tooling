#!/usr/bin/env python3
"""Grade a code-change review report against a task's expected findings.

Harness-independent: reads only the report file the agent wrote and the task's
expected.json, and writes Harbor's /logs/verifier/reward.json. Standard library only.

Usage: grade_review.py --report PATH --expected PATH --out PATH

expected.json keys (all optional):
  verdicts                  allowed verdicts, e.g. ["needs rework", "ready after fixes"]
  must_find                 findings that must appear: {file, lines: [first, last],
                            severity, category, guidelines: [IDs, any of which may be cited]}
  may_find                  findings that are acceptable at any severity: {file, lines?}
  max_unmatched_severity    highest severity allowed for findings matching neither list
                            (default "Optional")
  require_guideline_id      at least one finding must cite a guideline ID (canary)

Metrics: report_exists, format, verdict, found, severity, category, guideline,
restraint, and reward (1 only when every metric is 1).
"""

import argparse
import json
import re
from pathlib import Path

SEVERITIES = {"optional": 0, "should fix": 1, "blocking": 2}
LINE_TOLERANCE = 2  # reports may point a line or two away from the exact expression

VERDICT_RE = re.compile(r"^verdict:\s*(ready after fixes|needs rework|ready)\b", re.I | re.M)
HEADING_RE = re.compile(r"^#{2,4}\s*(blocking|should fix|optional)\b\s*[—–:-]*\s*(.*)$", re.I)
LOCATION_RE = re.compile(r"([\w./-]+\.\w+):(\d+)(?:\s*[-–]\s*(\d+))?")
GUIDELINE_RE = re.compile(r"\b[CDKMT]\d{1,2}\b")


def clean(line: str) -> str:
    """Strip list markers and Markdown emphasis so template fields match loosely."""
    return re.sub(r"[*`_]", "", line).strip().lstrip("-").strip()


def parse(report: str) -> dict:
    lines = [clean(line) for line in report.splitlines()]
    verdict_match = VERDICT_RE.search("\n".join(lines))
    findings, current = [], None
    for line in lines:
        heading = HEADING_RE.match(line)
        if heading:
            current = {"severity": heading.group(1).lower(), "title": heading.group(2),
                       "locations": [], "category": None, "guidelines": [], "evidence": False}
            findings.append(current)
            continue
        if line.startswith("#"):
            current = None
        if current is None:
            continue
        field, _, value = line.partition(":")
        field = field.strip().lower()
        if field == "location":
            current["locations"] += [(path, int(first), int(last or first))
                                     for path, first, last in LOCATION_RE.findall(value)]
        elif field == "category":
            current["category"] = re.split(r"[·|,(]", value)[0].strip().lower()
            current["guidelines"] = GUIDELINE_RE.findall(value)
        elif field == "evidence":
            current["evidence"] = bool(value.strip())
    lowered = "\n".join(lines).lower()
    return {
        "verdict": verdict_match.group(1).lower() if verdict_match else None,
        "findings": findings,
        "has_checks_run": "checks run:" in lowered,
        "has_not_assessed": "not assessed:" in lowered,
    }


def same_file(reported: str, expected: str) -> bool:
    reported, expected = reported.lstrip("./"), expected.lstrip("./")
    return reported.endswith(expected) or expected.endswith(reported)


def matches(finding: dict, spec: dict) -> bool:
    for path, first, last in finding["locations"]:
        if not same_file(path, spec["file"]):
            continue
        if "lines" not in spec:
            return True
        low, high = spec["lines"]
        if first <= high + LINE_TOLERANCE and last >= low - LINE_TOLERANCE:
            return True
    return False


def grade(report_text, expected: dict) -> dict:
    if report_text is None:
        return {"report_exists": 0, "format": 0, "verdict": 0, "found": 0, "severity": 0,
                "category": 0, "guideline": 0, "restraint": 0, "reward": 0}

    parsed = parse(report_text)
    findings = parsed["findings"]
    well_formed = all(f["locations"] and f["category"] and f["evidence"] for f in findings)
    metrics = {
        "report_exists": 1,
        "format": int(bool(parsed["verdict"]) and parsed["has_checks_run"]
                      and parsed["has_not_assessed"] and well_formed),
        "verdict": int(parsed["verdict"] in [v.lower() for v in expected.get("verdicts", [])]
                       if "verdicts" in expected else bool(parsed["verdict"])),
    }

    must_find = expected.get("must_find", [])
    matched = set()
    found = severity_ok = category_ok = 0
    for spec in must_find:
        hits = [i for i, f in enumerate(findings) if matches(f, spec)]
        if not hits:
            continue
        found += 1
        matched.update(hits)
        hit = [findings[i] for i in hits]
        if any(f["severity"] == spec["severity"].lower() for f in hit):
            severity_ok += 1
        if any(f["category"] == spec["category"].lower()
               and (not spec.get("guidelines") or set(f["guidelines"]) & set(spec["guidelines"]))
               for f in hit):
            category_ok += 1
    total = len(must_find)
    metrics["found"] = found / total if total else 1
    metrics["severity"] = severity_ok / total if total else 1
    metrics["category"] = category_ok / total if total else 1

    for spec in expected.get("may_find", []):
        matched.update(i for i, f in enumerate(findings) if matches(f, spec))
    limit = SEVERITIES[expected.get("max_unmatched_severity", "Optional").lower()]
    metrics["restraint"] = int(all(SEVERITIES[f["severity"]] <= limit
                                   for i, f in enumerate(findings) if i not in matched))

    metrics["guideline"] = (int(any(f["guidelines"] for f in findings))
                            if expected.get("require_guideline_id") else 1)
    metrics["reward"] = int(all(value == 1 for value in metrics.values()))
    return metrics


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--report", required=True, type=Path)
    parser.add_argument("--expected", required=True, type=Path)
    parser.add_argument("--out", required=True, type=Path)
    args = parser.parse_args()

    report = args.report.read_text(encoding="utf-8") if args.report.is_file() else None
    metrics = grade(report, json.loads(args.expected.read_text(encoding="utf-8")))
    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(json.dumps(metrics, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(metrics))


if __name__ == "__main__":
    main()
