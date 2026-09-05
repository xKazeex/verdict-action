'use strict';

const { HTTPFacilitatorClient, x402ResourceServer } = require('@x402/core/server');
const { ExactEvmScheme } = require('@x402/evm/exact/server');
const { paymentMiddleware } = require('@x402/express');
const { CONFIDENCE, hash } = require('./lifecycle');

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

module.exports = { PROTECTED_ROUTES, createPaymentMiddleware, createPaymentRoutes, fingerprintPayload, validatePaymentHeader };
