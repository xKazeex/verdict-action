'use strict';

const { buildReviewPrompt } = require('./prompt');
const { parseReviewOutput } = require('./parse-output');

// FLAGGED, not verified against a real call: this uses OpenAI's Responses API
// (/v1/responses), the current API surface for reasoning-tier models as of this writing,
// inferred from general API-shape knowledge rather than a fetched, model-specific
// reference for gpt-5.6-sol (released too recently for me to have first-hand API
// documentation for it). Confirm the request/response shape against a real call before
// relying on this beyond a mocked-fetch test -- see extractResponsesText()'s fallback
// parsing for the two response shapes this is written to handle.
const API_URL = 'https://api.openai.com/v1/responses';
const DEFAULT_MODEL = 'gpt-5.6-sol';

function extractResponsesText(data) {
  if (typeof data.output_text === 'string') return data.output_text;
  const output = Array.isArray(data.output) ? data.output : [];
  for (const item of output) {
    if (Array.isArray(item.content)) {
      const textPart = item.content.find((c) => typeof c.text === 'string');
      if (textPart) return textPart.text;
    }
  }
  throw new Error('Could not find text content in OpenAI Responses API output -- API shape may have changed, see FLAGGED note in this file');
}

/**
 * Reviewer B. A single stateless API call -- no thread ID, no prior messages, no
 * reference to Reviewer A or the Semgrep results. Only the snapshot's diff and the shared
 * review contract ever reach this call.
 */
async function reviewWithGpt(snapshot, options = {}) {
  const apiKey = options.apiKey || process.env.OPENAI_API_KEY;
  if (!apiKey) {
    throw new Error(
      'OPENAI_API_KEY is not set. BYOK: the consuming repo must supply this as its own GitHub Secret -- Verdict never proxies or custodies keys.'
    );
  }
  const fetchImpl = options.fetch || fetch;
  const model = options.model || DEFAULT_MODEL;
  const prompt = buildReviewPrompt(snapshot);

  const response = await fetchImpl(API_URL, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${apiKey}`
    },
    body: JSON.stringify({ model, input: prompt })
  });

  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw new Error(`OpenAI API error ${response.status}: ${text.slice(0, 500)}`);
  }
  const data = await response.json();
  const text = extractResponsesText(data);
  return parseReviewOutput('gpt-5.6-sol', text);
}

module.exports = { reviewWithGpt, extractResponsesText, API_URL, DEFAULT_MODEL };
