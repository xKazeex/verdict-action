'use strict';

const { loadConfig, shouldReview } = require('./config');
const { buildSnapshot, changedFilePaths, addedLines } = require('./snapshot');
const { scanForSecrets } = require('./secret-scan');
const { runSemgrep } = require('./semgrep');
const { reviewWithClaude } = require('./reviewers/claude');
const { reviewWithGpt } = require('./reviewers/openai');
const { buildDisagreementMatrix, determineStatus } = require('./combine');
const { renderMarkdownReport, renderSarif } = require('./report');

/**
 * Top-level orchestrator. Options exist to inject every side-effecting piece
 * (semgrepRunner, reviewers.claude, reviewers.gpt) so this can be exercised end-to-end in
 * tests without a real semgrep binary or real API calls.
 */
async function runVerdict({ repoRoot, baseSha, headSha, contextFiles = [], configPath, reviewers, semgrepRunner }) {
  const config = loadConfig(repoRoot, configPath);
  const snapshot = buildSnapshot({ repoRoot, baseSha, headSha, contextFiles });

  const decision = shouldReview(config, {
    changedFiles: changedFilePaths(snapshot),
    addedLines: addedLines(snapshot)
  });
  if (!decision.run) {
    return { outcome: 'SKIPPED', reason: decision.reason, snapshot };
  }

  const secretFindings = scanForSecrets(addedLines(snapshot));
  if (secretFindings.length > 0) {
    const rules = [...new Set(secretFindings.map((f) => f.rule))];
    return {
      outcome: 'BLOCKED_SECRETS_DETECTED',
      snapshot,
      secretFindings,
      message: `Refusing to transmit this diff to any model: ${secretFindings.length} likely secret(s) detected (${rules.join(', ')}). Rotate/remove before Verdict can review this PR.`
    };
  }

  const semgrepFindings = semgrepRunner
    ? await semgrepRunner(repoRoot, snapshot)
    : runSemgrep(repoRoot, snapshot);

  // Reviewer A and B run in parallel. Neither call is passed the other's output or the
  // scanner's output -- only the snapshot and the shared contract. This is the isolation
  // boundary the whole design depends on; do not thread anything else through here.
  const claudeReviewer = (reviewers && reviewers.claude) || reviewWithClaude;
  const gptReviewer = (reviewers && reviewers.gpt) || reviewWithGpt;
  const [claudeReview, gptReview] = await Promise.all([claudeReviewer(snapshot), gptReviewer(snapshot)]);

  const disagreementMatrix = buildDisagreementMatrix({
    semgrep: semgrepFindings,
    claude: claudeReview.findings,
    'gpt-5.6-sol': gptReview.findings
  });
  const status = determineStatus({
    claudeVerdict: claudeReview.overallVerdict,
    gptVerdict: gptReview.overallVerdict,
    disagreementMatrix
  });

  const markdown = renderMarkdownReport({ snapshot, status, semgrepFindings, claudeReview, gptReview, disagreementMatrix });
  const sarif = renderSarif({ snapshot, semgrepFindings, claudeReview, gptReview });

  return {
    outcome: status,
    status,
    snapshot,
    semgrepFindings,
    claudeReview,
    gptReview,
    disagreementMatrix,
    markdown,
    sarif
  };
}

module.exports = { runVerdict };
