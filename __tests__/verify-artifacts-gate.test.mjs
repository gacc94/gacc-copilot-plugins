import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
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
const PLANNER_SCRIPT = path.join(
  PLUGIN_ROOT,
  'skills',
  'karma-vitest-audit',
  'scripts',
  'generate-migration-plan.mjs'
);
const APPROVE_SCRIPT = path.join(
  PLUGIN_ROOT,
  'skills',
  'karma-vitest-migrate',
  'scripts',
  'approve-artifact.mjs'
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

function approveDiagnosisOnly(projectDir) {
  writeArtifacts(projectDir, {
    diag: { status: 'READY', approval: { status: 'APPROVED' } },
  });
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

function runHookGate(payload, defaultProjectDir, phase = 'migrate') {
  const stdin = typeof payload === 'string' ? payload : JSON.stringify(payload);
  const args = [GATE_SCRIPT, '--hook', '--project', defaultProjectDir];
  if (phase !== undefined) {
    args.push('--phase', phase);
  }
  const res = spawnSync(process.execPath, args, {
    input: stdin,
    encoding: 'utf8',
  });
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

    approveDiagnosisOnly(dir);
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

    approveWorkflow(dir);
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
    for (const phase of ['plan', 'migrate']) {
      for (const toolName of ['view', 'glob', 'grep', 'ask_user', 'web_fetch', 'update_todo']) {
        const out = runHookGate(
          { sessionId: 'sess-1', timestamp: Date.now(), cwd: dir, toolName, toolArgs: {} },
          dir,
          phase
        );
        assertNoDecision(
          out,
          `Documented runtime read-only tool "${toolName}" (phase=${phase}) should return NO_DECISION ({})`
        );
      }
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('Hook (Unconditional DENY): blocks invalid input, unknown tools, aliases, and task delegation EVEN when workflow is APPROVED', () => {
  const dir = createTempWorkspace();
  try {
    approveWorkflow(dir);

    assertDenied(runHookGate('', dir), 'Empty stdin must unconditionally DENY even with approved workflow');
    assertDenied(runHookGate('{corrupt-json', dir), 'Corrupt JSON must unconditionally DENY even with approved workflow');
    assertDenied(
      runHookGate({ cwd: dir, toolName: 'view', toolArgs: {} }, dir, 'invalid-phase'),
      'Invalid --phase must unconditionally DENY'
    );
    assertDenied(
      runHookGate({ cwd: dir, toolArgs: { path: 'src/app.component.ts' } }, dir),
      'Missing toolName must unconditionally DENY'
    );
    assertDenied(
      runHookGate({ cwd: dir, tool_name: 'edit', tool_input: { path: 'src/app.component.ts' } }, dir),
      'snake_case Local payload without camelCase toolName must DENY under strict preToolUse contract'
    );

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

    for (const phase of ['plan', 'migrate']) {
      assertDenied(
        runHookGate(
          {
            sessionId: 'sess-1',
            cwd: dir,
            toolName: 'task',
            toolArgs: { prompt: 'Edit src/app.component.ts to migrate specs' },
          },
          dir,
          phase
        ),
        `Delegation via "task" (phase=${phase}) must be unconditionally DENIED`
      );
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// =============================================================================
// 3. Phase 2 Planner Hook (--hook --phase plan): Read-Only on Source, Plan Artifacts Only
// =============================================================================
test('Hook (Planner --phase plan): blocks source edits, arbitrary shell, and diagnosis tampering; allows ONLY 02-migration-plan.* after diagnosis approval', () => {
  const dir = createTempWorkspace();
  try {
    const writePlanJson = {
      cwd: dir,
      toolName: 'create',
      toolArgs: { path: '.migration-artifacts/karma-to-vitest/02-migration-plan.json', content: '{}' },
    };
    const writePlanMd = {
      cwd: dir,
      toolName: 'create',
      toolArgs: { path: '.migration-artifacts/karma-to-vitest/02-migration-plan.md', content: '# Plan' },
    };

    // Before diagnosis approval -> writing plan is DENIED
    assertDenied(runHookGate(writePlanJson, dir, 'plan'), 'Planner cannot write plan before diagnosis is APPROVED');
    assertDenied(runHookGate(writePlanMd, dir, 'plan'), 'Planner cannot write plan md before diagnosis is APPROVED');

    // Trusted plugin script is allowed in Planner even before approval
    assertNoDecision(
      runHookGate(
        {
          cwd: dir,
          toolName: 'bash',
          toolArgs: { command: `node "${GATE_SCRIPT}" --project "." --phase plan` },
        },
        dir,
        'plan'
      ),
      'Planner may execute verify-artifacts-gate.mjs --phase plan'
    );

    // Approve diagnosis ONLY -> Planner can now write 02-migration-plan.{json,md}
    approveDiagnosisOnly(dir);
    assertNoDecision(runHookGate(writePlanJson, dir, 'plan'), 'Planner may write 02-migration-plan.json after diagnosis approval');
    assertNoDecision(runHookGate(writePlanMd, dir, 'plan'), 'Planner may write 02-migration-plan.md after diagnosis approval');

    // Even with FULL workflow approval, Planner is NEVER allowed to touch source files, diagnosis artifacts, other artifacts, ../ traversal, symlinks, or arbitrary shell
    approveWorkflow(dir);
    const artDir = path.join(dir, ARTIFACTS_REL);
    fs.symlinkSync(path.join(dir, 'src'), path.join(artDir, 'plan-escape-link'), 'dir');

    const deniedSrc = runHookGate(
      { cwd: dir, toolName: 'edit', toolArgs: { path: 'src/app.component.ts', new_str: '// edit' } },
      dir,
      'plan'
    );
    assertDenied(deniedSrc, 'Planner must NEVER edit source code');
    assert.match(deniedSrc.permissionDecisionReason, /\.migration-artifacts/);

    assertDenied(
      runHookGate(
        { cwd: dir, toolName: 'edit', toolArgs: { path: 'package.json', new_str: '{}' } },
        dir,
        'plan'
      ),
      'Planner must NEVER edit package.json'
    );
    assertDenied(
      runHookGate(
        {
          cwd: dir,
          toolName: 'edit',
          toolArgs: { path: '.migration-artifacts/karma-to-vitest/../../package.json', new_str: '{}' },
        },
        dir,
        'plan'
      ),
      'Planner must NEVER escape .migration-artifacts/karma-to-vitest via ../ traversal'
    );
    assertDenied(
      runHookGate(
        {
          cwd: dir,
          toolName: 'create',
          toolArgs: { path: '.migration-artifacts/karma-to-vitest/../02-migration-plan.json', content: '{}' },
        },
        dir,
        'plan'
      ),
      'Planner must NEVER write into parent directory via ../ traversal'
    );
    assertDenied(
      runHookGate(
        {
          cwd: dir,
          toolName: 'edit',
          toolArgs: { path: '.migration-artifacts/karma-to-vitest/plan-escape-link/app.component.ts', new_str: '// x' },
        },
        dir,
        'plan'
      ),
      'Planner must NEVER escape .migration-artifacts/karma-to-vitest via symlink'
    );
    assertDenied(
      runHookGate(
        {
          cwd: dir,
          toolName: 'edit',
          toolArgs: { path: '.migration-artifacts/karma-to-vitest/01-diagnosis-report.json', new_str: '{}' },
        },
        dir,
        'plan'
      ),
      'Planner must NEVER edit/self-approve 01-diagnosis-report.json'
    );
    assertDenied(
      runHookGate(
        { cwd: dir, toolName: 'bash', toolArgs: { command: 'npm install vitest' } },
        dir,
        'plan'
      ),
      'Planner must NEVER run arbitrary shell commands'
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// =============================================================================
// 4. Phase 3 Migrator Hook (--hook --phase migrate): Anti-Self-Approval + REQUIRE_GATE
// =============================================================================
test('Hook (Migrator --phase migrate): prevents self-approval of diagnosis/plan and gates workspace mutations', () => {
  const dir = createTempWorkspace();
  try {
    approveDiagnosisOnly(dir);
    writeArtifacts(dir, {
      plan: { approval: { status: 'PENDING' }, tasks: [{ id: 'T1' }] },
    });

    const editSrc = {
      sessionId: 'sess-1',
      cwd: dir,
      toolName: 'edit',
      toolArgs: { path: 'src/app.component.ts', new_str: 'export class Updated {}' },
    };
    const editPlan = {
      sessionId: 'sess-1',
      cwd: dir,
      toolName: 'edit',
      toolArgs: { path: '.migration-artifacts/karma-to-vitest/02-migration-plan.json', new_str: '{"approval":{"status":"APPROVED"}}' },
    };
    const editDiagnosis = {
      sessionId: 'sess-1',
      cwd: dir,
      toolName: 'edit',
      toolArgs: { path: '.migration-artifacts/karma-to-vitest/01-diagnosis-report.json', new_str: '{}' },
    };
    const bashTest = {
      sessionId: 'sess-1',
      cwd: dir,
      toolName: 'bash',
      toolArgs: JSON.stringify({ command: 'npx ng test --watch=false' }),
    };

    // Before plan approval -> ALL mutations (including self-approving 02-migration-plan.json) are DENIED
    assertDenied(runHookGate(editSrc, dir, 'migrate'), 'Workspace edit must be denied before plan approval');
    assertDenied(runHookGate(editPlan, dir, 'migrate'), 'Migrator must NOT edit/self-approve 02-migration-plan.json before approval');
    assertDenied(runHookGate(editDiagnosis, dir, 'migrate'), 'Migrator must NOT edit 01-diagnosis-report.json');
    assertDenied(runHookGate(bashTest, dir, 'migrate'), 'Workspace bash command must be denied before plan approval');

    // After full approval -> workspace edits, updating task status in 02-migration-plan.json, and ng test return NO_DECISION
    approveWorkflow(dir);
    assertNoDecision(runHookGate(editSrc, dir, 'migrate'), 'Workspace edit should return NO_DECISION after approval');
    assertNoDecision(runHookGate(editPlan, dir, 'migrate'), 'Updating 02-migration-plan.json task status should return NO_DECISION after approval');
    assertNoDecision(runHookGate(bashTest, dir, 'migrate'), 'Workspace bash command should return NO_DECISION after approval');

    // Phase 1 diagnosis artifacts remain IMMUTABLE even after full approval
    assertDenied(
      runHookGate(editDiagnosis, dir, 'migrate'),
      '01-diagnosis-report.json must remain immutable even after workflow approval'
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// =============================================================================
// 5. Shell Hardening: Executable validation, trusted script realpath, --project & --angular-project
// =============================================================================
test('Hook Security (Shell): enforces executable, realpath script allowlist, closed grammar, and workspace --project', () => {
  const dir = createTempWorkspace();
  const otherRepoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'other-repo-'));
  const fakeScriptDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fake-scripts-'));
  const fakeDiagnosis = path.join(fakeScriptDir, 'generate-diagnosis-report.mjs');
  fs.writeFileSync(fakeDiagnosis, 'console.log("evil");\n');

  try {
    assertNoDecision(
      runHookGate(
        {
          cwd: dir,
          toolName: 'bash',
          toolArgs: { command: `"${process.execPath}" "${DIAGNOSIS_SCRIPT}" --project "." --angular-project "admin-app"` },
        },
        dir
      ),
      'Trusted generate-diagnosis-report.mjs with --angular-project must return NO_DECISION'
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

    const invalidContractCommands = [
      `node "${PREREQS_SCRIPT}" --project`,
      `node "${PREREQS_SCRIPT}" --project . --project .`,
      `node "${PREREQS_SCRIPT}" --unknown-flag foo`,
      `node "${PREREQS_SCRIPT}" extra-positional`,
      `node "${GATE_SCRIPT}" --phase invalid`,
      `node "${DIAGNOSIS_SCRIPT}" --phase plan`,
      `node "${DIAGNOSIS_SCRIPT}" --angular-project ../escape`,
      `node "${PREREQS_SCRIPT}" --angular-project app`,
    ];
    for (const cmd of invalidContractCommands) {
      assertDenied(
        runHookGate({ cwd: dir, toolName: 'bash', toolArgs: { command: cmd } }, dir),
        `Invalid script argument contract must be denied: ${cmd}`
      );
    }

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
// 6. Per-Tool File Adapters, Symlinks, URIs, Unicode/Spaces, UNC, Out-of-Workspace
// =============================================================================
test('Hook Security (Files): per-tool adapters, symlinks, URIs, Unicode, patches, and workspace boundaries', () => {
  const dir = createTempWorkspace();
  const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), 'outside-ws-'));
  const artDir = path.join(dir, ARTIFACTS_REL);
  fs.mkdirSync(artDir, { recursive: true });

  fs.symlinkSync(path.join(dir, 'src'), path.join(artDir, 'escape-src'), 'dir');
  fs.symlinkSync(outsideDir, path.join(artDir, 'escape-outside'), 'dir');

  try {
    // 1. Before approval: path traversal, decoy content, rename/patch escaping -> DENIED
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
      '2-file patch touching workspace before approval must be denied'
    );

    // 2. Approve workflow -> valid workspace targets (URI with spaces/Unicode, ..backup, move, multi-file patch) return NO_DECISION
    approveWorkflow(dir);

    assertNoDecision(
      runHookGate(
        {
          cwd: dir,
          toolName: 'create',
          toolArgs: {
            filePath: pathToFileURL(path.join(dir, 'src', 'app revisión final.spec.ts')).href,
            content: '// spec',
          },
        },
        dir
      ),
      'Valid file:// URI with spaces and Unicode inside workspace must return NO_DECISION after approval'
    );

    assertNoDecision(
      runHookGate(
        {
          cwd: dir,
          toolName: 'create',
          toolArgs: { path: 'src/..notes.spec.ts', content: '// spec' },
        },
        dir
      ),
      'Filename starting with .. inside workspace (src/..notes.spec.ts) must not false-positive on traversal check'
    );

    assertDenied(
      runHookGate(
        {
          cwd: dir,
          toolName: 'create',
          toolArgs: { path: '.migration-artifacts/karma-to-vitest/..backup.json', content: '{}' },
        },
        dir
      ),
      'Migrator must deny writing unrelated files inside .migration-artifacts/karma-to-vitest/'
    );

    assertNoDecision(
      runHookGate(
        {
          cwd: dir,
          toolName: 'move',
          toolArgs: {
            sourcePath: 'src/a.spec.ts',
            destinationPath: 'src/b.spec.ts',
          },
        },
        dir
      ),
      'Move inside workspace must return NO_DECISION after approval'
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
              '*** Update File: src/app.component.ts',
              '*** End Patch',
            ].join('\n'),
          },
        },
        dir
      ),
      'Complete 2-file patch inside workspace must return NO_DECISION after approval'
    );

    // 3. Unconditional DENYs even AFTER approving the workflow:
    //    symlinks escaping artifacts, out-of-workspace targets, malformed URIs,
    //    incomplete patches, UNC paths, missing destination fields
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
// 7. Diagnosis Script: Multi-Project --angular-project Support
// =============================================================================
test('Diagnosis Generator: scopes specs and targets when --angular-project is provided', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gacc-diag-multiproj-'));
  try {
    fs.mkdirSync(path.join(dir, 'projects', 'app-a', 'src'), { recursive: true });
    fs.mkdirSync(path.join(dir, 'projects', 'app-b', 'src'), { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'package.json'),
      JSON.stringify({
        name: 'angular-monorepo',
        dependencies: { '@angular/core': '^21.1.0' },
        devDependencies: { '@angular/cli': '^21.1.0', karma: '^6.4.0' },
      })
    );
    fs.writeFileSync(
      path.join(dir, 'angular.json'),
      JSON.stringify({
        projects: {
          'app-a': {
            root: 'projects/app-a',
            architect: { test: { builder: '@angular-devkit/build-angular:karma', options: {} } },
          },
          'app-b': {
            root: 'projects/app-b',
            architect: { test: { builder: '@angular-devkit/build-angular:karma', options: {} } },
          },
        },
      })
    );
    fs.writeFileSync(path.join(dir, 'projects', 'app-a', 'src', 'a.spec.ts'), 'it("a", () => { jasmine.clock().install(); });\n');
    fs.writeFileSync(path.join(dir, 'projects', 'app-b', 'src', 'b1.spec.ts'), 'it("b1", () => { expect(true).toBe(true); });\n');
    fs.writeFileSync(path.join(dir, 'projects', 'app-b', 'src', 'b2.spec.ts'), 'it("b2", () => { expect(1).toBe(1); });\n');

    // Scoped to app-b -> sees only app-b's 2 simple specs (OFFICIAL_SCHEMATIC_SUFFICIENT)
    const resB = spawnSync(
      process.execPath,
      [DIAGNOSIS_SCRIPT, '--project', dir, '--angular-project', 'app-b'],
      { encoding: 'utf8' }
    );
    assert.equal(resB.status, 0, resB.stderr);
    const summaryB = JSON.parse(resB.stdout.trim());
    assert.equal(summaryB.status, 'READY');
    assert.equal(summaryB.recommendedStrategy, 'OFFICIAL_SCHEMATIC_SUFFICIENT');
    assert.equal(summaryB.metrics.specFileCount, 2);
    assert.equal(summaryB.metrics.angularProjectCount, 1);

    // Non-existent project -> BLOCKED with ANGULAR_PROJECT_NOT_FOUND
    const resMissing = spawnSync(
      process.execPath,
      [DIAGNOSIS_SCRIPT, '--project', dir, '--angular-project', 'does-not-exist'],
      { encoding: 'utf8' }
    );
    assert.equal(resMissing.status, 0, resMissing.stderr);
    const summaryMissing = JSON.parse(resMissing.stdout.trim());
    assert.equal(summaryMissing.status, 'BLOCKED');
    assert.ok(summaryMissing.blockers.some((b) => b.code === 'ANGULAR_PROJECT_NOT_FOUND'));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// =============================================================================
// 8. Latency Check (supports fail-open timeout risk mitigation)
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

// =============================================================================
// 9. Multi-Phase Coexistence Lifecycle: Diagnosis Hash/Score -> Deterministic Planner -> Hybrid Approval -> Migrator targetFiles Scope
// =============================================================================
test('End-to-End Multi-Phase Coexistence: diagnosisHash, complexityScore 1-10, deterministic batching, approve-artifact.mjs, and targetFiles enforcement', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gacc-multiphase-e2e-'));
  try {
    fs.mkdirSync(path.join(dir, 'src', 'app', 'auth'), { recursive: true });
    fs.mkdirSync(path.join(dir, 'src', 'app', 'billing'), { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'package.json'),
      JSON.stringify({
        name: 'enterprise-ng-app',
        dependencies: { '@angular/core': '^21.2.0' },
        devDependencies: { '@angular/cli': '^21.2.0', karma: '^6.4.0', 'jasmine-core': '^5.1.0' },
      })
    );
    fs.writeFileSync(
      path.join(dir, 'angular.json'),
      JSON.stringify({
        projects: {
          'enterprise-ng-app': {
            root: '',
            architect: {
              test: {
                builder: '@angular-devkit/build-angular:karma',
                options: { tsConfig: 'tsconfig.spec.json', karmaConfig: 'karma.conf.js' },
              },
            },
          },
        },
      })
    );
    fs.writeFileSync(path.join(dir, 'tsconfig.spec.json'), '{"compilerOptions":{"types":["jasmine"]}}\n');
    fs.writeFileSync(path.join(dir, 'karma.conf.js'), 'module.exports = { proxies: { "/api": "http://localhost" } };\n');
    fs.writeFileSync(path.join(dir, 'src', 'app', 'auth', 'login.service.ts'), 'export class LoginService {}\n');
    fs.writeFileSync(path.join(dir, 'src', 'app', 'auth', 'login.spec.ts'), 'it("low", () => { expect(true).toBe(true); });\n');
    fs.writeFileSync(
      path.join(dir, 'src', 'app', 'billing', 'invoice.spec.ts'),
      'it("med", fakeAsync(() => { tick(100); spyOn(a, "b").and.returnValue(1); }));\n'
    );
    fs.writeFileSync(
      path.join(dir, 'src', 'app', 'billing', 'clock.spec.ts'),
      'it("high", () => { jasmine.clock().install(); spyOnProperty(x, "y"); });\n'
    );

    // 1. Run Phase 1 Diagnosis
    const diagRes = spawnSync(process.execPath, [DIAGNOSIS_SCRIPT, '--project', dir], { encoding: 'utf8' });
    assert.equal(diagRes.status, 0, diagRes.stderr);
    const diagSummary = JSON.parse(diagRes.stdout.trim());
    assert.equal(diagSummary.status, 'READY');
    assert.match(diagSummary.diagnosisHash, /^sha256:[a-f0-9]{16}$/);

    const diagJsonPath = path.join(dir, ARTIFACTS_REL, '01-diagnosis-report.json');
    const diagJson = JSON.parse(fs.readFileSync(diagJsonPath, 'utf8'));
    assert.equal(diagJson.schemaVersion, '1.3.0');
    assert.equal(diagJson.specInventory.length, 3);
    for (const s of diagJson.specInventory) {
      assert.ok(Number.isInteger(s.complexityScore) && s.complexityScore >= 1 && s.complexityScore <= 10);
      if (s.complexity === 'low') assert.ok(s.complexityScore <= 3);
      if (s.complexity === 'medium') assert.ok(s.complexityScore >= 4 && s.complexityScore <= 6);
      if (s.complexity === 'high') assert.ok(s.complexityScore >= 7);
    }

    // 2. Planner script MUST fail before diagnosis approval
    const planFailRes = spawnSync(process.execPath, [PLANNER_SCRIPT, '--project', dir], { encoding: 'utf8' });
    assert.equal(planFailRes.status, 1, 'generate-migration-plan.mjs must refuse unapproved diagnosis');

    // 3. Approve diagnosis via approve-artifact.mjs (chat-confirmed hybrid approval)
    const approveDiagRes = spawnSync(
      process.execPath,
      [APPROVE_SCRIPT, '--project', dir, '--artifact', 'diagnosis', '--reviewer', 'gustavo', '--mode', 'chat-confirmed'],
      { encoding: 'utf8' }
    );
    assert.equal(approveDiagRes.status, 0, approveDiagRes.stderr);
    const updatedDiag = JSON.parse(fs.readFileSync(diagJsonPath, 'utf8'));
    assert.equal(updatedDiag.approval.status, 'APPROVED');
    assert.equal(updatedDiag.approval.mode, 'chat-confirmed');

    // 4. Generate deterministic multi-phase plan
    const planRes = spawnSync(process.execPath, [PLANNER_SCRIPT, '--project', dir], { encoding: 'utf8' });
    assert.equal(planRes.status, 0, planRes.stderr);
    const planSummary = JSON.parse(planRes.stdout.trim());
    assert.equal(planSummary.planMode, 'multi-phase');
    // Expect 5 phases: coexistence + low + medium + high + cutover-cleanup
    assert.equal(planSummary.phaseCount, 5);
    assert.equal(planSummary.phases[0].phaseId, 'phase-01-coexistence');
    assert.equal(planSummary.phases[4].kind, 'cutover-cleanup');

    // 5. Cannot approve phase-02 while phase-01 is still PENDING
    const phase2Id = planSummary.phases[1].phaseId;
    const approveEarlyRes = spawnSync(
      process.execPath,
      [APPROVE_SCRIPT, '--project', dir, '--artifact', 'phase', '--plan-phase', phase2Id, '--reviewer', 'gustavo'],
      { encoding: 'utf8' }
    );
    assert.equal(approveEarlyRes.status, 1, 'Must block approving phase-02 before phase-01 is COMPLETED');

    // 6. Approve phase-01-coexistence
    const approveP1Res = spawnSync(
      process.execPath,
      [APPROVE_SCRIPT, '--project', dir, '--artifact', 'phase', '--plan-phase', 'phase-01-coexistence', '--reviewer', 'gustavo'],
      { encoding: 'utf8' }
    );
    assert.equal(approveP1Res.status, 0, approveP1Res.stderr);

    // 7. Migrator hook during phase-01-coexistence:
    //    - Editing angular.json (in targetFiles) -> NO_DECISION ({})
    //    - Editing src/app/auth/login.service.ts (NOT in targetFiles) -> DENY
    //    - Editing unapproved plans/phase-02-*.json -> DENY
    //    - Editing active plans/phase-01-coexistence.json -> NO_DECISION ({})
    assertNoDecision(
      runHookGate({ cwd: dir, toolName: 'edit', toolArgs: { path: 'angular.json' } }, dir, 'migrate'),
      'Migrator should be allowed to edit angular.json declared in phase-01 targetFiles'
    );
    assertDenied(
      runHookGate({ cwd: dir, toolName: 'edit', toolArgs: { path: 'src/app/auth/login.service.ts' } }, dir, 'migrate'),
      'Migrator must DENY editing files outside active phase targetFiles'
    );
    assertDenied(
      runHookGate({ cwd: dir, toolName: 'edit', toolArgs: { path: `${ARTIFACTS_REL}/plans/${phase2Id}.json` } }, dir, 'migrate'),
      'Migrator must DENY editing an unapproved future phase plan file'
    );
    assertNoDecision(
      runHookGate(
        { cwd: dir, toolName: 'edit', toolArgs: { path: `${ARTIFACTS_REL}/plans/phase-01-coexistence.json` } },
        dir,
        'migrate'
      ),
      'Migrator should be allowed to update task/phase status in active approved phase file'
    );

    // 8. Drift detection: mutating diagnosisHash in 01-diagnosis-report.json blocks Migrator
    updatedDiag.diagnosisHash = 'sha256:ffffffffffffffff';
    fs.writeFileSync(diagJsonPath, JSON.stringify(updatedDiag, null, 2));
    assertDenied(
      runHookGate({ cwd: dir, toolName: 'edit', toolArgs: { path: 'angular.json' } }, dir, 'migrate'),
      'Migrator must DENY when diagnosisHash drifted from plan'
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// =============================================================================
// 10. Orchestrator (--phase orchestrate) & Analyst (--phase audit) Hooks + Planner plans/ Writes
// =============================================================================
test('Hooks (--phase orchestrate, --phase audit, --phase plan): enforce strict least privilege across all 4 agents', () => {
  const dir = createTempWorkspace();
  try {
    approveDiagnosisOnly(dir);

    // Orchestrator (--phase orchestrate): allows read-only, task, vscode/askQuestions, approve-artifact.mjs; denies edits & arbitrary shell
    assertNoDecision(
      runHookGate({ cwd: dir, toolName: 'task', toolArgs: { prompt: 'Run Analyst' } }, dir, 'orchestrate'),
      'Orchestrator must be allowed to delegate via task'
    );
    assertNoDecision(
      runHookGate({ cwd: dir, toolName: 'vscode/askQuestions', toolArgs: {} }, dir, 'orchestrate'),
      'Orchestrator must be allowed to use vscode/askQuestions'
    );
    assertNoDecision(
      runHookGate(
        {
          cwd: dir,
          toolName: 'bash',
          toolArgs: {
            command: `"${process.execPath}" "${APPROVE_SCRIPT}" --project "${dir}" --artifact diagnosis --reviewer gustavo --mode chat-confirmed`,
          },
        },
        dir,
        'orchestrate'
      ),
      'Orchestrator must be allowed to invoke approve-artifact.mjs with valid contract args'
    );
    assertDenied(
      runHookGate({ cwd: dir, toolName: 'edit', toolArgs: { path: 'package.json' } }, dir, 'orchestrate'),
      'Orchestrator must NEVER edit files directly'
    );
    assertDenied(
      runHookGate({ cwd: dir, toolName: 'bash', toolArgs: { command: 'npx ng test' } }, dir, 'orchestrate'),
      'Orchestrator must NEVER run arbitrary shell commands'
    );

    // Analyst (--phase audit): allows generate-diagnosis-report.mjs & check-prereqs.mjs; denies edits, task, approve-artifact, arbitrary shell
    assertNoDecision(
      runHookGate(
        {
          cwd: dir,
          toolName: 'bash',
          toolArgs: { command: `"${process.execPath}" "${DIAGNOSIS_SCRIPT}" --project "${dir}"` },
        },
        dir,
        'audit'
      ),
      'Analyst must be allowed to run generate-diagnosis-report.mjs'
    );
    assertDenied(
      runHookGate({ cwd: dir, toolName: 'task', toolArgs: { prompt: 'Delegate' } }, dir, 'audit'),
      'Analyst must NEVER delegate via task'
    );
    assertDenied(
      runHookGate({ cwd: dir, toolName: 'edit', toolArgs: { path: 'src/app.component.ts' } }, dir, 'audit'),
      'Analyst must NEVER edit workspace files'
    );
    assertDenied(
      runHookGate(
        {
          cwd: dir,
          toolName: 'bash',
          toolArgs: {
            command: `"${process.execPath}" "${APPROVE_SCRIPT}" --project "${dir}" --artifact diagnosis --reviewer bot`,
          },
        },
        dir,
        'audit'
      ),
      'Analyst must NEVER run approve-artifact.mjs'
    );

    // Planner (--phase plan): allows plans/phase-01-coexistence.{json,md} & generate-migration-plan.mjs; blocks approve-artifact.mjs & invalid names
    assertNoDecision(
      runHookGate(
        {
          cwd: dir,
          toolName: 'create',
          toolArgs: { path: `${ARTIFACTS_REL}/plans/phase-01-coexistence.json`, content: '{}' },
        },
        dir,
        'plan'
      ),
      'Planner must be allowed to write plans/phase-XX-*.json after diagnosis approval'
    );
    assertNoDecision(
      runHookGate(
        {
          cwd: dir,
          toolName: 'bash',
          toolArgs: { command: `"${process.execPath}" "${PLANNER_SCRIPT}" --project "${dir}"` },
        },
        dir,
        'plan'
      ),
      'Planner must be allowed to invoke generate-migration-plan.mjs after diagnosis approval'
    );
    assertDenied(
      runHookGate(
        {
          cwd: dir,
          toolName: 'create',
          toolArgs: { path: `${ARTIFACTS_REL}/plans/arbitrary.ts`, content: '' },
        },
        dir,
        'plan'
      ),
      'Planner must DENY writing non-phase files inside plans/'
    );
    assertDenied(
      runHookGate(
        {
          cwd: dir,
          toolName: 'bash',
          toolArgs: {
            command: `"${process.execPath}" "${APPROVE_SCRIPT}" --project "${dir}" --artifact diagnosis --reviewer bot`,
          },
        },
        dir,
        'plan'
      ),
      'Planner must NEVER run approve-artifact.mjs'
    );

    // Migrator (--phase migrate): must NEVER run approve-artifact.mjs even when workflow approved
    approveWorkflow(dir);
    assertDenied(
      runHookGate(
        {
          cwd: dir,
          toolName: 'bash',
          toolArgs: {
            command: `"${process.execPath}" "${APPROVE_SCRIPT}" --project "${dir}" --artifact phase --plan-phase phase-01-coexistence --reviewer bot`,
          },
        },
        dir,
        'migrate'
      ),
      'Migrator must NEVER invoke approve-artifact.mjs (no self-approval)'
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// =============================================================================
// 11. Pattern Precision: SpyObj<T>, jasmine.isSpy, calls.reset, expectedOutcome, and Legacy Build Builder Warning
// =============================================================================
test('Diagnosis Generator: detects jasmine.SpyObj<T>, jasmine.isSpy(), spy.calls.reset(), expectedOutcome, and legacy browser build builder', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gacc-diag-patterns-'));
  try {
    fs.mkdirSync(path.join(dir, 'src', 'app'), { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'package.json'),
      JSON.stringify({
        name: 'pattern-check-app',
        dependencies: { '@angular/core': '^21.2.0' },
        devDependencies: { '@angular/cli': '^21.2.0', karma: '^6.4.0', 'jasmine-core': '^5.1.0' },
      })
    );
    fs.writeFileSync(
      path.join(dir, 'angular.json'),
      JSON.stringify({
        projects: {
          'pattern-check-app': {
            root: '',
            architect: {
              build: { builder: '@angular-devkit/build-angular:browser' },
              test: { builder: '@angular-devkit/build-angular:karma', options: {} },
            },
          },
        },
      })
    );
    fs.writeFileSync(
      path.join(dir, 'src', 'app', 'simple.spec.ts'),
      'it("simple", () => { expect(true).toBe(true); });\n'
    );
    fs.writeFileSync(
      path.join(dir, 'src', 'app', 'spyobj.spec.ts'),
      'let svc: jasmine.SpyObj<UserService>;\nfoo.calls.reset();\n'
    );
    fs.writeFileSync(
      path.join(dir, 'src', 'app', 'isspy.spec.ts'),
      'it("checks spy", () => { expect(jasmine.isSpy(fn)).toBeTrue(); });\n'
    );

    const res = spawnSync(process.execPath, [DIAGNOSIS_SCRIPT, '--project', dir], { encoding: 'utf8' });
    assert.equal(res.status, 0, res.stderr);

    const diagJson = JSON.parse(
      fs.readFileSync(path.join(dir, ARTIFACTS_REL, '01-diagnosis-report.json'), 'utf8')
    );

    assert.equal(diagJson.status, 'READY');
    assert.equal(diagJson.recommendedStrategy, 'HYBRID_SCHEMATIC_PLUS_AGENT');
    assert.equal(diagJson.detected.buildBuilder, '@angular-devkit/build-angular:browser');
    assert.ok(
      diagJson.warnings.some((w) => w.code === 'LEGACY_BUILD_SYSTEM_DETECTED'),
      'Must warn when build target does not use @angular/build:application'
    );

    const byFile = new Map(diagJson.specInventory.map((s) => [s.file, s]));

    const simple = byFile.get('src/app/simple.spec.ts');
    assert.equal(simple.complexity, 'low');
    assert.equal(simple.expectedOutcome, 'automatically_migrated');

    const spyObj = byFile.get('src/app/spyobj.spec.ts');
    assert.equal(spyObj.complexity, 'medium');
    assert.equal(spyObj.expectedOutcome, 'requires_review');
    assert.ok(spyObj.jasminePatterns.includes('jasmine.SpyObj<T>'));
    assert.ok(spyObj.jasminePatterns.includes('spy.calls.reset'));

    const isSpy = byFile.get('src/app/isspy.spec.ts');
    assert.equal(isSpy.complexity, 'high');
    assert.equal(isSpy.expectedOutcome, 'manual_migration');
    assert.ok(isSpy.jasminePatterns.includes('jasmine.isSpy'));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
