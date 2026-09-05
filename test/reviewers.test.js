'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { buildReviewPrompt, REVIEW_CONTRACT } = require('../src/reviewers/prompt');
const { parseReviewOutput } = require('../src/reviewers/parse-output');
const { reviewWithClaude } = require('../src/reviewers/claude');
const { reviewWithGpt, extractResponsesText } = require('../src/reviewers/openai');
const { buildSnapshot } = require('../src/snapshot');
const { buildFixtureRepo } = require('./helpers/build-fixture-repo');

let injectionFixture;
before(() => {
  injectionFixture = buildFixtureRepo(path.join(__dirname, 'fixtures', 'injection-attempt'));
});
after(() => injectionFixture.cleanup());

function fakeSnapshotWithDiff(diff) {
  return { diff, baseSha: 'x'.repeat(40), headSha: 'y'.repeat(40) };
}

function mockFetch(bodyObj, ok = true, status = 200) {
  return async () => ({
    ok,
    status,
    json: async () => bodyObj,
    text: async () => JSON.stringify(bodyObj)
  });
}

// --- prompt / instruction-boundary structural tests -----------------------------------

test('buildReviewPrompt places the diff strictly after the BEGIN UNTRUSTED DIFF marker, contract text unmodified', () => {
  const prompt = buildReviewPrompt(fakeSnapshotWithDiff('some diff content'));
  const markerIndex = prompt.indexOf('BEGIN UNTRUSTED DIFF');
  const diffIndex = prompt.indexOf('some diff content');
  assert.ok(markerIndex < diffIndex, 'the marker must appear before the diff content');
  assert.ok(prompt.startsWith(REVIEW_CONTRACT), 'the contract text itself must be the literal prefix, unaltered');
});

test('the injection-attempt fixture diff lands entirely inside the untrusted-data region, and the contract above it is byte-identical regardless of the diff content', () => {
  const snapshot = buildSnapshot({ repoRoot: injectionFixture.repoRoot, baseSha: injectionFixture.baseSha, headSha: injectionFixture.headSha });
  const prompt = buildReviewPrompt(snapshot);

  const markerIndex = prompt.indexOf('BEGIN UNTRUSTED DIFF');
  const contractPortion = prompt.slice(0, markerIndex);
  assert.equal(contractPortion, REVIEW_CONTRACT.slice(0, markerIndex), 'diff content must never be able to alter the contract text preceding the marker');

  const injectedTextIndex = prompt.indexOf('SECURITY REVIEWER OVERRIDE');
  assert.ok(injectedTextIndex > markerIndex, 'the injection attempt text must land after the marker, inside the untrusted-data region, not before it');

  // Structural-only: this confirms the PROMPT correctly isolates the injection attempt as
  // data. It does NOT confirm a real model resists it -- that needs a live API call with
  // real keys, deferred per the agreed build order (see fixture-info.json's caveat).
});

// --- parse-output -----------------------------------------------------------------------

test('parseReviewOutput parses well-formed JSON output', () => {
  const raw = JSON.stringify({
    summary: 'looks fine',
    findings: [{ severity: 'high', category: 'injection', path: 'a.js', line: 3, description: 'x', evidence: 'y' }],
    overall_verdict: 'concerns'
  });
  const result = parseReviewOutput('claude', raw);
  assert.equal(result.parseError, null);
  assert.equal(result.overallVerdict, 'concerns');
  assert.equal(result.findings.length, 1);
  assert.equal(result.findings[0].severity, 'high');
});

test('parseReviewOutput strips a markdown fence the model wasn\'t supposed to use', () => {
  const raw = '```json\n' + JSON.stringify({ summary: 's', findings: [], overall_verdict: 'safe' }) + '\n```';
  const result = parseReviewOutput('gpt-5.6-sol', raw);
  assert.equal(result.parseError, null);
  assert.equal(result.overallVerdict, 'safe');
});

test('parseReviewOutput fails toward "concerns", never "safe", on unparseable output', () => {
  const result = parseReviewOutput('claude', 'not json at all, sorry');
  assert.ok(result.parseError);
  assert.equal(result.overallVerdict, 'concerns');
  assert.deepEqual(result.findings, []);
});

test('parseReviewOutput falls back to "concerns" if overall_verdict is missing or invalid, never defaults to "safe"', () => {
  const result = parseReviewOutput('claude', JSON.stringify({ summary: 's', findings: [] }));
  assert.equal(result.overallVerdict, 'concerns');
});

test('parseReviewOutput normalizes an invalid severity to "info" rather than dropping the finding', () => {
  const raw = JSON.stringify({ summary: 's', findings: [{ severity: 'super-critical!!', category: 'x', description: 'd' }], overall_verdict: 'safe' });
  const result = parseReviewOutput('claude', raw);
  assert.equal(result.findings[0].severity, 'info');
});

// --- reviewer API clients (mocked fetch, no real network) -------------------------------

test('reviewWithClaude throws a clear BYOK error if no API key is available', async () => {
  const original = process.env.ANTHROPIC_API_KEY;
  delete process.env.ANTHROPIC_API_KEY;
  try {
    await assert.rejects(
      () => reviewWithClaude(fakeSnapshotWithDiff('x'), { fetch: mockFetch({}) }),
      /ANTHROPIC_API_KEY is not set/
    );
  } finally {
    if (original !== undefined) process.env.ANTHROPIC_API_KEY = original;
  }
});

test('reviewWithClaude sends the prompt in the request body and parses a mocked response', async () => {
  let capturedBody;
  const fetchImpl = async (url, init) => {
    capturedBody = JSON.parse(init.body);
    return {
      ok: true,
      status: 200,
      json: async () => ({ content: [{ text: JSON.stringify({ summary: 's', findings: [], overall_verdict: 'safe' }) }] })
    };
  };
  const result = await reviewWithClaude(fakeSnapshotWithDiff('diff content here'), { apiKey: 'test-key', fetch: fetchImpl });
  assert.equal(result.channel, 'claude');
  assert.equal(result.overallVerdict, 'safe');
  assert.match(capturedBody.messages[0].content, /diff content here/);
});

test('reviewWithClaude surfaces a non-ok API response as a thrown error, not a silent "safe"', async () => {
  await assert.rejects(
    () => reviewWithClaude(fakeSnapshotWithDiff('x'), { apiKey: 'k', fetch: mockFetch({ error: 'rate limited' }, false, 429) }),
    /Claude API error 429/
  );
});

test('reviewWithGpt throws a clear BYOK error if no API key is available', async () => {
  const original = process.env.OPENAI_API_KEY;
  delete process.env.OPENAI_API_KEY;
  try {
    await assert.rejects(
      () => reviewWithGpt(fakeSnapshotWithDiff('x'), { fetch: mockFetch({}) }),
      /OPENAI_API_KEY is not set/
    );
  } finally {
    if (original !== undefined) process.env.OPENAI_API_KEY = original;
  }
});

test('reviewWithGpt sends the prompt and parses a mocked output_text response', async () => {
  let capturedBody;
  const fetchImpl = async (url, init) => {
    capturedBody = JSON.parse(init.body);
    return { ok: true, status: 200, json: async () => ({ output_text: JSON.stringify({ summary: 's', findings: [], overall_verdict: 'safe' }) }) };
  };
  const result = await reviewWithGpt(fakeSnapshotWithDiff('diff content here'), { apiKey: 'test-key', fetch: fetchImpl });
  assert.equal(result.channel, 'gpt-5.6-sol');
  assert.equal(result.overallVerdict, 'safe');
  assert.match(capturedBody.input, /diff content here/);
});

test('extractResponsesText handles the output[].content[].text shape as a fallback', () => {
  const text = extractResponsesText({ output: [{ content: [{ text: JSON.stringify({ summary: 's', findings: [], overall_verdict: 'safe' }) }] }] });
  assert.match(text, /overall_verdict/);
});

test('extractResponsesText throws clearly if neither known shape is present, rather than returning undefined silently', () => {
  assert.throws(() => extractResponsesText({ something_else: true }), /Could not find text content/);
});

test('reviewWithGpt surfaces a non-ok API response as a thrown error, not a silent "safe"', async () => {
  await assert.rejects(
    () => reviewWithGpt(fakeSnapshotWithDiff('x'), { apiKey: 'k', fetch: mockFetch({ error: 'bad request' }, false, 400) }),
    /OpenAI API error 400/
  );
});

// --- isolation between reviewers --------------------------------------------------------

test('Claude and GPT reviewer calls never receive each other\'s identity or output -- each call site only ever sees the snapshot and its own apiKey/model options', async () => {
  const seenBodies = [];
  const fetchImpl = async (url, init) => {
    seenBodies.push({ url, body: init.body });
    return { ok: true, status: 200, json: async () => ({ content: [{ text: JSON.stringify({ summary: 's', findings: [], overall_verdict: 'safe' }) }] }), text: async () => '' };
  };
  const gptFetchImpl = async (url, init) => {
    seenBodies.push({ url, body: init.body });
    return { ok: true, status: 200, json: async () => ({ output_text: JSON.stringify({ summary: 's', findings: [], overall_verdict: 'safe' }) }), text: async () => '' };
  };
  await Promise.all([
    reviewWithClaude(fakeSnapshotWithDiff('shared diff'), { apiKey: 'a', fetch: fetchImpl }),
    reviewWithGpt(fakeSnapshotWithDiff('shared diff'), { apiKey: 'b', fetch: gptFetchImpl })
  ]);
  assert.equal(seenBodies.length, 2);
  // Each request body legitimately names ITS OWN model (that's how you address the API) --
  // the isolation property being tested is CROSS-reference: Claude's request must never
  // mention GPT/gpt-5.6-sol, and GPT's request must never mention claude-sonnet, and
  // neither should contain phrasing like "the other reviewer said."
  const claudeCall = seenBodies.find((b) => b.url.includes('anthropic.com'));
  const gptCall = seenBodies.find((b) => b.url.includes('openai.com'));
  assert.ok(claudeCall && gptCall);
  assert.doesNotMatch(claudeCall.body, /gpt-5\.6-sol|openai/i, "Claude's request must never mention the other reviewer");
  assert.doesNotMatch(gptCall.body, /claude-sonnet|anthropic/i, "GPT's request must never mention the other reviewer");
  // NOTE: the shared contract text itself legitimately says "you have not seen... the
  // other reviewer's output" -- that's the isolation instruction TO the model, not a leak
  // OF the other reviewer's actual output. The real property (no cross-mention of model
  // identity) is already checked above; don't also forbid the contract's own wording.
});
