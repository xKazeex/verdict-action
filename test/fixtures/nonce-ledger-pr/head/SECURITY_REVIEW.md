# x402 Payment Security Review and Pre-Mainnet Plan

Date: 2026-08-17  
Scope: `xKazeex/base-api-gateway`, branch `audit/x402-hardening`  
Decision: **NOT APPROVED FOR MAINNET OR REAL-MONEY USE**

## Executive summary

The current Kitchen is a strong fail-closed Base Sepolia prototype. Configuration locks the payment contract to x402 v2 `exact`, Base Sepolia (`eip155:84532`), canonical Base Sepolia USDC, the confirmed recipient, a fixed test price, and the public test facilitator. Protected handlers run behind the official middleware, tests show that data is withheld on malformed payment, bad signature, contract mismatch, expiry, replay in the test double, verification failure, and settlement failure, and `PAYMENTS_ENABLED=false` remains the deployment default.

The successful Base Sepolia settlement proves protocol interoperability on testnet. It does not close the production risks below. Mainnet must remain disabled until every P0 item is implemented, independently tested, and explicitly approved.

## Trust boundaries

1. The client constructs and signs the x402 authorization; the Kitchen must treat every request/header as hostile.
2. The Kitchen defines the only acceptable route, scheme, network, asset, amount, and recipient.
3. The facilitator verifies and settles, and is therefore a security and availability dependency rather than merely a transport service.
4. Protected data may leave the Kitchen only after successful verification and settlement for the exact requirement.
5. Reverse proxies, logs, metrics, data providers, and deployment configuration are outside the cryptographic protocol but can still expose credentials, enable abuse, or corrupt paid results.

## Findings by severity

### Critical

None observed in the reviewed Base Sepolia implementation.

### High — P0 mainnet blockers

#### H-1: Replay and idempotency are not durably owned by the Kitchen

The production code delegates verification and settlement to the facilitator and has no durable nonce/payment ledger. The replay test uses an in-memory `Set` inside the facilitator double; it does not prove replay protection across processes, restarts, regions, retries, or a facilitator change.

**Fix:** Before mainnet, persist a collision-resistant payment identity (at minimum network, payer, authorization nonce and the bound payment requirement) with atomic `pending`/`settled`/`failed-or-unknown` transitions and a uniqueness constraint. Coordinate concurrent requests, retain records for at least the maximum authorization/retry horizon, and return the previously committed result for a proven duplicate rather than settling twice. Define reconciliation for timeout-after-submit and never blindly retry an indeterminate settlement.

**Acceptance evidence:** concurrent duplicate, restart, multi-instance, delayed retry, and timeout-after-submit tests against the real persistence layer; one settlement maximum for one authorization.

**STATUS (this session): a real fix for the specific race, but its benefit does not survive a restart on this deployment as currently configured — do not read this as closing the durability half of this finding.** `src/nonce-ledger.js` (SQLite, `UNIQUE(network, payer, nonce)`) is now consulted in `x402ResourceServer.onBeforeVerify` before Kitchen calls the real facilitator at all, with `onAfterVerify`/`onVerifyFailure`/`onAfterSettle`/`onSettleFailure` updating that row's status on every terminal outcome (`pending` → `settled`/`failed`) for observability — the `(network, payer, nonce)` key itself is never released; a failed attempt still permanently consumes that exact nonce, matching on-chain EIP-3009 semantics (`authorizationState` never resets). This closes the specific race this review didn't originally have language for: `@x402/evm`'s `/verify` runs an on-chain simulation by default but `/settle` skips it, so a second `/verify` could otherwise slip past before the first `/settle` lands. Confirmed live: an already-consumed nonce rejected in ~2ms locally vs. ~540ms for a real facilitator round-trip, before the facilitator was ever called a second time.

**But**: `render.yaml` declares no `disk:` block for this service, and Render web services without one have an ephemeral filesystem — every redeploy, manual restart, *and* the free tier's own inactivity-based cold-start cycle (observed directly, more than once, during this investigation) wipes local disk, including `data/nonce-ledger.db`. So on the actual deployed environment, this protection resets every time the process cold-starts, not just on a deliberate restart — it is real protection for the lifetime of one warm process, not the durable, restart-surviving ledger this finding calls for. This does **not** reopen a double-payment risk — the real facilitator's on-chain simulation and the chain itself remain the backstop exactly as before this fix, both before and after a cold start — but the specific benefit this fix adds (catching the race *before* it costs the facilitator a wasted broadcast) is only continuously available while the process stays warm, which Render's free tier does not guarantee. A durability fix needs either a Render persistent disk (paid) or an external store (managed Postgres/Redis); neither is in scope here. **Not addressed, deliberately out of scope for now**: the above, plus multi-instance coordination (SQLite is single-writer), timeout-after-submit reconciliation, and returning the previously-committed result to a proven duplicate rather than just rejecting it. Full acceptance evidence above (concurrent/multi-instance/delayed-retry/restart tests) still applies before mainnet — this status note narrows what's proven, it does not check any of those boxes.

#### H-2: Facilitator trust, response validation, and outage policy are incomplete

The service uses one public test facilitator. Exceptions fail closed, which is correct, but the production trust model, authentication, service-level expectations, compromise response, and reconciliation path are not defined. A success response must not be accepted solely because `success` is truthy.

**Fix:** Select a production facilitator only after security/legal/operational review. Authenticate it where supported; restrict outbound destination and redirects; pin the expected scheme/network capabilities; validate successful settlement fields against the accepted requirement (network, transaction identifier, payer where available); independently reconcile finalized chain receipts and token transfer recipient/asset/amount before treating accounting as final. Add a tested kill switch and fail-closed circuit breaker.

**Acceptance evidence:** contract tests for malformed/mismatched facilitator responses, DNS/TLS/connect/read timeouts, 429/5xx responses, partial outages, response tampering, and indeterminate settlement recovery.

#### H-3: Production observability and incident controls are not implemented

Unhandled errors are written directly to `console.error`, and there is no documented structured audit event, redaction policy, alerting, retention policy, or incident runbook. Payment headers and signed payloads must never enter logs, traces, exception systems, analytics, or support exports.

**Fix:** Implement structured allowlist-based security events with request/payment correlation IDs derived from non-secret metadata. Explicitly redact `PAYMENT-SIGNATURE`, authorization/signature bodies, cookies, authorization headers, environment values, and upstream error bodies. Alert on verify/settle failure rates, replay attempts, configuration drift, rate-limit saturation, and reconciliation gaps. Document kill-switch and facilitator-compromise procedures.

**Acceptance evidence:** automated log-capture tests using canary secrets and signed-payload-shaped fixtures, plus an incident tabletop that disables payments without deployment or fund movement.

### Medium — P1 production hardening

#### M-1: Rate limiting is single-layer and identity-blind

The paid routes have a bounded IP limiter, but its effectiveness depends on correct `TRUST_PROXY`, it is not distributed, and it does not distinguish challenge floods, invalid signatures, payer identities, or expensive facilitator operations.

**Fix:** Use a shared limiter with separate budgets for unauthenticated challenges, malformed/failed payments, payer/payment identity, and successfully paid traffic. Enforce edge request/header/time limits, concurrency caps, and bounded queues. Verify the exact proxy topology and reject spoofed forwarding chains.

#### M-2: Authorization freshness policy is implicit

Expiry is tested through the facilitator double, but the Kitchen does not document a maximum accepted lifetime or clock-skew policy. Long-lived authorizations increase replay exposure.

**Fix:** Define and test maximum validity duration, allowed clock skew, not-yet-valid behavior if supported, and server time monitoring. Reject requirements outside the policy before costly upstream work when the SDK exposes the fields safely.

#### M-3: Dependency and build integrity controls are incomplete

Direct x402 packages are exactly pinned, but other dependencies use ranges and there is no committed CI/security policy described here. A zero-vulnerability audit is a point-in-time signal, not supply-chain assurance.

**Fix:** Use `npm ci`, lockfile integrity, automated dependency review, scheduled vulnerability scanning, provenance/SBOM where practical, supported Node LTS, minimal production image/runtime privileges, and controlled upgrade tests. Treat x402/facilitator upgrades as security-sensitive changes.

#### M-4: Paid-result correctness and accounting are not yet production-defined

The protected handlers intentionally return `not_implemented`. Before real data is sold, the system needs freshness, upstream integrity, cache, refund/credit, and settlement-to-response accounting rules.

**Fix:** Bind each settled payment to an immutable response/audit record, define data freshness and failure semantics, do not charge for unavailable/invalid data, and provide reconciliation and customer-support evidence without exposing signed payloads.

### Low — P2 defense in depth

#### L-1: Public contract metadata exposes operational dependencies

`/v1/contract` publishes recipient and facilitator details. These are not secrets and aid discovery, but they also help targeted abuse.

**Fix:** Keep only intentional public metadata, avoid internal topology/version detail, and rate-limit or cache discovery endpoints at the edge.

#### L-2: Security headers and response-cache policy are not explicit

The service disables `X-Powered-By`, but paid and error responses should have explicit cache and browser-facing security behavior.

**Fix:** Set `Cache-Control: no-store` on payment challenges, payment responses, and errors; add appropriate baseline security headers; confirm intermediaries never cache one payer's response for another.

## Existing controls verified by review

- Mainnet and noncanonical network/chain, recipient, asset, price, and facilitator configuration fail at startup.
- Payments are disabled by default in code examples and the Render blueprint.
- Protected routes accept no query string or request body and cap JSON bodies globally.
- Payment headers have a size cap and basic x402 v2 shape validation before facilitator work.
- Facilitator exceptions and negative verify/settle results fail closed.
- Protected response release occurs through official x402 middleware after settlement.
- Test coverage includes the canonical challenge, official-client signing, mismatch cases, expiry/replay control-flow cases, upstream failure, and malformed input.
- No production secrets are required by the service and the repository's signing key is an explicit deterministic test fixture.

## Pre-mainnet go/no-go checklist

All P0 and P1 items require evidence links and an independent reviewer. An unchecked P0 item is an automatic **NO-GO**.

### P0 — mandatory security gates

- [ ] Durable, atomic replay/idempotency ledger works across restarts and multiple instances.
- [ ] Indeterminate settlement and reconciliation state machine is implemented and tested.
- [ ] Production facilitator due diligence, authentication, allowlisting, capability pinning, and outage/compromise runbook are approved.
- [ ] Settlement results are validated and reconciled to finalized on-chain token transfers for the exact network, asset, recipient, and amount.
- [ ] Structured allowlist logging and automated secret/signed-payload redaction tests pass.
- [ ] Kill switch is tested operationally; payment/data release fails closed during every dependency failure.
- [ ] Mainnet configuration is introduced only in a separately reviewed change with explicit owner approval; testnet and mainnet environments are isolated.

### P1 — mandatory production-readiness gates

- [ ] Distributed, proxy-correct rate limits, concurrency caps, timeouts, and abuse alerts are load-tested.
- [ ] Authorization maximum lifetime, clock skew, and time-synchronization policy are enforced and tested.
- [ ] CI runs tests, syntax/format checks, lockfile install, vulnerability/dependency review, and secret scanning on every change.
- [ ] Runtime uses supported Node LTS, least privilege, read-only/minimal filesystem where practical, and controlled egress.
- [ ] Data freshness, upstream failure, cache isolation, charge/no-charge, refund/credit, and accounting rules are implemented.
- [ ] Monitoring covers verification, settlement, replay, latency, reconciliation, and configuration drift without sensitive payloads.
- [ ] Backup/restore and disaster-recovery tests cover the idempotency/accounting store.
- [ ] Independent adversarial review and a small-value mainnet canary plan are approved; the canary is not executed as part of this review.

### P2 — defense in depth and operations

- [ ] Explicit no-store/cache policy and baseline security headers are verified through the full proxy/CDN path.
- [ ] SBOM/provenance, dependency update cadence, and x402 upgrade review ownership are documented.
- [ ] Incident response, support evidence, retention/deletion, and privacy policies are rehearsed.
- [ ] Capacity and cost-abuse tests demonstrate bounded loss during challenge floods and facilitator degradation.

## Validation required after each hardening change

Run the complete automated suite, syntax checks, JSON parsing, whitespace checks, production dependency audit, credential scan, and targeted negative tests. Mocked facilitator tests prove local control flow only. Any mainnet approval additionally requires isolated end-to-end evidence, reconciliation evidence, and explicit human authorization; it must never reuse or expose a wallet private key or signed payment payload.

## Review conclusion

The branch is suitable for continued Base Sepolia development with the kill switch and current fail-closed controls. It is not production-ready. H-1 through H-3 and every P0/P1 checklist item remain prerequisites for mainnet or real-money consideration.
