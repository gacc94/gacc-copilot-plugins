#!/usr/bin/env node
/**
 * Gate validator for the 3-phase Angular Karma-to-Vitest migration workflow.
 *
 * Modes:
 * 1. CLI mode:
 *    node verify-artifacts-gate.mjs --project <dir> --phase <plan|migrate>
 *    Exits with 0 if the required artifacts exist and are APPROVED, or 1 otherwise.
 *
 * 2. Copilot preToolUse Hook mode (agent-scoped on karma-vitest-migrator):
 *    node verify-artifacts-gate.mjs --hook [--project <dir>]
 *    Reads the Copilot preToolUse event JSON from stdin:
 *      { sessionId, timestamp, cwd, toolName, toolArgs }
 *    or VS Code PreToolUse snake_case format:
 *      { hook_event_name, session_id, timestamp, cwd, tool_name, tool_input }
 *    Outputs either:
 *    - {} (allow / no decision)
 *    - {"permissionDecision":"deny","permissionDecisionReason":"..."}
 *
 * Zero external dependencies — uses only built-in Node.js modules.
 */
import fs from 'node:fs';
import path from 'node:path';

const ARTIFACTS_SUBDIR = path.join('.migration-artifacts', 'karma-to-vitest');
const DIAGNOSIS_JSON = '01-diagnosis-report.json';
const DIAGNOSIS_MD = '01-diagnosis-report.md';
const PLAN_JSON = '02-migration-plan.json';
const PLAN_MD = '02-migration-plan.md';

// Official Copilot / VS Code mutating or shell execution tools that must pass the migration gate
const MUTATING_TOOL_PATTERNS = [
  'edit',
  'create',
  'write',
  'delete',
  'remove',
  'replace',
  'patch',
  'bash',
  'powershell',
  'terminal',
  'shell',
  'exec',
  'run_command',
];

// Official Copilot read-only, search, UI, and orchestration tools (always allowed)
const ALWAYS_ALLOWED_TOOLS = new Set([
  'view',
  'glob',
  'grep',
  'task',
  'ask_user',
  'web_fetch',
  'read',
  'search',
  'todo',
  'agent',
  'report_intent',
  'vscode/askquestions',
]);

function parseArgs(argv) {
  let projectDir = process.cwd();
  let phase = 'migrate';
  let isHook = false;

  for (let i = 2; i < argv.length; i++) {
    const arg = argv[i];
    if ((arg === '--project' || arg === '-p') && argv[i + 1]) {
      projectDir = path.resolve(argv[++i]);
    } else if (arg === '--phase' && argv[i + 1]) {
      phase = argv[++i];
    } else if (arg === '--hook') {
      isHook = true;
    }
  }
  return { projectDir, phase, isHook };
}

function validateGate(projectDir, phase) {
  const artifactsDir = path.join(projectDir, ARTIFACTS_SUBDIR);
  const diagJsonPath = path.join(artifactsDir, DIAGNOSIS_JSON);
  const diagMdPath = path.join(artifactsDir, DIAGNOSIS_MD);
  const planJsonPath = path.join(artifactsDir, PLAN_JSON);
  const planMdPath = path.join(artifactsDir, PLAN_MD);

  if (!fs.existsSync(diagJsonPath) || !fs.existsSync(diagMdPath)) {
    return {
      allowed: false,
      reason: `Faltan los artefactos de Fase 1 (${DIAGNOSIS_JSON} y/o ${DIAGNOSIS_MD}) en ${ARTIFACTS_SUBDIR}. Ejecuta primero el diagnóstico con el subagente analista.`,
    };
  }

  let diag;
  try {
    diag = JSON.parse(fs.readFileSync(diagJsonPath, 'utf8'));
  } catch (err) {
    return {
      allowed: false,
      reason: `El archivo ${DIAGNOSIS_JSON} no contiene JSON válido: ${err.message}`,
    };
  }

  if (diag.status !== 'READY') {
    const blockerMsg = Array.isArray(diag.blockers) && diag.blockers.length > 0
      ? diag.blockers.map((b) => b.message).join(' ')
      : 'El repositorio no cumple los requisitos mínimos (Angular 21.0.0+).';
    return {
      allowed: false,
      reason: `El diagnóstico está en estado "${diag.status}" (se requiere "READY"). Detalle: ${blockerMsg}`,
    };
  }

  if (diag?.approval?.status !== 'APPROVED') {
    return {
      allowed: false,
      reason: `El diagnóstico (${DIAGNOSIS_JSON}) tiene approval.status="${diag?.approval?.status || 'PENDING'}". Un especialista debe revisarlo y cambiar approval.status a "APPROVED" antes de continuar.`,
    };
  }

  if (phase === 'plan') {
    return {
      allowed: true,
      reason: 'Gate de Fase 2 (Planificación) superado: diagnóstico READY y APPROVED.',
    };
  }

  if (!fs.existsSync(planJsonPath) || !fs.existsSync(planMdPath)) {
    return {
      allowed: false,
      reason: `Faltan los artefactos de Fase 2 (${PLAN_JSON} y/o ${PLAN_MD}) en ${ARTIFACTS_SUBDIR}. Genera primero el plan de migración ejecutable.`,
    };
  }

  let plan;
  try {
    plan = JSON.parse(fs.readFileSync(planJsonPath, 'utf8'));
  } catch (err) {
    return {
      allowed: false,
      reason: `El archivo ${PLAN_JSON} no contiene JSON válido: ${err.message}`,
    };
  }

  if (plan?.approval?.status !== 'APPROVED') {
    return {
      allowed: false,
      reason: `El plan de migración (${PLAN_JSON}) tiene approval.status="${plan?.approval?.status || 'PENDING'}". Un especialista debe aprobar el plan (approval.status="APPROVED") antes de ejecutar la migración.`,
    };
  }

  if (!Array.isArray(plan.tasks) || plan.tasks.length === 0) {
    return {
      allowed: false,
      reason: `El plan de migración (${PLAN_JSON}) no contiene tareas ejecutables en el arreglo "tasks".`,
    };
  }

  return {
    allowed: true,
    reason: 'Gate de Fase 3 (Migración) superado: diagnóstico y plan ejecutable en estado APPROVED.',
  };
}

function extractRawArgsText(event) {
  const raw =
    event.toolArgs ??
    event.toolInput ??
    event.tool_input ??
    event.input ??
    event.arguments ??
    '';

  if (typeof raw === 'string') {
    return raw;
  }
  try {
    return JSON.stringify(raw);
  } catch {
    return '';
  }
}

function shouldAllowWithoutMigrationGate(event) {
  if (!event || typeof event !== 'object') return true;
  const toolName = String(event.toolName || event.tool_name || '').trim().toLowerCase();

  if (!toolName) return true;

  // Always allow known read-only, search, UI, and delegation tools
  if (ALWAYS_ALLOWED_TOOLS.has(toolName)) {
    return true;
  }

  // Only enforce the gate on mutating/shell tools; let unknown read/helper tools pass
  const isMutating = MUTATING_TOOL_PATTERNS.some((p) => toolName.includes(p));
  if (!isMutating) {
    return true;
  }

  const argsText = extractRawArgsText(event);

  // Always allow running the plugin's own prerequisite/diagnosis/gate validator scripts
  if (
    argsText.includes('check-prereqs.mjs') ||
    argsText.includes('generate-diagnosis-report.mjs') ||
    argsText.includes('verify-artifacts-gate.mjs')
  ) {
    return true;
  }

  // Always allow creating/editing files inside .migration-artifacts/karma-to-vitest
  const normalizedArgs = argsText.replace(/\\\\/g, '/').replace(/\\/g, '/');
  if (normalizedArgs.includes('.migration-artifacts/karma-to-vitest')) {
    return true;
  }

  return false;
}

function runHookMode(defaultProjectDir) {
  let stdinText = '';
  try {
    stdinText = fs.readFileSync(0, 'utf8').trim();
  } catch {
    stdinText = '';
  }

  let event = {};
  if (stdinText) {
    try {
      event = JSON.parse(stdinText);
    } catch {
      event = {};
    }
  }

  if (shouldAllowWithoutMigrationGate(event)) {
    process.stdout.write('{}\n');
    process.exit(0);
  }

  const projectDir = event.cwd ? path.resolve(event.cwd) : defaultProjectDir;
  const check = validateGate(projectDir, 'migrate');

  if (check.allowed) {
    process.stdout.write('{}\n');
  } else {
    process.stdout.write(
      `${JSON.stringify({
        permissionDecision: 'deny',
        permissionDecisionReason: check.reason,
      })}\n`
    );
  }
}

function main() {
  const { projectDir, phase, isHook } = parseArgs(process.argv);

  if (isHook) {
    runHookMode(projectDir);
    return;
  }

  const result = validateGate(projectDir, phase);
  if (result.allowed) {
    process.stdout.write(`${JSON.stringify({ status: 'ALLOWED', phase, message: result.reason }, null, 2)}\n`);
    process.exit(0);
  } else {
    process.stderr.write(`${JSON.stringify({ status: 'DENIED', phase, message: result.reason }, null, 2)}\n`);
    process.exit(1);
  }
}

main();
