import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const THIS_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(THIS_DIR, '..');
const MARKETPLACE_PATH = path.join(REPO_ROOT, '.github', 'plugin', 'marketplace.json');
const LEGACY_MARKETPLACE_PATH = path.join(REPO_ROOT, 'marketplace.json');
const PLUGIN_ROOT = path.join(REPO_ROOT, 'plugins', 'angular-frontend');
const PLUGIN_MANIFEST_PATH = path.join(PLUGIN_ROOT, 'plugin.json');
const AGENTS_DIR = path.join(PLUGIN_ROOT, 'com.github.copilot', 'agents');
const LEGACY_AGENTS_DIR = path.join(PLUGIN_ROOT, 'agents');

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function parseFrontmatter(mdContent) {
  const match = mdContent.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/);
  assert.ok(match, 'Agent file must contain valid YAML frontmatter delimited by ---');
  return { rawFrontmatter: match[1], body: match[2] };
}

function getScalarField(frontmatter, key) {
  const regex = new RegExp(`^${key}:\\s*(.+)$`, 'm');
  const match = frontmatter.match(regex);
  return match ? match[1].trim().replace(/^['"]|['"]$/g, '') : null;
}

test('Marketplace: validates full official .github/plugin/marketplace.json contract and version sync', () => {
  assert.ok(fs.existsSync(MARKETPLACE_PATH), '.github/plugin/marketplace.json must exist');
  assert.equal(
    fs.existsSync(LEGACY_MARKETPLACE_PATH),
    false,
    'Legacy root marketplace.json must be removed after migration'
  );

  const marketplace = readJson(MARKETPLACE_PATH);

  // Validate required marketplace top-level metadata
  assert.match(marketplace.name, /^[a-z0-9]+(?:-[a-z0-9]+)*$/, 'Marketplace name must be kebab-case');
  assert.equal(marketplace.name, 'gacc-copilot-plugins');
  assert.equal(typeof marketplace.owner, 'object');
  assert.ok(marketplace.owner && typeof marketplace.owner.name === 'string' && marketplace.owner.name.length > 0);
  assert.ok(typeof marketplace.owner.email === 'string' && marketplace.owner.email.includes('@'));
  assert.ok(marketplace.metadata && typeof marketplace.metadata.version === 'string');
  assert.ok(Array.isArray(marketplace.plugins) && marketplace.plugins.length >= 1);

  // Validate every plugin entry resolves and stays version-synchronized with its plugin.json
  for (const entry of marketplace.plugins) {
    assert.ok(typeof entry.name === 'string' && entry.name.length > 0);
    assert.ok(typeof entry.version === 'string' && /^\d+\.\d+\.\d+$/.test(entry.version));
    assert.ok(typeof entry.description === 'string' && entry.description.length > 0);
    assert.ok(typeof entry.source === 'string' && entry.source.length > 0);

    const resolvedPluginDir = path.resolve(REPO_ROOT, entry.source);
    const resolvedManifestPath = path.join(resolvedPluginDir, 'plugin.json');
    assert.ok(fs.existsSync(resolvedManifestPath), `source "${entry.source}" must contain plugin.json`);

    const manifest = readJson(resolvedManifestPath);
    assert.equal(entry.name, manifest.name, `Plugin name mismatch for ${entry.source}`);
    assert.equal(entry.version, manifest.version, `Plugin version mismatch between marketplace.json and ${entry.source}/plugin.json`);
  }
});

test('Agent Plugins 1.0: plugin.json declares official schema without legacy component fields or IDE-only wording', () => {
  const manifest = readJson(PLUGIN_MANIFEST_PATH);

  assert.equal(manifest.$schema, 'https://agent-plugins.org/schemas/1.0.0/plugin.schema.json');
  assert.equal(manifest.name, 'angular-frontend');
  assert.equal(manifest.version, '2.0.0');
  assert.equal(manifest.agents, undefined, 'Agent Plugins 1.0 must not declare legacy top-level "agents"');
  assert.equal(manifest.skills, undefined, 'Agent Plugins 1.0 must not declare legacy top-level "skills"');
  assert.match(manifest.description, /Copilot CLI/i, 'Description should reflect both VS Code and Copilot CLI scope');

  assert.equal(fs.existsSync(LEGACY_AGENTS_DIR), false, 'Legacy plugins/angular-frontend/agents/ must not exist');
  assert.ok(fs.existsSync(AGENTS_DIR), 'com.github.copilot/agents/ must exist');
  assert.ok(fs.existsSync(path.join(PLUGIN_ROOT, 'skills')), 'skills/ must remain at plugin root');
});

test('Schemas: all skill JSON schemas parse cleanly', () => {
  const schemasDir = path.join(PLUGIN_ROOT, 'skills', 'karma-vitest-audit', 'references');
  const schemaFiles = fs.readdirSync(schemasDir).filter((f) => f.endsWith('.schema.json'));
  assert.ok(schemaFiles.length >= 2, 'Expected diagnosis and migration plan schemas');

  for (const file of schemaFiles) {
    const parsed = readJson(path.join(schemasDir, file));
    assert.equal(typeof parsed, 'object');
    assert.ok(parsed.$schema || parsed.type, `${file} must be a valid JSON Schema`);
  }
});

test('Copilot Agents: frontmatter, visibility, subagent names, and agent-scoped preToolUse hook', () => {
  const agentFiles = fs
    .readdirSync(AGENTS_DIR)
    .filter((f) => f.endsWith('.agent.md'))
    .sort();

  assert.deepEqual(agentFiles, [
    'karma-vitest-analyst.agent.md',
    'karma-vitest-migrator.agent.md',
    'karma-vitest-orchestrator.agent.md',
    'karma-vitest-planner.agent.md',
  ]);

  const parsedAgents = new Map();
  let userInvocableCount = 0;

  for (const file of agentFiles) {
    const content = fs.readFileSync(path.join(AGENTS_DIR, file), 'utf8');
    const { rawFrontmatter, body } = parseFrontmatter(content);
    const name = getScalarField(rawFrontmatter, 'name');
    const userInvocable = getScalarField(rawFrontmatter, 'user-invocable');
    const toolsLine = getScalarField(rawFrontmatter, 'tools') || '';
    const hasHooks = /^hooks:/m.test(rawFrontmatter);
    const hasLocalAgentsWhitelist = /^agents:/m.test(rawFrontmatter);

    assert.ok(name, `${file} must declare a name`);
    assert.equal(
      hasLocalAgentsWhitelist,
      false,
      `${file} must not declare Local-harness-only "agents:" frontmatter`
    );

    if (userInvocable === 'true') {
      userInvocableCount++;
    } else {
      assert.equal(userInvocable, 'false', `${file} subagent must explicitly set user-invocable: false`);
    }

    parsedAgents.set(file, { name, userInvocable, toolsLine, hasHooks, rawFrontmatter, body });
  }

  assert.equal(userInvocableCount, 1, 'Exactly one agent must be user-invocable: true');

  const orchestrator = parsedAgents.get('karma-vitest-orchestrator.agent.md');
  assert.equal(orchestrator.name, 'Angular Karma-to-Vitest');
  assert.equal(orchestrator.userInvocable, 'true');
  assert.equal(orchestrator.hasHooks, false, 'Orchestrator must not carry migration hooks');
  assert.equal(orchestrator.toolsLine.includes("'edit'"), false, 'Orchestrator must not have edit tool');
  assert.equal(orchestrator.toolsLine.includes("'execute'"), false, 'Orchestrator must not have execute tool');

  const subagentNames = new Set(
    [...parsedAgents.entries()]
      .filter(([file]) => file !== 'karma-vitest-orchestrator.agent.md')
      .map(([, info]) => info.name)
  );

  for (const subName of ['Karma-Vitest Analyst', 'Karma-Vitest Planner', 'Karma-Vitest Migrator']) {
    assert.ok(subagentNames.has(subName), `Subagent "${subName}" must exist in com.github.copilot/agents/`);
    assert.ok(
      orchestrator.body.includes(subName),
      `Orchestrator body must reference subagent "${subName}"`
    );
  }

  for (const [file, info] of parsedAgents.entries()) {
    if (file === 'karma-vitest-migrator.agent.md') {
      assert.equal(info.hasHooks, true, 'Migrator must define agent-scoped hooks');
      assert.match(info.rawFrontmatter, /^\s+preToolUse:/m, 'Migrator must use Copilot harness preToolUse event');
      assert.equal(info.toolsLine.includes("'agent'"), false, 'Migrator must not declare delegation tools');
      const cmdMatch = info.rawFrontmatter.match(/command:\s*(.+)$/m);
      assert.ok(cmdMatch, 'Migrator hook must specify a command');
      const expandedCmd = cmdMatch[1].trim().replace(/\$\{PLUGIN_ROOT\}/g, PLUGIN_ROOT);
      const scriptMatch = expandedCmd.match(/"([^"]+\.mjs)"/);
      assert.ok(scriptMatch, 'Migrator hook command must reference a .mjs script');
      assert.ok(fs.existsSync(scriptMatch[1]), `Migrator hook script must exist at ${scriptMatch[1]}`);
    } else {
      assert.equal(info.hasHooks, false, `${file} must NOT define migration hooks`);
    }
  }
});
