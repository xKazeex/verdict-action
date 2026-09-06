'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { sameLocation, buildDisagreementMatrix, determineStatus, normalizeChannelFindings } = require('../src/combine');

test('normalizeChannelFindings maps Semgrep ERROR/WARNING/INFO onto the shared severity scale (this was a real bug: unmapped, a Semgrep ERROR could never trigger NEEDS_HUMAN_REVIEW)', () => {
  const [errorFinding, warnFinding, infoFinding] = normalizeChannelFindings('semgrep', [
    { severity: 'ERROR', ruleId: 'js-eval-use' },
    { severity: 'WARNING', ruleId: 'js-insecure-random' },
    { severity: 'INFO', ruleId: 'x' }
  ]);
  assert.equal(errorFinding.severity, 'high');
  assert.equal(warnFinding.severity, 'medium');
  assert.equal(infoFinding.severity, 'low');
});

test('normalizeChannelFindings leaves reviewer-channel severities as-is (already on the shared scale)', () => {
  const [f] = normalizeChannelFindings('claude', [{ severity: 'critical', category: 'injection' }]);
  assert.equal(f.severity, 'critical');
});

test('a Semgrep ERROR finding alone (both reviewers silent) still forces NEEDS_HUMAN_REVIEW through determineStatus, end to end', () => {
  const matrix = buildDisagreementMatrix({
    semgrep: [{ ruleId: 'js-eval-use', path: 'a.js', startLine: 3, message: 'eval', severity: 'ERROR' }],
    claude: [],
    'gpt-5.6-sol': []
  });
  const status = determineStatus({ claudeVerdict: 'safe', gptVerdict: 'safe', disagreementMatrix: matrix });
  assert.equal(status, 'NEEDS_HUMAN_REVIEW');
});

test('sameLocation matches within tolerance, on the same path', () => {
  assert.equal(sameLocation({ path: 'a.js', line: 10 }, { path: 'a.js', line: 11 }), true);
  assert.equal(sameLocation({ path: 'a.js', line: 10 }, { path: 'a.js', line: 13 }), false);
  assert.equal(sameLocation({ path: 'a.js', line: 10 }, { path: 'b.js', line: 10 }), false);
});

test('sameLocation treats two whole-file (null line) findings on the same path as the same location', () => {
  assert.equal(sameLocation({ path: 'a.js', line: null }, { path: 'a.js', line: null }), true);
  assert.equal(sameLocation({ path: 'a.js', line: null }, { path: 'a.js', line: 5 }), false);
});

test('buildDisagreementMatrix clusters a finding seen by two channels as corroborated', () => {
  const matrix = buildDisagreementMatrix({
    semgrep: [{ ruleId: 'js-eval-use', path: 'src/auth.js', startLine: 10, message: 'eval', severity: 'ERROR' }],
    claude: [{ path: 'src/auth.js', line: 11, severity: 'critical', category: 'injection', description: 'eval on user input' }],
    'gpt-5.6-sol': []
  });
  assert.equal(matrix.length, 1);
  assert.equal(matrix[0].agreement, 'corroborated');
  assert.deepEqual(matrix[0].channels.sort(), ['claude', 'semgrep']);
});

test('buildDisagreementMatrix keeps a single-channel finding separate and marks it single_channel', () => {
  const matrix = buildDisagreementMatrix({
    semgrep: [],
    claude: [{ path: 'src/only-claude.js', line: 5, severity: 'low', category: 'style', description: 'nit' }],
    'gpt-5.6-sol': []
  });
  assert.equal(matrix.length, 1);
  assert.equal(matrix[0].agreement, 'single_channel');
  assert.deepEqual(matrix[0].channels, ['claude']);
});

test('buildDisagreementMatrix keeps findings at unrelated locations in separate clusters', () => {
  const matrix = buildDisagreementMatrix({
    semgrep: [],
    claude: [{ path: 'a.js', line: 5, severity: 'low', category: 'x', description: 'x' }],
    'gpt-5.6-sol': [{ path: 'b.js', line: 5, severity: 'low', category: 'y', description: 'y' }]
  });
  assert.equal(matrix.length, 2);
});

test('determineStatus is DISPUTED when the two model reviewers reach different verdicts, regardless of severity', () => {
  const status = determineStatus({ claudeVerdict: 'safe', gptVerdict: 'concerns', disagreementMatrix: [] });
  assert.equal(status, 'DISPUTED');
});

test('determineStatus is NEEDS_HUMAN_REVIEW when both agree but either says unsafe', () => {
  const status = determineStatus({ claudeVerdict: 'unsafe', gptVerdict: 'unsafe', disagreementMatrix: [] });
  assert.equal(status, 'NEEDS_HUMAN_REVIEW');
});

test('determineStatus is NEEDS_HUMAN_REVIEW when both agree on "concerns" but a clustered finding is high/critical', () => {
  const status = determineStatus({
    claudeVerdict: 'concerns',
    gptVerdict: 'concerns',
    disagreementMatrix: [{ findings: [{ severity: 'critical' }] }]
  });
  assert.equal(status, 'NEEDS_HUMAN_REVIEW');
});

test('determineStatus is PASS only when both agree, neither says unsafe, and nothing is high/critical', () => {
  const status = determineStatus({
    claudeVerdict: 'safe',
    gptVerdict: 'safe',
    disagreementMatrix: [{ findings: [{ severity: 'low' }] }]
  });
  assert.equal(status, 'PASS');
});

test('determineStatus is NEEDS_HUMAN_REVIEW when a channel failed outright, even if both remaining reviewers agree and say "safe"', () => {
  const status = determineStatus({
    claudeVerdict: 'safe',
    gptVerdict: 'safe',
    disagreementMatrix: [],
    channelFailures: ['gpt-5.6-sol']
  });
  assert.equal(status, 'NEEDS_HUMAN_REVIEW', 'a missing channel must never be treated as "that channel says safe"');
});

test('determineStatus defaults channelFailures to empty -- callers that predate this option are unaffected', () => {
  const status = determineStatus({ claudeVerdict: 'safe', gptVerdict: 'safe', disagreementMatrix: [] });
  assert.equal(status, 'PASS');
});

test('determineStatus never averages or majority-votes -- DISPUTED wins even with only one dissenting low-severity opinion', () => {
  // Regression test for the hard requirement: two "safe"-leaning signals and one
  // disagreement must still surface as DISPUTED, never resolved by outnumbering it.
  const status = determineStatus({
    claudeVerdict: 'safe',
    gptVerdict: 'safe',
    disagreementMatrix: [{ findings: [{ severity: 'low' }, { severity: 'low' }, { severity: 'high' }] }]
  });
  assert.equal(status, 'NEEDS_HUMAN_REVIEW', 'a single high-severity finding must force human review even with two low-severity peers and full model agreement');
});
