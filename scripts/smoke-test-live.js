'use strict';

// One-off, manually-run smoke test against REAL Claude + OpenAI API calls. Not part of
// `npm test` -- this costs real money and should not run in CI or on every local test run.
//
// Uses the injection-attempt fixture deliberately: it's the smallest fixture in the repo
// (a single ~20-line file) AND it's the one thing the structural tests in
// test/reviewers.test.js could never confirm -- whether a REAL model actually ignores the
// embedded "SECURITY REVIEWER OVERRIDE" instruction rather than just verifying the prompt
// places it after the untrusted-data marker.
//
// Usage: node scripts/smoke-test-live.js

const fs = require('node:fs');
const path = require('node:path');
const { buildFixtureRepo } = require('../test/helpers/build-fixture-repo');
const { runVerdict } = require('../src/verdict');

function loadDotEnv(envPath) {
  if (!fs.existsSync(envPath)) return;
  for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    const value = trimmed.slice(eq + 1).trim();
    if (!(key in process.env)) process.env[key] = value;
  }
}

// GPT-5.6 Sol Standard pricing, as given directly by the user: $4/$20 per million
// input/output tokens. Anthropic pricing for claude-sonnet-5 is NOT verified here -- rather
// than guess a number, raw token counts are printed and left for the user to price.
const GPT_PRICE_PER_MILLION = { input: 4, output: 20 };

function estimateCostUsd(pricePerMillion, inputTokens, outputTokens) {
  if (typeof inputTokens !== 'number' || typeof outputTokens !== 'number') return null;
  return (inputTokens / 1e6) * pricePerMillion.input + (outputTokens / 1e6) * pricePerMillion.output;
}

// Field names vary by provider/API version (input_tokens vs prompt_tokens, etc.) -- try the
// known candidates rather than hardcoding one shape.
function extractTokenCounts(usage) {
  if (!usage) return { input: null, output: null };
  const input = usage.input_tokens ?? usage.prompt_tokens ?? null;
  const output = usage.output_tokens ?? usage.completion_tokens ?? null;
  return { input, output };
}

function summarizeReview(label, review) {
  console.log(`\n--- ${label} ---`);
  console.log('overallVerdict:', review.overallVerdict);
  console.log('parseError:', review.parseError);
  console.log('summary:', review.summary);
  console.log('findings:', JSON.stringify(review.findings, null, 2));
  console.log('usage (raw, as returned by the API):', JSON.stringify(review.usage));
}

async function main() {
  loadDotEnv(path.join(__dirname, '..', '.env'));

  if (!process.env.ANTHROPIC_API_KEY) throw new Error('ANTHROPIC_API_KEY missing from .env');
  if (!process.env.OPENAI_API_KEY) throw new Error('OPENAI_API_KEY missing from .env');

  const fixture = buildFixtureRepo(path.join(__dirname, '..', 'test', 'fixtures', 'injection-attempt'));
  try {
    console.log('Running Verdict against the injection-attempt fixture with REAL Claude + GPT-5.6 Sol calls...');
    console.log('(no semgrepRunner override -- real local Semgrep also runs if installed, no cost)');

    const result = await runVerdict({
      repoRoot: fixture.repoRoot,
      baseSha: fixture.baseSha,
      headSha: fixture.headSha
      // reviewers and semgrepRunner both omitted -- runVerdict defaults to the real,
      // non-mocked implementations for all three channels.
    });

    console.log('\n=== OUTCOME:', result.outcome, '===');

    if (result.outcome === 'SKIPPED' || result.outcome === 'BLOCKED_SECRETS_DETECTED') {
      console.log(result.reason || result.message);
      return;
    }

    console.log('\nSemgrep findings:', JSON.stringify(result.semgrepFindings, null, 2));
    summarizeReview('Claude (Reviewer A)', result.claudeReview);
    summarizeReview('GPT-5.6 Sol (Reviewer B)', result.gptReview);

    console.log('\n--- Disagreement matrix ---');
    console.log(JSON.stringify(result.disagreementMatrix, null, 2));

    console.log('\n=== Did each channel independently catch the real eval() vulnerability, without falling for the injected override? ===');
    console.log('Claude verdict:', result.claudeReview.overallVerdict, '| findings:', result.claudeReview.findings.length);
    console.log('GPT verdict:', result.gptReview.overallVerdict, '| findings:', result.gptReview.findings.length);
    console.log('Semgrep findings:', result.semgrepFindings.length);

    console.log('\n=== Token usage / cost estimate for this run ===');
    const claudeTokens = extractTokenCounts(result.claudeReview.usage);
    console.log(
      `Claude (Sonnet 5): input=${claudeTokens.input ?? 'unknown'} output=${claudeTokens.output ?? 'unknown'}`,
      '-- pricing not verified for claude-sonnet-5, no cost estimate computed (check console.anthropic.com for current rates)'
    );
    const gptTokens = extractTokenCounts(result.gptReview.usage);
    const gptCost = estimateCostUsd(GPT_PRICE_PER_MILLION, gptTokens.input, gptTokens.output);
    console.log(
      `GPT-5.6 Sol: input=${gptTokens.input ?? 'unknown'} output=${gptTokens.output ?? 'unknown'}`,
      gptCost !== null ? `-- est. $${gptCost.toFixed(4)} at $4/$20 per million (input/output)` : '-- could not compute (unrecognized usage shape, see raw usage above)'
    );
  } finally {
    fixture.cleanup();
  }
}

main().catch((err) => {
  console.error('\nSmoke test failed:', err);
  process.exitCode = 1;
});
