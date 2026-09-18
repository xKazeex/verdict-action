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
const DEFAULT_TIMEOUT_MS = 60000;

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
  const timeoutMs = options.timeoutMs ?? (Number(process.env.REVIEWER_TIMEOUT_MS) || DEFAULT_TIMEOUT_MS);
  const prompt = buildReviewPrompt(snapshot);

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  let response;
  try {
    response = await fetchImpl(API_URL, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${apiKey}`
      },
      body: JSON.stringify({ model, input: prompt }),
      signal: controller.signal
    });
  } catch (err) {
    if (err.name === 'AbortError') {
      throw new Error(`OpenAI API request timed out after ${timeoutMs}ms`);
    }
    throw err;
  } finally {
    clearTimeout(timeoutId);
  }

  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw new Error(`OpenAI API error ${response.status}: ${text.slice(0, 500)}`);
  }
  const data = await response.json();
  const text = extractResponsesText(data);
  const parsed = parseReviewOutput('gpt-5.6-sol', text);
  // See the matching comment in reviewers/claude.js: an unparseable response must be a
  // channel failure (thrown, routed through unavailableReview()/channelFailures), not an
  // ordinary degraded result -- otherwise it can silently look like "reviewed, 0
  // findings" and, depending on the other channel's verdict, produce a false PASS.
  if (parsed.parseError) throw new Error(parsed.parseError);
  return { ...parsed, usage: data.usage || null };
}

module.exports = { reviewWithGpt, extractResponsesText, API_URL, DEFAULT_MODEL, DEFAULT_TIMEOUT_MS };
