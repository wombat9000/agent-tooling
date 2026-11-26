/** Shared condition metadata detection and judge-code instruction helpers for Harbor runs. */
import { existsSync, readFileSync } from 'node:fs';
import { basename, join } from 'node:path';

export const JUDGE_CODE_SKILL_SLUG = 'judge-code';
export const JUDGE_CODE_INSTRUCTION_MARKER = 'Required quality gate: judge-code';

export const JUDGE_CODE_EXTRA_INSTRUCTION = [
  '## Required quality gate: judge-code',
  '',
  'The `judge-code` skill is installed in your skills directory and `OPENROUTER_API_KEY` is configured in your environment.',
  'Before finishing, your production code **must** pass both per-file linting (`node "$SKILL_DIR/scripts/judge-code.mts" <src-path> --fail-on-warning`) and module-level linting (`node "$SKILL_DIR/scripts/judge-code.mts" module <src-path> --fail-on-warning`) with exit code 0 (0 errors and 0 warnings) while keeping typecheck and tests green.',
  'Do not skip or rationalize away failing checks; refactor your production code and re-run typecheck, tests, and both `judge-code` commands until both exit 0.',
].join('\n');

export type BaseRunCondition = 'skill' | 'baseline' | 'oracle' | 'nop';

export interface RunSkillFlags {
  hasPrimarySkill: boolean;
  hasJudgeCode: boolean;
}

export interface HarborRunConditionInfo {
  baseCondition: BaseRunCondition | null;
  withJudgeCode: boolean;
  agentName: string | null;
  agentModel: string | null;
  agentSummary: string | null;
}

function normalizedSkillBasename(entry: unknown): string | null {
  if (typeof entry !== 'string') return null;
  const trimmed = entry.trim().replace(/[\\/]+$/, '');
  if (!trimmed) return null;
  const parts = trimmed.split(/[\\/]/);
  return parts[parts.length - 1] || null;
}

/** Classify a Harbor agent's configured skill list into primary skill vs opt-in judge-code. */
export function inspectRunSkills(skills: readonly unknown[]): RunSkillFlags {
  let hasPrimarySkill = false;
  let hasJudgeCode = false;
  for (const entry of skills) {
    const slug = normalizedSkillBasename(entry);
    if (!slug) continue;
    if (slug === JUDGE_CODE_SKILL_SLUG) {
      hasJudgeCode = true;
    } else {
      hasPrimarySkill = true;
    }
  }
  return { hasPrimarySkill, hasJudgeCode };
}

/** Parse base condition and opt-in judge-code flag from a Harbor job folder name. */
export function inspectHarborJobName(jobName: string): {
  baseCondition: BaseRunCondition | null;
  withJudgeCode: boolean;
} {
  const withJudgeCode = jobName.includes('-with-judge-code-');
  if (jobName.startsWith('oracle-')) return { baseCondition: 'oracle', withJudgeCode: false };
  if (jobName.startsWith('nop-')) return { baseCondition: 'nop', withJudgeCode: false };
  if (jobName.startsWith('run-baseline-') || jobName.startsWith('canary-baseline-')) {
    return { baseCondition: 'baseline', withJudgeCode };
  }
  if (jobName.startsWith('run-skill-') || jobName.startsWith('canary-skill-') || jobName.startsWith('canary-')) {
    return { baseCondition: 'skill', withJudgeCode };
  }
  return { baseCondition: null, withJudgeCode };
}

/** Inspect a saved Harbor run directory's config.json (with folder-name fallback). */
export function inspectHarborRunCondition(runDir: string): HarborRunConditionInfo {
  const folderHint = inspectHarborJobName(basename(runDir));
  let baseCondition: BaseRunCondition | null = null;
  let withJudgeCode = folderHint.withJudgeCode;
  let agentName: string | null = null;
  let agentModel: string | null = null;
  let agentSummary: string | null = null;

  const configPath = join(runDir, 'config.json');
  if (existsSync(configPath)) {
    try {
      const config = JSON.parse(readFileSync(configPath, 'utf8')) as {
        agents?: Array<{
          name?: string;
          model_name?: string;
          skills?: unknown[];
          kwargs?: Record<string, unknown>;
        }>;
      };
      const firstAgent = Array.isArray(config.agents) ? config.agents[0] : undefined;
      if (firstAgent && typeof firstAgent === 'object') {
        agentName = typeof firstAgent.name === 'string' && firstAgent.name.trim() ? firstAgent.name.trim() : null;
        agentModel = typeof firstAgent.model_name === 'string' && firstAgent.model_name.trim()
          ? firstAgent.model_name.trim()
          : null;
        const effort = typeof firstAgent.kwargs?.reasoning_effort === 'string'
          ? firstAgent.kwargs.reasoning_effort
          : null;
        if (agentName) {
          const details = [agentModel, effort].filter(Boolean).join(', ');
          agentSummary = details ? `${agentName} (${details})` : agentName;
        }
        if (agentName === 'oracle' || agentName === 'nop') {
          baseCondition = agentName;
          withJudgeCode = false;
        } else {
          const skills = Array.isArray(firstAgent.skills) ? firstAgent.skills : [];
          const flags = inspectRunSkills(skills);
          const kwargWithJudgeCode = firstAgent.kwargs?.with_judge_code === true;
          withJudgeCode = flags.hasJudgeCode || kwargWithJudgeCode || folderHint.withJudgeCode;
          if (flags.hasPrimarySkill) {
            baseCondition = 'skill';
          } else if (agentName) {
            baseCondition = 'baseline';
          }
        }
      }
    } catch {
      // Fall back to folder-name heuristics below.
    }
  }

  if (!baseCondition) {
    baseCondition = folderHint.baseCondition;
  }

  return {
    baseCondition,
    withJudgeCode,
    agentName,
    agentModel: agentModel ?? agentName,
    agentSummary,
  };
}

/** Build a human-readable badge label and CSS kind for a run condition. */
export function formatConditionBadge(
  baseCondition: BaseRunCondition | null,
  withJudgeCode: boolean,
): { label: string; kind: 'skill' | 'baseline' | 'oracle' | 'neutral' } | null {
  if (!baseCondition) return null;
  if (baseCondition === 'oracle') return { label: 'Oracle', kind: 'oracle' };
  if (baseCondition === 'nop') return { label: 'Nop', kind: 'neutral' };
  const suffix = withJudgeCode ? ' + judge-code' : '';
  if (baseCondition === 'skill') return { label: `Skill${suffix}`, kind: 'skill' };
  return { label: `Baseline${suffix}`, kind: 'baseline' };
}
