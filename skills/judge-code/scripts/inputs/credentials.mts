const STRICT_CREDENTIAL_PATTERNS = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /\b(?:sk-or-v1-|sk-(?:proj|svcacct)-|gh[pousr]_|github_pat_|xox[baprs]-)[a-z0-9_-]{16,}/i,
  /\bAIza[0-9A-Za-z_-]{35}\b/,
  /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/,
];

const GENERIC_CREDENTIAL_ASSIGNMENT_RE =
  /(?:api[_-]?key|access[_-]?token|password|client[_-]?secret)['"]?\s*[:=]\s*['"]([^\s'"]{8,})['"]/gi;

export const TEST_PLACEHOLDER_PREFIX_RE =
  /^(?:e2e|local[-_]emulator|dev[-_]only|test|playwright|fixture|fake|mock|stub|dummy|example)[-_]/i;

/**
 * Detect likely embedded credentials in source or document text.
 * Live token prefixes and PEM keys are always blocked everywhere.
 * Generic key/secret assignments allow explicit synthetic placeholder prefixes in test files only.
 */
export function containsSensitiveCredential(
  text: string,
  options: { isTestFile?: boolean } = {},
): boolean {
  if (STRICT_CREDENTIAL_PATTERNS.some((pattern) => pattern.test(text))) {
    return true;
  }
  const isTestFile = Boolean(options.isTestFile);
  for (const match of text.matchAll(GENERIC_CREDENTIAL_ASSIGNMENT_RE)) {
    const value = match[1];
    if (isTestFile && TEST_PLACEHOLDER_PREFIX_RE.test(value)) {
      continue;
    }
    return true;
  }
  return false;
}
