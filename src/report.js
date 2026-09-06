'use strict';

const TOOL_NAME = 'verdict';
const TOOL_VERSION = '0.1.0';
const TOOL_URI = 'https://github.com/xKazeex/verdict-action';

function sarifLevel(severity) {
  switch ((severity || '').toLowerCase()) {
    case 'critical':
    case 'high':
    case 'error':
      return 'error';
    case 'medium':
    case 'warning':
      return 'warning';
    default:
      return 'note';
  }
}

function reviewerCell(review) {
  if (review.unavailable) return 'unavailable ⚠️';
  return `${review.overallVerdict}${review.parseError ? ' ⚠️ (parse error)' : ''}`;
}

/**
 * Renders the PR comment. Each channel's verdict is shown on its own row -- this format
 * has no code path that can collapse three independent opinions into "2 of 3 say safe."
 */
function renderMarkdownReport({ snapshot, status, semgrepFindings, semgrepError, claudeReview, gptReview, disagreementMatrix }) {
  const lines = [];
  lines.push(`## Verdict security review — status: \`${status}\``);
  lines.push('');
  lines.push(
    `Snapshot: base \`${snapshot.baseSha.slice(0, 12)}\` → head \`${snapshot.headSha.slice(0, 12)}\`, diff sha256 \`${snapshot.diffSha256.slice(0, 16)}…\``
  );
  lines.push('');

  if (semgrepError || claudeReview.unavailable || gptReview.unavailable) {
    lines.push('> ⚠️ **Degraded mode: not every evidence channel produced a result.** A missing');
    lines.push('> channel is never treated as "that channel says safe" -- this forces human review');
    lines.push('> below regardless of what the remaining channel(s) reported.');
    lines.push('');
  }

  lines.push('### Channel verdicts (shown separately, never combined)');
  lines.push('');
  lines.push('| Channel | Verdict | Findings |');
  lines.push('|---|---|---|');
  lines.push(`| Semgrep (deterministic) | ${semgrepError ? 'unavailable ⚠️' : '—'} | ${semgrepFindings.length} |`);
  lines.push(`| Claude (Sonnet 5) | ${reviewerCell(claudeReview)} | ${claudeReview.findings.length} |`);
  lines.push(`| GPT-5.6 Sol | ${reviewerCell(gptReview)} | ${gptReview.findings.length} |`);
  lines.push('');

  if (semgrepError) lines.push(`- ⚠️ Semgrep unavailable: ${semgrepError}`);
  if (claudeReview.unavailable) lines.push(`- ⚠️ Claude (Sonnet 5) ${claudeReview.summary}`);
  if (gptReview.unavailable) lines.push(`- ⚠️ GPT-5.6 Sol ${gptReview.summary}`);
  if (semgrepError || claudeReview.unavailable || gptReview.unavailable) lines.push('');

  if (disagreementMatrix.length > 0) {
    lines.push('### Findings by location');
    lines.push('');
    for (const cluster of disagreementMatrix) {
      const where = cluster.path ? `\`${cluster.path}${cluster.line ? ':' + cluster.line : ''}\`` : '(unlocated)';
      lines.push(`- ${where} — seen by **${cluster.channels.join(', ')}** (${cluster.agreement})`);
      for (const f of cluster.findings) {
        lines.push(`  - [${f.channel}] **${f.severity}** ${f.category}: ${f.description}`);
      }
    }
    lines.push('');
  } else {
    lines.push('No findings from any channel.');
    lines.push('');
  }

  if (status !== 'PASS') {
    lines.push('---');
    lines.push(
      `**${status}**: a human must review this before merge. Verdict never auto-resolves reviewer disagreement or auto-approves a high/critical finding. Merging requires the override label.`
    );
  }

  return lines.join('\n');
}

/**
 * Renders SARIF 2.1.0. All three channels' findings are included as results from the same
 * "verdict" tool run, each result's message prefixed with its origin channel so the
 * per-channel distinction survives into SARIF consumers too.
 */
function renderSarif({ snapshot, semgrepFindings, claudeReview, gptReview }) {
  const rulesSeen = new Map();
  const results = [];

  function addResult(channel, ruleId, message, filePath, line, level) {
    if (!rulesSeen.has(ruleId)) {
      rulesSeen.set(ruleId, { id: ruleId, name: ruleId, shortDescription: { text: message.slice(0, 120) } });
    }
    results.push({
      ruleId,
      level,
      message: { text: `[${channel}] ${message}` },
      locations: filePath
        ? [{ physicalLocation: { artifactLocation: { uri: filePath }, region: { startLine: line || 1 } } }]
        : []
    });
  }

  for (const f of semgrepFindings) {
    addResult('semgrep', f.ruleId, f.message || f.ruleId, f.path, f.startLine, sarifLevel(f.severity));
  }
  for (const f of claudeReview.findings) {
    addResult('claude', `claude/${f.category}`, f.description, f.path, f.line, sarifLevel(f.severity));
  }
  for (const f of gptReview.findings) {
    addResult('gpt-5.6-sol', `gpt-5.6-sol/${f.category}`, f.description, f.path, f.line, sarifLevel(f.severity));
  }

  return {
    version: '2.1.0',
    $schema: 'https://raw.githubusercontent.com/oasis-tcs/sarif-spec/master/Schemata/sarif-schema-2.1.0.json',
    runs: [
      {
        tool: {
          driver: {
            name: TOOL_NAME,
            informationUri: TOOL_URI,
            version: TOOL_VERSION,
            rules: [...rulesSeen.values()]
          }
        },
        properties: { snapshotId: snapshot.snapshotId, baseSha: snapshot.baseSha, headSha: snapshot.headSha },
        results
      }
    ]
  };
}

module.exports = { renderMarkdownReport, renderSarif, sarifLevel };
