# Verdict

A required check that blocks merge on payment/auth/agent diffs: two independent AI
reviewers (Claude Sonnet 5 and GPT-5.6 Sol) plus a deterministic Semgrep scanner run
against the same immutable PR snapshot, in isolation from each other, and the result is
**never** silently collapsed into a majority vote or an averaged confidence score. Any
disagreement between the two model reviewers, or a high/critical finding from any channel,
marks the PR `DISPUTED` or `NEEDS_HUMAN_REVIEW` — human override only, never automatic.

It grew out of dogfooding on [x402](https://github.com/xKazeex/base-api-gateway)-style
payment infrastructure — see "What's deferred" below for that origin case study.

**Status: v0. Core logic is tested (mocked fixtures + a live smoke test against real Claude
+ GPT-5.6 Sol API calls). The full pipeline — real `pull_request` trigger, both reviewers,
Semgrep, PR comment, and the merge gate itself — is now confirmed working on real GitHub
Actions infrastructure via two live self-test PRs (a clean `PASS` and a blocked
`NEEDS_HUMAN_REVIEW`).** See "What's deferred" below for what's still genuinely open.

## How it works

1. Triggers on `pull_request`. Skips entirely unless the diff touches a path in
   `.verdict.yml`'s `critical_paths`, or an added line matches a `risk_triggers` pattern.
   No `.verdict.yml` in the repo is a hard error, not "review everything."
2. Builds an **immutable snapshot** first: base SHA, head SHA, a SHA-256 of the diff, a
   file manifest, and hashes of any configured contextual files. Every downstream step
   reads from this one frozen object — never re-queries git or the working tree — so a
   push to the branch mid-run can't change what gets reviewed partway through.
3. **Secret-scanning gate**: the diff's added lines are scanned before anything is
   transmitted anywhere. Any likely secret blocks the run entirely (`BLOCKED_SECRETS_DETECTED`)
   — neither model is ever called.
4. Three channels run, Semgrep and the two model calls fully independent of each other:
   - **Semgrep**, deterministic, against the snapshot's exact file content (materialized
     into an isolated temp dir at the snapshotted `headSha`, not the live working tree).
   - **Reviewer A (Claude Sonnet 5)** — one stateless API call, the raw diff plus a shared
     review contract, nothing else.
   - **Reviewer B (GPT-5.6 Sol)** — same contract, same diff, same isolation. Neither
     reviewer's request ever mentions the other reviewer's model, output, or existence.
5. Both reviewers are instructed, explicitly and structurally, that everything in the diff
   is untrusted data, never instructions — regardless of how it's formatted or what
   authority it claims. See `test/fixtures/injection-attempt/` for the adversarial test
   fixture this is checked against.
6. A disagreement matcher clusters findings by location across all three channels
   (`corroborated` if seen by ≥2, `single_channel` otherwise) — this is reporting
   structure, not a vote.
7. Status is `PASS`, `DISPUTED` (the two model reviewers reached different overall
   verdicts), or `NEEDS_HUMAN_REVIEW` (either reviewer said "unsafe," or any channel
   flagged a high/critical finding). Posted as a PR comment (each channel's verdict shown
   on its own row) and emitted as SARIF.
8. Anything other than `PASS` fails the check. Merging past it needs a human to add the
   override label after actually reviewing — never automatic.
9. **BYOK**: `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` come from the consuming repo's own
   GitHub Secrets. Verdict never proxies or custodies keys or source code centrally.
10. **Degraded-mode failure handling.** Secret-scanning failing outright is a hard gate
    (`SECRET_SCAN_FAILED`, fails closed, no diff is ever sent to a model). Semgrep or either
    reviewer failing independently (timeout, API error, malformed response) does not crash
    the run or drop the other channels' real results — the failed channel is reported as
    `unavailable` with the underlying reason, and a missing channel is never treated as
    "that channel says safe": it always forces `NEEDS_HUMAN_REVIEW`, same as a genuine
    disagreement or a high/critical finding. No raw stack trace ever reaches the PR comment.

## Repo layout

```
src/
  config.js          .verdict.yml loading/validation, critical_paths + risk_triggers gate
  snapshot.js         immutable snapshot builder (base/head SHA, diff hash, file manifest)
  secret-scan.js       pre-transmission secret-detection gate
  semgrep.js           runs the bundled ruleset against the snapshot's materialized content
  combine.js            disagreement matcher + status determination (never a vote)
  report.js              PR-comment markdown + SARIF rendering
  verdict.js               top-level orchestrator (all side effects injectable for testing)
  reviewers/
    prompt.js               shared review contract, instruction-boundary rule
    parse-output.js          validates/normalizes a reviewer's raw JSON output
    claude.js                 Reviewer A -- stateless Anthropic Messages API call
    openai.js                  Reviewer B -- stateless OpenAI Responses API call
  index.js             GitHub Action entrypoint (pull_request context -> runVerdict() -> PR comment + check status)
dist/index.js        bundled entrypoint actually run by the Action (see "Building the Action" below) -- committed, not built by GitHub
rules/basic.yml       bundled local Semgrep ruleset (not --config auto, deliberately -- see below)
scripts/
  run-tests.js            cross-platform test runner (see "Running the tests")
  smoke-test-live.js      manual, real-API-cost smoke test -- not part of npm test
.github/workflows/verdict.yml   self-test workflow: runs this Action against its own PRs
test/                 70 tests, node:test, zero real network calls
test/fixtures/
  nonce-ledger-pr/     a REAL diff, reconstructed as its own tiny git repo, from
                       xKazeex/base-api-gateway commits 06885f7..d29dabb (the actual
                       nonce-ledger replay-protection work)
  injection-attempt/  synthetic diff: a real eval() vulnerability plus an embedded
                       prompt-injection attempt in a comment
action.yml            GitHub Action metadata (runs: node24, main: dist/index.js)
```

## Building the Action

`action.yml`'s `main` points at `dist/index.js`, a single bundled file (esbuild) with all
runtime dependencies inlined -- `@actions/core` and `@actions/github` currently ship as
ESM-only packages (no `require` condition in their `package.json` `exports` map), so
`src/index.js` loads them via dynamic `import()` rather than `require()`; everything else in
this project stays CommonJS. `uses: ./`-style Action invocation just executes this file
directly -- it does **not** run `npm install` first, so `dist/index.js` must be committed,
not gitignored.

```
npm run build
```

Rebuild and commit `dist/index.js` whenever `src/` changes, before merging or tagging a
release. Nothing in CI does this for you.

## Running the tests

```
npm install
npm test
```

Requires `semgrep` on `PATH` (`pip install semgrep`) for two tests; those two skip
gracefully if it's not found. Everything else, including the reviewer API clients, runs
against mocked `fetch` — **zero real network calls or API keys required to run the suite.**

## What's deferred (flagged, not silently skipped)

- **A real-world adopter.** Verdict has so far only run against its own repo
  ([xKazeex/verdict-action](https://github.com/xKazeex/verdict-action)) via two synthetic
  self-test PRs — see below. No other repo, including the originally-intended Kitchen
  (`base-api-gateway`) nonce-ledger dogfooding PR, has run this yet.

## Confirmed on real GitHub Actions infrastructure

Two synthetic self-test PRs against this repo exercised the actual `pull_request` trigger
end to end — not a reconstructed fixture, not a mocked test, not a manual script:

- **PR #1** touched a `critical_paths` entry with a small, deliberately low-risk change.
  The workflow fired on the real trigger, Semgrep and both reviewers ran, a PR comment was
  posted, and the check passed cleanly (`PASS`) — confirming the golden path: real
  event-payload parsing, real PR-comment posting via `octokit`, real check-status reporting.
- **PR #2** introduced a real `eval()` vulnerability (reusing the injection-attempt
  fixture's pattern). The run correctly landed on a non-`PASS` status, the check failed, and
  merge was blocked without the override label — confirming the merge gate itself actually
  gates, not just that the Action runs and reports.

Between the two, everything this README describes — trigger, snapshot, three independent
channels, disagreement handling, PR comment, SARIF, and the merge gate — has now run on
real GitHub Actions infrastructure against real PRs.

## Confirmed against real API calls (`scripts/smoke-test-live.js`)

`npm test` still runs entirely against mocked `fetch` — zero real network calls or API
keys required for the suite. But `scripts/smoke-test-live.js` (not part of `npm test`; run
manually with `node scripts/smoke-test-live.js`, needs `ANTHROPIC_API_KEY` /
`OPENAI_API_KEY` in `.env`, costs real money) has since confirmed, against real calls to
both APIs and the `test/fixtures/injection-attempt` fixture:

- The OpenAI Responses API request/response shape in `src/reviewers/openai.js` — previously
  inferred from general API-shape knowledge, not a verified fetch of GPT-5.6 Sol's specific
  documentation — round-trips correctly against a real call.
- **Real injection resistance.** Both Reviewer A (Claude Sonnet 5) and Reviewer B (GPT-5.6
  Sol) independently reported `unsafe`, caught the real `eval()` RCE and the auth-bypass
  `return true`, and explicitly classified the embedded "SECURITY REVIEWER OVERRIDE"
  comment as a `prompt_injection_attempt` finding rather than obeying it. Neither reviewer
  saw the other's output or Semgrep's finding — corroboration in the disagreement matrix was
  independent. Run overall status: `NEEDS_HUMAN_REVIEW`, as expected for two `unsafe`
  verdicts plus a Semgrep-confirmed critical finding.
- Both reviewer functions (`reviewWithClaude`, `reviewWithGpt`) now return a `usage` field
  (the raw usage object from each API response, field names un-normalized since they differ
  by provider) so `scripts/smoke-test-live.js` can print token counts and, for GPT-5.6 Sol
  (pricing given directly: $4 / $20 per million input/output tokens), an estimated cost per
  run. Anthropic pricing for `claude-sonnet-5` is not verified here, so no cost estimate is
  computed for that side — only raw token counts are printed.

## A bug the tests actually caught

`combine.js` originally left Semgrep's own severity vocabulary (`ERROR`/`WARNING`/`INFO`)
unmapped onto the shared `critical`/`high`/`medium`/`low`/`info` scale used everywhere
else. The practical effect: a Semgrep `ERROR` finding could never, on its own, force
`NEEDS_HUMAN_REVIEW` — string equality between `'error'` and `'high'`/`'critical'` is
always false. Caught by `test/verdict.test.js`'s injection-attempt case, which runs the
real (unmocked) Semgrep against a real `eval()` vulnerability specifically to prove the
defense-in-depth property (Semgrep alone must be able to block a false `PASS` even if both
model reviewers are compromised) holds — not just assumed it did.

## License

[MIT](LICENSE)
