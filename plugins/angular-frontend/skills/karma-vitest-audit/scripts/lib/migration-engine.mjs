/**
 * migration-engine.mjs — Declarative rule evaluation, complexity scoring, and risk classification engine.
 *
 * Consumes `references/migration-rules.json` (`migration-rules` layer) as the single source of truth
 * so pattern detection, complexity classification, and migration outcomes stay decoupled from
 * reporting (`migration-reporter`) and gate enforcement (`migration-validator`).
 *
 * Zero external dependencies — pure Node.js ESM.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const THIS_DIR = path.dirname(fileURLToPath(import.meta.url));
export const DEFAULT_RULES_PATH = path.resolve(THIS_DIR, '..', '..', 'references', 'migration-rules.json');

const COMPLEXITY_RANK = { low: 0, medium: 1, high: 2 };
const TREATMENT_RANK = {
  automatically_migrated: 0,
  requires_review: 1,
  manual_migration: 2,
};

const CUSTOM_KARMA_STRUCTURAL_PATTERNS = [
  { name: 'proxies', regex: /\bproxies\s*:/ },
  { name: 'customLaunchers', regex: /\bcustomLaunchers\s*:/ },
  { name: 'preprocessors', regex: /\bpreprocessors\s*:/ },
  { name: 'files', regex: /\bfiles\s*:\s*\[/ },
  { name: 'webpack', regex: /\bwebpack\s*:/ },
];

export function loadMigrationRules(rulesPath = DEFAULT_RULES_PATH) {
  const raw = JSON.parse(fs.readFileSync(rulesPath, 'utf8'));
  if (!raw || !Array.isArray(raw.rules)) {
    throw new Error(`Invalid migration-rules catalog at ${rulesPath}`);
  }
  const compiled = raw.rules.map((rule) => ({
    ...rule,
    globalRegex: new RegExp(rule.detectionPattern, 'g'),
    testRegex: new RegExp(rule.detectionPattern),
  }));
  return {
    schemaVersion: raw.schemaVersion,
    sourceFramework: raw.sourceFramework,
    targetFramework: raw.targetFramework,
    rules: compiled,
  };
}

function countMatches(content, globalRegex) {
  globalRegex.lastIndex = 0;
  const m = content.match(globalRegex);
  return m ? m.length : 0;
}

export function analyzeSpecContent(content, catalog = loadMigrationRules()) {
  const specRules = catalog.rules.filter((r) => r.scope === 'spec');
  const detectedPatterns = new Set();
  const matchedRuleIds = [];
  const fileComplexPatterns = [];

  let fileJasmineCount = 0;
  let fileAsyncTimerCount = 0;
  let maxComplexity = 'low';
  let worstTreatment = 'automatically_migrated';

  for (const rule of specRules) {
    if (rule.signalBucket === 'jasmine_api') {
      const c = countMatches(content, rule.globalRegex);
      if (c > 0) {
        fileJasmineCount += c;
        detectedPatterns.add(rule.name);
        matchedRuleIds.push(rule.id);
        if (COMPLEXITY_RANK[rule.minimumComplexity || 'low'] > COMPLEXITY_RANK[maxComplexity]) {
          maxComplexity = rule.minimumComplexity;
        }
        if (TREATMENT_RANK[rule.treatment] > TREATMENT_RANK[worstTreatment]) {
          worstTreatment = rule.treatment;
        }
      }
      continue;
    }

    if (rule.signalBucket === 'async_timer') {
      const c = countMatches(content, rule.globalRegex);
      if (c > 0) {
        fileAsyncTimerCount += c;
        detectedPatterns.add(rule.name);
        matchedRuleIds.push(rule.id);
        if (COMPLEXITY_RANK[rule.minimumComplexity || 'medium'] > COMPLEXITY_RANK[maxComplexity]) {
          maxComplexity = rule.minimumComplexity || 'medium';
        }
        if (TREATMENT_RANK[rule.treatment] > TREATMENT_RANK[worstTreatment]) {
          worstTreatment = rule.treatment;
        }
      }
      continue;
    }

    if (rule.signalBucket === 'complex_spec') {
      const c = countMatches(content, rule.globalRegex);
      if (c > 0) {
        if (rule.name === 'jasmine.clock') {
          fileAsyncTimerCount += c;
        }
        fileComplexPatterns.push(rule.name);
        detectedPatterns.add(rule.name);
        matchedRuleIds.push(rule.id);
        if (COMPLEXITY_RANK[rule.minimumComplexity || 'high'] > COMPLEXITY_RANK[maxComplexity]) {
          maxComplexity = rule.minimumComplexity || 'high';
        }
        if (TREATMENT_RANK[rule.treatment] > TREATMENT_RANK[worstTreatment]) {
          worstTreatment = rule.treatment;
        }
      }
    }
  }

  // Volume thresholds align with existing deterministic diagnosis contract
  if (fileComplexPatterns.length > 0 || fileJasmineCount >= 12) {
    maxComplexity = 'high';
  } else if (
    COMPLEXITY_RANK[maxComplexity] < COMPLEXITY_RANK.medium &&
    (fileAsyncTimerCount > 0 || fileJasmineCount >= 4)
  ) {
    maxComplexity = 'medium';
  }

  if (maxComplexity !== 'low' && TREATMENT_RANK[worstTreatment] < TREATMENT_RANK.requires_review) {
    worstTreatment = 'requires_review';
  }

  const rawScore =
    1 +
    Math.min(4, Math.ceil(fileJasmineCount / 3)) +
    (fileAsyncTimerCount >= 3 ? 2 : fileAsyncTimerCount > 0 ? 1 : 0) +
    Math.min(3, fileComplexPatterns.length * 2);

  let complexityScore;
  if (maxComplexity === 'high') {
    complexityScore = Math.max(7, Math.min(10, rawScore + 2));
  } else if (maxComplexity === 'medium') {
    complexityScore = Math.max(4, Math.min(6, rawScore));
  } else {
    complexityScore = Math.max(1, Math.min(3, rawScore));
  }

  return {
    jasminePatterns: [...detectedPatterns],
    matchedRuleIds,
    jasmineApiCount: fileJasmineCount,
    fakeAsyncTickCount: fileAsyncTimerCount,
    complexPatterns: fileComplexPatterns,
    complexity: maxComplexity,
    complexityScore,
    expectedOutcome: worstTreatment,
  };
}

export function inspectAllSpecs(specFiles, catalog = loadMigrationRules()) {
  let totalJasmineApiUsages = 0;
  let totalFakeAsyncTickUsages = 0;
  const complexSpecFiles = [];
  const complexPatternsSet = new Set();
  const specInventory = [];
  const counts = { low: 0, medium: 0, high: 0 };

  for (const spec of specFiles) {
    let content = '';
    try {
      content = fs.readFileSync(spec.absolutePath, 'utf8');
    } catch {
      continue;
    }

    const analysis = analyzeSpecContent(content, catalog);
    totalJasmineApiUsages += analysis.jasmineApiCount;
    totalFakeAsyncTickUsages += analysis.fakeAsyncTickCount;
    counts[analysis.complexity] += 1;

    if (analysis.complexPatterns.length > 0) {
      for (const p of analysis.complexPatterns) {
        complexPatternsSet.add(p);
      }
      complexSpecFiles.push({
        file: spec.relativePath,
        patterns: analysis.complexPatterns,
      });
    }

    specInventory.push({
      file: spec.relativePath,
      jasminePatterns: analysis.jasminePatterns,
      jasmineApiCount: analysis.jasmineApiCount,
      fakeAsyncTickCount: analysis.fakeAsyncTickCount,
      complexity: analysis.complexity,
      complexityScore: analysis.complexityScore,
      expectedOutcome: analysis.expectedOutcome,
    });
  }

  const sortRank = { high: 0, medium: 1, low: 2 };
  specInventory.sort(
    (a, b) =>
      sortRank[a.complexity] - sortRank[b.complexity] ||
      b.complexityScore - a.complexityScore ||
      a.file.localeCompare(b.file)
  );

  const total = specInventory.length;
  const pct = (n) => (total === 0 ? 0 : Math.round((n / total) * 100));
  const lowPct = pct(counts.low);
  const highPct = pct(counts.high);
  const mediumPct = total === 0 ? 0 : Math.max(0, 100 - lowPct - highPct);

  return {
    specInventory,
    totalJasmineApiUsages,
    totalFakeAsyncTickUsages,
    complexSpecPatterns: [...complexPatternsSet],
    complexSpecFiles,
    complexityBreakdown: {
      low: { count: counts.low, percentage: lowPct },
      medium: { count: counts.medium, percentage: mediumPct },
      high: { count: counts.high, percentage: highPct },
    },
  };
}

export function inspectKarmaConfigContent(content, catalog = loadMigrationRules()) {
  const features = [];
  for (const p of CUSTOM_KARMA_STRUCTURAL_PATTERNS) {
    if (p.regex.test(content)) {
      features.push(p.name);
    }
  }
  const karmaRules = catalog.rules.filter((r) => r.scope === 'karma-config');
  for (const rule of karmaRules) {
    if (rule.testRegex.test(content)) {
      features.push(rule.name === 'custom-karma-plugins' ? 'non-default-karma-plugins' : rule.name);
    }
  }
  return {
    isCustom: features.length > 0,
    customFeatures: features,
  };
}
