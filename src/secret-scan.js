'use strict';

// Hand-rolled rather than an added dependency -- for a tool whose entire job is deciding
// what's safe to transmit off-repo, a smaller, fully auditable dependency surface is
// itself a reasonable security property. Not exhaustive: a v0 baseline covering the most
// common real-world leak shapes (cloud provider keys, private key blocks, VCS/chat/API
// tokens, generic high-entropy secret-like assignments). FLAGGED: if broader coverage is
// needed beyond v0, consider a maintained scanner (gitleaks/trufflehog) instead of growing
// this list indefinitely by hand.
const SECRET_PATTERNS = [
  { name: 'aws_access_key_id', re: /\bAKIA[0-9A-Z]{16}\b/ },
  { name: 'aws_secret_access_key_assignment', re: /aws_secret_access_key\s*[:=]\s*['"][A-Za-z0-9/+=]{40}['"]/i },
  { name: 'private_key_block', re: /-----BEGIN (RSA |EC |OPENSSH |DSA |PGP )?PRIVATE KEY-----/ },
  { name: 'github_token', re: /\bgh[pousr]_[A-Za-z0-9]{36,255}\b/ },
  { name: 'slack_token', re: /\bxox[baprs]-[A-Za-z0-9-]{10,72}\b/ },
  { name: 'anthropic_api_key', re: /\bsk-ant-[A-Za-z0-9_-]{20,}\b/ },
  { name: 'openai_api_key', re: /\bsk-(proj-)?[A-Za-z0-9_-]{20,}\b/ },
  { name: 'stripe_key', re: /\b(sk|pk|rk)_(live|test)_[A-Za-z0-9]{16,}\b/ },
  { name: 'generic_secret_assignment', re: /(api[_-]?key|secret|token|password)\s*[:=]\s*['"][A-Za-z0-9_\-/+]{20,}['"]/i },
  { name: 'jwt_like', re: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/ }
];

/**
 * Scans added diff lines for likely secrets. This is the hard gate required before
 * anything is transmitted to either model: if this returns any findings, the caller MUST
 * refuse to send the snapshot to Claude or GPT-5.6 Sol at all.
 *
 * Findings deliberately never include the matched secret VALUE, only the rule name and
 * line index -- the scanner itself must not become a second place the secret gets copied
 * into logs or a report.
 */
function scanForSecrets(addedLines) {
  const findings = [];
  addedLines.forEach((line, lineIndex) => {
    for (const pattern of SECRET_PATTERNS) {
      if (pattern.re.test(line)) {
        findings.push({ rule: pattern.name, lineIndex });
      }
    }
  });
  return findings;
}

module.exports = { scanForSecrets, SECRET_PATTERNS };
