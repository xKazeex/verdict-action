'use strict';

const { loadConfig, shouldReview } = require('./config');
const { buildSnapshot, changedFilePaths, addedLines } = require('./snapshot');
const { scanForSecrets } = require('./secret-scan');
const { runSemgrep } = require('./semgrep');
const { reviewWithClaude } = require('./reviewers/claude');
const { reviewWithGpt } = require('./reviewers/openai');
const { buildDisagreementMatrix, determineStatus } = require('./combine');
const { renderMarkdownReport, renderSarif } = require('./report');

function errorMessage(err) {
  return err instanceof Error ? err.message : String(err);
}

// A channel that fails outright (timeout, API error, malformed response, scanner crash)
// must never be silently treated as "that channel says safe" -- it's dropped from the
// evidence and recorded as a failure instead, which forces NEEDS_HUMAN_REVIEW (see
// combine.js). This turns what would otherwise be an unhandled crash (and no PR comment at
// all) into a clear, reportable degraded-mode result.
function unavailableReview(channel, err) {
  return {
    channel,
    parseError: null,
    summary: `unavailable — falling back to the remaining channel(s), human review required (${errorMessage(err)})`,
    findings: [],
    overallVerdict: 'concerns',
    unavailable: true
  };
}

/**
 * Top-level orchestrator. Options exist to inject every side-effecting piece
 * (secretScanner, semgrepRunner, reviewers.claude, reviewers.gpt) so this can be exercised
 * end-to-end in tests without a real semgrep binary or real API calls.
 */
async function runVerdict({ repoRoot, baseSha, headSha, contextFiles = [], configPath, reviewers, semgrepRunner, secretScanner }) {
  const config = loadConfig(repoRoot, configPath);
  const snapshot = buildSnapshot({ repoRoot, baseSha, headSha, contextFiles });

  const decision = shouldReview(config, {
    changedFiles: changedFilePaths(snapshot),
    addedLines: addedLines(snapshot)
  });
  if (!decision.run) {
    return { outcome: 'SKIPPED', reason: decision.reason, snapshot };
  }

  // Secret-scanning is a hard gate, not an independent evidence channel -- if it can't run
  // at all, fail closed (never fall through to sending the diff to either model).
  const scanSecrets = secretScanner || scanForSecrets;
  let secretFindings;
  try {
    secretFindings = scanSecrets(addedLines(snapshot));
  } catch (err) {
    return {
      outcome: 'SECRET_SCAN_FAILED',
      snapshot,
      message: `Secret-scanning itself failed before any diff could be sent to a model, refusing to proceed: ${errorMessage(err)}`
    };
  }
  if (secretFindings.length > 0) {
    const rules = [...new Set(secretFindings.map((f) => f.rule))];
    return {
      outcome: 'BLOCKED_SECRETS_DETECTED',
      snapshot,
      secretFindings,
      message: `Refusing to transmit this diff to any model: ${secretFindings.length} likely secret(s) detected (${rules.join(', ')}). Rotate/remove before Verdict can review this PR.`
    };
  }

  const channelFailures = [];

  let semgrepFindings;
  let semgrepError = null;
  try {
    semgrepFindings = semgrepRunner ? await semgrepRunner(repoRoot, snapshot) : runSemgrep(repoRoot, snapshot);
  } catch (err) {
    channelFailures.push('semgrep');
    semgrepFindings = [];
    semgrepError = errorMessage(err);
  }

  // Reviewer A and B run in parallel. Neither call is passed the other's output or the
  // scanner's output -- only the snapshot and the shared contract. This is the isolation
  // boundary the whole design depends on; do not thread anything else through here.
  // allSettled, not all: one reviewer erroring (timeout, API error, malformed response)
  // must not take down the other's already-independent result.
  const claudeReviewer = (reviewers && reviewers.claude) || reviewWithClaude;
  const gptReviewer = (reviewers && reviewers.gpt) || reviewWithGpt;
  const [claudeSettled, gptSettled] = await Promise.allSettled([claudeReviewer(snapshot), gptReviewer(snapshot)]);

  const claudeReview = claudeSettled.status === 'fulfilled' ? claudeSettled.value : unavailableReview('claude', claudeSettled.reason);
  const gptReview = gptSettled.status === 'fulfilled' ? gptSettled.value : unavailableReview('gpt-5.6-sol', gptSettled.reason);
  if (claudeReview.unavailable) channelFailures.push('claude');
  if (gptReview.unavailable) channelFailures.push('gpt-5.6-sol');

  const disagreementMatrix = buildDisagreementMatrix({
    semgrep: semgrepFindings,
    claude: claudeReview.findings,
    'gpt-5.6-sol': gptReview.findings
  });
  const status = determineStatus({
    claudeVerdict: claudeReview.overallVerdict,
    gptVerdict: gptReview.overallVerdict,
    disagreementMatrix,
    channelFailures
  });

  const markdown = renderMarkdownReport({ snapshot, status, semgrepFindings, semgrepError, claudeReview, gptReview, disagreementMatrix });
  const sarif = renderSarif({ snapshot, semgrepFindings, claudeReview, gptReview });

  return {
    outcome: status,
    status,
    snapshot,
    semgrepFindings,
    semgrepError,
    claudeReview,
    gptReview,
    channelFailures,
    disagreementMatrix,
    markdown,
    sarif
  };
}

module.exports = { runVerdict };
