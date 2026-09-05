'use strict';

const LINE_TOLERANCE = 2;

// Semgrep's severity vocabulary (ERROR/WARNING/INFO) is not the same scale as the
// reviewers' (critical/high/medium/low/info) -- without this mapping, a Semgrep ERROR
// finding's severity string ('error') never equals 'high' or 'critical' in
// determineStatus()'s check, so it could never force NEEDS_HUMAN_REVIEW on its own. Caught
// by test/verdict.test.js's injection-attempt case, which asserts the defense-in-depth
// property (Semgrep alone must be able to block a PASS) directly rather than assuming it.
const SEMGREP_SEVERITY_MAP = { ERROR: 'high', WARNING: 'medium', INFO: 'low' };

function normalizeChannelFindings(channel, findings) {
  return findings.map((f) => {
    const severity =
      channel === 'semgrep'
        ? (SEMGREP_SEVERITY_MAP[f.severity] || 'low').toLowerCase()
        : (f.severity || 'info').toLowerCase();
    return {
      channel,
      path: f.path || null,
      line: typeof f.line === 'number' ? f.line : typeof f.startLine === 'number' ? f.startLine : null,
      severity,
      category: f.category || f.ruleId || 'uncategorized',
      description: f.description || f.message || ''
    };
  });
}

/**
 * Two findings are "the same location" if they're in the same file and within
 * LINE_TOLERANCE lines of each other. A fuzzy, documented v0 heuristic -- three channels
 * with different granularity (a single flagged line vs. a described range) won't always
 * agree on the exact line, and this is deliberately forgiving rather than under-matching
 * and hiding real corroboration.
 */
function sameLocation(a, b) {
  if (!a.path || !b.path || a.path !== b.path) return false;
  if (a.line === null || b.line === null) return a.line === b.line;
  return Math.abs(a.line - b.line) <= LINE_TOLERANCE;
}

/**
 * Clusters findings from all channels by location, so the report can show "seen by N
 * channels" (corroborated) vs. "only channel X" (single_channel) without ever collapsing
 * that into a single combined confidence score.
 */
function buildDisagreementMatrix(channelFindings) {
  const all = [];
  for (const [channel, findings] of Object.entries(channelFindings)) {
    all.push(...normalizeChannelFindings(channel, findings));
  }

  const clusters = [];
  for (const finding of all) {
    const existing = clusters.find((cluster) => cluster.some((f) => sameLocation(f, finding)));
    if (existing) existing.push(finding);
    else clusters.push([finding]);
  }

  return clusters.map((cluster) => {
    const channels = [...new Set(cluster.map((f) => f.channel))];
    return {
      path: cluster[0].path,
      line: cluster[0].line,
      channels,
      channelCount: channels.length,
      findings: cluster,
      agreement: channels.length >= 2 ? 'corroborated' : 'single_channel'
    };
  });
}

/**
 * Never resolves disagreement into a majority vote or an averaged confidence -- that's a
 * hard requirement, not a preference. DISPUTED if the two model reviewers reach different
 * overall_verdicts. NEEDS_HUMAN_REVIEW if either reviewer says "unsafe" (even if they
 * agree) or any clustered finding is high/critical severity from any channel. Otherwise
 * PASS. A human is always the judge for anything other than a clean PASS.
 */
function determineStatus({ claudeVerdict, gptVerdict, disagreementMatrix }) {
  const anyHighOrCritical = disagreementMatrix.some((cluster) =>
    cluster.findings.some((f) => f.severity === 'high' || f.severity === 'critical')
  );
  if (claudeVerdict !== gptVerdict) return 'DISPUTED';
  if (claudeVerdict === 'unsafe' || gptVerdict === 'unsafe') return 'NEEDS_HUMAN_REVIEW';
  if (anyHighOrCritical) return 'NEEDS_HUMAN_REVIEW';
  return 'PASS';
}

module.exports = { normalizeChannelFindings, sameLocation, buildDisagreementMatrix, determineStatus, LINE_TOLERANCE };
