'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { renderMarkdownReport, renderSarif, sarifLevel } = require('../src/report');

function fakeSnapshot() {
  return {
    baseSha: 'a'.repeat(40),
    headSha: 'b'.repeat(40),
    diffSha256: 'c'.repeat(64),
    snapshotId: 'd'.repeat(64)
  };
}

test('renderMarkdownReport shows each channel verdict on its own row, never a combined "N of 3" line', () => {
  const md = renderMarkdownReport({
    snapshot: fakeSnapshot(),
    status: 'DISPUTED',
    semgrepFindings: [],
    claudeReview: { overallVerdict: 'safe', findings: [], parseError: null },
    gptReview: { overallVerdict: 'concerns', findings: [], parseError: null },
    disagreementMatrix: []
  });
  assert.match(md, /Claude \(Sonnet 5\) \| safe/);
  assert.match(md, /GPT-5\.6 Sol \| concerns/);
  assert.doesNotMatch(md, /\d of \d/i, 'must never render a majority-style "N of M" summary');
});

test('renderMarkdownReport includes the override-required note for any non-PASS status', () => {
  const md = renderMarkdownReport({
    snapshot: fakeSnapshot(),
    status: 'NEEDS_HUMAN_REVIEW',
    semgrepFindings: [],
    claudeReview: { overallVerdict: 'unsafe', findings: [], parseError: null },
    gptReview: { overallVerdict: 'unsafe', findings: [], parseError: null },
    disagreementMatrix: []
  });
  assert.match(md, /human must review this before merge/);
});

test('renderMarkdownReport omits the override note for PASS', () => {
  const md = renderMarkdownReport({
    snapshot: fakeSnapshot(),
    status: 'PASS',
    semgrepFindings: [],
    claudeReview: { overallVerdict: 'safe', findings: [], parseError: null },
    gptReview: { overallVerdict: 'safe', findings: [], parseError: null },
    disagreementMatrix: []
  });
  assert.doesNotMatch(md, /human must review/);
});

test('renderMarkdownReport surfaces a parse error visibly rather than silently treating it as a clean review', () => {
  const md = renderMarkdownReport({
    snapshot: fakeSnapshot(),
    status: 'NEEDS_HUMAN_REVIEW',
    semgrepFindings: [],
    claudeReview: { overallVerdict: 'concerns', findings: [], parseError: 'Could not parse claude output as JSON' },
    gptReview: { overallVerdict: 'safe', findings: [], parseError: null },
    disagreementMatrix: []
  });
  assert.match(md, /parse error/);
});

test('renderSarif produces valid-shaped SARIF 2.1.0 with results from all three channels, each message prefixed by channel', () => {
  const sarif = renderSarif({
    snapshot: fakeSnapshot(),
    semgrepFindings: [{ ruleId: 'js-eval-use', path: 'a.js', startLine: 3, message: 'eval', severity: 'ERROR' }],
    claudeReview: { findings: [{ category: 'injection', path: 'a.js', line: 3, description: 'eval on input', severity: 'critical' }] },
    gptReview: { findings: [{ category: 'injection', path: 'a.js', line: 3, description: 'eval on input', severity: 'critical' }] }
  });
  assert.equal(sarif.version, '2.1.0');
  const results = sarif.runs[0].results;
  assert.equal(results.length, 3);
  assert.ok(results.some((r) => r.message.text.startsWith('[semgrep]')));
  assert.ok(results.some((r) => r.message.text.startsWith('[claude]')));
  assert.ok(results.some((r) => r.message.text.startsWith('[gpt-5.6-sol]')));
});

test('sarifLevel maps severities to SARIF levels', () => {
  assert.equal(sarifLevel('critical'), 'error');
  assert.equal(sarifLevel('high'), 'error');
  assert.equal(sarifLevel('medium'), 'warning');
  assert.equal(sarifLevel('low'), 'note');
  assert.equal(sarifLevel('info'), 'note');
  assert.equal(sarifLevel(undefined), 'note');
});
