import { lstatSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { CLAUDE_DEEP_MODEL, CLAUDE_MODEL, CODEX_MODEL } from '../engine/cli-backend.mts';
import {
  DEFAULT_CLI_CONCURRENCY,
  DEFAULT_DECISION_MODEL,
  DEFAULT_FILE_MODE_DECISION_MODEL,
  DEFAULT_OPENROUTER_CONCURRENCY,
  type JudgeBackend,
} from '../engine/types.mts';
import type { JudgeMode } from '../rubrics/types.mts';

export const EXIT_OK = 0;
export const EXIT_FINDINGS = 1;
export const EXIT_ERROR = 2;

export type Subcommand = 'file' | 'module' | 'structure' | 'list' | 'explain';

const EXPLICIT_SUBCOMMANDS = new Set<Subcommand>(['list', 'explain', 'module', 'structure']);

const SUBCOMMAND_TO_MODE: Partial<Record<Subcommand, JudgeMode>> = {
  structure: 'structure',
  module: 'code',
  file: 'file',
};

const CLI_PARSE_OPTIONS = {
  deep: { type: 'boolean', default: false },
  model: { type: 'string' },
  backend: { type: 'string' },
  quiet: { type: 'boolean', short: 'q', default: false },
  verbose: { type: 'boolean', short: 'v', default: false },
  json: { type: 'boolean', default: false },
  out: { type: 'string' },
  rubric: { type: 'string', multiple: true },
  rule: { type: 'string', multiple: true },
  exclude: { type: 'string', multiple: true },
  ignore: { type: 'string', multiple: true },
  conventions: { type: 'string' },
  'no-conventions': { type: 'boolean', default: false },
  requirements: { type: 'string' },
  'max-warnings': { type: 'string' },
  'fail-on-warning': { type: 'boolean', default: false },
  concurrency: { type: 'string' },
  'allow-credentials': { type: 'boolean', default: false },
  'dry-run': { type: 'boolean', default: false },
  'list-rubrics': { type: 'boolean', default: false },
  help: { type: 'boolean', short: 'h', default: false },
} as const;

export const USAGE = `Usage:
  judge-code <path...> [options]              Lint production & test files/directories (file-scoped checks, fast model)
  judge-code --changed [base-ref] [options]   Lint git-modified/untracked files (default base: main or HEAD)
  judge-code module <path...> [options]       Lint module bundle(s) with file + module checks (deep model)
  judge-code structure <path> [options]       Lint directory layout via structural manifest (deep model)
  judge-code list [--verbose]                 List bundled rubrics, check IDs, scopes, and thresholds
  judge-code explain <check-id...> [options]  Show full criteria (instructions, pass, fail) for check ID(s)

Options:
  --deep                Use deep model (${DEFAULT_DECISION_MODEL} instead of ${DEFAULT_FILE_MODE_DECISION_MODEL} on openrouter; ${CLAUDE_DEEP_MODEL} instead of ${CLAUDE_MODEL} on claude)
  --model ID            Explicit model ID override (OpenRouter ID on openrouter, or CLI model ID on codex/claude)
  --backend BACKEND     Judge backend: openrouter (default), codex (${CODEX_MODEL}), or claude (${CLAUDE_MODEL}; --deep for ${CLAUDE_DEEP_MODEL})
  --quiet, -q           Show errors only; hide borderline warnings
  --verbose, -v         Include full rule instructions and pass/fail criteria in \`judge-code list\`
  --json                Emit structured JSON result to stdout instead of formatted linter output
  --out NEW_DIRECTORY   Optional private directory for request.json, response.txt, and result.json artifacts
  --rubric NAME_OR_PATH Narrow to bundled rubric name/ID or load local .json rubric (repeatable)
  --rule CHECK_ID       Narrow to specific check ID(s) (repeatable)
  --exclude CHECK_ID    Exclude a specific check ID (repeatable)
  --ignore GLOB         Exclude matching paths or basenames (repeatable)
  --conventions FILE    Explicit Markdown/text conventions doc (overrides auto-loaded AGENTS.md)
  --no-conventions      Disable auto-loaded AGENTS.md conventions
  --requirements FILE   Optional Markdown or text requirements document
  --changed [REF]       Lint git-modified/untracked files vs. REF (default: main, fallback: HEAD)
  --max-warnings N      Exit with status ${EXIT_FINDINGS} if warning count exceeds N (non-negative integer)
  --fail-on-warning     Exit with status ${EXIT_FINDINGS} if any warning is found (same as --max-warnings 0)
  --concurrency N       Max concurrent requests (default: ${DEFAULT_OPENROUTER_CONCURRENCY} openrouter, ${DEFAULT_CLI_CONCURRENCY} codex/claude)
  --allow-credentials   Allow inputs matching heuristic credential patterns after review
  --dry-run             Preview resolved files/checks without sending any requests
  --list-rubrics        Alias for \`judge-code list\`
  --help, -h            Show this help

Severity & exit codes:
  error    Score < 60/100
  warning  Score 60 up to the rule's pass threshold (default 80/100)

  ${EXIT_OK}  Clean (0 errors, and warnings within --max-warnings / no --fail-on-warning)
  ${EXIT_FINDINGS}  Findings (1+ errors, or warning limit exceeded)
  ${EXIT_ERROR}  Error (scoring/transport/backend error, invalid CLI arguments, or oversize input)
`;

export interface ParsedRunCommand {
  kind: 'run';
  mode: JudgeMode;
  positionals: string[];
  changed: boolean;
  changedBase?: string;
  backend: JudgeBackend;
  model: string;
  quiet: boolean;
  json: boolean;
  out?: string;
  rubrics: string[];
  rules?: string[];
  exclude?: string[];
  ignore: string[];
  conventions?: string;
  noConventions: boolean;
  requirements?: string;
  maxWarnings?: number;
  failOnWarning: boolean;
  concurrency?: number;
  allowCredentials: boolean;
  dryRun: boolean;
}

export type ParsedCliCommand =
  | { kind: 'help' }
  | { kind: 'list'; verbose: boolean }
  | { kind: 'explain'; ruleIds: string[]; rubrics: string[] }
  | ParsedRunCommand;

interface ModelSelectionInput {
  backend: JudgeBackend;
  mode: JudgeMode;
  modelArg?: string;
  deep: boolean;
}

interface ExtractedSubcommand {
  subcommand: Subcommand;
  restArgs: string[];
  changed: boolean;
  changedBase?: string;
}

function parseBackend(value: string | undefined): JudgeBackend {
  if (value === undefined || value === 'openrouter') return 'openrouter';
  if (value === 'codex' || value === 'claude') return value;
  throw new Error(`Invalid --backend: ${value}. Choose openrouter, codex, or claude.`);
}

function parseIntegerFlag(
  value: string | undefined,
  pattern: RegExp,
  errorMessage: string,
): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Number(value);
  if (!pattern.test(value) || !Number.isSafeInteger(parsed)) {
    throw new Error(errorMessage);
  }
  return parsed;
}

function validateCliModel(value: string, backend: 'codex' | 'claude'): string {
  const trimmed = value.trim();
  if (!trimmed || trimmed.startsWith('-') || /\s/.test(trimmed)) {
    throw new Error(`Invalid --model for --backend ${backend}: ${value}`);
  }
  return trimmed;
}

const MODEL_RESOLVERS: Record<JudgeBackend, (input: Omit<ModelSelectionInput, 'backend'>) => string> = {
  claude: ({ modelArg, deep }) => (
    modelArg !== undefined ? validateCliModel(modelArg, 'claude') : deep ? CLAUDE_DEEP_MODEL : CLAUDE_MODEL
  ),
  codex: ({ modelArg, deep }) => {
    if (deep) {
      throw new Error(
        `--deep is only supported with --backend openrouter or --backend claude (codex uses ${CODEX_MODEL}; use --model to override)`,
      );
    }
    return modelArg !== undefined ? validateCliModel(modelArg, 'codex') : CODEX_MODEL;
  },
  openrouter: ({ mode, modelArg, deep }) => {
    const defaultModel = mode === 'file' && !deep
      ? DEFAULT_FILE_MODE_DECISION_MODEL
      : DEFAULT_DECISION_MODEL;
    const model = modelArg ?? defaultModel;
    if (!/^[a-z0-9_.-]+\/[a-z0-9_.:-]+$/i.test(model)) {
      throw new Error('Use a full OpenRouter model ID for --model (for example liquid/d1.2-ultra)');
    }
    return model;
  },
};

function resolveModel(input: ModelSelectionInput): string {
  if (input.deep && input.modelArg !== undefined) {
    throw new Error('Cannot combine --deep and --model');
  }
  return MODEL_RESOLVERS[input.backend](input);
}

function isNextTokenBaseRef(token: string | undefined, cwd: string): token is string {
  if (token === undefined || token.startsWith('-')) return false;
  return !lstatSync(resolve(cwd, token), { throwIfNoEntry: false });
}

function extractSubcommandAndChanged(rawArgs: string[], cwd: string): ExtractedSubcommand {
  const first = rawArgs[0] as Subcommand | undefined;
  const hasExplicitSubcommand = first !== undefined && EXPLICIT_SUBCOMMANDS.has(first);
  const subcommand: Subcommand = hasExplicitSubcommand ? first : 'file';
  const startIdx = hasExplicitSubcommand ? 1 : 0;

  let changed = false;
  let changedBase: string | undefined;
  const restArgs: string[] = [];
  let afterDoubleDash = false;

  for (let i = startIdx; i < rawArgs.length; i += 1) {
    const arg = rawArgs[i];
    if (afterDoubleDash || arg === '--') {
      if (arg === '--') afterDoubleDash = true;
      restArgs.push(arg);
      continue;
    }
    if (arg === '--changed') {
      changed = true;
      const next = rawArgs[i + 1];
      if (isNextTokenBaseRef(next, cwd)) {
        changedBase = next;
        i += 1;
      }
      continue;
    }
    if (arg.startsWith('--changed=')) {
      changed = true;
      const value = arg.slice('--changed='.length).trim();
      if (!value) throw new Error('Invalid --changed value: expected a non-empty git ref');
      changedBase = value;
      continue;
    }
    restArgs.push(arg);
  }

  return { subcommand, restArgs, changed, changedBase };
}

type ParsedFlagValues = ReturnType<typeof parseArgs<{ options: typeof CLI_PARSE_OPTIONS; allowPositionals: true }>>['values'];

function buildRunCommand(
  extracted: ExtractedSubcommand,
  values: ParsedFlagValues,
  positionals: string[],
): ParsedRunCommand {
  const backend = parseBackend(values.backend);
  const concurrency = parseIntegerFlag(
    values.concurrency,
    /^[1-9]\d*$/,
    `Invalid --concurrency: ${values.concurrency}. Expected a positive integer.`,
  );
  const maxWarnings = parseIntegerFlag(
    values['max-warnings'],
    /^(?:0|[1-9]\d*)$/,
    `Invalid --max-warnings: ${values['max-warnings']}. Expected a non-negative integer.`,
  );
  if (values.out !== undefined && !values.out.trim()) {
    throw new Error('--out must be a non-empty directory path');
  }

  const mode = SUBCOMMAND_TO_MODE[extracted.subcommand] ?? 'file';
  const model = resolveModel({ backend, mode, modelArg: values.model, deep: Boolean(values.deep) });

  return {
    kind: 'run',
    mode,
    positionals,
    changed: extracted.changed,
    changedBase: extracted.changedBase,
    backend,
    model,
    quiet: Boolean(values.quiet),
    json: Boolean(values.json),
    out: values.out,
    rubrics: values.rubric ?? [],
    rules: values.rule,
    exclude: values.exclude,
    ignore: [...new Set(values.ignore ?? [])],
    conventions: values.conventions,
    noConventions: Boolean(values['no-conventions']),
    requirements: values.requirements,
    maxWarnings,
    failOnWarning: Boolean(values['fail-on-warning']),
    concurrency,
    allowCredentials: Boolean(values['allow-credentials']),
    dryRun: Boolean(values['dry-run']),
  };
}

export function parseCliCommand(rawArgs: string[], cwd: string): ParsedCliCommand {
  const extracted = extractSubcommandAndChanged(rawArgs, cwd);
  const { values, positionals } = parseArgs({
    args: extracted.restArgs,
    allowPositionals: true,
    options: CLI_PARSE_OPTIONS,
  });

  if (values.help) return { kind: 'help' };
  if (extracted.changed && extracted.subcommand !== 'file') {
    throw new Error(`--changed is only supported for file linting (not \`judge-code ${extracted.subcommand}\`)`);
  }
  if (extracted.subcommand === 'list' || values['list-rubrics']) {
    if (extracted.subcommand === 'list' && positionals.length > 0) {
      throw new Error(`Unexpected arguments for \`judge-code list\`: ${positionals.join(' ')}`);
    }
    return { kind: 'list', verbose: Boolean(values.verbose) };
  }
  if (extracted.subcommand === 'explain') {
    return { kind: 'explain', ruleIds: positionals, rubrics: values.rubric ?? [] };
  }
  return buildRunCommand(extracted, values, positionals);
}
