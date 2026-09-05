'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { scanForSecrets } = require('../src/secret-scan');

test('detects an AWS access key id', () => {
  const findings = scanForSecrets(['const key = "AKIAABCDEFGHIJKLMNOP";']);
  assert.equal(findings.length, 1);
  assert.equal(findings[0].rule, 'aws_access_key_id');
});

test('detects a PEM private key block', () => {
  const findings = scanForSecrets(['-----BEGIN RSA PRIVATE KEY-----']);
  assert.ok(findings.some((f) => f.rule === 'private_key_block'));
});

test('detects an Anthropic-shaped API key', () => {
  const findings = scanForSecrets(['ANTHROPIC_API_KEY=sk-ant-api03-abcdefghijklmnopqrstuvwxyz123456']);
  assert.ok(findings.some((f) => f.rule === 'anthropic_api_key'));
});

test('detects a GitHub personal access token', () => {
  const findings = scanForSecrets(['token: ghp_1234567890abcdefghijklmnopqrstuvwxyz']);
  assert.ok(findings.some((f) => f.rule === 'github_token'));
});

test('findings never include the matched secret value, only rule name and line index', () => {
  const findings = scanForSecrets(['const key = "AKIAABCDEFGHIJKLMNOP";']);
  const serialized = JSON.stringify(findings);
  assert.doesNotMatch(serialized, /AKIAABCDEFGHIJKLMNOP/, 'the scanner itself must not leak the secret value into its own findings');
});

test('ordinary code produces no findings', () => {
  const findings = scanForSecrets([
    'function add(a, b) { return a + b; }',
    'const config = { retries: 3 };',
    '// TODO: handle the timeout case'
  ]);
  assert.deepEqual(findings, []);
});

test('reports lineIndex matching the position in the input array', () => {
  const findings = scanForSecrets(['fine', 'also fine', 'const k = "AKIAABCDEFGHIJKLMNOP";']);
  assert.equal(findings[0].lineIndex, 2);
});
