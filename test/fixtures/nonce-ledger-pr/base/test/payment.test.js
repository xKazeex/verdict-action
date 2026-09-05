'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const { x402Client } = require('@x402/core/client');
const { registerExactEvmScheme } = require('@x402/evm/exact/client');
const { privateKeyToAccount } = require('viem/accounts');
const { createApp } = require('../src/app');
const { loadConfig } = require('../src/config');

const TEST_PRIVATE_KEY = `0x${'1'.repeat(64)}`;
const PAYER = privateKeyToAccount(TEST_PRIVATE_KEY).address;
const TX_HASH = `0x${'a'.repeat(64)}`;

function decodeHeader(value) {
  return JSON.parse(Buffer.from(value, 'base64').toString('utf8'));
}

function encodeHeader(value) {
  return Buffer.from(JSON.stringify(value)).toString('base64');
}

function makeFacilitator(overrides = {}) {
  const seen = new Set();
  return {
    getSupported: async () => ({
      kinds: [{ x402Version: 2, scheme: 'exact', network: 'eip155:84532', extra: {} }],
      extensions: [],
      signers: {}
    }),
    verify: async payload => {
      const authorization = payload.payload.authorization || {};
      if (!/^0x[0-9a-f]{130}$/i.test(payload.payload.signature || '')) {
        return { isValid: false, invalidReason: 'invalid_signature' };
      }
      if (Number(authorization.validBefore) <= Math.floor(Date.now() / 1000)) {
        return { isValid: false, invalidReason: 'payment_expired' };
      }
      if (seen.has(authorization.nonce)) return { isValid: false, invalidReason: 'replayed_payment' };
      if (overrides.verify) return overrides.verify(payload);
      seen.add(authorization.nonce);
      return { isValid: true, payer: PAYER };
    },
    settle: async payload => {
      if (overrides.settle) return overrides.settle(payload);
      return { success: true, transaction: TX_HASH, network: 'eip155:84532', payer: PAYER };
    }
  };
}

function enabledApp(facilitator = makeFacilitator()) {
  return createApp(loadConfig({ NODE_ENV: 'test', PAYMENTS_ENABLED: 'true' }), { facilitator });
}

async function challenge(app, path = '/v1/market/prices') {
  const response = await request(app).get(path).set('accept', 'application/json').expect(402);
  assert.ok(response.headers['payment-required']);
  return decodeHeader(response.headers['payment-required']);
}

async function signedPayload(paymentRequired) {
  const client = new x402Client();
  registerExactEvmScheme(client, {
    signer: privateKeyToAccount(TEST_PRIVATE_KEY),
    networks: ['eip155:84532']
  });
  return client.createPaymentPayload(paymentRequired);
}

async function paidRequest(app, payload, path = '/v1/market/prices') {
  return request(app)
    .get(path)
    .set('accept', 'application/json')
    .set('payment-signature', encodeHeader(payload));
}

function assertNoProtectedData(response) {
  assert.notEqual(response.status, 200);
  assert.equal(response.body.resource, undefined);
  assert.equal(response.body.data, undefined);
}

test('no payment returns the canonical v2 Base Sepolia requirement', async () => {
  const required = await challenge(enabledApp());
  assert.equal(required.x402Version, 2);
  assert.equal(required.accepts.length, 1);
  assert.deepEqual(
    {
      scheme: required.accepts[0].scheme,
      network: required.accepts[0].network,
      amount: required.accepts[0].amount,
      asset: required.accepts[0].asset,
      payTo: required.accepts[0].payTo
    },
    {
      scheme: 'exact',
      network: 'eip155:84532',
      amount: '2000',
      asset: '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
      payTo: '0x1a308b96C05634D3068BB614026D3163191EbA4e'
    }
  );
});

test('official client signs a complete flow and data is released only after settlement', async () => {
  const app = enabledApp();
  const required = await challenge(app);
  const payload = await signedPayload(required);
  assert.match(payload.payload.signature, /^0x[0-9a-f]{130}$/i);

  const response = await paidRequest(app, payload);
  assert.equal(response.status, 200);
  assert.equal(response.body.resource, 'market-prices');
  assert.ok(response.headers['payment-response']);
  const settlement = decodeHeader(response.headers['payment-response']);
  assert.equal(settlement.success, true);
  assert.equal(settlement.transaction, TX_HASH);
});

test('malformed payment headers and bad signatures fail closed', async () => {
  const app = enabledApp();
  assertNoProtectedData(await request(app).get('/v1/market/prices').set('payment-signature', '%%%'));
  const payload = await signedPayload(await challenge(app));
  payload.payload.signature = '0xdeadbeef';
  assertNoProtectedData(await paidRequest(app, payload));
});

for (const [name, mutate] of [
  ['wrong recipient', requirement => { requirement.payTo = '0x0000000000000000000000000000000000000001'; }],
  ['wrong amount', requirement => { requirement.amount = '1999'; }],
  ['wrong chain/network', requirement => { requirement.network = 'eip155:8453'; }],
  ['wrong token/asset', requirement => { requirement.asset = '0x0000000000000000000000000000000000000001'; }]
]) {
  test(`${name} fails closed`, async () => {
    const app = enabledApp();
    const payload = await signedPayload(await challenge(app));
    mutate(payload.accepted);
    assertNoProtectedData(await paidRequest(app, payload));
  });
}

test('expired authorization and replayed authorization fail closed', async () => {
  const app = enabledApp();
  const expired = await signedPayload(await challenge(app));
  expired.payload.authorization.validBefore = String(Math.floor(Date.now() / 1000) - 1);
  assertNoProtectedData(await paidRequest(app, expired));

  const replay = await signedPayload(await challenge(app));
  assert.equal((await paidRequest(app, replay)).status, 200);
  assertNoProtectedData(await paidRequest(app, replay));
});

test('facilitator verification failure and unavailability fail closed', async () => {
  const invalidApp = enabledApp(makeFacilitator({
    verify: async () => ({ isValid: false, invalidReason: 'facilitator_rejected' })
  }));
  assertNoProtectedData(await paidRequest(invalidApp, await signedPayload(await challenge(invalidApp))));

  const unavailableApp = enabledApp(makeFacilitator({
    verify: async () => { throw new Error('private upstream detail'); }
  }));
  const response = await paidRequest(unavailableApp, await signedPayload(await challenge(unavailableApp)));
  assertNoProtectedData(response);
  assert.doesNotMatch(JSON.stringify(response.body), /private upstream detail/);
});

test('facilitator settlement failure and unavailability never release buffered data', async () => {
  for (const settle of [
    async () => ({ success: false, transaction: '', network: 'eip155:84532', errorReason: 'failed' }),
    async () => { throw new Error('private settlement detail'); }
  ]) {
    const app = enabledApp(makeFacilitator({ settle }));
    const response = await paidRequest(app, await signedPayload(await challenge(app)));
    assertNoProtectedData(response);
    assert.doesNotMatch(JSON.stringify(response.body), /private settlement detail/);
  }
});

test('malformed request inputs are rejected before payment processing', async () => {
  const response = await request(enabledApp()).get('/v1/network/gas?unexpected=true').expect(400);
  assert.equal(response.body.error, 'invalid_request');
  assert.equal(response.headers['payment-required'], undefined);
});
