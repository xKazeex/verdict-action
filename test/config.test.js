'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { loadConfig, validateConfig, pathMatchesCritical, findRiskTriggerMatch, shouldReview } = require('../src/config');

function tmpRepo(configYaml) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'verdict-config-test-'));
  if (configYaml !== undefined) fs.writeFileSync(path.join(dir, '.verdict.yml'), configYaml);
  return dir;
}

test('loadConfig throws if .verdict.yml is missing -- never silently reviews everything or nothing', () => {
  const dir = tmpRepo(undefined);
  assert.throws(() => loadConfig(dir), /not found/);
});

test('loadConfig throws if both critical_paths and risk_triggers are empty', () => {
  const dir = tmpRepo('critical_paths: []\nrisk_triggers: []\n');
  assert.throws(() => loadConfig(dir), /at least one entry/);
});

test('loadConfig throws on an invalid regex in risk_triggers', () => {
  const dir = tmpRepo('critical_paths: []\nrisk_triggers:\n  - pattern: "([unterminated"\n');
  assert.throws(() => loadConfig(dir), /not a valid regex/);
});

test('loadConfig parses a valid config', () => {
  const dir = tmpRepo('critical_paths:\n  - "src/**"\nrisk_triggers:\n  - pattern: "eval\\\\("\n');
  const config = loadConfig(dir);
  assert.deepEqual(config.criticalPaths, ['src/**']);
  assert.equal(config.riskTriggers.length, 1);
  assert.equal(config.riskTriggers[0].pattern, 'eval\\(');
});

test('pathMatchesCritical respects glob patterns', () => {
  assert.equal(pathMatchesCritical('src/payment.js', ['src/**']), true);
  assert.equal(pathMatchesCritical('docs/readme.md', ['src/**']), false);
  assert.equal(pathMatchesCritical('.verdict.yml', ['.verdict.yml']), true);
});

test('findRiskTriggerMatch finds the first matching added line', () => {
  const triggers = [{ pattern: 'child_process' }];
  const match = findRiskTriggerMatch(['const x = 1;', 'require("child_process")'], triggers);
  assert.ok(match);
  assert.equal(match.lineIndex, 1);
});

test('shouldReview runs when a changed file matches critical_paths, even with no risk trigger', () => {
  const config = validateConfig({ critical_paths: ['src/**'], risk_triggers: [] });
  const decision = shouldReview(config, { changedFiles: ['src/payment.js', 'README.md'], addedLines: ['nothing interesting'] });
  assert.equal(decision.run, true);
  assert.equal(decision.reason, 'critical_path');
});

test('shouldReview runs when an added line matches risk_triggers, even outside critical_paths', () => {
  const config = validateConfig({ critical_paths: ['src/**'], risk_triggers: [{ pattern: 'AKIA[0-9A-Z]{16}' }] });
  const decision = shouldReview(config, {
    changedFiles: ['docs/notes.md'],
    addedLines: ['some text', 'oops AKIAABCDEFGHIJKLMNOP leaked here']
  });
  assert.equal(decision.run, true);
  assert.equal(decision.reason, 'risk_trigger');
});

test('shouldReview skips when neither critical_paths nor risk_triggers match', () => {
  const config = validateConfig({ critical_paths: ['src/**'], risk_triggers: [{ pattern: 'eval\\(' }] });
  const decision = shouldReview(config, { changedFiles: ['README.md'], addedLines: ['just docs'] });
  assert.equal(decision.run, false);
});
