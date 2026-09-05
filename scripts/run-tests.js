'use strict';

// Cross-platform test file selection: node --test's own recursive discovery would also
// pick up the *.test.js files copied into test/fixtures/nonce-ledger-pr and
// test/fixtures/injection-attempt (real files from the fixture's SOURCE repo, with
// dependencies that don't exist here) and try to run them as if they were Verdict's own
// tests. Explicitly enumerating test/*.test.js (non-recursive) avoids that without
// depending on shell glob expansion, which isn't portable across bash/cmd/PowerShell.
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const testDir = path.join(__dirname, '..', 'test');
const files = fs
  .readdirSync(testDir)
  .filter((name) => name.endsWith('.test.js'))
  .map((name) => path.join('test', name));

if (files.length === 0) {
  console.error('No test/*.test.js files found.');
  process.exit(1);
}

const result = spawnSync(process.execPath, ['--test', ...files], { stdio: 'inherit' });
process.exit(result.status === null ? 1 : result.status);
