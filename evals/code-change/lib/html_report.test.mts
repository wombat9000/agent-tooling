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
  assert.ok(!html.includes('Trial usage and timing'), 'usage strip is omitted when no trial has usage or timing metrics');
});

test('HTML renders per-trial and aggregate tokens, cost, and duration when present and handles partial/null fallback', (t) => {
  const f = fixture(t);
  const first = putTrial(f.directory, 'trial-one', ['pass', 'pass']);
  const second = putTrial(f.directory, 'trial-two', ['pass', 'fail']);
  writeFileSync(join(f.directory, 'summary.json'), JSON.stringify({
    source_run: '/saved/source',
    model: 'test/judge',
    reports: [
      {
        ...first,
        usage: {
          n_input_tokens: 40_000,
          n_cache_tokens: 25_000,
          n_output_tokens: 5_000,
          cost_usd: 0.25,
          duration_sec: 90,
          agent_duration_sec: 75,
        },
      },
      {
        ...second,
        usage: {
          n_input_tokens: 20_000,
          n_cache_tokens: 15_000,
          n_output_tokens: 3_000,
          cost_usd: 0.15,
          duration_sec: 30,
          agent_duration_sec: 25,
        },
      },
    ],
  }));
  const html = readFileSync(writeHtmlReport(f.directory), 'utf8');
  assert.ok(html.includes('Trial usage and timing'));
  assert.ok(html.includes('60.0k'));
  assert.ok(html.includes('8.00k'));
  assert.ok(html.includes('40.0k cache'));
  assert.ok(html.includes('$0.40'));
  assert.ok(html.includes('mean $0.20 / trial (2/2)'));
  assert.ok(html.includes('1m 00s'));
  assert.ok(html.includes('Mean tokens'));
  assert.ok(html.includes('Mean cost'));
  assert.ok(html.includes('Mean duration'));
  assert.ok(html.includes('40.0k in (25.0k cache) / 5.00k out'));
  assert.ok(html.includes('agent 1m 15s'));
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
  // Without rubric_groups, no grouped-matrix controls are shown.
  assert.ok(!html.includes('class="matrix-controls"'));
  assert.ok(html.includes('class="heat-pill fail trial-jump"'));
  assert.ok(html.includes('class="heat-pill pass trial-jump"'));
});

test('multi-rubric reports render collapsible rubric groups, weakest-link cells, and interactive Grouped / Worst-first views', (t) => {
  const f = fixture(t);
  const trial = putTrial(f.directory, 'one', ['pass', 'pass', 'fail', 'pass'], {
    rubric: 'domain-modelling-v1+solid-v1',
    rubric_groups: {
      'domain-modelling': ['check_0', 'check_1'],
      solid: ['check_2', 'check_3'],
    },
    quality: {
      pass_rate: 3 / 4,
      checks: {
        check_0: { choice: 'pass', pass_probability: 0.98, confidence: 0.96 },
        check_1: { choice: 'pass', pass_probability: 0.95, confidence: 0.9 },
        check_2: { choice: 'fail', pass_probability: 0.2, confidence: 0.6 },
        check_3: { choice: 'pass', pass_probability: 0.67, confidence: 0.34 },
      },
    },
  });
  writeFileSync(join(f.directory, 'summary.json'), JSON.stringify({
    model: 'test/judge',
    source_run: '/saved/source',
    reports: [trial],
  }));
  const html = readFileSync(writeHtmlReport(f.directory), 'utf8');
  assert.ok(html.includes('class="matrix-controls"'));
  // Failing group (SOLID) is sorted first and auto-expanded; clean group (Domain Modelling) starts collapsed.
  assert.ok(html.indexOf('data-group-row="solid"') < html.indexOf('data-group-row="domain-modelling"'));
  assert.ok(html.includes('data-group-toggle="solid"'));
  assert.ok(html.includes('aria-expanded="true" data-group-toggle="solid"'));
  assert.ok(html.includes('aria-expanded="false" data-group-toggle="domain-modelling"'));
  // Group cells show weakest-link probability and lowest check name in popover.
  assert.ok(html.includes('<span>Lowest</span><strong>check 2 (20.0%)</strong>'));
  assert.ok(html.includes('<span>Lowest</span><strong>check 1 (95.0%)</strong>'));
  // Compact heatmap cells omit repeated pass/fail words and vary gradient color by probability.
  const passStyles = [...html.matchAll(/class="heat-pill pass trial-jump" style="([^"]+)"/g)].map((m) => m[1]);
  assert.ok(passStyles.length >= 4);
  assert.ok(new Set(passStyles).size >= 3);
  assert.ok(!html.includes('>pass 98%<'));
  assert.ok(html.includes('>98%</a>'));
  assert.ok(html.includes('>20%</a>'));
  // Clean tail (check_0 and check_1, both >=90% and 1/1) is folded in Worst-first view.
  assert.ok(html.includes('data-clean-fold'));
  assert.ok(html.includes('2 checks passing cleanly (≥ 90%, 2/2)'));

  const makeBtn = (initialClasses: string[], attrs: Record<string, string>, dataset: Record<string, string>, text = '') => {
    const classes = new Set(initialClasses);
    const caret = { textContent: attrs['aria-expanded'] === 'true' ? '▾' : '▸' };
    const btn = {
      dataset,
      classes,
      attrs,
      textContent: text,
      hidden: false,
      classList: { toggle(cls: string, force: boolean) { if (force) classes.add(cls); else classes.delete(cls); } },
      getAttribute(k: string) { return attrs[k] ?? null; },
      setAttribute(k: string, v: string) { attrs[k] = v; },
      querySelector(sel: string) { return sel === '.group-caret' ? caret : null; },
      closest(sel: string) {
        if (sel === '[data-matrix-mode]' && 'matrixMode' in dataset) return btn;
        if (sel === '[data-matrix-expand-all]' && 'matrixExpandAll' in dataset) return btn;
        if (sel === '[data-group-toggle]' && 'groupToggle' in dataset) return btn;
        if (sel === '[data-clean-fold]' && 'cleanFold' in dataset) return btn;
        return null;
      },
      caret,
    };
    return btn;
  };

  const modeBtns = [...html.matchAll(/<button type="button" class="view-btn([^"]*)" role="tab" aria-selected="([^"]*)" data-matrix-mode="([^"]*)">/g)]
    .map((m) => makeBtn(['view-btn', ...m[1].trim().split(/\s+/).filter(Boolean)], { 'aria-selected': m[2] }, { matrixMode: m[3] }));
  const expandAllBtn = makeBtn(['mini-btn'], {}, { matrixExpandAll: '' }, 'Expand all');
  const groupToggles = [...html.matchAll(/<button type="button" class="group-toggle" aria-expanded="([^"]*)" data-group-toggle="([^"]*)">/g)]
    .map((m) => makeBtn(['group-toggle'], { 'aria-expanded': m[1] }, { groupToggle: m[2] }));
  const groupRows = [...html.matchAll(/<tr class="matrix-group-row([^"]*)" data-group-row="([^"]*)">/g)]
    .map((m) => {
      const classes = new Set(['matrix-group-row', ...m[1].trim().split(/\s+/).filter(Boolean)]);
      return { dataset: { groupRow: m[2] }, classes, classList: { toggle(c: string, f: boolean) { if (f) classes.add(c); else classes.delete(c); } } };
    });
  const childRows = [...html.matchAll(/<tr class="matrix-child-row" data-group-child="([^"]*)"([^>]*)>/g)]
    .map((m) => ({ dataset: { groupChild: m[1] }, hidden: m[2].includes('hidden') }));
  const viewBodies = [...html.matchAll(/<tbody data-matrix-view="([^"]*)"([^>]*)>/g)]
    .map((m) => ({ dataset: { matrixView: m[1] }, hidden: m[2].includes('hidden') }));
  const foldMatch = html.match(/<button type="button" class="fold-toggle" aria-expanded="([^"]*)" data-clean-fold data-count="([^"]*)" data-passed="([^"]*)" data-scored="([^"]*)">/)!;
  const foldBtn = makeBtn(
    ['fold-toggle'],
    { 'aria-expanded': foldMatch[1] },
    { cleanFold: '', count: foldMatch[2], passed: foldMatch[3], scored: foldMatch[4] },
  );
  const cleanTailRows = [...html.matchAll(/<tr class="matrix-flat-row" data-clean-tail([^>]*)>/g)]
    .map((m) => ({ hidden: m[1].includes('hidden') }));

  assert.equal(modeBtns.length, 2);
  assert.equal(groupToggles.length, 2);
  assert.equal(childRows.length, 4);
  assert.deepEqual(childRows.map((r) => [r.dataset.groupChild, r.hidden]), [
    ['solid', false],
    ['solid', false],
    ['domain-modelling', true],
    ['domain-modelling', true],
  ]);
  assert.equal(cleanTailRows.length, 2);
  assert.deepEqual(cleanTailRows.map((r) => r.hidden), [true, true]);

  type Control = { value: string; textContent: string; addEventListener: (name: string, handler: () => void) => void };
  const controls = Object.fromEntries(['task-filter', 'state-filter', 'visible-count', 'expand', 'collapse'].map((id) => {
    const control: Control = { value: '', textContent: '', addEventListener() {} };
    return [id, control];
  }));
  let docClick: ((event: { target: unknown }) => void) | undefined;
  const script = html.match(/<script>([\s\S]*)<\/script>/)![1];
  runInNewContext(script, {
    document: {
      getElementById: (id: string) => controls[id],
      querySelectorAll: (sel: string) => {
        if (sel === '[data-matrix-mode]') return modeBtns;
        if (sel === '[data-matrix-expand-all]') return [expandAllBtn];
        if (sel === '[data-group-toggle]') return groupToggles;
        if (sel === 'tr[data-group-row]') return groupRows;
        if (sel === 'tr[data-group-child]') return childRows;
        if (sel === 'tbody[data-matrix-view]') return viewBodies;
        if (sel === 'tr[data-clean-tail]') return cleanTailRows;
        return [];
      },
      addEventListener(name: string, fn: (event: { target: unknown }) => void) {
        if (name === 'click') docClick = fn;
      },
    },
  });
  assert.ok(docClick);

  // Clicking collapsed Domain Modelling expands its rows and flips button to Collapse all.
  docClick({ target: groupToggles[1] });
  assert.equal(groupToggles[1].attrs['aria-expanded'], 'true');
  assert.equal(groupToggles[1].caret.textContent, '▾');
  assert.deepEqual(childRows.map((r) => r.hidden), [false, false, false, false]);
  assert.equal(expandAllBtn.textContent, 'Collapse all');

  // Clicking Collapse all collapses every group and flips button back to Expand all.
  docClick({ target: expandAllBtn });
  assert.deepEqual(childRows.map((r) => r.hidden), [true, true, true, true]);
  assert.equal(expandAllBtn.textContent, 'Expand all');

  // Switching to Worst first shows flat tbody and hides Expand all.
  docClick({ target: modeBtns[1] });
  assert.deepEqual(viewBodies.map((b) => [b.dataset.matrixView, b.hidden]), [['grouped', true], ['flat', false]]);
  assert.equal(expandAllBtn.hidden, true);

  // Expanding clean tail reveals the 2 clean rows.
  docClick({ target: foldBtn });
  assert.equal(foldBtn.attrs['aria-expanded'], 'true');
  assert.deepEqual(cleanTailRows.map((r) => r.hidden), [false, false]);
  assert.equal(foldBtn.textContent, '▾ Hide 2 checks passing cleanly');
});



test('TypeScript and TSX reports highlight syntax and escape JSX across source lines', (t) => {
  const { directory } = fixture(t);
  const trial = putTrial(directory, 'todo-trial', ['pass'], { target: 'production_code' });
  const sources = {
    'todo.ts': ['const title = <string>input;', 'const limit = 80;'],
    'TodoApp.tsx': [
      'export const identity = <T,>(value: T) => value;',
      '/* JSX component',
      ' * on multiple lines */',
      'export const View = () => (',
      '  <Card title="a & b"',
      '    visible={2 < 3}>',
      "    It's // JSX text",
      '    {items.map((item) => <Item key={item.id} />)}',
      '    {`value: ${true ? "yes" : "no"}`}',
      '    <script>{title}</script>',
      '  </Card>',
      ');',
    ],
  };
  const productionFiles = Object.fromEntries(Object.entries(sources).map(([name, lines]) => [
    name, lines.map((line, index) => `${index + 1}: ${line}`).join('\n'),
  ]));
  const request = { ...trial.request, state: { ...trial.request.state, production_files: productionFiles } };
  writeFileSync(join(trial.result_dir, 'request.json'), JSON.stringify(request));
  writeFileSync(join(directory, 'summary.json'), JSON.stringify({ model: 'test/judge', reports: [trial] }));

  const html = readFileSync(writeHtmlReport(directory), 'utf8');
  for (const token of [
    '<span class="tok-kw">export</span>',
    '&lt;<span class="tok-ty">string</span>&gt;input',
    '&lt;<span class="tok-ty">T</span>,&gt;',
    '<span class="tok-num">80</span>',
    '<span class="tok-cm"> * on multiple lines */</span>',
    '<span class="tok-ty">&lt;Card</span>',
    '<span class="tok-ann">title</span>=<span class="tok-str">&quot;a &amp; b&quot;</span>',
    '<span class="tok-ann">visible</span>',
    '<span class="tok-num">2</span> &lt; <span class="tok-num">3</span>',
    'It&#39;s // JSX text',
    '<span class="tok-ty">&lt;Item</span>',
    '<span class="tok-kw">${</span><span class="tok-num">true</span>',
    '<span class="tok-ty">&lt;/Card</span>',
    '<span class="tok-ty">&lt;script</span>',
  ]) {
    assert.ok(html.includes(token), token);
  }
  assert.doesNotMatch(html, /<script>\{title\}<\/script>/);
});

test('test_code reports render Test files viewer, collapsible Production context, Test files KPI, and escape XSS', (t) => {
  const { directory } = fixture(t);
  const trial = putTrial(directory, 'booking__abc', ['pass', 'fail'], {
    target: 'test_code',
    scope: 'whole',
    file_count: 1,
    context_file_count: 2,
    rubric: 'testing-v1',
  });
  const request = {
    ...trial.request,
    state: {
      task: 'implement-meeting-room-booking',
      requirement: 'Spec text',
      scope: 'whole',
      test_files: {
        'booking/BookingApiTest.kt': '1: package booking\n2: class BookingApiTest { val x = "<script>evil()</script>" }',
      },
      production_files_context: {
        'booking/Booking.kt': '1: package booking\n2: data class Booking(val id: String)',
        'booking/Room.kt': '1: package booking\n2: data class Room(val id: String)',
      },
    },
  };
  writeFileSync(join(trial.result_dir, 'request.json'), JSON.stringify(request));
  writeFileSync(join(directory, 'summary.json'), JSON.stringify({
    model: 'test/judge',
    source_run: '/saved/source',
    target: 'test_code',
    reports: [trial],
  }));

  const html = readFileSync(writeHtmlReport(directory), 'utf8');
  assert.ok(html.includes('<span class="cond-badge cond-neutral">Tests</span>'));
  assert.ok(html.includes('Target <strong>test_code</strong>'));
  assert.ok(html.includes('<div class="kpi-label">Test files</div>'));
  assert.ok(html.includes('<h3>Test files (1)</h3>'));
  assert.ok(html.includes('Production context (2 files)'));
  assert.ok(html.includes('Context files <strong>2</strong>'));
  assert.ok(html.includes('data-tab-group="t0"'));
  assert.ok(html.includes('data-tab-group="t0-ctx"'));
  assert.ok(!html.includes('<script>evil()</script>'));
  assert.ok(html.includes('&lt;script&gt;evil()&lt;/script&gt;'));
});
