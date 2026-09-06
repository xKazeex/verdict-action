'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { runVerdict } = require('./verdict');

async function main(core, github) {
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

  if (result.outcome === 'BLOCKED_SECRETS_DETECTED' || result.outcome === 'SECRET_SCAN_FAILED') {
    core.setFailed(result.message);
    await postComment(github, githubToken, pr, `## Verdict — status: \`${result.outcome}\`\n\n${result.message}`);
    return;
  }

  const sarifPath = path.join(repoRoot, 'verdict-results.sarif');
  fs.writeFileSync(sarifPath, JSON.stringify(result.sarif, null, 2));
  core.setOutput('sarif-path', sarifPath);

  await postComment(github, githubToken, pr, result.markdown);

  const hasOverride = Array.isArray(pr.labels) && pr.labels.some((l) => l.name === overrideLabel);
  if (result.status !== 'PASS' && !hasOverride) {
    core.setFailed(
      `Verdict status ${result.status}: human review required. Apply the "${overrideLabel}" label after reviewing to allow merge.`
    );
  } else if (result.status !== 'PASS' && hasOverride) {
    core.warning(`Verdict status ${result.status}, but "${overrideLabel}" label present -- not failing the check. This override was a human decision, not Verdict's.`);
  }
}

async function postComment(github, token, pr, body) {
  const octokit = github.getOctokit(token);
  const { owner, repo } = github.context.repo;
  await octokit.rest.issues.createComment({ owner, repo, issue_number: pr.number, body });
}

async function run() {
  // Dynamic import(), not require(): @actions/core and @actions/github ship ESM-only (no
  // "require" condition in their package.json "exports" map as of @actions/core@3.0.1 /
  // @actions/github@9.1.1), discovered when the first real bundling/live-run attempt
  // failed on this. import() uses ESM resolution and works fine from an async function --
  // no need to convert the rest of this (well-tested) CommonJS codebase to ESM for it.
  const core = await import('@actions/core');
  const github = await import('@actions/github');
  try {
    await main(core, github);
  } catch (err) {
    core.setFailed(err instanceof Error ? err.message : String(err));
  }
}

run();
