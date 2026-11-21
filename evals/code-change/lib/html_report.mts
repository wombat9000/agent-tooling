/** Build a standalone, offline HTML report from saved judge requests and scores. */
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, extname, join, resolve } from 'node:path';

interface Check {
  choice: string;
  pass_probability: number;
  confidence: number;
}
interface Question {
  instructions: string;
  criteria: { pass: string; fail: string };
}
interface SavedResult {
  status: string;
  requested_model: string;
  returned_model: string | null;
  rubric: string;
  deterministic: Record<string, number>;
  quality: { pass_rate: number; checks: Record<string, Check> } | null;
  error?: string;
}
interface SavedRequest {
  model: string;
  state: { task: string; review: string; requirement: string };
  questions: Record<string, Question>;
}
interface Trial {
  trial: string;
  task: string;
  status: string;
  error: string | null;
  result: SavedResult | null;
  request: SavedRequest | null;
}

function readJson(path: string) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

/** Find the newest saved judgment, excluding request-only dry runs and pending batches. */
export function latestJudgment(root: string): string {
  const candidates: Array<{ directory: string; modified: number }> = [];
  if (existsSync(root)) {
    for (const group of readdirSync(root, { withFileTypes: true })) {
      if (!group.isDirectory()) continue;
      for (const entry of readdirSync(join(root, group.name), { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        const directory = join(root, group.name, entry.name);
        const summary = join(directory, 'summary.json');
        const result = join(directory, 'result.json');
        if (existsSync(summary)) {
          const data = readJson(summary);
          if (data.reports?.some((trial: { status: string }) => ['scored', 'error', 'missing_report'].includes(trial.status))) {
            candidates.push({ directory, modified: statSync(summary).mtimeMs });
          }
        } else if (existsSync(result) && ['scored', 'error', 'missing_report'].includes(readJson(result).status)) {
          candidates.push({ directory, modified: statSync(result).mtimeMs });
        }
      }
    }
  }
  candidates.sort((a, b) => b.modified - a.modified || a.directory.localeCompare(b.directory));
  if (!candidates.length) throw new Error('No saved judge scores. Run pnpm eval judge --latest first.');
  return candidates[0].directory;
}

/** Read historical rubric text from request.json, never from the current task files. */
function loadTrials(directory: string): { source: string; model: string; trials: Trial[] } {
  const summaryPath = join(directory, 'summary.json');
  if (!statSync(directory, { throwIfNoEntry: false })?.isDirectory()
    || ![summaryPath, join(directory, 'result.json'), join(directory, 'request.json')].some((path) => existsSync(path))) {
    throw new Error(`No saved judge data in ${directory}. Choose a judge output directory or use --latest.`);
  }
  const summary = existsSync(summaryPath) ? readJson(summaryPath) : null;
  const entries = summary ? summary.reports : [{ trial: basename(directory), result_dir: directory }];
  if (!Array.isArray(entries) || !entries.length) throw new Error('No trial data to report.');
  const trials: Trial[] = entries.map((entry) => {
    const trialDirectory = resolve(entry.result_dir);
    const resultPath = join(trialDirectory, 'result.json');
    const requestPath = join(trialDirectory, 'request.json');
    const result: SavedResult | null = existsSync(resultPath) ? readJson(resultPath) : null;
    const request: SavedRequest | null = existsSync(requestPath) ? readJson(requestPath) : null;
    const status = result?.status ?? entry.status ?? 'pending';
    if (status === 'scored' && (!result?.quality || !request)) {
      throw new Error(`Scored trial is missing its request or quality data: ${entry.trial}`);
    }
    return {
      trial: String(entry.trial), task: String(entry.task ?? request?.state.task ?? 'Review'),
      status, error: result?.error ?? entry.error ?? null, result, request,
    };
  });
  return { source: summary?.source_run ?? directory,
    model: summary?.model ?? trials[0].result?.requested_model ?? trials[0].request?.model ?? 'Unknown', trials };
}

/** Escape all saved content, including Markdown, before placing it in HTML or attributes. */
function escape(value: unknown): string {
  return String(value ?? '').replace(/[&<>"']/g, (character) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[character]!);
}

function percent(value: number | null | undefined): string {
  return typeof value === 'number' && Number.isFinite(value) ? `${(value * 100).toFixed(1)}%` : '—';
}

function state(trial: Trial): string {
  if (trial.status !== 'scored') return 'unscored';
  return trial.result!.quality!.pass_rate === 1 ? 'passed' : 'attention';
}

function questionHtml(id: string, question: Question, check?: Check): string {
  const choice = check?.choice ?? 'Not scored';
  return `<section class="check">
    <div class="check-heading"><h4>${escape(id.replaceAll('_', ' '))}</h4><span class="badge ${choice === 'pass' ? 'pass' : choice === 'fail' ? 'fail' : 'neutral'}">${escape(choice)}</span></div>
    <div class="signals"><span>P(pass) <strong>${percent(check?.pass_probability)}</strong></span><span>Confidence <strong>${percent(check?.confidence)}</strong></span></div>
    <p class="question">${escape(question.instructions)}</p>
    <div class="criteria"><div><h5>Pass when</h5><p>${escape(question.criteria.pass)}</p></div><div><h5>Fail when</h5><p>${escape(question.criteria.fail)}</p></div></div>
  </section>`;
}

function trialHtml(trial: Trial, index: number): string {
  const result = trial.result;
  const checks = result?.quality?.checks;
  const questions = trial.request?.questions ?? {};
  const passed = checks ? Object.values(checks).filter((check) => check.choice === 'pass').length : 0;
  const score = result?.quality ? `${passed}/${Object.keys(checks!).length} checks · ${percent(result.quality.pass_rate)}` : trial.status.replaceAll('_', ' ');
  const deterministic = result?.deterministic.reward;
  return `<details class="trial" data-task="${escape(trial.task)}" data-state="${state(trial)}" ${index === 0 ? 'open' : ''}>
    <summary><span class="trial-name">${escape(trial.trial)}</span><span class="badge ${state(trial) === 'passed' ? 'pass' : state(trial) === 'attention' ? 'fail' : 'neutral'}">${escape(score)}</span></summary>
    <div class="trial-body"><div class="trial-meta"><span>Rubric <strong>${escape(result?.rubric ?? 'Pending')}</strong></span><span>Deterministic reward <strong>${deterministic === undefined ? '—' : escape(deterministic)}</strong></span><span>Returned model <strong>${escape(result?.returned_model ?? '—')}</strong></span></div>
    ${trial.error ? `<p class="error">${escape(trial.error)}</p>` : ''}
    ${trial.request ? `<details class="context"><summary>Task requirement</summary><pre>${escape(trial.request.state.requirement)}</pre></details>` : ''}
    <h3>Rubric and scores</h3>
    ${Object.entries(questions).map(([id, question]) => questionHtml(id, question, checks?.[id])).join('') || '<p class="muted">No saved rubric yet. This trial has not been judged.</p>'}
    <details class="context review"><summary>Original review</summary><pre>${escape(trial.request?.state.review ?? 'No saved review.')}</pre></details>
    </div></details>`;
}

const STYLE = `
:root{color-scheme:light;--ink:#16243b;--muted:#5c687b;--line:#dce3ed;--blue:#3158cf;--green:#116547;--amber:#92440c}*{box-sizing:border-box}body{margin:0;background:#f4f6fa;color:var(--ink);font:16px/1.55 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}main{max-width:1200px;margin:0 auto;padding:48px 32px 72px}header{border-top:4px solid var(--blue);padding:25px 0 28px}.eyebrow{font-size:.875rem;font-weight:700;letter-spacing:.12em;color:var(--blue);text-transform:uppercase}h1{font-size:clamp(2rem,4vw,3rem);line-height:1.15;letter-spacing:-.04em;margin:12px 0}h2{font-size:1.35rem;margin:0 0 18px}h3{font-size:1.1rem;margin:24px 0 12px}h4{font-size:1rem;margin:0;text-transform:capitalize}h5{font-size:.875rem;margin:0 0 6px;color:var(--muted)}p{margin:8px 0}.subtitle,.muted{color:var(--muted)}.source{font-size:.875rem;overflow-wrap:anywhere}.cards{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:16px;margin-bottom:28px}.card,.panel,.trial{background:white;border:1px solid var(--line);border-radius:12px}.card{padding:20px 22px}.card-label{color:var(--muted);font-size:.875rem}.card-value{font-size:2rem;font-weight:700;letter-spacing:-.035em;margin:4px 0}.card-note{font-size:.875rem;color:var(--muted)}.panel{padding:24px;margin-bottom:26px}.table-scroll{overflow-x:auto}table{width:100%;border-collapse:collapse;text-align:left}th{font-size:.875rem;color:var(--muted);font-weight:600}th,td{padding:12px 14px;border-bottom:1px solid var(--line)}th:first-child,td:first-child{padding-left:0}tbody tr:last-child td{border-bottom:0}.numeric{font-variant-numeric:tabular-nums;white-space:nowrap}.task-name{font-weight:600}.note{font-size:.875rem;color:var(--muted);margin:18px 0 0}.filters{display:flex;gap:18px;align-items:end;flex-wrap:wrap;margin:25px 0 16px}.field{display:flex;flex-direction:column;gap:6px;font-size:.875rem;color:var(--muted)}select,button{font:inherit;color:var(--ink);background:white;border:1px solid #b8c5d8;border-radius:7px;min-height:42px;padding:8px 12px}select{appearance:none;min-width:190px;padding-right:38px;background-image:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='8'%3E%3Cpath d='m1 1 5 5 5-5' fill='none' stroke='%235c687b' stroke-width='2'/%3E%3C/svg%3E");background-position:right 14px center;background-repeat:no-repeat}button{cursor:pointer}button:hover{background:#edf2ff;border-color:var(--blue)}:focus-visible{outline:3px solid #8da7ff;outline-offset:3px}.trial{margin:12px 0;overflow:hidden}.trial>summary{padding:18px 20px;display:flex;align-items:center;justify-content:space-between;gap:12px;cursor:pointer;list-style:none}.trial>summary::-webkit-details-marker{display:none}.trial>summary:before{content:'+';color:var(--blue);font-weight:600}.trial[open]>summary:before{content:'−'}.trial-name{flex:1;font:600 .875rem/1.5 ui-monospace,SFMono-Regular,Consolas,monospace;overflow-wrap:anywhere}.trial[open]>summary{border-bottom:1px solid var(--line);background:#f9fbff}.badge{display:inline-flex;border-radius:5px;padding:4px 9px;font-size:.875rem;line-height:1.4;font-weight:600;white-space:nowrap}.pass{color:var(--green);background:#e9f6ef}.fail{color:var(--amber);background:#fff2e4}.neutral{color:var(--muted);background:#eef1f6}.trial-body{padding:22px}.trial-meta{display:flex;gap:10px 24px;flex-wrap:wrap;font-size:.875rem;color:var(--muted);margin-bottom:20px}.trial-meta strong{color:var(--ink);font-weight:500;overflow-wrap:anywhere}.check{border:1px solid var(--line);border-radius:9px;padding:18px;margin:12px 0}.check-heading{display:flex;gap:12px;justify-content:space-between;align-items:center}.signals{display:flex;flex-wrap:wrap;gap:20px;color:var(--muted);font-size:.875rem;margin:10px 0}.signals strong{color:var(--ink);font-variant-numeric:tabular-nums}.question{color:var(--muted);font-size:.875rem;margin:14px 0;white-space:pre-wrap}.criteria{display:grid;grid-template-columns:1fr 1fr;gap:22px;padding-top:12px;border-top:1px solid var(--line)}.criteria p{margin:0;font-size:.9375rem;white-space:pre-wrap}.context{margin:14px 0;border:1px solid var(--line);border-radius:8px}.context>summary{cursor:pointer;padding:12px 14px;font-weight:600;font-size:.875rem}.context pre{margin:0;padding:16px;border-top:1px solid var(--line);background:#f8fafc;white-space:pre-wrap;overflow-wrap:anywhere;font: .875rem/1.7 ui-monospace,SFMono-Regular,Consolas,monospace}.error{background:#fff0f0;color:#a02b32;padding:14px;border-radius:8px}.count{font-size:.875rem;color:var(--muted);margin-left:auto}footer{font-size:.875rem;color:var(--muted);margin-top:30px} [hidden]{display:none!important}@media(max-width:700px){main{padding:24px 16px 40px}.cards{grid-template-columns:repeat(2,minmax(0,1fr));gap:10px}.card{padding:15px}.panel{padding:18px}.criteria{grid-template-columns:1fr;gap:16px}.trial-body{padding:14px}.trial>summary{flex-wrap:wrap;padding:16px}.trial-name{flex-basis:75%}.badge{white-space:normal}.count{margin-left:0}.filters{gap:12px}select{min-width:150px}.trial-meta{flex-direction:column}}@media print{body{background:white}main{max-width:none;padding:0}.filters{display:none}.panel,.trial,.check{break-inside:avoid;box-shadow:none}}`;

const SCRIPT = `
const taskFilter=document.getElementById('task-filter');
const stateFilter=document.getElementById('state-filter');
const trials=[...document.querySelectorAll('.trial')];
function filter(){let visible=0;for(const trial of trials){trial.hidden=Boolean((taskFilter.value&&trial.dataset.task!==taskFilter.value)||(stateFilter.value&&trial.dataset.state!==stateFilter.value));if(!trial.hidden)visible++;}document.getElementById('visible-count').textContent=visible+' of '+trials.length+' trials';}
taskFilter.addEventListener('change',filter);stateFilter.addEventListener('change',filter);
document.getElementById('expand').addEventListener('click',()=>{for(const trial of trials)if(!trial.hidden)trial.open=true;});
document.getElementById('collapse').addEventListener('click',()=>{for(const trial of trials)trial.open=false;});
filter();`;

/**
 * Write a self-contained HTML file from saved scores. Makes no API calls and leaves JSON intact.
 * All review/rubric content is escaped. Regeneration uses saved requests, not today's task rubric.
 */
export function writeHtmlReport(inputDirectory: string, outputFile?: string): string {
  const directory = resolve(inputDirectory);
  const output = outputFile ? resolve(outputFile) : join(directory, 'report.html');
  if (extname(output).toLowerCase() !== '.html') throw new Error('HTML output must end in .html');
  const { source, model, trials } = loadTrials(directory);
  const scored = trials.filter((trial) => trial.status === 'scored');
  const mean = scored.length ? scored.reduce((sum, trial) => sum + trial.result!.quality!.pass_rate, 0) / scored.length : null;
  const allPassed = scored.filter((trial) => trial.result!.quality!.pass_rate === 1).length;
  const errors = trials.filter((trial) => trial.status === 'error').length;
  const missing = trials.filter((trial) => trial.status === 'missing_report').length;
  const pending = trials.filter((trial) => trial.status === 'pending').length;
  const dryRuns = trials.filter((trial) => trial.status === 'dry_run').length;
  const tasks = [...new Set(trials.map((trial) => trial.task))];
  const taskRows = tasks.map((task) => {
    const group = trials.filter((trial) => trial.task === task);
    const judged = group.filter((trial) => trial.status === 'scored');
    const checks = judged.flatMap((trial) => Object.values(trial.result!.quality!.checks));
    const passed = checks.filter((check) => check.choice === 'pass').length;
    const taskMean = judged.length ? judged.reduce((sum, trial) => sum + trial.result!.quality!.pass_rate, 0) / judged.length : null;
    const deterministic = group.filter((trial) => trial.result?.deterministic.reward === 1).length;
    return `<tr><td class="task-name">${escape(task)}</td><td class="numeric">${judged.length}/${group.length}</td><td class="numeric">${percent(taskMean)}</td><td class="numeric">${passed}/${checks.length}</td><td class="numeric">${deterministic}/${group.filter((trial) => trial.result).length}</td></tr>`;
  }).join('');
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; img-src data:; base-uri 'none'; form-action 'none'">
  <title>Code-change eval report</title><style>${STYLE}</style></head><body><main>
  <header><div class="eyebrow">Agent tooling · Evaluation results</div><h1>Code-change review report</h1><p class="subtitle">Judge: <strong>${escape(model)}</strong></p><p class="source muted">Source run: ${escape(basename(source))}</p></header>
  <section class="cards" aria-label="Run overview">
    <div class="card"><div class="card-label">Reviews scored</div><div class="card-value">${scored.length}<span class="muted"> / ${trials.length}</span></div><div class="card-note">Saved attempts in this report</div></div>
    <div class="card"><div class="card-label">Mean trial score</div><div class="card-value">${percent(mean)}</div><div class="card-note">Each scored review has equal weight</div></div>
    <div class="card"><div class="card-label">All checks passed</div><div class="card-value">${allPassed}<span class="muted"> / ${scored.length}</span></div><div class="card-note">Reviews with every rubric check marked pass</div></div>
    <div class="card"><div class="card-label">Unscored reviews</div><div class="card-value">${trials.length - scored.length}</div><div class="card-note">${errors} grading errors · ${missing} missing reports<br>${pending} pending · ${dryRuns} dry runs</div></div>
  </section>
  <section class="panel"><h2>Results by task</h2><div class="table-scroll"><table><thead><tr><th scope="col">Task</th><th scope="col">Scored</th><th scope="col">Mean score</th><th scope="col">Rubric checks passed</th><th scope="col">Deterministic passes</th></tr></thead><tbody>${taskRows}</tbody></table></div><p class="note">A trial score is the fraction of rubric questions marked pass. P(pass) and confidence are separate model signals, shown below. Unscored trials are excluded from averages. Judge accuracy and confidence thresholds are not yet calibrated.</p></section>
  <h2>Rubric and review details</h2><div class="filters"><label class="field">Task<select id="task-filter"><option value="">All tasks</option>${tasks.map((task) => `<option value="${escape(task)}">${escape(task)}</option>`).join('')}</select></label><label class="field">Result<select id="state-filter"><option value="">All results</option><option value="attention">Some checks failed</option><option value="passed">All checks passed</option><option value="unscored">Not scored</option></select></label><button id="expand" type="button">Expand trials</button><button id="collapse" type="button">Collapse trials</button><span class="count" id="visible-count" aria-live="polite"></span></div>
  ${trials.map(trialHtml).join('')}
  <footer>Generated from saved requests and scores. Rubric text and original reviews are shown as recorded; no new judge calls were made to build this page.</footer>
  </main><script>${SCRIPT}</script></body></html>`;
  mkdirSync(dirname(output), { recursive: true });
  writeFileSync(output, html);
  return output;
}
