#!/usr/bin/env node
/**
 * Grade REVIEW.md against expected.json and write Harbor's reward.json.
 * Uses only Node built-ins. Run with Node.js 22.18+; no build step is needed.
 */
import { mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

/** Locations are inclusive; matching allows two lines on either side. */
export interface FindingLocation {
  file: string;
  lines?: [number, number];
}

/** Severity/category compare without case; guideline IDs compare exactly. */
export interface ExpectedFinding extends FindingLocation {
  severity: string;
  category: string;
  /** Any one of these IDs must be cited in the category field. */
  guidelines?: string[];
}

/** All fields are optional. Unmatched findings default to at most Optional. */
export interface ExpectedReview {
  verdicts?: string[];
  must_find?: ExpectedFinding[];
  may_find?: FindingLocation[];
  max_unmatched_severity?: string;
  require_guideline_id?: boolean;
}

/** Scores range from 0 to 1; reward is 1 only when all other scores are 1. */
export interface ReviewScores {
  report_exists: number;
  format: number;
  verdict: number;
  found: number;
  severity: number;
  category: number;
  guideline: number;
  restraint: number;
  reward: number;
}

type Severity = 'optional' | 'should fix' | 'blocking';
interface Finding {
  severity: Severity;
  locations: Array<{ path: string; first: number; last: number }>;
  category: string | null;
  guidelines: string[];
  evidence: boolean;
}

const SEVERITIES: Record<Severity, number> = { optional: 0, 'should fix': 1, blocking: 2 };
const LINE_TOLERANCE = 2;
// Python's word boundaries and decimal digits are Unicode-aware; JavaScript's are not.
const VERDICT_RE = /^verdict:\s*(ready after fixes|needs rework|ready)(?![\p{L}\p{N}_])/imu;
const HEADING_RE = /^#{2,4}\s*(blocking|should fix|optional)(?![\p{L}\p{N}_])\s*[—–:-]*\s*(.*)$/iu;
const LOCATION_RE = /([\p{L}\p{N}_./-]+\.[\p{L}\p{N}_]+):(\p{Nd}+)(?:\s*[-–]\s*(\p{Nd}+))?/gu;
const GUIDELINE_RE = /(?<![\p{L}\p{N}_])[CDKMT]\p{Nd}{1,2}(?![\p{L}\p{N}_])/gu;

/** Convert Unicode decimal digits, including mixed scripts, as Python int does. */
function lineNumber(digits: string): number {
  return Number(Array.from(digits, (digit) => {
    if (digit >= '0' && digit <= '9') return digit;
    const point = digit.codePointAt(0)!;
    let start = point;
    // Decimal digits occur in contiguous zero-to-nine groups, sometimes adjacent.
    while (/\p{Nd}/u.test(String.fromCodePoint(start - 1))) start -= 1;
    return String((point - start) % 10);
  }).join(''));
}

/** Accept the same loose Markdown fields as the original Python scorer. */
function parse(report: string) {
  // Python splitlines accepts these separators as well as CR and LF.
  const lines = report.split(/\r\n|[\n\r\v\f\x1c-\x1e\x85\u2028\u2029]/)
    .map((line) => line.replace(/[*`_]/g, '').trim().replace(/^-+/, '').trim());
  const text = lines.join('\n');
  const findings: Finding[] = [];
  let current: Finding | null = null;
  for (const line of lines) {
    const heading = HEADING_RE.exec(line);
    if (heading) {
      current = {
        severity: heading[1].toLowerCase() as Severity,
        locations: [], category: null, guidelines: [], evidence: false,
      };
      findings.push(current);
      continue;
    }
    if (line.startsWith('#')) current = null;
    if (!current) continue;
    const separator = line.indexOf(':');
    if (separator === -1) continue;
    const field = line.slice(0, separator).trim().toLowerCase();
    const value = line.slice(separator + 1);
    if (field === 'location') {
      for (const match of value.matchAll(LOCATION_RE)) {
        current.locations.push({
          path: match[1], first: lineNumber(match[2]), last: lineNumber(match[3] || match[2]),
        });
      }
    } else if (field === 'category') {
      current.category = value.split(/[·|,(]/)[0].trim().toLowerCase();
      current.guidelines = value.match(GUIDELINE_RE) ?? [];
    } else if (field === 'evidence') {
      current.evidence = Boolean(value.trim());
    }
  }
  const lowered = text.toLowerCase();
  return {
    verdict: VERDICT_RE.exec(text)?.[1].toLowerCase() ?? null,
    findings,
    hasChecksRun: lowered.includes('checks run:'),
    hasNotAssessed: lowered.includes('not assessed:'),
  };
}

/** Preserve suffix-based path matching and the original location-only check. */
function matches(finding: Finding, spec: FindingLocation): boolean {
  const expected = spec.file.replace(/^[./]+/, '');
  return finding.locations.some(({ path, first, last }) => {
    const reported = path.replace(/^[./]+/, '');
    if (!reported.endsWith(expected) && !expected.endsWith(reported)) return false;
    if (!spec.lines) return true;
    const [low, high] = spec.lines;
    return first <= high + LINE_TOLERANCE && last >= low - LINE_TOLERANCE;
  });
}

/**
 * Score report structure and expected finding labels, without judging meaning.
 * A null report means no file exists and returns all zeroes. No files are changed.
 */
export function grade(report: string | null, expected: ExpectedReview): ReviewScores {
  if (report === null) {
    return {
      report_exists: 0, format: 0, verdict: 0, found: 0, severity: 0,
      category: 0, guideline: 0, restraint: 0, reward: 0,
    };
  }
  const parsed = parse(report);
  const { findings } = parsed;
  const wellFormed = findings.every((f) => f.locations.length && f.category && f.evidence);
  const mustFind = expected.must_find ?? [];
  const matched = new Set<number>();
  let found = 0;
  let severity = 0;
  let category = 0;
  for (const spec of mustFind) {
    const hits = findings.filter((finding, index) => {
      if (!matches(finding, spec)) return false;
      matched.add(index);
      return true;
    });
    if (!hits.length) continue;
    found += 1;
    if (hits.some((f) => f.severity === spec.severity.toLowerCase())) severity += 1;
    if (hits.some((f) => f.category === spec.category.toLowerCase()
      && (!spec.guidelines?.length || spec.guidelines.some((id) => f.guidelines.includes(id))))) {
      category += 1;
    }
  }
  for (const spec of expected.may_find ?? []) {
    findings.forEach((finding, index) => {
      if (matches(finding, spec)) matched.add(index);
    });
  }
  const limitName = (expected.max_unmatched_severity ?? 'Optional').toLowerCase();
  if (!Object.hasOwn(SEVERITIES, limitName)) {
    throw new Error(`Unknown max_unmatched_severity: ${limitName}`);
  }
  const limit = SEVERITIES[limitName as Severity];
  const scores: ReviewScores = {
    report_exists: 1,
    format: Number(Boolean(parsed.verdict) && parsed.hasChecksRun && parsed.hasNotAssessed && wellFormed),
    verdict: Number(expected.verdicts === undefined ? Boolean(parsed.verdict)
      : expected.verdicts.some((v) => v.toLowerCase() === parsed.verdict)),
    found: mustFind.length ? found / mustFind.length : 1,
    severity: mustFind.length ? severity / mustFind.length : 1,
    category: mustFind.length ? category / mustFind.length : 1,
    restraint: Number(findings.every((f, index) => matched.has(index) || SEVERITIES[f.severity] <= limit)),
    guideline: expected.require_guideline_id ? Number(findings.some((f) => f.guidelines.length)) : 1,
    reward: 0,
  };
  scores.reward = Number(Object.entries(scores).every(([key, value]) => key === 'reward' || value === 1));
  return scores;
}

/** Missing reports score zero; other input or output errors stop the CLI. */
function main(): void {
  const { values } = parseArgs({
    options: { report: { type: 'string' }, expected: { type: 'string' }, out: { type: 'string' } },
  });
  if (!values.report || !values.expected || !values.out) {
    throw new Error('Usage: node grade_review.mts --report PATH --expected PATH --out PATH');
  }
  const report = statSync(values.report, { throwIfNoEntry: false })?.isFile()
    ? readFileSync(values.report, 'utf8') : null;
  const expected: ExpectedReview = JSON.parse(readFileSync(values.expected, 'utf8'));
  const scores = grade(report, expected);
  mkdirSync(dirname(values.out), { recursive: true });
  writeFileSync(values.out, `${JSON.stringify(scores, null, 2)}\n`);
  console.log(JSON.stringify(scores));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
