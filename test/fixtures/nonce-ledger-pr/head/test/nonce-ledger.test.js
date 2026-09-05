'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createNonceLedger } = require('../src/nonce-ledger');

function freshLedger() {
  return createNonceLedger(':memory:');
}

test('reserve succeeds once and rejects a duplicate (network, payer, nonce)', () => {
  const ledger = freshLedger();
  const network = 'eip155:84532';
  const payer = '0x7Df90018094c52B7b0aae98f26354A81B9D8371B';
  const nonce = '0xf225c67f5a202e845867e7abdf9bfc1b47f1104cef3915e0690313defb48bf85';

  const first = ledger.reserve(network, payer, nonce);
  assert.deepEqual(first, { reserved: true });
  assert.equal(ledger.getStatus(network, payer, nonce), 'pending');

  const second = ledger.reserve(network, payer, nonce);
  assert.equal(second.reserved, false);
  assert.equal(second.reason, 'duplicate_authorization_nonce');

  ledger.close();
});

test('reserve is case-insensitive on payer and nonce', () => {
  const ledger = freshLedger();
  const network = 'eip155:84532';
  const payer = '0xAbCdEf0000000000000000000000000000000001';
  const nonce = '0xDEADBEEF00000000000000000000000000000000000000000000000000001';

  assert.equal(ledger.reserve(network, payer, nonce).reserved, true);
  assert.equal(ledger.reserve(network, payer.toLowerCase(), nonce.toLowerCase()).reserved, false);

  ledger.close();
});

test('different nonces for the same payer do not collide', () => {
  const ledger = freshLedger();
  const network = 'eip155:84532';
  const payer = '0x7Df90018094c52B7b0aae98f26354A81B9D8371B';

  assert.equal(ledger.reserve(network, payer, '0x01').reserved, true);
  assert.equal(ledger.reserve(network, payer, '0x02').reserved, true);

  ledger.close();
});

test('markSettled and markFailed update status, and a failed nonce stays permanently consumed', () => {
  const ledger = freshLedger();
  const network = 'eip155:84532';
  const payer = '0x7Df90018094c52B7b0aae98f26354A81B9D8371B';

  const settledNonce = '0x01';
  ledger.reserve(network, payer, settledNonce);
  ledger.markSettled(network, payer, settledNonce);
  assert.equal(ledger.getStatus(network, payer, settledNonce), 'settled');

  const failedNonce = '0x02';
  ledger.reserve(network, payer, failedNonce);
  ledger.markFailed(network, payer, failedNonce);
  assert.equal(ledger.getStatus(network, payer, failedNonce), 'failed');

  // A failed attempt still permanently reserves that exact nonce -- by design, per
  // DEBUG_LOG.md: resubmitting the exact same nonce is either a retry of the same
  // request or a replay attempt, and either way a legitimate client can always sign a
  // fresh authorization with a new nonce instead.
  const retry = ledger.reserve(network, payer, failedNonce);
  assert.equal(retry.reserved, false);

  ledger.close();
});

test('getStatus returns undefined for a nonce that was never reserved', () => {
  const ledger = freshLedger();
  assert.equal(
    ledger.getStatus('eip155:84532', '0x7Df90018094c52B7b0aae98f26354A81B9D8371B', '0xnever'),
    undefined
  );
  ledger.close();
});
