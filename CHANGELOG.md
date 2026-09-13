# Changelog — Verdict

This file tracks security- and behavior-relevant changes to Verdict itself, in the same
plain, specific style as `SECURITY_REVIEW.md`-style status notes in repos Verdict reviews.
It is not a substitute for Git history, and it does not record every commit — only changes
that affect what Verdict actually detects, reports, or gates on.

## 2026-09-13 — Fixed: a reviewer parse error was not treated as a channel failure (security-relevant)

**Severity: high. This was a real bug in a shipped version (`9594c5d`), not a theoretical
one — it was in production use reviewing real PRs before this fix.**

**What was wrong:** `src/reviewers/parse-output.js`'s `parseReviewOutput()` correctly fails
toward `"concerns"` with zero findings when a model's response isn't valid JSON — a
deliberate, tested, defensive default. But `reviewWithClaude`/`reviewWithGpt`
(`src/reviewers/claude.js`, `src/reviewers/openai.js`) returned that degraded object as an
**ordinary, successful review result**. It never set `unavailable: true`, so it never
reached `channelFailures` in `src/verdict.js`, never tripped `combine.js`'s
`channelFailures.length > 0` check (which unconditionally forces `NEEDS_HUMAN_REVIEW`
ahead of every other rule), and never rendered `report.js`'s `⚠️ Degraded mode` banner. The
only visible trace was a small inline `⚠️ (parse error)` annotation next to the verdict word
in the PR-comment table — easy to miss, and with zero effect on the actual merge-gating
status.

**The exact scenario this could have produced a false `PASS` in:** one reviewer's response
fails to parse (defaults to `overallVerdict: 'concerns'`, 0 findings) while the *other*
reviewer genuinely reviews the diff and comes back `safe` with no high/critical findings.
`determineStatus()` in `combine.js` checks `claudeVerdict !== gptVerdict` for disagreement —
`'concerns' !== 'safe'` — so in that exact pairing it would still have surfaced as
`DISPUTED`, not `PASS`. But if the parse-failed channel's fallback verdict happened to match
the healthy channel's — e.g. the healthy reviewer itself returned `'concerns'` rather than
`'safe'`, a legitimate, unremarkable outcome for many real diffs — the disagreement check
would not fire, `'unsafe'` would not be present, and with no high/critical findings from
either channel (the failed one contributes none by construction), `determineStatus()` would
return `PASS`. A PR would merge having received, in effect, review from only one channel,
with the report giving no forced signal that anything was degraded.

**How it was actually found:** discovered by inspecting a real run of Verdict `9594c5d`
against `xKazeex/base-api-gateway#3` (a genuine dogfooding PR, not a synthetic test), where
Claude's channel hit a parse error and the run happened to still resolve to `DISPUTED` —
which on inspection turned out to be coincidental (GPT-5.6 Sol had independently reported
`unsafe` on that same run; the disagreement between `unsafe` and the parse-error fallback's
`concerns` is what actually produced `DISPUTED`, not any handling of the parse failure
itself). Tracing the code path from `report.js`'s rendered `concerns ⚠️ (parse error)` back
through `combine.js` and `parse-output.js` confirmed the parse-error path was structurally
identical to an ordinary successful review everywhere that mattered for the merge gate.

**The fix (`1ad09bf`):** `reviewWithClaude`/`reviewWithGpt` now throw when
`parseReviewOutput()` reports a parse error, instead of returning it as data. Throwing
routes it through the exact same `Promise.allSettled` → `unavailableReview()` path already
used for a genuine API/network failure, so a parse error is now indistinguishable, in every
way that matters for the merge gate, from a reviewer timing out or erroring: it enters
`channelFailures`, forces `NEEDS_HUMAN_REVIEW` regardless of the other channel's verdict,
and renders the `Degraded mode` banner. `parseReviewOutput()` itself is unchanged — it
remains the pure, independently-tested parsing/fallback function; the integration point
that was silently discarding its `parseError` field is what was fixed.

**Test coverage added:** a reviewer-level test per client asserting an unparseable response
now rejects rather than resolving (`test/reviewers.test.js`), and an end-to-end test
(`test/verdict.test.js`) that drives the real `reviewWithClaude` (mocked `fetch` only, so
the actual `parse-output.js` integration runs) with unparseable output paired against a
genuinely clean `safe` result from GPT, asserting `NEEDS_HUMAN_REVIEW` — the specific false-
`PASS`-risk scenario above, made concrete.

**Anything still open:** none for this specific bug — the fix closes the gap at the only
place it could occur. `parseReviewOutput()`'s markdown-fence-stripping and other lenient
parsing behavior is unchanged and still governs what counts as "parseable" in the first
place; a model wrapping valid JSON in unexpected formatting beyond that fence is not
addressed here and was never in scope for this fix.

**Consuming repos:** if your workflow pins Verdict to a commit older than `1ad09bf` (see
your `.github/workflows/verdict.yml`'s `uses:` line and its own comment on why it's pinned
rather than floating on `@main`), you are running the buggy version. Bump the pin.
