'use strict';

const VALID_SEVERITIES = new Set(['critical', 'high', 'medium', 'low', 'info']);
const VALID_VERDICTS = new Set(['safe', 'concerns', 'unsafe']);

function extractJson(text) {
  // Models sometimes wrap JSON in a markdown fence despite instructions not to --
  // strip it defensively rather than fail the whole review over formatting.
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidate = fenced ? fenced[1] : text;
  return JSON.parse(candidate.trim());
}

function normalizeFinding(f, index) {
  return {
    index,
    severity: VALID_SEVERITIES.has(f.severity) ? f.severity : 'info',
    category: typeof f.category === 'string' && f.category.length > 0 ? f.category : 'uncategorized',
    path: typeof f.path === 'string' ? f.path : null,
    line: Number.isInteger(f.line) ? f.line : null,
    description: typeof f.description === 'string' ? f.description : '',
    evidence: typeof f.evidence === 'string' ? f.evidence : ''
  };
}

/**
 * Parses and validates one reviewer's raw text output into the shared internal shape.
 * A parse failure or a missing/invalid overall_verdict defaults to "concerns", never
 * "safe" -- fail toward caution when a reviewer's output can't be trusted as well-formed.
 */
function parseReviewOutput(channel, rawText) {
  let parsed;
  try {
    parsed = extractJson(rawText);
  } catch (err) {
    return {
      channel,
      parseError: `Could not parse ${channel}'s output as JSON: ${err.message}`,
      rawText,
      summary: null,
      findings: [],
      overallVerdict: 'concerns'
    };
  }

  const findings = Array.isArray(parsed.findings)
    ? parsed.findings.map((f, i) => normalizeFinding(f || {}, i))
    : [];
  const overallVerdict = VALID_VERDICTS.has(parsed.overall_verdict) ? parsed.overall_verdict : 'concerns';

  return {
    channel,
    parseError: null,
    rawText,
    summary: typeof parsed.summary === 'string' ? parsed.summary : null,
    findings,
    overallVerdict
  };
}

module.exports = { parseReviewOutput, normalizeFinding, VALID_SEVERITIES, VALID_VERDICTS };
