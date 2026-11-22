import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const THIS_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(THIS_DIR, '..');
const PLUGIN_ROOT = path.join(REPO_ROOT, 'plugins', 'angular-frontend');

const GATE_SCRIPT = path.join(
  PLUGIN_ROOT,
  'skills',
  'karma-vitest-migrate',
  'scripts',
  'verify-artifacts-gate.mjs'
);
const PREREQS_SCRIPT = path.join(
  PLUGIN_ROOT,
  'skills',
  'angular-migration-prereqs',
  'scripts',
  'check-prereqs.mjs'
);
const DIAGNOSIS_SCRIPT = path.join(
  PLUGIN_ROOT,
  'skills',
  'karma-vitest-audit',
  'scripts',
  'generate-diagnosis-report.mjs'
);

const ARTIFACTS_REL = path.join('.migration-artifacts', 'karma-to-vitest');

function createTempWorkspace() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gacc-gate-test-'));
  fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'projects', 'sub-app'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'package.json'), '{"name":"demo"}\n');
  fs.writeFileSync(path.join(dir, 'src', 'app.component.ts'), 'export class App {}\n');
  return dir;
}

function writeArtifacts(projectDir, { diag, plan } = {}) {
  const artDir = path.join(projectDir, ARTIFACTS_REL);
  fs.mkdirSync(artDir, { recursive: true });
  if (diag) {
    fs.writeFileSync(path.join(artDir, '01-diagnosis-report.json'), JSON.stringify(diag, null, 2));
    fs.writeFileSync(path.join(artDir, '01-diagnosis-report.md'), '# Diagnosis\n');
  }
  if (plan) {
    fs.writeFileSync(path.join(artDir, '02-migration-plan.json'), JSON.stringify(plan, null, 2));
    fs.writeFileSync(path.join(artDir, '02-migration-plan.md'), '# Plan\n');
  }
}

function approveWorkflow(projectDir) {
  writeArtifacts(projectDir, {
    diag: { status: 'READY', approval: { status: 'APPROVED' } },
    plan: { approval: { status: 'APPROVED' }, tasks: [{ id: 'T1' }] },
  });
}

function runCliGate(projectDir, phase) {
  return spawnSync(process.execPath, [GATE_SCRIPT, '--project', projectDir, '--phase', phase], {
    encoding: 'utf8',
  });
}

function runHookGate(payload, defaultProjectDir) {
  const stdin = typeof payload === 'string' ? payload : JSON.stringify(payload);
  const res = spawnSync(
    process.execPath,
    [GATE_SCRIPT, '--hook', '--project', defaultProjectDir],
    {
      input: stdin,
      encoding: 'utf8',
    }
  );
  assert.equal(res.status, 0, `Hook must exit 0, got ${res.status}. stderr: ${res.stderr}`);
  return JSON.parse(res.stdout.trim());
}

function assertDenied(output, msg) {
  assert.equal(output.permissionDecision, 'deny', `${msg} — got: ${JSON.stringify(output)}`);
  assert.equal(typeof output.permissionDecisionReason, 'string');
  assert.ok(output.permissionDecisionReason.length > 0);
  // Copilot harness expects flat JSON (never Local harness hookSpecificOutput wrapper)
  assert.equal(output.hookSpecificOutput, undefined);
}

// Note: {} is NO_DECISION (lets the Copilot harness continue its normal permission flow), NOT explicit allow.
function assertNoDecision(output, msg) {
  assert.deepEqual(output, {}, `${msg} — got: ${JSON.stringify(output)}`);
}

// =============================================================================
// 1. CLI Gate Mode (--phase plan / --phase migrate)
// =============================================================================
test('CLI Gate: enforces diagnosis and plan approval lifecycle', () => {
  const dir = createTempWorkspace();
  try {
    assert.equal(runCliGate(dir, 'plan').status, 1);
    assert.equal(runCliGate(dir, 'migrate').status, 1);

    writeArtifacts(dir, {
      diag: {
        status: 'BLOCKED',
        blockers: [{ message: 'Angular 19 detected' }],
        approval: { status: 'APPROVED' },
      },
    });
    assert.equal(runCliGate(dir, 'plan').status, 1);
    assert.equal(runCliGate(dir, 'migrate').status, 1);

    writeArtifacts(dir, {
      diag: { status: 'READY', approval: { status: 'PENDING' } },
    });
    assert.equal(runCliGate(dir, 'plan').status, 1);
    assert.equal(runCliGate(dir, 'migrate').status, 1);

    writeArtifacts(dir, {
      diag: { status: 'READY', approval: { status: 'APPROVED' } },
    });
    assert.equal(runCliGate(dir, 'plan').status, 0);
    assert.equal(runCliGate(dir, 'migrate').status, 1);

    writeArtifacts(dir, {
      plan: { approval: { status: 'APPROVED' }, tasks: [] },
    });
    assert.equal(runCliGate(dir, 'migrate').status, 1);

    writeArtifacts(dir, {
      plan: { approval: { status: 'PENDING' }, tasks: [{ id: 'T1' }] },
    });
    assert.equal(runCliGate(dir, 'migrate').status, 1);

    writeArtifacts(dir, {
      plan: { approval: { status: 'APPROVED' }, tasks: [{ id: 'T1' }] },
    });
    assert.equal(runCliGate(dir, 'migrate').status, 0);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// =============================================================================
// 2. Three-State Decision Model: NO_DECISION, REQUIRE_GATE, and Unconditional DENY
// =============================================================================
test('Hook (NO_DECISION): emits {} ONLY for documented Copilot runtime read-only tools', () => {
  const dir = createTempWorkspace();
  try {
    for (const toolName of ['view', 'glob', 'grep', 'ask_user', 'web_fetch', 'update_todo']) {
      const out = runHookGate(
        { sessionId: 'sess-1', timestamp: Date.now(), cwd: dir, toolName, toolArgs: {} },
        dir
      );
      assertNoDecision(out, `Documented runtime read-only tool "${toolName}" should return NO_DECISION ({})`);
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('Hook (Unconditional DENY): blocks invalid input, unknown tools, aliases, and task delegation EVEN when workflow is APPROVED', () => {
  const dir = createTempWorkspace();
  try {
    // CRITICAL: approve the workflow FIRST to prove these are unconditional DENYs (not REQUIRE_GATE)
    approveWorkflow(dir);

    // 1. Invalid stdin / corrupt JSON / missing camelCase toolName / snake_case partial payload
    assertDenied(runHookGate('', dir), 'Empty stdin must unconditionally DENY even with approved workflow');
    assertDenied(runHookGate('{corrupt-json', dir), 'Corrupt JSON must unconditionally DENY even with approved workflow');
    assertDenied(
      runHookGate({ cwd: dir, toolArgs: { path: 'src/app.component.ts' } }, dir),
      'Missing toolName must unconditionally DENY'
    );
    assertDenied(
      runHookGate({ cwd: dir, tool_name: 'edit', tool_input: { path: 'src/app.component.ts' } }, dir),
      'snake_case Local payload without camelCase toolName must DENY under strict preToolUse contract'
    );

    // 2. Unknown runtime tools and frontmatter configuration aliases must NEVER pass even when approved
    for (const disallowedTool of [
      'custom_mutator',
      'read',
      'search',
      'todo',
      'agent',
      'agent/runSubagent',
      'report_intent',
      'vscode/askQuestions',
    ]) {
      assertDenied(
        runHookGate(
          { cwd: dir, toolName: disallowedTool, toolArgs: { path: 'src/app.component.ts' } },
          dir
        ),
        `Unknown/alias tool "${disallowedTool}" must unconditionally DENY even when workflow is APPROVED`
      );
    }

    // 3. Delegation via `task` inside Migrator (trying to spawn a subagent to edit src/app.component.ts)
    assertDenied(
      runHookGate(
        {
          sessionId: 'sess-1',
          cwd: dir,
          toolName: 'task',
          toolArgs: { prompt: 'Edit src/app.component.ts to migrate specs' },
        },
        dir
      ),
      'Delegation via "task" inside Migrator must be unconditionally DENIED'
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('Hook (REQUIRE_GATE): denies workspace edits/commands before approval and returns NO_DECISION after approval', () => {
  const dir = createTempWorkspace();
  try {
    const editEvent = {
      sessionId: 'sess-1',
      cwd: dir,
      toolName: 'edit',
      toolArgs: { path: 'src/app.component.ts', new_str: 'export class Updated {}' },
    };
    const bashEvent = {
      sessionId: 'sess-1',
      cwd: dir,
      toolName: 'bash',
      // Defensive test: stringified JSON toolArgs (schema types toolArgs as unknown)
      toolArgs: JSON.stringify({ command: 'npx ng test --watch=false' }),
    };

    // Before approval -> DENY
    assertDenied(runHookGate(editEvent, dir), 'Workspace edit must be denied before approval');
    assertDenied(runHookGate(bashEvent, dir), 'Workspace bash command must be denied before approval');

    // After approval -> NO_DECISION ({})
    approveWorkflow(dir);
    assertNoDecision(runHookGate(editEvent, dir), 'Workspace edit should return NO_DECISION after approval');
    assertNoDecision(runHookGate(bashEvent, dir), 'Workspace bash command should return NO_DECISION after approval');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// =============================================================================
// 3. Shell Hardening: Executable validation, trusted script realpath, --project boundary
// =============================================================================
test('Hook Security (Shell): enforces executable, realpath script allowlist, closed grammar, and workspace --project', () => {
  const dir = createTempWorkspace();
  const otherRepoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'other-repo-'));
  const fakeScriptDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fake-scripts-'));
  const fakeDiagnosis = path.join(fakeScriptDir, 'generate-diagnosis-report.mjs');
  fs.writeFileSync(fakeDiagnosis, 'console.log("evil");\n');

  try {
    // 1. Legitimate script using absolute process.execPath (preferred) and bare `node` (PATH-trusted)
    assertNoDecision(
      runHookGate(
        {
          cwd: dir,
          toolName: 'bash',
          toolArgs: { command: `"${process.execPath}" "${DIAGNOSIS_SCRIPT}" --project "."` },
        },
        dir
      ),
      'Trusted script invoked via process.execPath must return NO_DECISION'
    );

    assertNoDecision(
      runHookGate(
        {
          cwd: dir,
          toolName: 'bash',
          toolArgs: { command: `node "${GATE_SCRIPT}" --project "projects/sub-app" --phase migrate` },
        },
        dir
      ),
      'Trusted script with --project pointing to workspace subdirectory must return NO_DECISION'
    );

    assertNoDecision(
      runHookGate(
        {
          cwd: dir,
          toolName: 'powershell',
          toolArgs: { command: `node "${PREREQS_SCRIPT}" -p "${dir}"` },
        },
        dir
      ),
      'Trusted script via powershell pointing to workspace root must return NO_DECISION'
    );

    // 2. Relative node binary (./node), Node flags before script (-e / -r), or fake script path -> DENY
    const badExecOrScript = [
      `./node "${PREREQS_SCRIPT}" --project "."`,
      `node -e "process.exit(0)" "${PREREQS_SCRIPT}"`,
      `node -r ./evil.js "${PREREQS_SCRIPT}"`,
      `node "${fakeDiagnosis}" --project "."`,
    ];
    for (const cmd of badExecOrScript) {
      assertDenied(
        runHookGate({ cwd: dir, toolName: 'bash', toolArgs: { command: cmd } }, dir),
        `Untrusted executable/flags/script must be denied: ${cmd}`
      );
    }

    // 3. --project pointing outside the current workspace -> DENY
    const outsideProjectCommands = [
      `node "${DIAGNOSIS_SCRIPT}" --project "${otherRepoDir}"`,
      `node "${DIAGNOSIS_SCRIPT}" --project ".."`,
      `node "${PREREQS_SCRIPT}" -p "/tmp"`,
    ];
    for (const cmd of outsideProjectCommands) {
      assertDenied(
        runHookGate({ cwd: dir, toolName: 'bash', toolArgs: { command: cmd } }, dir),
        `--project pointing outside workspace must be denied: ${cmd}`
      );
    }

    // 4. Variables, operators, escapes, backslashes on POSIX, unbalanced quotes -> DENY
    const dangerousShellCommands = [
      `node "${PREREQS_SCRIPT}" --project $HOME`,
      `node "${PREREQS_SCRIPT}" --project \${HOME}`,
      `node "${PREREQS_SCRIPT}" --project %USERPROFILE%`,
      `node "${PREREQS_SCRIPT}" --project $env:TEMP`,
      `node "${PREREQS_SCRIPT}" --project !TEMP!`,
      `rm -rf src/ # ${DIAGNOSIS_SCRIPT}`,
      `node "${PREREQS_SCRIPT}" --project . && rm -rf src/`,
      `node "${PREREQS_SCRIPT}" --project . || rm -rf src/`,
      `node "${PREREQS_SCRIPT}" --project . ; rm -rf src/`,
      `node "${PREREQS_SCRIPT}" --project . | tee package.json`,
      `node "${PREREQS_SCRIPT}" --project . > package.json`,
      `node "${PREREQS_SCRIPT}" --project $(whoami)`,
      `node "${PREREQS_SCRIPT}" --project \`whoami\``,
      `node "${PREREQS_SCRIPT}" --project .\nrm -rf src/`,
      `node "${PREREQS_SCRIPT}" --project . & del package.json`,
      `node "${PREREQS_SCRIPT}" --project ^.`,
      `node "${PREREQS_SCRIPT}" --project "unclosed`,
      `node "${PREREQS_SCRIPT}" --project ".\\"`,
    ];
    for (const cmd of dangerousShellCommands) {
      assertDenied(
        runHookGate({ cwd: dir, toolName: 'bash', toolArgs: { command: cmd } }, dir),
        `Shell syntax/injection must be denied: ${cmd}`
      );
    }

    // 5. Invalid, duplicate, or incomplete script arguments -> DENY
    const invalidContractCommands = [
      `node "${PREREQS_SCRIPT}" --project`,
      `node "${PREREQS_SCRIPT}" --project . --project .`,
      `node "${PREREQS_SCRIPT}" --unknown-flag foo`,
      `node "${PREREQS_SCRIPT}" extra-positional`,
      `node "${GATE_SCRIPT}" --phase invalid`,
      `node "${DIAGNOSIS_SCRIPT}" --phase plan`,
    ];
    for (const cmd of invalidContractCommands) {
      assertDenied(
        runHookGate({ cwd: dir, toolName: 'bash', toolArgs: { command: cmd } }, dir),
        `Invalid script argument contract must be denied: ${cmd}`
      );
    }

    // 6. Shell event missing command field -> unconditional DENY even when approved
    approveWorkflow(dir);
    assertDenied(
      runHookGate({ cwd: dir, toolName: 'bash', toolArgs: { script: 'echo hi' } }, dir),
      'Shell tool without "command" field must unconditionally DENY'
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(otherRepoDir, { recursive: true, force: true });
    fs.rmSync(fakeScriptDir, { recursive: true, force: true });
  }
});

// =============================================================================
// 4. Per-Tool File Adapters, Symlinks, URIs, Unicode/Spaces, UNC, Out-of-Workspace
// =============================================================================
test('Hook Security (Files): per-tool adapters, symlinks, URIs, Unicode, patches, and workspace boundaries', () => {
  const dir = createTempWorkspace();
  const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), 'outside-ws-'));
  const artDir = path.join(dir, ARTIFACTS_REL);
  fs.mkdirSync(artDir, { recursive: true });

  // Symlink inside artifacts pointing to src/ (inside workspace, escaping artifacts)
  fs.symlinkSync(path.join(dir, 'src'), path.join(artDir, 'escape-src'), 'dir');
  // Symlink inside artifacts pointing completely outside workspace
  fs.symlinkSync(outsideDir, path.join(artDir, 'escape-outside'), 'dir');

  try {
    // 1. Legitimate artifact operations (relative, file:// URI, spaces + Unicode, ..backup, rename/move/patch)
    assertNoDecision(
      runHookGate(
        {
          cwd: dir,
          toolName: 'edit',
          toolArgs: { path: '.migration-artifacts/karma-to-vitest/02-migration-plan.json', new_str: '{}' },
        },
        dir
      ),
      'Legitimate edit inside artifacts must return NO_DECISION'
    );

    assertNoDecision(
      runHookGate(
        {
          cwd: dir,
          toolName: 'create',
          toolArgs: {
            filePath: pathToFileURL(path.join(artDir, '02 plan revisión final.md')).href,
            content: '# Plan',
          },
        },
        dir
      ),
      'Legitimate file:// URI with spaces and Unicode inside artifacts must return NO_DECISION'
    );

    assertNoDecision(
      runHookGate(
        {
          cwd: dir,
          toolName: 'create',
          toolArgs: { path: '.migration-artifacts/karma-to-vitest/..backup.json', content: '{}' },
        },
        dir
      ),
      'Filename starting with .. inside artifacts (..backup.json) must not false-positive'
    );

    assertNoDecision(
      runHookGate(
        {
          cwd: dir,
          toolName: 'move',
          toolArgs: {
            sourcePath: '.migration-artifacts/karma-to-vitest/a.json',
            destinationPath: '.migration-artifacts/karma-to-vitest/b.json',
          },
        },
        dir
      ),
      'Move with both source and destination inside artifacts must return NO_DECISION'
    );

    assertNoDecision(
      runHookGate(
        {
          cwd: dir,
          toolName: 'apply_patch',
          toolArgs: {
            input: [
              '*** Begin Patch',
              '*** Update File: .migration-artifacts/karma-to-vitest/02-migration-plan.json',
              '*** Add File: .migration-artifacts/karma-to-vitest/notes.md',
              '*** End Patch',
            ].join('\n'),
          },
        },
        dir
      ),
      'Multi-file patch strictly inside artifacts must return NO_DECISION'
    );

    // 2. Decoy content, path traversal, move escaping artifacts, 2-file patch touching src/ -> DENY before approval
    assertDenied(
      runHookGate(
        {
          cwd: dir,
          toolName: 'edit',
          toolArgs: {
            path: 'src/app.component.ts',
            new_str: '// .migration-artifacts/karma-to-vitest/02-migration-plan.json',
          },
        },
        dir
      ),
      'Decoy artifact path in content must be denied before approval'
    );

    assertDenied(
      runHookGate(
        {
          cwd: dir,
          toolName: 'edit',
          toolArgs: { path: '.migration-artifacts/karma-to-vitest/../../package.json', new_str: '{}' },
        },
        dir
      ),
      'Path traversal escaping artifacts must be denied'
    );

    assertDenied(
      runHookGate(
        {
          cwd: dir,
          toolName: 'rename',
          toolArgs: {
            oldPath: '.migration-artifacts/karma-to-vitest/02-migration-plan.json',
            newPath: 'package.json',
          },
        },
        dir
      ),
      'Rename moving file out of artifacts must be denied before approval'
    );

    assertDenied(
      runHookGate(
        {
          cwd: dir,
          toolName: 'apply_patch',
          toolArgs: {
            input: [
              '*** Begin Patch',
              '*** Update File: .migration-artifacts/karma-to-vitest/02-migration-plan.json',
              '*** Update File: src/app.component.ts',
              '*** End Patch',
            ].join('\n'),
          },
        },
        dir
      ),
      '2-file patch where one file is outside artifacts must be denied before approval'
    );

    // 3. Unconditional DENYs even AFTER approving the workflow:
    //    symlinks escaping artifacts, out-of-workspace targets, malformed URIs,
    //    incomplete patches, UNC paths, missing destination fields
    approveWorkflow(dir);

    assertDenied(
      runHookGate(
        {
          cwd: dir,
          toolName: 'edit',
          toolArgs: { path: '.migration-artifacts/karma-to-vitest/escape-src/app.component.ts' },
        },
        dir
      ),
      'Symlink escape from artifacts (existing file) must unconditionally DENY'
    );

    assertDenied(
      runHookGate(
        {
          cwd: dir,
          toolName: 'create',
          toolArgs: { path: '.migration-artifacts/karma-to-vitest/escape-outside/new.ts' },
        },
        dir
      ),
      'Symlink escape outside workspace (non-existent file) must unconditionally DENY'
    );

    assertDenied(
      runHookGate(
        {
          cwd: dir,
          toolName: 'edit',
          toolArgs: { path: path.join(outsideDir, 'secret.txt') },
        },
        dir
      ),
      'Absolute path outside workspace must unconditionally DENY even when approved'
    );

    assertDenied(
      runHookGate(
        {
          cwd: dir,
          toolName: 'edit',
          toolArgs: { uri: 'file://%ZZ-malformed-uri' },
        },
        dir
      ),
      'Malformed file:// URI must unconditionally DENY'
    );

    assertDenied(
      runHookGate(
        {
          cwd: dir,
          toolName: 'edit',
          toolArgs: { uri: 'vscode-remote://host/.migration-artifacts/karma-to-vitest/plan.json' },
        },
        dir
      ),
      'Non-file URI scheme must unconditionally DENY'
    );

    assertDenied(
      runHookGate(
        {
          cwd: dir,
          toolName: 'edit',
          toolArgs: { path: '\\\\server\\share\\file.ts' },
        },
        dir
      ),
      'Windows UNC path must unconditionally DENY'
    );

    assertDenied(
      runHookGate(
        {
          cwd: dir,
          toolName: 'apply_patch',
          toolArgs: {
            input: '*** Begin Patch\n*** Update File: \n*** End Patch',
          },
        },
        dir
      ),
      'Patch with empty/incomplete file header must unconditionally DENY'
    );

    assertDenied(
      runHookGate(
        {
          cwd: dir,
          toolName: 'apply_patch',
          toolArgs: {
            input: '*** Update File: .migration-artifacts/karma-to-vitest/02-migration-plan.json',
          },
        },
        dir
      ),
      'Patch missing Begin/End envelope must unconditionally DENY'
    );

    assertDenied(
      runHookGate(
        {
          cwd: dir,
          toolName: 'rename',
          toolArgs: { oldPath: '.migration-artifacts/karma-to-vitest/a.json' },
        },
        dir
      ),
      'Rename missing destination field must unconditionally DENY'
    );

    assertDenied(
      runHookGate(
        {
          cwd: dir,
          toolName: 'edit',
          toolArgs: { content: '.migration-artifacts/karma-to-vitest/02-migration-plan.json' },
        },
        dir
      ),
      'Edit without verifiable target path field must unconditionally DENY'
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(outsideDir, { recursive: true, force: true });
  }
});

// =============================================================================
// 5. Latency Check (supports fail-open timeout risk mitigation)
// =============================================================================
test('Hook Performance: completes local gate evaluation well below timeoutSec (10s)', () => {
  const dir = createTempWorkspace();
  try {
    const start = Date.now();
    const out = runHookGate(
      { cwd: dir, toolName: 'edit', toolArgs: { path: 'src/app.component.ts' } },
      dir
    );
    const elapsedMs = Date.now() - start;
    assertDenied(out, 'Unapproved workspace edit must be denied');
    assert.ok(elapsedMs < 2000, `Hook took ${elapsedMs}ms; must remain fast to minimize fail-open timeout risk`);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
