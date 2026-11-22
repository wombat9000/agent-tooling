import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { runInNewContext } from 'node:vm';
import { latestJudgment, writeHtmlReport } from './html_report.mts';

function fixture(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), 'code-change-html-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const directory = join(root, 'judges/run/model');
  mkdirSync(directory, { recursive: true });
  return { root, directory };
}

function putTrial(directory: string, trial: string, choices: Array<'pass' | 'fail'>, overrides = {}) {
  const resultDirectory = join(directory, trial);
  mkdirSync(resultDirectory, { recursive: true });
  const questions = Object.fromEntries(choices.map((_, index) => [`check_${index}`, {
    type: 'choice', instructions: `Saved rubric question ${index}?`,
    criteria: { pass: `Saved pass criterion ${index}`, fail: `Saved fail criterion ${index}` },
  }]));
  const request = { model: 'test/judge', state: { task: 'task-a', requirement: 'Original requirement',
    review: 'Original review text' }, questions };
  const checks = Object.fromEntries(choices.map((choice, index) => [`check_${index}`, {
    choice, pass_probability: choice === 'pass' ? 0.59 : 0.2, confidence: 0.18,
  }]));
  const result = { status: 'scored', requested_model: 'test/judge', returned_model: 'test/judge-snapshot',
    rubric: 'saved-rubric-1', deterministic: { reward: 0 },
    quality: { pass_rate: choices.filter((choice) => choice === 'pass').length / choices.length, checks }, ...overrides };
  writeFileSync(join(resultDirectory, 'request.json'), JSON.stringify(request));
  writeFileSync(join(resultDirectory, 'result.json'), JSON.stringify(result));
  return { trial, task: request.state.task, status: result.status, result_dir: resultDirectory, request, result };
}

test('HTML includes the historical rubric, choices, probabilities, and original review', (t) => {
  const f = fixture(t);
  const trial = putTrial(f.directory, 'trial-one', ['pass', 'fail']);
  writeFileSync(join(f.directory, 'summary.json'), JSON.stringify({ source_run: '/saved/source', model: 'test/judge', reports: [trial] }));
  const html = readFileSync(writeHtmlReport(f.directory), 'utf8');
  for (const text of ['Saved rubric question 0?', 'Saved pass criterion 0', 'Saved fail criterion 0',
    'Original review text', 'Original requirement', 'saved-rubric-1', 'test/judge-snapshot', '59.0%', '18.0%', '50.0%']) {
    assert.ok(html.includes(text), text);
  }
  assert.ok(html.includes('data-state="attention"'));
  assert.ok(html.includes('Mean trial score'));
  assert.ok(html.includes('Deterministic passes'));
  assert.ok(html.includes('id="task-filter"'));
  assert.ok(html.includes('id="state-filter"'));
  assert.ok(!html.includes('<script src='));
  assert.ok(!html.includes('<link rel="stylesheet"'));
});

test('mean trial scores give equal weight to trials, while task check counts remain separate', (t) => {
  const f = fixture(t);
  const first = putTrial(f.directory, 'one', ['pass', 'fail']);
  const second = putTrial(f.directory, 'two', ['pass', 'pass', 'pass', 'pass']);
  const failed = putTrial(f.directory, 'error', ['pass'], { status: 'error', quality: null, error: 'HTTP 429' });
  writeFileSync(join(f.directory, 'summary.json'), JSON.stringify({ model: 'test/judge', source_run: '/saved/source', reports: [
    first, second, failed, { trial: 'pending', task: 'task-a', status: 'pending', result_dir: join(f.directory, 'pending') },
  ] }));
  const html = readFileSync(writeHtmlReport(f.directory), 'utf8');
  assert.ok(html.includes('75.0%'));
  assert.ok(html.includes('5/6'));
  assert.ok(html.includes('HTTP 429'));
  assert.ok(html.includes('Unscored trials are excluded from averages'));
  assert.ok(!html.includes('NaN'));
  assert.equal((html.match(/class="trial"/g) ?? []).length, 4);
});

test('untrusted review, task, rubric, and error text cannot introduce HTML or script', (t) => {
  const f = fixture(t);
  const trial = putTrial(f.directory, 'one', ['pass']);
  const payload = '</pre><script>alert("xss")</script><img src=x onerror="alert(1)">';
  trial.request.state.review = payload;
  trial.request.state.requirement = payload;
  trial.request.state.task = payload;
  trial.request.questions.check_0.instructions = payload;
  trial.request.questions.check_0.criteria.pass = payload;
  trial.result.rubric = payload;
  writeFileSync(join(trial.result_dir, 'request.json'), JSON.stringify(trial.request));
  writeFileSync(join(trial.result_dir, 'result.json'), JSON.stringify(trial.result));
  const html = readFileSync(writeHtmlReport(trial.result_dir), 'utf8');
  assert.ok(!html.includes(payload));
  assert.ok(!html.includes('<img src=x'));
  assert.ok(html.includes('&lt;script&gt;alert(&quot;xss&quot;)&lt;/script&gt;'));
  assert.equal((html.match(/<script>/g) ?? []).length, 1);
});

test('latest report source excludes newer dry runs and ignores generated HTML modification time', (t) => {
  const f = fixture(t);
  const first = putTrial(f.directory, 'first', ['pass']);
  // A single judgment lives at judges/<task>/<model-run>/result.json.
  const scoredDirectory = first.result_dir;
  const single = join(f.root, 'judges/task/scored');
  mkdirSync(single, { recursive: true });
  writeFileSync(join(single, 'result.json'), JSON.stringify(first.result));
  const dry = join(f.root, 'judges/task/dry');
  mkdirSync(dry);
  writeFileSync(join(dry, 'result.json'), JSON.stringify({ ...first.result, status: 'dry_run' }));
  utimesSync(join(single, 'result.json'), new Date('2026-01-01'), new Date('2026-01-01'));
  utimesSync(join(dry, 'result.json'), new Date('2040-01-01'), new Date('2040-01-01'));
  writeFileSync(join(dry, 'report.html'), 'newer HTML is not a new judgment');
  assert.equal(latestJudgment(join(f.root, 'judges')), single);
  assert.ok(readFileSync(writeHtmlReport(scoredDirectory), 'utf8').includes('Saved pass criterion 0'));
});

test('report output cannot overwrite score JSON, and empty histories give a useful error', (t) => {
  const f = fixture(t);
  const trial = putTrial(f.directory, 'one', ['pass']);
  const before = readFileSync(join(trial.result_dir, 'result.json'), 'utf8');
  assert.throws(() => writeHtmlReport(trial.result_dir, join(trial.result_dir, 'result.json')), /must end in .html/);
  assert.equal(readFileSync(join(trial.result_dir, 'result.json'), 'utf8'), before);
  assert.throws(() => latestJudgment(join(f.root, 'missing')), /No saved judge scores/);
});

test('missing and empty input folders fail without creating report artifacts; interrupted requests remain viewable', (t) => {
  const f = fixture(t);
  const missing = join(f.root, 'missing');
  assert.throws(() => writeHtmlReport(missing), /No saved judge data/);
  assert.equal(existsSync(missing), false);
  assert.throws(() => writeHtmlReport(f.directory), /No saved judge data/);
  assert.equal(existsSync(join(f.directory, 'report.html')), false);
  const trial = putTrial(f.directory, 'interrupted', ['pass']);
  rmSync(join(trial.result_dir, 'result.json'));
  const html = readFileSync(writeHtmlReport(trial.result_dir), 'utf8');
  assert.ok(html.includes('Original review text'));
  assert.ok(html.includes('pending'));
});

test('missing reports and grading errors have distinct counts and no quality scores', (t) => {
  const f = fixture(t);
  const missing = putTrial(f.directory, 'missing', ['pass'], { status: 'missing_report', quality: null });
  const failed = putTrial(f.directory, 'failed', ['pass'], { status: 'error', quality: null, error: 'HTTP 429' });
  writeFileSync(join(f.directory, 'summary.json'), JSON.stringify({ model: 'test/judge', reports: [missing, failed] }));
  const html = readFileSync(writeHtmlReport(f.directory), 'utf8');
  assert.ok(html.includes('1 grading errors · 1 missing reports'));
  assert.ok(html.includes('Unscored reviews'));
  assert.ok(!html.includes('2 grading errors'));
});

test('saved-page controls filter trials, update counts, and expand only visible reviews', (t) => {
  const f = fixture(t);
  const first = putTrial(f.directory, 'one', ['pass']);
  const second = putTrial(f.directory, 'two', ['fail']);
  second.task = 'task-b';
  writeFileSync(join(f.directory, 'summary.json'), JSON.stringify({ model: 'test/judge', source_run: '/saved/source', reports: [first, second] }));
  const html = readFileSync(writeHtmlReport(f.directory), 'utf8');
  const trials = [...html.matchAll(/<details class="trial" data-task="([^"]*)" data-state="([^"]*)" ([^>]*)>/g)]
    .map((match) => ({ dataset: { task: match[1], state: match[2] }, hidden: false, open: match[3].includes('open') }));
  type Control = { value: string; textContent: string; handlers: Record<string, () => void>; addEventListener: (name: string, handler: () => void) => void };
  const controls = Object.fromEntries(['task-filter', 'state-filter', 'visible-count', 'expand', 'collapse'].map((id) => {
    const control: Control = { value: '', textContent: '', handlers: {}, addEventListener(name, handler) { this.handlers[name] = handler; } };
    return [id, control];
  }));
  const script = html.match(/<script>([\s\S]*)<\/script>/)![1];
  runInNewContext(script, { document: { getElementById: (id: string) => controls[id], querySelectorAll: () => trials } });
  assert.equal(controls['visible-count'].textContent, '2 of 2 trials');
  controls['task-filter'].value = 'task-b';
  controls['task-filter'].handlers.change();
  assert.deepEqual(trials.map((trial) => trial.hidden), [true, false]);
  assert.equal(controls['visible-count'].textContent, '1 of 2 trials');
  controls.collapse.handlers.click();
  controls.expand.handlers.click();
  assert.deepEqual(trials.map((trial) => trial.open), [false, true]);
  controls['state-filter'].value = 'passed';
  controls['state-filter'].handlers.change();
  assert.equal(controls['visible-count'].textContent, '0 of 2 trials');
});

test('code reports render Check x Trial matrix, failure-first checks, and deduplicated tabbed source viewer', (t) => {
  const f = fixture(t);
  const resultDirectory = join(f.directory, 'implement-mars-rover__abc123');
  mkdirSync(resultDirectory, { recursive: true });
  const questions = {
    passing_check: { type: 'choice', instructions: 'Passes?', criteria: { pass: 'Yes', fail: 'No' } },
    failing_check: { type: 'choice', instructions: 'Fails?', criteria: { pass: 'Clean', fail: 'Messy' } },
  };
  const request = {
    model: 'test/judge',
    state: {
      task: 'implement-mars-rover',
      requirement: 'Spec text',
      scope: 'per-file',
      production_files: {
        'rover/A.kt': '1: package rover\n2: /** doc\n3:  * end */\n4: class RoverA { val s = "${result.x} $y <script>x</script>" }',
        'rover/B.kt': '1: package rover\n2: enum class Dir { NORTH }',
      },
    },
    questions,
  };
  const result = {
    status: 'scored',
    target: 'production_code',
    scope: 'per-file',
    file_count: 2,
    requested_model: 'test/judge',
    returned_model: 'test/judge-snap',
    rubric: 'r1',
    deterministic: { reward: 1 },
    quality: {
      pass_rate: 0.75,
      all_files_pass_rate: 0.5,
      checks: {
        passing_check: { choice: 'pass', pass_probability: 0.95, confidence: 0.9, files_passed: 2, files_total: 2, min_pass_probability: 0.94 },
        failing_check: { choice: 'fail', pass_probability: 0.2, confidence: 0.8, files_passed: 1, files_total: 2, min_pass_probability: 0.1 },
      },
    },
    file_results: [
      { file: 'rover/A.kt', status: 'scored', pass_rate: 1, checks: {
        passing_check: { choice: 'pass', pass_probability: 0.96, confidence: 0.9 },
        failing_check: { choice: 'pass', pass_probability: 0.8, confidence: 0.8 },
      } },
      { file: 'rover/B.kt', status: 'scored', pass_rate: 0.5, checks: {
        passing_check: { choice: 'pass', pass_probability: 0.94, confidence: 0.9 },
        failing_check: { choice: 'fail', pass_probability: 0.1, confidence: 0.8 },
      } },
    ],
  };
  writeFileSync(join(resultDirectory, 'request.json'), JSON.stringify(request));
  writeFileSync(join(resultDirectory, 'result.json'), JSON.stringify(result));
  writeFileSync(join(f.directory, 'summary.json'), JSON.stringify({
    source_run: '/saved/source',
    model: 'test/judge',
    scope: 'per-file',
    reports: [{ trial: 'implement-mars-rover__abc123', task: 'implement-mars-rover', status: 'scored', result_dir: resultDirectory }],
  }));

  const html = readFileSync(writeHtmlReport(f.directory), 'utf8');
  assert.ok(html.includes('Check × Trial matrix'));
  assert.ok(html.includes('abc123'));
  // Failing check appears before passing check in both the matrix and the trial check table.
  assert.ok(html.indexOf('failing check') < html.indexOf('passing check'));
  assert.ok(html.includes('class="criteria-toggle"'));
  assert.ok(html.includes('class="file-tab active"'));
  // Each file's source is embedded once (no duplicate dump in per-file mode) with Kotlin syntax highlighting.
  assert.equal((html.match(/RoverA/g) ?? []).length, 1);
  assert.equal((html.match(/NORTH/g) ?? []).length, 1);
  assert.ok(html.includes('<span class="ln">1</span><span class="cl"><span class="tok-kw">package</span> rover</span>'));
  assert.ok(html.includes('<span class="tok-cm"> * end */</span>'));
  assert.ok(html.includes('<span class="tok-const">NORTH</span>'));
  assert.ok(html.includes('<span class="tok-kw">${</span>result.x<span class="tok-kw">}</span>'));
  assert.ok(html.includes('<span class="tok-kw">$</span>y'));
  assert.ok(html.includes('class="tip-card"'));
  assert.ok(html.includes('class="cell-pop"'));
  assert.ok(html.includes('rover/B.kt (10.0%)'));
  // Raw script tags inside highlighted Kotlin strings remain escaped.
  assert.ok(!html.includes('<script>x</script>'));
  assert.ok(html.includes('&lt;script&gt;x&lt;/script&gt;'));
});

