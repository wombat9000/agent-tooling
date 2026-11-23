import { writeFileSync } from 'node:fs';
import type { ChoiceQuestion } from './rubrics.mts';
import { nonempty, object } from './rubrics.mts';

export const ENDPOINT = 'https://openrouter.ai/api/alpha/decisions';
export const DEFAULT_DECISION_MODEL = 'liquid/d1.2-ultra';

export async function postOpenRouter(
  endpoint: string,
  body: string,
  key: string,
  responsePath: string,
  transport: typeof fetch,
): Promise<unknown> {
  let response: Response;
  let raw: string;
  try {
    response = await transport(endpoint, {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body,
      redirect: 'error',
      signal: AbortSignal.timeout(30_000),
    });
    raw = await response.text();
  } catch {
    throw new Error('OpenRouter request failed or timed out');
  }
  if (raw.includes(key)) {
    writeFileSync(responsePath, raw.replaceAll(key, '[redacted]'), { mode: 0o600 });
    throw new Error('OpenRouter response contained credential material');
  }
  writeFileSync(responsePath, raw, { mode: 0o600 });
  if (!response.ok) throw new Error(`OpenRouter returned HTTP ${response.status}`);
  try {
    return JSON.parse(raw);
  } catch {
    throw new Error('OpenRouter returned invalid JSON');
  }
}

export function saveJson(path: string, value: unknown): string {
  const body = `${JSON.stringify(value, null, 2)}\n`;
  writeFileSync(path, body, { mode: 0o600 });
  return body;
}

export interface Judgment {
  choice: 'pass' | 'fail';
  pass_probability: number;
  confidence: number;
  files_passed?: number;
  files_total?: number;
  min_pass_probability?: number;
}

export function numbered(files: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(files).map(([path, text]) => [path,
    text.split(/\r?\n/).map((line, index) => `${index + 1}: ${line}`).join('\n')]));
}

/** Validate every required answer before producing any quality scores. */
export function readAnswers(raw: unknown, questions: Record<string, ChoiceQuestion>) {
  const response = object(raw, 'OpenRouter response');
  const model = nonempty(response.model, 'Returned model');
  const answers = object(response.answers, 'answers');
  const checks: Record<string, Judgment> = Object.fromEntries(Object.keys(questions).map((id) => {
    const answer = object(answers[id], `Answer ${id}`);
    if (answer.type !== 'choice' || (answer.choice !== 'pass' && answer.choice !== 'fail')) {
      throw new Error(`Answer ${id} must choose pass or fail`);
    }
    const probabilities = object(answer.probabilities, `${id}.probabilities`);
    const pass = probability(probabilities.pass, `${id}.pass`);
    const fail = probability(probabilities.fail, `${id}.fail`);
    if (Object.keys(probabilities).sort().join(',') !== 'fail,pass'
      || Math.abs(pass + fail - 1) > 0.001
      || (answer.choice === 'pass' ? pass < fail : fail < pass)) {
      throw new Error(`Answer ${id} has inconsistent probabilities`);
    }
    return [id, {
      choice: answer.choice,
      pass_probability: pass,
      confidence: probability(answer.confidence, `${id}.confidence`),
    }];
  }));
  return { model, checks };
}

function probability(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1) {
    throw new Error(`${label} must be a number from 0 to 1`);
  }
  return value;
}
