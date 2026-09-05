'use strict';

const { HTTPFacilitatorClient, x402ResourceServer } = require('@x402/core/server');
const { ExactEvmScheme } = require('@x402/evm/exact/server');
const { paymentMiddleware } = require('@x402/express');
const { CONFIDENCE, hash } = require('./lifecycle');
const { createNonceLedger } = require('./nonce-ledger');

const PROTECTED_ROUTES = Object.freeze({
  'GET /v1/market/prices': Object.freeze({ description: 'Kitchen market price resource', resource: '/v1/market/prices' }),
  'GET /v1/network/gas': Object.freeze({ description: 'Kitchen Base Sepolia gas resource', resource: '/v1/network/gas' })
});

function createPaymentRoutes(config) {
  return Object.fromEntries(Object.entries(PROTECTED_ROUTES).map(([route, metadata]) => [route, {
    accepts: [{ scheme: 'exact', network: config.caip2Network, price: config.paymentPrice, payTo: config.recipientWallet }],
    description: metadata.description,
    mimeType: 'application/json',
    unpaidResponseBody: () => ({
      contentType: 'application/json',
      body: { error: 'payment_required', message: 'A valid x402 v2 payment is required.' }
    }),
    settlementFailedResponseBody: () => ({
      contentType: 'application/json',
      body: { error: 'payment_settlement_failed', message: 'Payment could not be settled.' }
    })
  }]));
}

function fingerprintPayload(payload) {
  return hash(JSON.stringify({
    x402Version: payload?.x402Version,
    accepted: payload?.accepted,
    authorization: payload?.payload?.authorization,
    signatureHash: payload?.payload?.signature ? hash(payload.payload.signature) : undefined
  }));
}

// Pulls (network, payer, nonce) out of an exact-EVM (EIP-3009) payment payload.
// Returns undefined if the payload isn't shaped like one -- callers must treat that
// as "can't dedupe this one" and decide their own fail-open/fail-closed behavior;
// this never throws.
function extractAuthorizationKey(paymentPayload, requirements) {
  const authorization = paymentPayload && paymentPayload.payload && paymentPayload.payload.authorization;
  const network = requirements && requirements.network;
  if (!authorization || typeof authorization.from !== 'string' || typeof authorization.nonce !== 'string' || typeof network !== 'string') {
    return undefined;
  }
  return { network, payer: authorization.from, nonce: authorization.nonce };
}

// Registers the replay/idempotency guard described in DEBUG_LOG.md (P0 gap H-1):
// reserves (network, payer, nonce) atomically before Kitchen ever calls the real
// facilitator's /verify, and updates that reservation's status on every terminal
// outcome ('pending' -> 'settled'/'failed') for observability. The (network, payer,
// nonce) key itself is never released -- a failed attempt still permanently consumes
// that exact nonce, matching on-chain EIP-3009 semantics (a nonce is single-use
// regardless of outcome). A legitimate retry signs a fresh authorization with a new
// nonce; it does not reuse the failed one.
function registerNonceLedgerHooks(server, ledger, lifecycle) {
  server.onBeforeVerify((context) => {
    const key = extractAuthorizationKey(context.paymentPayload, context.requirements);
    if (!key) {
      // Unrecognized payload shape (not exact-EVM/EIP-3009) -- nothing to dedupe against.
      // Fail OPEN here deliberately: this is a "should never happen" branch for the only
      // scheme Kitchen registers, not a security boundary we're choosing to skip.
      return undefined;
    }
    const result = ledger.reserve(key.network, key.payer, key.nonce);
    if (result.reserved) {
      return undefined;
    }
    if (result.reason === 'ledger_error') {
      // Can't prove uniqueness -- fail CLOSED rather than silently let a possible
      // duplicate through. Deliberately NOT recorded as a DUPLICATE lifecycle event:
      // it isn't one -- it's a local infrastructure failure (the ledger itself is
      // unreachable/erroring), and recording it under DUPLICATE would misclassify the
      // evidence trail. It still reaches the operator via console.error above; a
      // dedicated lifecycle event type for ledger outages is a reasonable future
      // addition but out of scope here.
      console.error('[nonce-ledger] reserve failed unexpectedly, aborting payment:', result.error);
      return { abort: true, reason: 'nonce_ledger_unavailable', message: 'Could not verify payment uniqueness.' };
    }
    // Caught locally, before the facilitator is ever called -- evidence_source says so,
    // distinct from the facilitator-detected 'facilitator:verify' DUPLICATE below.
    lifecycle?.record({
      lifecycle_event_type: 'DUPLICATE', status: 'DETECTED', evidence_confidence: CONFIDENCE.VERIFIED,
      evidence_source: 'kitchen:nonce-ledger', evidence_pointer: 'kitchen:duplicate_authorization_nonce',
      evidence_fingerprint: fingerprintPayload(context.paymentPayload)
    });
    return {
      abort: true,
      reason: 'duplicate_authorization_nonce',
      message: 'duplicate nonce, already processed or in flight'
    };
  });

  server.onAfterVerify((context) => {
    const key = extractAuthorizationKey(context.paymentPayload, context.requirements);
    if (!key) return undefined;
    if (!context.result || !context.result.isValid) {
      ledger.markFailed(key.network, key.payer, key.nonce);
    }
    return undefined;
  });

  server.onVerifyFailure((context) => {
    const key = extractAuthorizationKey(context.paymentPayload, context.requirements);
    if (key) ledger.markFailed(key.network, key.payer, key.nonce);
    return undefined;
  });

  server.onAfterSettle((context) => {
    const key = extractAuthorizationKey(context.paymentPayload, context.requirements);
    if (!key) return undefined;
    if (context.result && context.result.success) {
      ledger.markSettled(key.network, key.payer, key.nonce);
    } else {
      ledger.markFailed(key.network, key.payer, key.nonce);
    }
    return undefined;
  });

  server.onSettleFailure((context) => {
    const key = extractAuthorizationKey(context.paymentPayload, context.requirements);
    if (key) ledger.markFailed(key.network, key.payer, key.nonce);
    return undefined;
  });
}

function createPaymentMiddleware(config, options = {}) {
  const lifecycle = options.lifecycle;
  const upstream = options.facilitator || new HTTPFacilitatorClient({ url: config.facilitatorUrl, timeoutMs: 10_000 });
  const record = input => lifecycle?.record(input);
  const evidence = payload => {
    const fingerprint = fingerprintPayload(payload);
    return { evidence_fingerprint: fingerprint, evidence_pointer: `payment:sha256:${fingerprint}` };
  };

  const facilitator = {
    getSupported: async () => {
      try { return await upstream.getSupported(); }
      catch { throw new Error('x402 facilitator capability discovery failed'); }
    },
    verify: async (...args) => {
      const payment = args[0];
      let result;
      try { result = await upstream.verify(...args); }
      catch { result = { isValid: false, invalidReason: 'facilitator_unavailable' }; }
      const invalidReason = result.invalidReason || 'verification_succeeded';
      const replay = invalidReason === 'replayed_payment';
      const duplicate = invalidReason === 'duplicate_payment';
      record({
        lifecycle_event_type: 'AUTHORIZATION', status: result.isValid ? 'ACCEPTED' : 'REJECTED',
        evidence_confidence: CONFIDENCE.VERIFIED, evidence_source: 'facilitator:verify', ...evidence(payment)
      });
      record({
        lifecycle_event_type: 'VERIFICATION',
        status: replay ? 'REPLAY_REJECTED' : result.isValid ? 'SUCCEEDED' : 'FAILED',
        evidence_confidence: CONFIDENCE.VERIFIED, evidence_source: 'facilitator:verify',
        evidence_pointer: replay ? 'facilitator:replayed_payment' : `facilitator:${invalidReason}`,
        evidence_fingerprint: fingerprintPayload(payment)
      });
      if (duplicate) record({
        lifecycle_event_type: 'DUPLICATE', status: 'DETECTED', evidence_confidence: CONFIDENCE.VERIFIED,
        evidence_source: 'facilitator:verify', evidence_pointer: 'facilitator:duplicate_payment',
        evidence_fingerprint: fingerprintPayload(payment)
      });
      return result;
    },
    settle: async (...args) => {
      const payment = args[0];
      let result;
      try { result = await upstream.settle(...args); }
      catch {
        result = { success: false, transaction: '', network: config.caip2Network, errorReason: 'facilitator_unavailable' };
      }
      record({
        lifecycle_event_type: 'SETTLEMENT',
        status: result.success ? 'SUCCEEDED' : result.errorReason === 'timeout' ? 'TIMEOUT' : 'FAILED',
        evidence_confidence: CONFIDENCE.VERIFIED, evidence_source: 'facilitator:settle',
        evidence_pointer: result.success ? 'facilitator:settlement-success' : `facilitator:${result.errorReason || 'settlement_failed'}`,
        evidence_fingerprint: fingerprintPayload(payment),
        transaction_reference: result.success ? result.transaction : undefined
      });
      return result;
    }
  };
  const server = new x402ResourceServer(facilitator).register(config.caip2Network, new ExactEvmScheme());

  const ledger = options.nonceLedger || createNonceLedger();
  registerNonceLedgerHooks(server, ledger, lifecycle);

  return paymentMiddleware(createPaymentRoutes(config), server, undefined, undefined, true);
}

function validatePaymentHeader(lifecycle) {
  return (req, res, next) => {
    const value = req.get('payment-signature');
    if (!value) return next();
    try {
      if (value.length > 16_384) throw new Error('oversized');
      const decoded = JSON.parse(Buffer.from(value, 'base64').toString('utf8'));
      if (!decoded || decoded.x402Version !== 2 || typeof decoded.payload !== 'object') throw new Error('invalid');
      lifecycle?.record({
        ...req.lifecycle,
        lifecycle_event_type: 'AUTHORIZATION', status: 'PRESENT', evidence_confidence: CONFIDENCE.VERIFIED,
        evidence_source: 'application:header-validation', evidence_pointer: `payment:sha256:${hash(value)}`,
        evidence_fingerprint: hash(value)
      });
    } catch {
      lifecycle?.record({
        ...req.lifecycle,
        lifecycle_event_type: 'AUTHORIZATION', status: 'REJECTED', evidence_confidence: CONFIDENCE.VERIFIED,
        evidence_source: 'application:header-validation', evidence_pointer: 'payment-signature:redacted',
        evidence_fingerprint: hash(value)
      });
      return res.status(402).json({ error: 'invalid_payment', message: 'The PAYMENT-SIGNATURE header is malformed.' });
    }
    return next();
  };
}

module.exports = {
  PROTECTED_ROUTES,
  createPaymentMiddleware,
  createPaymentRoutes,
  fingerprintPayload,
  validatePaymentHeader,
  registerNonceLedgerHooks,
  extractAuthorizationKey
};
