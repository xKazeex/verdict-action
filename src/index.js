'use strict';

const fs = require('node:fs');
const path = require('node:path');
const core = require('@actions/core');
const github = require('@actions/github');
const { runVerdict } = require('./verdict');

// NOTE: this entrypoint has not yet been exercised against a real GitHub Actions run --
// per the build sequencing agreed for v0, core logic (config/snapshot/secret-scan/semgrep/
// combine/report) was built and tested first against mocked reviewers; this file wires
// that logic to real GitHub Actions context and has only been reviewed, not run live.
// Confirm event-payload field names and the override-label check against a real
// pull_request run before trusting this beyond a first smoke test.

async function main() {
  const anthropicApiKey = core.getInput('anthropic-api-key', { required: true });
  const openaiApiKey = core.getInput('openai-api-key', { required: true });
  const githubToken = core.getInput('github-token', { required: true });
  const configPath = core.getInput('config-path') || '.verdict.yml';
  const overrideLabel = core.getInput('override-label') || 'verdict-override';

  const pr = github.context.payload.pull_request;
  if (!pr) {
    core.setFailed('Verdict only runs on pull_request events; no pull_request found in the event payload.');
    return;
  }

  const repoRoot = process.env.GITHUB_WORKSPACE || process.cwd();
  const baseSha = pr.base.sha;
  const headSha = pr.head.sha;

  const result = await runVerdict({
    repoRoot,
    baseSha,
    headSha,
    contextFiles: [configPath],
    configPath,
    reviewers: {
      claude: (snapshot) => require('./reviewers/claude').reviewWithClaude(snapshot, { apiKey: anthropicApiKey }),
      gpt: (snapshot) => require('./reviewers/openai').reviewWithGpt(snapshot, { apiKey: openaiApiKey })
    }
  });

  core.setOutput('status', result.outcome);

  if (result.outcome === 'SKIPPED') {
    core.info(`Verdict skipped: ${result.reason}`);
    return;
  }

  if (result.outcome === 'BLOCKED_SECRETS_DETECTED') {
    core.setFailed(result.message);
    await postComment(githubToken, pr, `## Verdict — status: \`BLOCKED_SECRETS_DETECTED\`\n\n${result.message}`);
    return;
  }

  const sarifPath = path.join(repoRoot, 'verdict-results.sarif');
  fs.writeFileSync(sarifPath, JSON.stringify(result.sarif, null, 2));
  core.setOutput('sarif-path', sarifPath);

  await postComment(githubToken, pr, result.markdown);

  const hasOverride = Array.isArray(pr.labels) && pr.labels.some((l) => l.name === overrideLabel);
  if (result.status !== 'PASS' && !hasOverride) {
    core.setFailed(
      `Verdict status ${result.status}: human review required. Apply the "${overrideLabel}" label after reviewing to allow merge.`
    );
  } else if (result.status !== 'PASS' && hasOverride) {
    core.warning(`Verdict status ${result.status}, but "${overrideLabel}" label present -- not failing the check. This override was a human decision, not Verdict's.`);
  }
}

async function postComment(token, pr, body) {
  const octokit = github.getOctokit(token);
  const { owner, repo } = github.context.repo;
  await octokit.rest.issues.createComment({ owner, repo, issue_number: pr.number, body });
}

main().catch((err) => {
  core.setFailed(err instanceof Error ? err.message : String(err));
});
