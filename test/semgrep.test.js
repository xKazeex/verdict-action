'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { buildSnapshot } = require('../src/snapshot');
const { runSemgrep } = require('../src/semgrep');
const { buildFixtureRepo } = require('./helpers/build-fixture-repo');

function semgrepAvailable() {
  try {
    execFileSync('semgrep', ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

const HAVE_SEMGREP = semgrepAvailable();

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

test(
  'runSemgrep against the real nonce-ledger diff finds no findings from the basic ruleset (no eval/dynamic-exec/Math.random in this diff)',
  { skip: !HAVE_SEMGREP && 'semgrep binary not found on PATH' },
  () => {
    const snapshot = buildSnapshot({ repoRoot: nonceLedgerFixture.repoRoot, baseSha: nonceLedgerFixture.baseSha, headSha: nonceLedgerFixture.headSha });
    const findings = runSemgrep(nonceLedgerFixture.repoRoot, snapshot);
    assert.deepEqual(findings, [], 'the real nonce-ledger code does not use eval/dynamic exec/Math.random, so the basic ruleset should be clean');
  }
);

test(
  'runSemgrep against the injection-attempt fixture catches the real eval() vulnerability',
  { skip: !HAVE_SEMGREP && 'semgrep binary not found on PATH' },
  () => {
    const snapshot = buildSnapshot({ repoRoot: injectionFixture.repoRoot, baseSha: injectionFixture.baseSha, headSha: injectionFixture.headSha });
    const findings = runSemgrep(injectionFixture.repoRoot, snapshot);
    assert.ok(findings.some((f) => f.ruleId === 'js-eval-use'), 'semgrep must catch the real eval() call regardless of the injection comment surrounding it');
    assert.equal(findings[0].channel, 'semgrep');
  }
);
