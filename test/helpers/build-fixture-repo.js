'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

function copyDir(src, dest) {
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, entry.name);
    const d = path.join(dest, entry.name);
    if (entry.isDirectory()) copyDir(s, d);
    else fs.copyFileSync(s, d);
  }
}

function git(args, cwd) {
  execFileSync('git', args, { cwd, stdio: 'pipe' });
}

function gitOut(args, cwd) {
  return execFileSync('git', args, { cwd }).toString().trim();
}

/**
 * Builds a fresh, isolated git repo (in a fresh temp directory, NOT inside the checked-in
 * fixture folder -- a nested .git under the tracked repo shows up to git as an "embedded
 * repository" / dangling gitlink, which a fresh clone can't resolve) with two commits:
 * "base" from fixtureDir/base/, "head" from fixtureDir/head/. This is what lets
 * buildSnapshot() run real `git diff`/`git show` against fixture content exactly like it
 * would against a real PR, without committing a broken nested repo.
 *
 * Returned SHAs are never hardcoded anywhere -- a freshly created commit's SHA depends on
 * its timestamp, so a fixture rebuilt on a different machine or day would not reproduce a
 * baked-in SHA. Callers read them back from the object this returns.
 *
 * Any top-level file/dir in fixtureDir other than base/, head/, and fixture-info.json
 * (e.g. .verdict.yml) is copied into the built repo's working directory as-is, uncommitted
 * -- config that loadConfig() reads live from disk, not from git history.
 */
function buildFixtureRepo(fixtureDir) {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'verdict-fixture-'));

  git(['init', '-q'], repoRoot);
  git(['config', 'user.email', 'fixture@example.com'], repoRoot);
  git(['config', 'user.name', 'Verdict Fixture'], repoRoot);

  copyDir(path.join(fixtureDir, 'base'), repoRoot);
  git(['add', '-A'], repoRoot);
  git(['commit', '-q', '-m', 'base'], repoRoot);
  const baseSha = gitOut(['rev-parse', 'HEAD'], repoRoot);

  // Clear the working tree (except .git) before laying down head/, so a file present in
  // base/ but absent from head/ is correctly recorded as a deletion in the diff.
  for (const entry of fs.readdirSync(repoRoot)) {
    if (entry === '.git') continue;
    fs.rmSync(path.join(repoRoot, entry), { recursive: true, force: true });
  }
  copyDir(path.join(fixtureDir, 'head'), repoRoot);
  git(['add', '-A'], repoRoot);
  git(['commit', '-q', '-m', 'head'], repoRoot);
  const headSha = gitOut(['rev-parse', 'HEAD'], repoRoot);

  for (const entry of fs.readdirSync(fixtureDir, { withFileTypes: true })) {
    if (entry.name === 'base' || entry.name === 'head' || entry.name === 'fixture-info.json') continue;
    const s = path.join(fixtureDir, entry.name);
    const d = path.join(repoRoot, entry.name);
    if (entry.isDirectory()) copyDir(s, d);
    else fs.copyFileSync(s, d);
  }

  return {
    repoRoot,
    baseSha,
    headSha,
    cleanup: () => fs.rmSync(repoRoot, { recursive: true, force: true })
  };
}

module.exports = { buildFixtureRepo };
