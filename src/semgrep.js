'use strict';

const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const DEFAULT_RULES_PATH = path.join(__dirname, '..', 'rules', 'basic.yml');

/**
 * Writes the exact blob content at snapshot.headSha for every non-deleted changed file
 * into an isolated temp directory, so Semgrep scans the SNAPSHOT's content -- never the
 * live working tree, which could have moved on since the snapshot was taken.
 */
function materializeSnapshotFiles(repoRoot, snapshot, destDir) {
  for (const entry of snapshot.fileManifest) {
    if (entry.status === 'D') continue; // nothing to scan for a deleted file
    const destPath = path.join(destDir, entry.path);
    fs.mkdirSync(path.dirname(destPath), { recursive: true });
    const content = execFileSync('git', ['show', `${snapshot.headSha}:${entry.path}`], {
      cwd: repoRoot,
      maxBuffer: 64 * 1024 * 1024
    });
    fs.writeFileSync(destPath, content);
  }
}

function normalizeSemgrepResults(parsed, tmpDir) {
  const results = Array.isArray(parsed.results) ? parsed.results : [];
  return results.map((r) => ({
    channel: 'semgrep',
    ruleId: (r.check_id || '').split('.').pop(),
    path: path.relative(tmpDir, r.path).split(path.sep).join('/'),
    startLine: r.start && r.start.line,
    endLine: r.end && r.end.line,
    message: (r.extra && r.extra.message) || r.check_id,
    severity: (r.extra && r.extra.severity) || 'INFO'
  }));
}

/**
 * Runs Semgrep against the immutable snapshot's content (not the working tree). Uses the
 * bundled local ruleset (rules/basic.yml) by default rather than `--config auto`, which
 * would depend on network access to Semgrep's registry -- undesirable for a reusable
 * Action that other repos' CI will invoke, possibly offline or rate-limited.
 */
function runSemgrep(repoRoot, snapshot, options = {}) {
  const semgrepBin = options.semgrepBin || 'semgrep';
  const configPath = options.configPath || DEFAULT_RULES_PATH;
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'verdict-semgrep-'));
  try {
    materializeSnapshotFiles(repoRoot, snapshot, tmpDir);
    let stdout;
    try {
      stdout = execFileSync(
        semgrepBin,
        ['--config', configPath, '--json', '--quiet', '--no-git-ignore', tmpDir],
        { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }
      );
    } catch (err) {
      // Semgrep can exit non-zero in some configurations even on a clean successful scan
      // with findings -- stdout still carries valid JSON in that case, so recover it
      // rather than treating every non-zero exit as a hard failure.
      if (err.stdout) stdout = err.stdout.toString();
      else throw new Error(`semgrep invocation failed: ${err.message}`);
    }
    const parsed = JSON.parse(stdout);
    return normalizeSemgrepResults(parsed, tmpDir);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

module.exports = { runSemgrep, materializeSnapshotFiles, normalizeSemgrepResults, DEFAULT_RULES_PATH };
