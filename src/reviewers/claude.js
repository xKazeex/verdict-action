'use strict';

const { buildReviewPrompt } = require('./prompt');
const { parseReviewOutput } = require('./parse-output');

const API_URL = 'https://api.anthropic.com/v1/messages';
const DEFAULT_MODEL = 'claude-sonnet-5';
const ANTHROPIC_VERSION = '2023-06-01';

/**
 * Reviewer A. A single stateless API call -- no thread ID, no prior messages, no
 * reference to Reviewer B or the Semgrep results. Only the snapshot's diff and the shared
 * review contract ever reach this call.
 */
async function reviewWithClaude(snapshot, options = {}) {
  const apiKey = options.apiKey || process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    throw new Error(
      'ANTHROPIC_API_KEY is not set. BYOK: the consuming repo must supply this as its own GitHub Secret -- Verdict never proxies or custodies keys.'
    );
  }
  const fetchImpl = options.fetch || fetch;
  const model = options.model || DEFAULT_MODEL;
  const prompt = buildReviewPrompt(snapshot);

  const response = await fetchImpl(API_URL, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': ANTHROPIC_VERSION
    },
    body: JSON.stringify({
      model,
      max_tokens: 4096,
      messages: [{ role: 'user', content: prompt }]
    })
  });

  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw new Error(`Claude API error ${response.status}: ${text.slice(0, 500)}`);
  }
  const data = await response.json();
  const text = Array.isArray(data.content) ? data.content.map((block) => block.text || '').join('') : '';
  const parsed = parseReviewOutput('claude', text);
  // An unparseable response is a channel failure, not a degraded-but-still-usable
  // result: throwing here (rather than returning parsed.parseError as ordinary data)
  // routes it through the exact same Promise.allSettled -> unavailableReview() path in
  // verdict.js as a network/API error, so it forces channelFailures/NEEDS_HUMAN_REVIEW
  // and the "Degraded mode" banner regardless of what the other channel reports. Before
  // this, a parse error silently defaulted to overallVerdict 'concerns' with 0 findings
  // -- indistinguishable in effect from a channel that reviewed and found nothing, which
  // could coincidentally still produce a false PASS.
  if (parsed.parseError) throw new Error(parsed.parseError);
  return { ...parsed, usage: data.usage || null };
}

module.exports = { reviewWithClaude, API_URL, DEFAULT_MODEL };
