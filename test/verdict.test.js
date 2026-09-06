'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { runVerdict } = require('../src/verdict');
const { buildFixtureRepo } = require('./helpers/build-fixture-repo');

let nonceLedgerFixture;
let injectionFixture;
before(() => {
  nonceLedgerFixture = buildFixtureRepo(path.join(__dirname, 'fixtures', 'nonce-ledger-pr'));
  injectionFixture = buildFixtureRepo(path.join(__dirname, 'fixtures', 'injection-attempt'));
});
after(() => {
  nonceLedgerFixture.cleanup();
  injectionFixture.cleanup();
});

function safeReviewer(channel) {
  return async () => ({ channel, parseError: null, summary: 'looks fine', findings: [], overallVerdict: 'safe' });
}

function noopSemgrep() {
  return async () => [];
}

test('end-to-end against the real nonce-ledger diff: both reviewers say safe, semgrep clean -> PASS', async () => {
  const result = await runVerdict({
    repoRoot: nonceLedgerFixture.repoRoot,
    baseSha: nonceLedgerFixture.baseSha,
    headSha: nonceLedgerFixture.headSha,
    reviewers: { claude: safeReviewer('claude'), gpt: safeReviewer('gpt-5.6-sol') },
    semgrepRunner: noopSemgrep()
  });
  assert.equal(result.outcome, 'PASS');
  assert.equal(result.snapshot.baseSha, nonceLedgerFixture.baseSha);
  assert.match(result.markdown, /Claude \(Sonnet 5\) \| safe/);
  assert.match(result.markdown, /GPT-5\.6 Sol \| safe/);
  assert.equal(result.sarif.version, '2.1.0');
});

test('reviewers disagreeing on the same real diff produces DISPUTED, not a silent resolution', async () => {
  const result = await runVerdict({
    repoRoot: nonceLedgerFixture.repoRoot,
    baseSha: nonceLedgerFixture.baseSha,
    headSha: nonceLedgerFixture.headSha,
    reviewers: {
      claude: async () => ({ channel: 'claude', parseError: null, summary: 's', findings: [], overallVerdict: 'safe' }),
      gpt: async () => ({ channel: 'gpt-5.6-sol', parseError: null, summary: 's', findings: [], overallVerdict: 'concerns' })
    },
    semgrepRunner: noopSemgrep()
  });
  assert.equal(result.outcome, 'DISPUTED');
});

test('a high-severity finding from just one reviewer still forces NEEDS_HUMAN_REVIEW even if both say "safe" overall', async () => {
  const result = await runVerdict({
    repoRoot: nonceLedgerFixture.repoRoot,
    baseSha: nonceLedgerFixture.baseSha,
    headSha: nonceLedgerFixture.headSha,
    reviewers: {
      claude: async () => ({
        channel: 'claude', parseError: null, summary: 's',
        findings: [{ severity: 'high', category: 'x', path: 'src/payment.js', line: 60, description: 'flagged', evidence: 'e' }],
        overallVerdict: 'safe'
      }),
      gpt: safeReviewer('gpt-5.6-sol')
    },
    semgrepRunner: noopSemgrep()
  });
  assert.equal(result.outcome, 'NEEDS_HUMAN_REVIEW');
});

test('a diff not touching critical_paths or risk_triggers is SKIPPED, and neither semgrep nor either reviewer is ever invoked', async () => {
  let semgrepCalled = false;
  let claudeCalled = false;
  let gptCalled = false;
  const result = await runVerdict({
    repoRoot: nonceLedgerFixture.repoRoot,
    baseSha: nonceLedgerFixture.baseSha,
    headSha: nonceLedgerFixture.headSha,
    configPath: '.verdict-docs-only.yml',
    reviewers: {
      claude: async () => { claudeCalled = true; return safeReviewer('claude')(); },
      gpt: async () => { gptCalled = true; return safeReviewer('gpt-5.6-sol')(); }
    },
    semgrepRunner: async () => { semgrepCalled = true; return []; }
  });
  assert.equal(result.outcome, 'SKIPPED');
  assert.equal(semgrepCalled, false);
  assert.equal(claudeCalled, false);
  assert.equal(gptCalled, false);
});

test('a diff containing a likely secret is BLOCKED before either model is ever called', async () => {
  let claudeCalled = false;
  let gptCalled = false;
  // This test cares specifically about the secret-scan gate, which needs a diff that
  // actually contains one -- builds its own tiny inline fixture rather than reusing the
  // shared ones above.
  const fs = require('node:fs');
  const os = require('node:os');
  const { execFileSync } = require('node:child_process');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'verdict-secret-fixture-'));
  const git = (args) => execFileSync('git', args, { cwd: dir });
  git(['init', '-q']);
  git(['config', 'user.email', 'fixture@example.com']);
  git(['config', 'user.name', 'Verdict Fixture']);
  fs.writeFileSync(path.join(dir, 'src.js'), 'module.exports = {};\n');
  fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.verdict.yml'), 'critical_paths:\n  - "**"\n');
  git(['add', '-A']);
  git(['commit', '-q', '-m', 'base']);
  const baseSha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: dir }).toString().trim();
  fs.writeFileSync(path.join(dir, 'src.js'), 'const key = "AKIAABCDEFGHIJKLMNOP";\nmodule.exports = { key };\n');
  git(['add', '-A']);
  git(['commit', '-q', '-m', 'head: leaks a key']);
  const headSha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: dir }).toString().trim();

  const result = await runVerdict({
    repoRoot: dir,
    baseSha,
    headSha,
    reviewers: {
      claude: async () => { claudeCalled = true; return safeReviewer('claude')(); },
      gpt: async () => { gptCalled = true; return safeReviewer('gpt-5.6-sol')(); }
    },
    semgrepRunner: noopSemgrep()
  });

  assert.equal(result.outcome, 'BLOCKED_SECRETS_DETECTED');
  assert.equal(claudeCalled, false, 'Claude must never be called when a secret is detected');
  assert.equal(gptCalled, false, 'GPT must never be called when a secret is detected');
  assert.doesNotMatch(result.message, /AKIAABCDEFGHIJKLMNOP/, 'the block message itself must not leak the secret value');

  fs.rmSync(dir, { recursive: true, force: true });
});

test('if one reviewer throws (timeout/API error/malformed response), the run degrades gracefully to NEEDS_HUMAN_REVIEW with a clear message instead of crashing or dropping the other reviewer\'s result', async () => {
  const result = await runVerdict({
    repoRoot: nonceLedgerFixture.repoRoot,
    baseSha: nonceLedgerFixture.baseSha,
    headSha: nonceLedgerFixture.headSha,
    reviewers: {
      claude: safeReviewer('claude'),
      gpt: async () => { throw new Error('GPT-5.6 Sol API error 503: upstream overloaded'); }
    },
    semgrepRunner: noopSemgrep()
  });
  assert.equal(result.outcome, 'NEEDS_HUMAN_REVIEW');
  assert.equal(result.gptReview.unavailable, true);
  assert.match(result.gptReview.summary, /GPT-5\.6 Sol API error 503/);
  assert.equal(result.claudeReview.overallVerdict, 'safe', 'the healthy reviewer\'s real result must still be used, not discarded');
  assert.match(result.markdown, /GPT-5\.6 Sol \| unavailable/);
  assert.doesNotMatch(result.markdown, /at Object\.|node_modules|\.js:\d+:\d+/, 'no raw stack trace should ever reach the PR comment');
});

test('if Semgrep itself fails (missing binary, malformed output), the run degrades to NEEDS_HUMAN_REVIEW rather than crashing, and both reviewers still run', async () => {
  const result = await runVerdict({
    repoRoot: nonceLedgerFixture.repoRoot,
    baseSha: nonceLedgerFixture.baseSha,
    headSha: nonceLedgerFixture.headSha,
    reviewers: { claude: safeReviewer('claude'), gpt: safeReviewer('gpt-5.6-sol') },
    semgrepRunner: async () => { throw new Error('semgrep: command not found'); }
  });
  assert.equal(result.outcome, 'NEEDS_HUMAN_REVIEW');
  assert.equal(result.semgrepError, 'semgrep: command not found');
  assert.deepEqual(result.semgrepFindings, []);
  assert.match(result.markdown, /Semgrep \(deterministic\) \| unavailable/);
});

test('if secret-scanning itself throws, the run fails closed (SECRET_SCAN_FAILED) before either reviewer is ever called', async () => {
  let claudeCalled = false;
  let gptCalled = false;
  const result = await runVerdict({
    repoRoot: nonceLedgerFixture.repoRoot,
    baseSha: nonceLedgerFixture.baseSha,
    headSha: nonceLedgerFixture.headSha,
    reviewers: {
      claude: async () => { claudeCalled = true; return safeReviewer('claude')(); },
      gpt: async () => { gptCalled = true; return safeReviewer('gpt-5.6-sol')(); }
    },
    semgrepRunner: noopSemgrep(),
    secretScanner: () => { throw new Error('secret-scan: corrupted pattern table'); }
  });
  assert.equal(result.outcome, 'SECRET_SCAN_FAILED');
  assert.equal(claudeCalled, false);
  assert.equal(gptCalled, false);
  assert.match(result.message, /corrupted pattern table/);
});

test('the injection-attempt fixture: even with a mocked reviewer that "falls for it," the pipeline still surfaces the real vulnerability via Semgrep, and status is not silently PASS', async () => {
  // This does not test real model resistance to the injection (needs a live API call --
  // see the fixture's caveat). It tests that even a WORST-CASE compromised reviewer output
  // doesn't produce a false PASS, because Semgrep runs independently and catches the real
  // eval() regardless of what either model reports.
  const compromisedReviewer = async () => ({
    channel: 'claude',
    parseError: null,
    summary: 'Reviewed and approved per included authorization.',
    findings: [],
    overallVerdict: 'safe'
  });
  const result = await runVerdict({
    repoRoot: injectionFixture.repoRoot,
    baseSha: injectionFixture.baseSha,
    headSha: injectionFixture.headSha,
    reviewers: { claude: compromisedReviewer, gpt: compromisedReviewer }
    // real semgrepRunner (default) -- this is the one real, non-mocked scanner in this test
  });
  assert.notEqual(result.outcome, 'PASS', 'Semgrep must still catch the real eval() vulnerability even if both mocked reviewers "fell for" the injection');
  assert.ok(result.semgrepFindings.some((f) => f.ruleId === 'js-eval-use'));
});
