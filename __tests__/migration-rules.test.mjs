import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  analyzeSpecContent,
  inspectKarmaConfigContent,
  loadMigrationRules,
} from '../plugins/angular-frontend/skills/karma-vitest-audit/scripts/lib/migration-engine.mjs';

const THIS_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(THIS_DIR, '..');
const RULES_PATH = path.join(
  REPO_ROOT,
  'plugins',
  'angular-frontend',
  'skills',
  'karma-vitest-audit',
  'references',
  'migration-rules.json'
);
const RULES_SCHEMA_PATH = path.join(
  REPO_ROOT,
  'plugins',
  'angular-frontend',
  'skills',
  'karma-vitest-audit',
  'references',
  'migration-rules.schema.json'
);

const VALID_CATEGORIES = new Set([
  'ast_transformation',
  'type_transformation',
  'semantic_transformation',
  'configuration_migration',
]);
const VALID_TREATMENTS = new Set(['automatically_migrated', 'requires_review', 'manual_migration']);
const TREATMENT_RANK = {
  automatically_migrated: 0,
  requires_review: 1,
  manual_migration: 2,
};

test('migration-rules: catalog schema and every rule unit is syntactically valid and self-verifying (positive input, clean output)', () => {
  assert.ok(fs.existsSync(RULES_PATH), 'migration-rules.json must exist');
  assert.ok(fs.existsSync(RULES_SCHEMA_PATH), 'migration-rules.schema.json must exist');

  const schema = JSON.parse(fs.readFileSync(RULES_SCHEMA_PATH, 'utf8'));
  assert.equal(schema.type, 'object');

  const catalog = loadMigrationRules(RULES_PATH);
  assert.equal(catalog.schemaVersion, '1.0.0');
  assert.ok(catalog.rules.length >= 20, 'Expected comprehensive rule catalog');

  const seenIds = new Set();
  for (const rule of catalog.rules) {
    assert.match(rule.id, /^RULE-[A-Z]+-[0-9]{3}$/, `Invalid rule ID: ${rule.id}`);
    assert.equal(seenIds.has(rule.id), false, `Duplicate rule ID: ${rule.id}`);
    seenIds.add(rule.id);

    assert.ok(VALID_CATEGORIES.has(rule.category), `Invalid category on ${rule.id}: ${rule.category}`);
    assert.ok(VALID_TREATMENTS.has(rule.treatment), `Invalid treatment on ${rule.id}: ${rule.treatment}`);
    assert.ok(
      typeof rule.safetyCriteria === 'string' && rule.safetyCriteria.trim().length >= 10,
      `${rule.id} must declare explicit safetyCriteria`
    );
    assert.ok(rule.examples && typeof rule.examples.input === 'string' && rule.examples.input.length > 0);
    assert.ok(
      rule.examples && typeof rule.examples.expectedOutput === 'string' && rule.examples.expectedOutput.length > 0
    );

    // Positive match on legacy Jasmine/Karma input example
    assert.equal(
      rule.testRegex.test(rule.examples.input),
      true,
      `${rule.id} (${rule.name}) regex MUST match its own Jasmine/Karma example input`
    );

    // Clean check on migrated Vitest expected output (no false positive after migration)
    assert.equal(
      rule.testRegex.test(rule.examples.expectedOutput),
      false,
      `${rule.id} (${rule.name}) regex MUST NOT false-positive on its migrated expectedOutput`
    );

    if (rule.scope === 'spec') {
      const inputEval = analyzeSpecContent(rule.examples.input, catalog);
      assert.ok(
        inputEval.matchedRuleIds.includes(rule.id),
        `migration-engine must report ${rule.id} when analyzing its input example`
      );
      assert.ok(
        TREATMENT_RANK[inputEval.expectedOutcome] >= TREATMENT_RANK[rule.treatment],
        `${rule.id} expectedOutcome (${inputEval.expectedOutcome}) must be at least ${rule.treatment}`
      );

      const outputEval = analyzeSpecContent(rule.examples.expectedOutput, catalog);
      assert.equal(
        outputEval.matchedRuleIds.includes(rule.id),
        false,
        `migration-engine must NOT match ${rule.id} on migrated expectedOutput`
      );
    }
  }
});

test('migration-engine: enforces exact treatments for unsupported and high-risk patterns', () => {
  const catalog = loadMigrationRules(RULES_PATH);

  // 1. jasmine.addMatchers() -> manual_migration
  const addMatchers = analyzeSpecContent("jasmine.addMatchers({ toBeEven: () => ({}) });", catalog);
  assert.equal(addMatchers.expectedOutcome, 'manual_migration');
  assert.equal(addMatchers.complexity, 'high');

  // 2. jasmine.clock() with complex logic -> requires_review
  const clock = analyzeSpecContent(
    'jasmine.clock().install(); jasmine.clock().tick(500); jasmine.clock().uninstall();',
    catalog
  );
  assert.equal(clock.expectedOutcome, 'requires_review');
  assert.equal(clock.complexity, 'high');
  assert.equal(clock.fakeAsyncTickCount, 3);

  // 3. Custom Jasmine matchers -> manual_migration
  const customMatchers = analyzeSpecContent(
    'declare namespace jasmine { interface Matchers<T> { toMatchCustom(): boolean; } }',
    catalog
  );
  assert.equal(customMatchers.expectedOutcome, 'manual_migration');
  assert.ok(customMatchers.jasminePatterns.includes('custom-jasmine-matchers'));

  // 4. Custom Karma plugins -> detected as custom & rule treatment is manual_migration
  const karmaRes = inspectKarmaConfigContent("plugins: [require('karma-junit-reporter')]", catalog);
  assert.equal(karmaRes.isCustom, true);
  assert.ok(karmaRes.customFeatures.includes('non-default-karma-plugins'));
  const karmaRule = catalog.rules.find((r) => r.id === 'RULE-CFG-001');
  assert.equal(karmaRule.treatment, 'manual_migration');

  // 5. fakeAsync() + tick() -> requires_review
  const fakeAsyncRes = analyzeSpecContent('it("t", fakeAsync(() => { tick(100); }));', catalog);
  assert.equal(fakeAsyncRes.expectedOutcome, 'requires_review');
  assert.equal(fakeAsyncRes.complexity, 'medium');

  // 6. jasmine.SpyObj<T> with methods and properties -> requires_review
  const spyObjProps = analyzeSpecContent(
    "const svc: jasmine.SpyObj<Store> = jasmine.createSpyObj('Store', ['load'], { state$: of(1) });",
    catalog
  );
  assert.equal(spyObjProps.expectedOutcome, 'requires_review');
  assert.ok(spyObjProps.jasminePatterns.includes('jasmine.SpyObj<T>'));
  assert.ok(spyObjProps.jasminePatterns.includes('jasmine.createSpyObj-with-properties'));

  // 7. spy.calls.reset() must map ONLY to mockClear(), never mockReset()
  const resetRule = catalog.rules.find((r) => r.name === 'spy.calls.reset');
  assert.ok(resetRule);
  assert.equal(resetRule.treatment, 'requires_review');
  assert.match(resetRule.examples.expectedOutput, /\.mockClear\(\)/);
  assert.doesNotMatch(resetRule.examples.expectedOutput, /\.mockReset\(\)/);
});
