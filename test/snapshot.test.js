'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { buildSnapshot, changedFilePaths, addedLines, sha256 } = require('../src/snapshot');
const { buildFixtureRepo } = require('./helpers/build-fixture-repo');

let fixture;
before(() => {
  fixture = buildFixtureRepo(path.join(__dirname, 'fixtures', 'nonce-ledger-pr'));
});
after(() => fixture.cleanup());

test('buildSnapshot against the real nonce-ledger fixture reproduces the exact known diff', () => {
  const snapshot = buildSnapshot({ repoRoot: fixture.repoRoot, baseSha: fixture.baseSha, headSha: fixture.headSha });

  assert.equal(snapshot.baseSha, fixture.baseSha);
  assert.equal(snapshot.headSha, fixture.headSha);
  assert.equal(snapshot.diffSha256, sha256(snapshot.diff), 'diffSha256 must actually be the hash of the diff field');
  assert.match(snapshot.diff, /nonce-ledger\.js/);
  assert.match(snapshot.diff, /registerNonceLedgerHooks/);

  const files = changedFilePaths(snapshot).sort();
  assert.deepEqual(files, [
    '.gitignore',
    'SECURITY_REVIEW.md',
    'package-lock.json',
    'package.json',
    'src/nonce-ledger.js',
    'src/payment.js',
    'test/nonce-ledger.test.js',
    'test/payment.test.js'
  ]);
});

test('buildSnapshot is deterministic -- same base/head produces the same snapshotId', () => {
  const a = buildSnapshot({ repoRoot: fixture.repoRoot, baseSha: fixture.baseSha, headSha: fixture.headSha });
  const b = buildSnapshot({ repoRoot: fixture.repoRoot, baseSha: fixture.baseSha, headSha: fixture.headSha });
  assert.equal(a.snapshotId, b.snapshotId);
});

test('buildSnapshot the returned object is frozen -- downstream code cannot mutate the snapshot', () => {
  const snapshot = buildSnapshot({ repoRoot: fixture.repoRoot, baseSha: fixture.baseSha, headSha: fixture.headSha });
  assert.throws(() => {
    'use strict';
    snapshot.headSha = 'tampered';
  }, /Cannot assign to read only property|not extensible/);
});

test('buildSnapshot records contextFileHashes, and null for a context file absent at headSha', () => {
  const snapshot = buildSnapshot({
    repoRoot: fixture.repoRoot,
    baseSha: fixture.baseSha,
    headSha: fixture.headSha,
    contextFiles: ['package.json', 'this-file-does-not-exist.yml']
  });
  assert.ok(typeof snapshot.contextFileHashes['package.json'] === 'string');
  assert.equal(snapshot.contextFileHashes['this-file-does-not-exist.yml'], null);
});

test('buildSnapshot throws without both SHAs -- refuses to review "current state of the branch"', () => {
  assert.throws(() => buildSnapshot({ repoRoot: fixture.repoRoot, baseSha: fixture.baseSha }), /requires both baseSha and headSha/);
  assert.throws(() => buildSnapshot({ repoRoot: fixture.repoRoot, headSha: fixture.headSha }), /requires both baseSha and headSha/);
});

test('addedLines extracts + lines without the leading + and without the +++ file header', () => {
  const snapshot = buildSnapshot({ repoRoot: fixture.repoRoot, baseSha: fixture.baseSha, headSha: fixture.headSha });
  const lines = addedLines(snapshot);
  assert.ok(lines.some((l) => l.includes('registerNonceLedgerHooks')));
  assert.ok(!lines.some((l) => l.startsWith('+')), 'no line should retain the leading +');
  assert.ok(!lines.some((l) => l.includes('+++ b/')), '+++ file headers must be excluded');
});
