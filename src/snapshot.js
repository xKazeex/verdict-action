'use strict';

const crypto = require('node:crypto');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

function sha256(input) {
  return crypto.createHash('sha256').update(input).digest('hex');
}

function git(args, cwd) {
  return execFileSync('git', args, { cwd, maxBuffer: 64 * 1024 * 1024 });
}

// execFileSync inherits the child's stderr to the parent by default, even when the caller
// catches the resulting error -- so a routinely-expected failure (a context file simply not
// being committed, which the catch block below handles correctly) would still print a raw
// "fatal: ..." line straight into the Action's log, looking like a crash when nothing
// actually went wrong. Used only for the context-file lookup below, where "doesn't exist at
// this SHA" is an expected outcome, not the main diff/name-status calls where a git failure
// would mean something genuinely wrong with baseSha/headSha and should stay loud.
function gitQuiet(args, cwd) {
  return execFileSync('git', args, { cwd, maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] });
}

/**
 * Builds an immutable snapshot of a PR's diff between two fixed commits. Everything
 * downstream (secret scan, Semgrep, both reviewers, the disagreement matcher, the report)
 * reads from THIS frozen object -- never re-reads the working tree or re-queries git --
 * so a push to the branch after the snapshot is taken cannot change what gets reviewed
 * partway through a run. Motivated directly by a prior incident where a stale checkout
 * caused real confusion on another project; this is a hard requirement, not a preference.
 */
function buildSnapshot({ repoRoot, baseSha, headSha, contextFiles = [] }) {
  if (!repoRoot) throw new Error('buildSnapshot requires repoRoot');
  if (!baseSha || !headSha) throw new Error('buildSnapshot requires both baseSha and headSha');

  const diff = git(['diff', '--no-color', `${baseSha}...${headSha}`], repoRoot).toString('utf8');
  const diffSha256 = sha256(diff);

  const nameStatusRaw = git(['diff', '--no-color', '--name-status', `${baseSha}...${headSha}`], repoRoot).toString('utf8');
  const fileManifest = nameStatusRaw
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const parts = line.split('\t');
      return { status: parts[0], path: parts[parts.length - 1] };
    });

  const contextFileHashes = {};
  for (const relPath of contextFiles) {
    try {
      const content = gitQuiet(['show', `${headSha}:${relPath}`], repoRoot);
      contextFileHashes[relPath] = sha256(content);
    } catch {
      // File doesn't exist at headSha -- recorded as null, not silently omitted, so a
      // consumer relying on e.g. .verdict.yml's own hash can tell "absent" from "unhashed."
      contextFileHashes[relPath] = null;
    }
  }

  const identityInput = JSON.stringify({ baseSha, headSha, diffSha256, fileManifest, contextFileHashes });
  const snapshotId = sha256(identityInput);

  return Object.freeze({
    schemaVersion: 1,
    snapshotId,
    baseSha,
    headSha,
    diffSha256,
    diff,
    fileManifest,
    contextFileHashes,
    builtAt: new Date().toISOString()
  });
}

function changedFilePaths(snapshot) {
  return snapshot.fileManifest.map((entry) => entry.path);
}

/** Added lines (unified diff '+' lines), leading '+' stripped, '+++' file headers excluded. */
function addedLines(snapshot) {
  return snapshot.diff
    .split('\n')
    .filter((line) => line.startsWith('+') && !line.startsWith('+++'))
    .map((line) => line.slice(1));
}

module.exports = { buildSnapshot, changedFilePaths, addedLines, sha256, git, path };
