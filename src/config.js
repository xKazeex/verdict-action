'use strict';

const fs = require('node:fs');
const path = require('node:path');
const yaml = require('js-yaml');
const { minimatch } = require('minimatch');

// Matches action.yml's config-path default -- kept in sync manually since action.yml
// (consumed by the Actions runtime) and this file (consumed by Node) can't share a constant.
const DEFAULT_CONFIG_PATH = '.verdict.yml';

/**
 * Loads and validates .verdict.yml. Verdict never guesses which paths are critical --
 * a missing or empty config is a hard error, not "review everything" or "review nothing."
 */
function loadConfig(repoRoot, configPath = DEFAULT_CONFIG_PATH) {
  const fullPath = path.join(repoRoot, configPath);
  if (!fs.existsSync(fullPath)) {
    throw new Error(
      `Verdict config not found at ${configPath}. Verdict requires an explicit .verdict.yml declaring critical_paths and/or risk_triggers -- it never guesses.`
    );
  }
  const raw = fs.readFileSync(fullPath, 'utf8');
  let parsed;
  try {
    parsed = yaml.load(raw);
  } catch (err) {
    throw new Error(`Failed to parse ${configPath}: ${err.message}`);
  }
  return validateConfig(parsed);
}

function validateConfig(parsed) {
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('.verdict.yml must be a YAML mapping (an object at the top level)');
  }
  const criticalPaths = Array.isArray(parsed.critical_paths) ? parsed.critical_paths : [];
  const riskTriggers = Array.isArray(parsed.risk_triggers) ? parsed.risk_triggers : [];

  if (criticalPaths.length === 0 && riskTriggers.length === 0) {
    throw new Error('.verdict.yml must declare at least one entry in critical_paths or risk_triggers');
  }

  criticalPaths.forEach((p, i) => {
    if (typeof p !== 'string' || p.length === 0) {
      throw new Error(`critical_paths[${i}] must be a non-empty glob string, got: ${JSON.stringify(p)}`);
    }
  });

  riskTriggers.forEach((t, i) => {
    if (!t || typeof t !== 'object' || typeof t.pattern !== 'string' || t.pattern.length === 0) {
      throw new Error(`risk_triggers[${i}] must be an object with a non-empty string "pattern", got: ${JSON.stringify(t)}`);
    }
    try {
      // eslint-disable-next-line no-new
      new RegExp(t.pattern);
    } catch (err) {
      throw new Error(`risk_triggers[${i}].pattern is not a valid regex ("${t.pattern}"): ${err.message}`);
    }
  });

  return Object.freeze({ criticalPaths, riskTriggers });
}

function pathMatchesCritical(filePath, criticalPaths) {
  return criticalPaths.some((glob) => minimatch(filePath, glob, { dot: true }));
}

function findRiskTriggerMatch(addedLines, riskTriggers) {
  for (const trigger of riskTriggers) {
    const re = new RegExp(trigger.pattern);
    for (let i = 0; i < addedLines.length; i += 1) {
      if (re.test(addedLines[i])) {
        return { trigger, lineIndex: i, line: addedLines[i] };
      }
    }
  }
  return null;
}

/**
 * Decides whether Verdict should run at all for this diff. Two independent gates, either
 * one is sufficient: a changed file matches a critical_paths glob, or an added line
 * matches a risk_triggers pattern (e.g. a dependency add, a dangerous function call,
 * regardless of which file it's in).
 */
function shouldReview(config, { changedFiles, addedLines }) {
  const matchedPath = changedFiles.find((f) => pathMatchesCritical(f, config.criticalPaths));
  if (matchedPath) {
    return { run: true, reason: 'critical_path', detail: matchedPath };
  }
  const triggerMatch = findRiskTriggerMatch(addedLines, config.riskTriggers);
  if (triggerMatch) {
    return { run: true, reason: 'risk_trigger', detail: triggerMatch.trigger.pattern, matchedLine: triggerMatch.line };
  }
  return { run: false, reason: 'no_critical_path_or_risk_trigger_matched' };
}

module.exports = {
  DEFAULT_CONFIG_PATH,
  loadConfig,
  validateConfig,
  pathMatchesCritical,
  findRiskTriggerMatch,
  shouldReview
};
