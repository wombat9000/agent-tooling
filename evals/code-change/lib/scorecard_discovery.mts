/** Discover skills, test/eval coverage, checked-in scorecards, and live staleness state. */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import {
  computeRubricHash,
  computeSkillHash,
  computeTaskHash,
  evaluateStaleness,
  resolveRubricForTarget,
  type StalenessResult,
} from './scorecard_hashes.mts';
import {
  CONDITION_ORDER,
  TARGET_ORDER,
  compareCodepoint,
  validateTaskScorecard,
  type ScorecardCondition,
  type ScorecardEntry,
  type ScorecardTarget,
  type TaskScorecard,
} from './scorecard_schema.mts';

export interface SkillCoverageInfo {
  skill: string;
  hasHarborEvals: boolean;
  harborTasks: string[];
  evaluatedTasks: string[];
  hasUnitTests: boolean;
  unitTestFiles: string[];
  coverageStatus: 'harbor_evals' | 'unit_tests' | 'none';
}

export interface EvaluatedEntryView {
  skill: string;
  task: string;
  condition: ScorecardCondition;
  target: ScorecardTarget;
  entry: ScorecardEntry;
  staleness: StalenessResult;
}

export interface TaskTargetRow {
  skill: string;
  task: string;
  target: ScorecardTarget;
  baseline: EvaluatedEntryView | null;
  skillEntry: EvaluatedEntryView | null;
  liftPassRate: number | null;
  liftMeanProb: number | null;
  currentRubricGroups?: Record<string, string[]>;
  currentQuestions?: Record<string, { instructions: string; criteria: { pass: string; fail: string } }>;
}

export interface ScorecardSnapshot {
  skills: SkillCoverageInfo[];
  scorecards: TaskScorecard[];
  rows: TaskTargetRow[];
  entries: EvaluatedEntryView[];
}

function collectTestFiles(dir: string, prefix = ''): string[] {
  if (!statSync(dir, { throwIfNoEntry: false })?.isDirectory()) return [];
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => compareCodepoint(a.name, b.name))) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      out.push(...collectTestFiles(join(dir, entry.name), rel));
    } else if (entry.isFile() && /\.(?:test|spec)\.[cm]?[jt]sx?$/.test(entry.name)) {
      out.push(rel);
    }
  }
  return out;
}

export function discoverHarborTasks(repoRoot: string, skill: string): string[] {
  const tasksDir = join(repoRoot, 'evals', skill, 'tasks');
  if (!statSync(tasksDir, { throwIfNoEntry: false })?.isDirectory()) return [];
  return readdirSync(tasksDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && existsSync(join(tasksDir, entry.name, 'task.toml')))
    .map((entry) => entry.name)
    .sort(compareCodepoint);
}

/** Load and validate every checked-in scorecard JSON file under evals/scorecards/<skill>/<task>.json. */
export function loadAllScorecards(repoRoot: string): TaskScorecard[] {
  const root = join(repoRoot, 'evals/scorecards');
  if (!statSync(root, { throwIfNoEntry: false })?.isDirectory()) return [];
  const scorecards: TaskScorecard[] = [];
  const skillDirs = readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort(compareCodepoint);

  for (const skillDir of skillDirs) {
    const fullSkillDir = join(root, skillDir);
    const files = readdirSync(fullSkillDir, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith('.json'))
      .map((entry) => entry.name)
      .sort(compareCodepoint);

    for (const file of files) {
      const filePath = join(fullSkillDir, file);
      const raw = JSON.parse(readFileSync(filePath, 'utf8'));
      const validated = validateTaskScorecard(raw, `evals/scorecards/${skillDir}/${file}`);
      const expectedTask = file.slice(0, -'.json'.length);
      if (validated.skill !== skillDir) {
        throw new Error(`evals/scorecards/${skillDir}/${file}: skill field (${validated.skill}) does not match directory (${skillDir})`);
      }
      if (validated.task !== expectedTask) {
        throw new Error(`evals/scorecards/${skillDir}/${file}: task field (${validated.task}) does not match filename (${expectedTask})`);
      }
      scorecards.push(validated);
    }
  }
  return scorecards;
}

/** Build the complete live scorecard snapshot combining skills/, evals/, and evals/scorecards/. */
export function buildScorecardSnapshot(repoRoot: string): ScorecardSnapshot {
  const scorecards = loadAllScorecards(repoRoot);
  const scorecardsBySkill = new Map<string, TaskScorecard[]>();
  for (const sc of scorecards) {
    const list = scorecardsBySkill.get(sc.skill) ?? [];
    list.push(sc);
    scorecardsBySkill.set(sc.skill, list);
  }

  const skillsDir = join(repoRoot, 'skills');
  const skillNames = statSync(skillsDir, { throwIfNoEntry: false })?.isDirectory()
    ? readdirSync(skillsDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && existsSync(join(skillsDir, entry.name, 'SKILL.md')))
      .map((entry) => entry.name)
      .sort(compareCodepoint)
    : [];

  const skills: SkillCoverageInfo[] = skillNames.map((skill) => {
    const harborTasks = discoverHarborTasks(repoRoot, skill);
    const evaluatedTasks = (scorecardsBySkill.get(skill) ?? [])
      .map((sc) => sc.task)
      .sort(compareCodepoint);
    const unitTestFiles = collectTestFiles(join(repoRoot, 'skills', skill, 'tests'));
    const hasHarborEvals = harborTasks.length > 0;
    const hasUnitTests = unitTestFiles.length > 0;
    const coverageStatus: SkillCoverageInfo['coverageStatus'] = hasHarborEvals
      ? 'harbor_evals'
      : hasUnitTests
        ? 'unit_tests'
        : 'none';
    return {
      skill,
      hasHarborEvals,
      harborTasks,
      evaluatedTasks,
      hasUnitTests,
      unitTestFiles,
      coverageStatus,
    };
  });

  // Memoize working-tree hashes so repeated lookups stay fast.
  const skillHashCache = new Map<string, string | null>();
  const taskHashCache = new Map<string, string | null>();
  const rubricCache = new Map<string, ReturnType<typeof resolveRubricForTarget>>();

  const getSkillHash = (skill: string): string | null => {
    if (!skillHashCache.has(skill)) {
      skillHashCache.set(skill, computeSkillHash(repoRoot, skill));
    }
    return skillHashCache.get(skill)!;
  };
  const getTaskHash = (skill: string, task: string): string | null => {
    const key = `${skill}/${task}`;
    if (!taskHashCache.has(key)) {
      taskHashCache.set(key, computeTaskHash(repoRoot, skill, task));
    }
    return taskHashCache.get(key)!;
  };
  const getRubric = (skill: string, task: string, target: ScorecardTarget) => {
    const key = `${skill}/${task}/${target}`;
    if (!rubricCache.has(key)) {
      rubricCache.set(key, resolveRubricForTarget(repoRoot, skill, task, target));
    }
    return rubricCache.get(key)!;
  };

  const entries: EvaluatedEntryView[] = [];
  const rows: TaskTargetRow[] = [];

  for (const sc of scorecards) {
    const presentTargets = new Set<ScorecardTarget>();
    for (const condition of CONDITION_ORDER) {
      const map = sc.entries[condition];
      if (!map) continue;
      for (const target of TARGET_ORDER) {
        if (map[target]) presentTargets.add(target);
      }
    }

    for (const target of TARGET_ORDER) {
      if (!presentTargets.has(target)) continue;
      const currentSkillHash = getSkillHash(sc.skill);
      const currentTaskHash = getTaskHash(sc.skill, sc.task);
      const currentRubric = getRubric(sc.skill, sc.task, target);
      const currentRubricHash = currentRubric?.hash ?? computeRubricHash(repoRoot, sc.skill, sc.task, target);

      const evaluate = (condition: ScorecardCondition): EvaluatedEntryView | null => {
        const entry = sc.entries[condition]?.[target];
        if (!entry) return null;
        const staleness = evaluateStaleness(condition, entry.hashes, {
          skill_hash: currentSkillHash,
          task_hash: currentTaskHash,
          rubric_hash: currentRubricHash,
        });
        const view: EvaluatedEntryView = {
          skill: sc.skill,
          task: sc.task,
          condition,
          target,
          entry,
          staleness,
        };
        entries.push(view);
        return view;
      };

      const baseline = evaluate('baseline');
      const skillEntry = evaluate('skill');

      const liftPassRate = baseline && skillEntry
        ? skillEntry.entry.quality.pass_rate - baseline.entry.quality.pass_rate
        : null;
      const liftMeanProb = baseline && skillEntry
        ? skillEntry.entry.quality.mean_pass_probability - baseline.entry.quality.mean_pass_probability
        : null;

      rows.push({
        skill: sc.skill,
        task: sc.task,
        target,
        baseline,
        skillEntry,
        liftPassRate,
        liftMeanProb,
        ...(currentRubric?.groups ? { currentRubricGroups: currentRubric.groups } : {}),
        ...(currentRubric?.questions ? { currentQuestions: currentRubric.questions } : {}),
      });
    }
  }

  return { skills, scorecards, rows, entries };
}
