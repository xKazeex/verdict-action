# Verdict

Multi-model adversarial security review, as a GitHub Action. Two independent LLM reviewers
(Claude Sonnet 5 and GPT-5.6 Sol) plus Semgrep run against the same immutable PR snapshot,
in isolation from each other, and the result is **never** silently collapsed into a
majority vote or an averaged confidence score. Any disagreement between the two model
reviewers, or a high/critical finding from any channel, marks the PR `DISPUTED` or
`NEEDS_HUMAN_REVIEW` — a human is the judge, not an algorithm.

**Status: v0, core logic built and tested against real fixtures with mocked model calls.
Not yet wired to real API keys or run as a live GitHub Action.** See "What's deferred"
below before treating this as ready to protect a real repo.

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
rules/basic.yml       bundled local Semgrep ruleset (not --config auto, deliberately -- see below)
test/                 65 tests, node:test, zero real network calls
test/fixtures/
  nonce-ledger-pr/     a REAL diff, reconstructed as its own tiny git repo, from
                       xKazeex/base-api-gateway commits 06885f7..d29dabb (the actual
                       nonce-ledger replay-protection work)
  injection-attempt/  synthetic diff: a real eval() vulnerability plus an embedded
                       prompt-injection attempt in a comment
action.yml            GitHub Action metadata (runs: node20)
```

## Running the tests

```
npm install
npm test
```

Requires `semgrep` on `PATH` (`pip install semgrep`) for two tests; those two skip
gracefully if it's not found. Everything else, including the reviewer API clients, runs
against mocked `fetch` — **zero real network calls or API keys required to run the suite.**

## What's deferred (flagged, not silently skipped)

- **Real API calls.** Both reviewer integrations are built and tested against mocked
  `fetch`, per the agreed build order (core logic first, real keys last). The OpenAI
  Responses API request/response shape in `src/reviewers/openai.js` is inferred from
  general API-shape knowledge, not a verified fetch of GPT-5.6 Sol's specific
  documentation (it's a very recent release) — confirm against a real call before trusting
  it beyond a smoke test.
- **A real GitHub repo.** This project lives locally only; it hasn't been pushed anywhere.
  `git init` is done, nothing is pushed.
- **A live `pull_request` run.** `src/index.js` (the Action entrypoint) is written and
  reviewed but has never executed inside an actual GitHub Actions run — event-payload
  field names, PR-comment posting, and the override-label check are unverified against a
  real trigger.
- **A real test PR.** `test/fixtures/nonce-ledger-pr` is a real diff but a *reconstructed*
  one (two commits in an isolated fixture repo, not a live PR on GitHub) — good enough to
  test snapshotting/scanning/review logic, not the real `pull_request` webhook path.
- **Real injection resistance.** The injection-attempt fixture confirms the *prompt* is
  structurally sound (the injected text lands inside the untrusted-data region; the
  contract text above the marker is provably unaffected by diff content). It does **not**
  confirm a real model actually resists the embedded instruction — that needs a live call.

## A bug the tests actually caught

`combine.js` originally left Semgrep's own severity vocabulary (`ERROR`/`WARNING`/`INFO`)
unmapped onto the shared `critical`/`high`/`medium`/`low`/`info` scale used everywhere
else. The practical effect: a Semgrep `ERROR` finding could never, on its own, force
`NEEDS_HUMAN_REVIEW` — string equality between `'error'` and `'high'`/`'critical'` is
always false. Caught by `test/verdict.test.js`'s injection-attempt case, which runs the
real (unmocked) Semgrep against a real `eval()` vulnerability specifically to prove the
defense-in-depth property (Semgrep alone must be able to block a false `PASS` even if both
model reviewers are compromised) holds — not just assumed it did.
