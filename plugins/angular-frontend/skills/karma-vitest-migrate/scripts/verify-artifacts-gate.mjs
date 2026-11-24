#!/usr/bin/env node
/**
 * Gate validator & agent-scoped preToolUse hook for the Angular Karma-to-Vitest migration workflow.
 *
 * Modes:
 * 1. CLI mode:
 *    node verify-artifacts-gate.mjs --project <dir> --phase <plan|migrate> [--plan-phase <phaseId>]
 *    Exits with 0 if the required artifacts exist and are APPROVED, or 1 otherwise.
 *
 * 2. Copilot harness preToolUse Hook mode (agent-scoped across all 4 agents):
 *    - Orchestrator:       node verify-artifacts-gate.mjs --hook --phase orchestrate [--project <dir>]
 *    - Analyst (Phase 1):  node verify-artifacts-gate.mjs --hook --phase audit [--project <dir>]
 *    - Planner (Phase 2):  node verify-artifacts-gate.mjs --hook --phase plan [--project <dir>]
 *    - Migrator (Phase 3): node verify-artifacts-gate.mjs --hook --phase migrate [--project <dir>] [--plan-phase <phaseId>]
 *    Reads the Copilot harness preToolUse camelCase event JSON from stdin:
 *      { sessionId, timestamp, cwd, toolName, toolArgs }
 *    Outputs flat Copilot harness JSON to stdout:
 *      - {} (NO_DECISION: lets the harness continue its normal permission flow)
 *      - {"permissionDecision":"deny","permissionDecisionReason":"..."} (DENY)
 *
 * Security model (Workflow Level 1 — NOT a replacement for OS sandboxing or org policies):
 * Three explicit decision states:
 *   - DENY (unconditional, never bypassed by workflow approval):
 *       * Invalid/empty stdin, missing toolName, malformed toolArgs, or invalid --phase.
 *       * Unknown runtime toolName (strictly separated from agent frontmatter aliases).
 *       * Subagent delegation via "task" inside Analyst, Planner, and Migrator (allowed ONLY in Orchestrator).
 *       * Unverifiable/malformed file targets, non-file URIs, UNC paths, symlink escapes,
 *         or mutations targeting paths outside the workspace root.
 *       * Phase 1 diagnosis artifacts (01-diagnosis-report.*) are immutable in Planner and Migrator hooks.
 *       * approve-artifact.mjs is strictly forbidden inside Analyst, Planner, and Migrator (no self-approval).
 *       * In --phase orchestrate: ALL file edits and ALL shell commands except approve-artifact.mjs.
 *       * In --phase audit (Analyst): ALL file edits and ALL shell commands except generate-diagnosis-report.mjs / check-prereqs.mjs.
 *       * In --phase plan (Planner): ANY file write outside 02-migration-plan.{json,md} and plans/phase-XX-*.{json,md},
 *         and ANY shell command outside authorized read/plan plugin scripts.
 *   - NO_DECISION ({}):
 *       * Officially documented read-only/non-mutating runtime tools (view, glob, grep,
 *         ask_user, web_fetch, update_todo), plus task and vscode/askQuestions in Orchestrator only.
 *       * Exact invocations of phase-authorized plugin scripts (verified via canonical realpath,
 *         closed grammar, strict per-script contract, and --project constrained inside workspace).
 *   - REQUIRE_GATE:
 *       * In --phase plan (Planner): generating/writing plan files requires diagnosis READY + APPROVED.
 *       * In --phase migrate (Migrator): workspace file mutations and shell commands require diagnosis
 *         READY + APPROVED, matching diagnosisHash, sequential prior phases COMPLETED, active phase
 *         APPROVED with tasks, and (when targetFiles are declared) target path within active phase targetFiles.
 *
 * Zero external dependencies — uses only built-in Node.js modules.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ARTIFACTS_SUBDIR = path.join('.migration-artifacts', 'karma-to-vitest');
const PLANS_SUBDIR = 'plans';
const DIAGNOSIS_JSON = '01-diagnosis-report.json';
const DIAGNOSIS_MD = '01-diagnosis-report.md';
const DIAGNOSIS_HTML = '01-diagnosis-report.html';
const PLAN_JSON = '02-migration-plan.json';
const PLAN_MD = '02-migration-plan.md';

const PHASE1_IMMUTABLE_ARTIFACTS = new Set([DIAGNOSIS_JSON, DIAGNOSIS_MD, DIAGNOSIS_HTML]);
const PHASE2_MASTER_ARTIFACTS = new Set([PLAN_JSON, PLAN_MD]);
const PHASE_PLAN_ARTIFACT_REGEX = /^plans\/phase-\d{2}-[a-z0-9-]+\.(json|md)$/;
const PHASE_ID_REGEX = /^phase-\d{2}-[a-z0-9-]+$/;

const VALID_HOOK_PHASES = new Set(['orchestrate', 'audit', 'plan', 'migrate']);

const THIS_FILE = fileURLToPath(import.meta.url);
const PLUGIN_ROOT_DIR = path.resolve(path.dirname(THIS_FILE), '..', '..', '..');

const TRUSTED_SCRIPT_SPECS = [
  {
    name: 'check-prereqs.mjs',
    relPath: path.join('skills', 'angular-migration-prereqs', 'scripts', 'check-prereqs.mjs'),
  },
  {
    name: 'generate-diagnosis-report.mjs',
    relPath: path.join('skills', 'karma-vitest-audit', 'scripts', 'generate-diagnosis-report.mjs'),
  },
  {
    name: 'generate-migration-plan.mjs',
    relPath: path.join('skills', 'karma-vitest-audit', 'scripts', 'generate-migration-plan.mjs'),
  },
  {
    name: 'verify-artifacts-gate.mjs',
    relPath: path.join('skills', 'karma-vitest-migrate', 'scripts', 'verify-artifacts-gate.mjs'),
  },
  {
    name: 'approve-artifact.mjs',
    relPath: path.join('skills', 'karma-vitest-migrate', 'scripts', 'approve-artifact.mjs'),
  },
];

// Least-privilege per-phase allowlist for trusted plugin scripts
const ALLOWED_SCRIPTS_BY_PHASE = new Map([
  ['orchestrate', new Set(['approve-artifact.mjs'])],
  ['audit', new Set(['generate-diagnosis-report.mjs', 'check-prereqs.mjs'])],
  [
    'plan',
    new Set([
      'verify-artifacts-gate.mjs',
      'generate-migration-plan.mjs',
      'check-prereqs.mjs',
      'generate-diagnosis-report.mjs',
    ]),
  ],
  [
    'migrate',
    new Set(['verify-artifacts-gate.mjs', 'check-prereqs.mjs', 'generate-diagnosis-report.mjs']),
  ],
]);

function realpathNative(p) {
  return typeof fs.realpathSync.native === 'function'
    ? fs.realpathSync.native(p)
    : fs.realpathSync(p);
}

function buildTrustedScriptMap() {
  const map = new Map();
  for (const spec of TRUSTED_SCRIPT_SPECS) {
    const absPath = path.resolve(PLUGIN_ROOT_DIR, spec.relPath);
    try {
      map.set(realpathNative(absPath), spec.name);
    } catch {
      map.set(absPath, spec.name);
    }
  }
  return map;
}

const TRUSTED_SCRIPT_REALPATHS = buildTrustedScriptMap();

// Official GitHub Copilot preToolUse runtime tool identifiers ONLY
const READ_ONLY_RUNTIME_TOOLS = new Set([
  'view',
  'glob',
  'grep',
  'ask_user',
  'web_fetch',
  'update_todo',
]);

// Tools permitted ONLY in Orchestrator (never in Analyst, Planner, or Migrator)
const ORCHESTRATOR_ONLY_TOOLS = new Set(['task', 'vscode/askquestions']);

// Subagent delegation tool in Copilot runtime: unconditionally denied inside Analyst, Planner & Migrator
const BLOCKED_DELEGATION_TOOLS = new Set(['task']);

// Official shell execution tools in Copilot preToolUse runtime
const SHELL_RUNTIME_TOOLS = new Set(['bash', 'powershell']);

// Closed grammar: disallow Bash, PowerShell, and Windows CMD metacharacters / expansions
const FORBIDDEN_SHELL_CHARS_REGEX =
  process.platform === 'win32'
    ? /[$`%!&|;<>(){}*?~#^\r\n\0]/
    : /[$`%!&|;<>(){}*?~#^\\\r\n\0]/;

const SAFE_ANGULAR_PROJECT_NAME_REGEX = /^[a-zA-Z0-9._/@-]+$/;
const SAFE_REVIEWER_REGEX = /^[a-zA-Z0-9._@ -]{1,80}$/;

function parseArgs(argv) {
  let projectDir = process.cwd();
  let phase = 'migrate';
  let planPhase = null;
  let isHook = false;

  for (let i = 2; i < argv.length; i++) {
    const arg = argv[i];
    if ((arg === '--project' || arg === '-p') && argv[i + 1]) {
      projectDir = path.resolve(argv[++i]);
    } else if (arg === '--phase' && argv[i + 1]) {
      phase = argv[++i];
    } else if (arg === '--plan-phase' && argv[i + 1]) {
      planPhase = argv[++i].trim();
    } else if (arg === '--hook') {
      isHook = true;
    }
  }
  return { projectDir, phase, planPhase, isHook };
}

function normalizePosixRel(p) {
  return String(p || '')
    .replace(/\\/g, '/')
    .replace(/^\.\//, '')
    .replace(/\/+/g, '/');
}

function collectAllowedTargetFiles(tasks) {
  const set = new Set();
  if (!Array.isArray(tasks)) return set;
  for (const task of tasks) {
    if (!task || !Array.isArray(task.targetFiles)) continue;
    for (const f of task.targetFiles) {
      if (typeof f === 'string' && f.trim()) {
        set.add(normalizePosixRel(f.trim()));
      }
    }
  }
  return set;
}

function validateGate(projectDir, phase, requestedPlanPhase = null) {
  if (phase !== 'plan' && phase !== 'migrate') {
    return {
      allowed: false,
      reason: `Fase de validación CLI inválida "${phase}" (se esperaba "plan" o "migrate").`,
    };
  }

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
    const blockerMsg =
      Array.isArray(diag.blockers) && diag.blockers.length > 0
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

  // Multi-phase plan mode (schemaVersion 2.0.0, planMode: "multi-phase")
  if (plan.planMode === 'multi-phase') {
    if (!Array.isArray(plan.phases) || plan.phases.length === 0) {
      return {
        allowed: false,
        reason: `El plan maestro (${PLAN_JSON}) no contiene fases en el arreglo "phases".`,
      };
    }

    if (diag.diagnosisHash && plan.diagnosisHash && diag.diagnosisHash !== plan.diagnosisHash) {
      return {
        allowed: false,
        reason: `Deriva detectada entre diagnóstico y plan maestro (diagnosisHash: ${diag.diagnosisHash} vs ${plan.diagnosisHash}). Regenera el plan de Fase 2.`,
      };
    }

    const sortedPhases = [...plan.phases].sort((a, b) => (a.order || 0) - (b.order || 0));

    // Load each phase file and determine the target active phase
    const loadedPhases = [];
    for (const entry of sortedPhases) {
      if (!entry || typeof entry.phaseId !== 'string' || !PHASE_ID_REGEX.test(entry.phaseId)) {
        return {
          allowed: false,
          reason: `Identificador de fase inválido en ${PLAN_JSON}: "${entry?.phaseId}".`,
        };
      }
      const phaseJsonPath = path.join(artifactsDir, PLANS_SUBDIR, `${entry.phaseId}.json`);
      if (!fs.existsSync(phaseJsonPath)) {
        return {
          allowed: false,
          reason: `Falta el archivo de fase plans/${entry.phaseId}.json referenciado en ${PLAN_JSON}.`,
        };
      }
      let phaseObj;
      try {
        phaseObj = JSON.parse(fs.readFileSync(phaseJsonPath, 'utf8'));
      } catch (err) {
        return {
          allowed: false,
          reason: `El archivo plans/${entry.phaseId}.json no contiene JSON válido: ${err.message}`,
        };
      }
      loadedPhases.push({ entry, phaseObj });
    }

    let activeRecord = null;
    if (requestedPlanPhase) {
      if (!PHASE_ID_REGEX.test(requestedPlanPhase)) {
        return {
          allowed: false,
          reason: `Valor de --plan-phase inválido: "${requestedPlanPhase}".`,
        };
      }
      activeRecord = loadedPhases.find((r) => r.entry.phaseId === requestedPlanPhase) || null;
      if (!activeRecord) {
        return {
          allowed: false,
          reason: `La fase solicitada "${requestedPlanPhase}" no existe en ${PLAN_JSON}.`,
        };
      }
    } else {
      activeRecord = loadedPhases.find((r) => r.phaseObj.status !== 'COMPLETED') || null;
      if (!activeRecord) {
        return {
          allowed: false,
          reason: `Todas las fases en ${PLAN_JSON} ya están en estado COMPLETED. No hay fases pendientes de migración.`,
        };
      }
    }

    const activeId = activeRecord.entry.phaseId;
    const activePhase = activeRecord.phaseObj;

    if (diag.diagnosisHash && activePhase.diagnosisHash && diag.diagnosisHash !== activePhase.diagnosisHash) {
      return {
        allowed: false,
        reason: `Deriva detectada en plans/${activeId}.json (diagnosisHash: ${diag.diagnosisHash} vs ${activePhase.diagnosisHash}). Regenera el plan antes de migrar.`,
      };
    }

    // Sequential gate: every prior phase must be COMPLETED
    for (const prev of loadedPhases) {
      if (prev.entry.phaseId === activeId) break;
      if (prev.phaseObj.status !== 'COMPLETED') {
        return {
          allowed: false,
          reason: `No se puede ejecutar "${activeId}" porque la fase previa "${prev.entry.phaseId}" está en estado "${prev.phaseObj.status}" (debe ser "COMPLETED").`,
        };
      }
    }

    if (activePhase.dependsOnPhase) {
      const dep = loadedPhases.find((r) => r.entry.phaseId === activePhase.dependsOnPhase);
      if (!dep || dep.phaseObj.status !== 'COMPLETED') {
        return {
          allowed: false,
          reason: `La fase "${activeId}" depende de "${activePhase.dependsOnPhase}", que no está en estado COMPLETED.`,
        };
      }
    }

    if (activePhase?.approval?.status !== 'APPROVED') {
      return {
        allowed: false,
        reason: `La fase "${activeId}" (plans/${activeId}.json) tiene approval.status="${activePhase?.approval?.status || 'PENDING'}". Un especialista debe aprobar esta fase antes de ejecutarla.`,
      };
    }

    if (!Array.isArray(activePhase.tasks) || activePhase.tasks.length === 0) {
      return {
        allowed: false,
        reason: `La fase "${activeId}" no contiene tareas ejecutables en "tasks".`,
      };
    }

    const allowedTargetFiles = collectAllowedTargetFiles(activePhase.tasks);

    return {
      allowed: true,
      planMode: 'multi-phase',
      activePhaseId: activeId,
      allowedTargetFiles,
      reason: `Gate de Fase 3 superado para la fase "${activeId}": diagnóstico READY + APPROVED, fases previas COMPLETED y fase activa APPROVED.`,
    };
  }

  // Legacy monolithic single-plan mode (backward compatibility)
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

  const allowedTargetFiles = collectAllowedTargetFiles(plan.tasks);

  return {
    allowed: true,
    planMode: 'single-plan',
    activePhaseId: null,
    allowedTargetFiles,
    reason: 'Gate de Fase 3 (Migración) superado: diagnóstico y plan ejecutable en estado APPROVED.',
  };
}

/**
 * Strict camelCase contract for Copilot preToolUse: reads ONLY event.toolArgs.
 */
function parseToolArgsObject(event) {
  if (!Object.prototype.hasOwnProperty.call(event, 'toolArgs')) {
    return null;
  }
  const raw = event.toolArgs;
  if (raw === undefined || raw === null) {
    return null;
  }
  if (typeof raw === 'string') {
    const trimmed = raw.trim();
    if (!trimmed) return null;
    try {
      const parsed = JSON.parse(trimmed);
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
    } catch {
      return null;
    }
  }
  if (typeof raw === 'object' && !Array.isArray(raw)) {
    return raw;
  }
  return null;
}

function resolveRealPathAllowingMissingTail(targetPath) {
  const absolute = path.resolve(targetPath);
  const missingSegments = [];
  let current = absolute;

  while (!fs.existsSync(current)) {
    const parent = path.dirname(current);
    if (parent === current) {
      return absolute;
    }
    missingSegments.unshift(path.basename(current));
    current = parent;
  }

  const realExisting = realpathNative(current);
  return missingSegments.length > 0
    ? path.join(realExisting, ...missingSegments)
    : realExisting;
}

function isStrictSubpathOrEqual(baseDir, candidatePath, { allowEqual = false } = {}) {
  const rel = path.relative(baseDir, candidatePath);
  if (rel === '') {
    return allowEqual;
  }
  if (path.isAbsolute(rel)) {
    return false;
  }
  const segments = rel.split(path.sep);
  return segments[0] !== '..' && !segments.includes('..');
}

function tokenizeClosedCommand(command) {
  if (typeof command !== 'string') return null;
  const trimmed = command.trim();
  if (!trimmed || FORBIDDEN_SHELL_CHARS_REGEX.test(trimmed)) {
    return null;
  }
  if (process.platform === 'win32' && /\\["']/.test(trimmed)) {
    return null;
  }

  const tokens = [];
  let current = '';
  let inToken = false;
  let quote = null;

  for (let i = 0; i < trimmed.length; i++) {
    const ch = trimmed[i];

    if (quote) {
      if (ch === quote) {
        quote = null;
      } else {
        current += ch;
      }
      continue;
    }

    if (ch === '"' || ch === "'") {
      quote = ch;
      inToken = true;
      continue;
    }

    if (ch === ' ' || ch === '\t') {
      if (inToken) {
        tokens.push(current);
        current = '';
        inToken = false;
      }
      continue;
    }

    current += ch;
    inToken = true;
  }

  if (quote !== null) {
    return null;
  }
  if (inToken) {
    tokens.push(current);
  }
  return tokens.length > 0 ? tokens : null;
}

function isAllowedNodeExecutable(execToken) {
  if (!execToken || typeof execToken !== 'string') return false;

  if (path.isAbsolute(execToken)) {
    try {
      return realpathNative(execToken) === realpathNative(process.execPath);
    } catch {
      return false;
    }
  }

  const lower = execToken.toLowerCase();
  return lower === 'node' || lower === 'node.exe';
}

function isProjectArgWithinWorkspace(projectArg, projectDir) {
  if (!projectArg || typeof projectArg !== 'string' || projectArg.startsWith('-')) {
    return false;
  }
  if (isUncPath(projectArg)) {
    return false;
  }
  try {
    const workspaceReal = resolveRealPathAllowingMissingTail(projectDir);
    const targetReal = resolveRealPathAllowingMissingTail(path.resolve(projectDir, projectArg));
    return isStrictSubpathOrEqual(workspaceReal, targetReal, { allowEqual: true });
  } catch {
    return false;
  }
}

function validateScriptContractArgs(scriptName, args, projectDir) {
  const seen = new Set();

  for (let i = 0; i < args.length; i++) {
    const flag = args[i];

    if (flag === '--project' || flag === '-p') {
      if (seen.has('project')) return false;
      const val = args[i + 1];
      if (!val || !isProjectArgWithinWorkspace(val, projectDir)) {
        return false;
      }
      seen.add('project');
      i++;
      continue;
    }

    if (
      (scriptName === 'generate-diagnosis-report.mjs' || scriptName === 'generate-migration-plan.mjs') &&
      flag === '--angular-project'
    ) {
      if (seen.has('angular-project')) return false;
      const val = args[i + 1];
      if (!val || val.startsWith('-') || val.includes('..') || !SAFE_ANGULAR_PROJECT_NAME_REGEX.test(val)) {
        return false;
      }
      seen.add('angular-project');
      i++;
      continue;
    }

    if (scriptName === 'verify-artifacts-gate.mjs' && flag === '--phase') {
      if (seen.has('phase')) return false;
      const val = args[i + 1];
      if (val !== 'plan' && val !== 'migrate') return false;
      seen.add('phase');
      i++;
      continue;
    }

    if (scriptName === 'verify-artifacts-gate.mjs' && flag === '--plan-phase') {
      if (seen.has('plan-phase')) return false;
      const val = args[i + 1];
      if (!val || !PHASE_ID_REGEX.test(val)) return false;
      seen.add('plan-phase');
      i++;
      continue;
    }

    if (scriptName === 'verify-artifacts-gate.mjs' && flag === '--hook') {
      if (seen.has('hook')) return false;
      seen.add('hook');
      continue;
    }

    if (scriptName === 'approve-artifact.mjs' && flag === '--artifact') {
      if (seen.has('artifact')) return false;
      const val = args[i + 1];
      if (val !== 'diagnosis' && val !== 'phase') return false;
      seen.add('artifact');
      i++;
      continue;
    }

    if (scriptName === 'approve-artifact.mjs' && flag === '--plan-phase') {
      if (seen.has('plan-phase')) return false;
      const val = args[i + 1];
      if (!val || !PHASE_ID_REGEX.test(val)) return false;
      seen.add('plan-phase');
      i++;
      continue;
    }

    if (scriptName === 'approve-artifact.mjs' && flag === '--reviewer') {
      if (seen.has('reviewer')) return false;
      const val = args[i + 1];
      if (!val || !SAFE_REVIEWER_REGEX.test(val)) return false;
      seen.add('reviewer');
      i++;
      continue;
    }

    if (scriptName === 'approve-artifact.mjs' && flag === '--mode') {
      if (seen.has('mode')) return false;
      const val = args[i + 1];
      if (val !== 'chat-confirmed' && val !== 'manual-json') return false;
      seen.add('mode');
      i++;
      continue;
    }

    return false;
  }

  return true;
}

/**
 * Inspects a shell command against the canonical trusted plugin scripts registry.
 * Returns { matchedScriptName, validArgs } or null if not a trusted plugin script.
 */
function inspectTrustedPluginScriptInvocation(command, projectDir) {
  const tokens = tokenizeClosedCommand(command);
  if (!tokens || tokens.length < 2) return null;

  const [execToken, scriptToken, ...restArgs] = tokens;
  if (!isAllowedNodeExecutable(execToken)) return null;
  if (scriptToken.startsWith('-')) return null;

  const resolvedScript = path.resolve(projectDir, scriptToken);
  let realScript;
  try {
    realScript = realpathNative(resolvedScript);
  } catch {
    return null;
  }

  const matchedScriptName = TRUSTED_SCRIPT_REALPATHS.get(realScript);
  if (!matchedScriptName) {
    return null;
  }

  const validArgs = validateScriptContractArgs(matchedScriptName, restArgs, projectDir);
  return { matchedScriptName, validArgs };
}

// =============================================================================
// Per-tool target extraction adapters (conservative, schema-aware)
// =============================================================================

function isUncPath(raw) {
  return /^\\\\/.test(raw) || /^\/\/[^/]/.test(raw);
}

function normalizeTargetPath(rawTarget) {
  if (typeof rawTarget !== 'string') return null;
  const trimmed = rawTarget.trim();
  if (!trimmed || trimmed.includes('\0') || isUncPath(trimmed)) {
    return null;
  }

  if (/^file:\/\//i.test(trimmed)) {
    try {
      const converted = fileURLToPath(trimmed);
      if (!converted || isUncPath(converted)) return null;
      return converted;
    } catch {
      return null;
    }
  }

  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(trimmed)) {
    return null;
  }

  if (process.platform !== 'win32' && /^[a-zA-Z]:[\\/]/.test(trimmed)) {
    return null;
  }

  return trimmed;
}

function getExactlyOneStringField(argsObj, candidateKeys, forbiddenKeys = []) {
  for (const forbidden of forbiddenKeys) {
    if (Object.prototype.hasOwnProperty.call(argsObj, forbidden)) {
      return null;
    }
  }
  const found = [];
  for (const key of candidateKeys) {
    if (Object.prototype.hasOwnProperty.call(argsObj, key)) {
      const val = argsObj[key];
      if (typeof val !== 'string' || !val.trim()) return null;
      found.push(val);
    }
  }
  return found.length === 1 ? found[0] : null;
}

const UNEXPECTED_MULTI_KEYS = [
  'paths',
  'files',
  'edits',
  'changes',
  'oldPath',
  'newPath',
  'sourcePath',
  'destinationPath',
  'from',
  'to',
];

function extractEditTargets(argsObj) {
  const target = getExactlyOneStringField(argsObj, ['path', 'filePath', 'uri'], UNEXPECTED_MULTI_KEYS);
  return target ? [target] : null;
}

function extractCreateTargets(argsObj) {
  const target = getExactlyOneStringField(argsObj, ['path', 'filePath', 'uri'], UNEXPECTED_MULTI_KEYS);
  return target ? [target] : null;
}

function extractDeleteTargets(argsObj) {
  const target = getExactlyOneStringField(argsObj, ['path', 'filePath', 'uri'], UNEXPECTED_MULTI_KEYS);
  return target ? [target] : null;
}

function extractPairTargets(argsObj) {
  const source = getExactlyOneStringField(argsObj, ['oldPath', 'sourcePath', 'from']);
  const dest = getExactlyOneStringField(argsObj, ['newPath', 'destinationPath', 'to']);
  if (!source || !dest) return null;
  return [source, dest];
}

function extractPatchTargets(argsObj) {
  const patchText = getExactlyOneStringField(argsObj, ['patch', 'input', 'diff']);
  if (!patchText) return null;

  const lines = patchText.split(/\r?\n/);
  const hasBegin = lines.some((l) => l.trim() === '*** Begin Patch');
  const hasEnd = lines.some((l) => l.trim() === '*** End Patch');
  if (!hasBegin || !hasEnd) {
    return null;
  }

  const targets = [];
  for (const line of lines) {
    const match = line.match(/^\*\*\*\s+(Add File|Update File|Delete File|Move to):(.*)$/);
    if (match) {
      const target = match[2].trim();
      if (!target) {
        return null;
      }
      targets.push(target);
    }
  }

  return targets.length > 0 ? targets : null;
}

const FILE_MUTATION_ADAPTERS = new Map([
  ['edit', extractEditTargets],
  ['create', extractCreateTargets],
  ['delete', extractDeleteTargets],
  ['rename', extractPairTargets],
  ['move', extractPairTargets],
  ['apply_patch', extractPatchTargets],
  ['patch', extractPatchTargets],
]);

/**
 * Classifies a single target path into:
 *   - { kind: 'INVALID', reason }
 *   - { kind: 'INSIDE_ARTIFACTS', artifactRel, workspaceRel }
 *   - { kind: 'INSIDE_WORKSPACE', workspaceRel }
 */
function classifyTargetPath(rawTarget, projectDir) {
  const normalized = normalizeTargetPath(rawTarget);
  if (!normalized) {
    return { kind: 'INVALID', reason: `Ruta o URI de destino inválida o no verificable: "${rawTarget}".` };
  }

  const workspaceAbs = path.resolve(projectDir);
  const artifactsAbs = path.resolve(projectDir, ARTIFACTS_SUBDIR);
  const candidateAbs = path.resolve(projectDir, normalized);

  let workspaceReal;
  let artifactsReal;
  let candidateReal;
  try {
    workspaceReal = resolveRealPathAllowingMissingTail(workspaceAbs);
    artifactsReal = resolveRealPathAllowingMissingTail(artifactsAbs);
    candidateReal = resolveRealPathAllowingMissingTail(candidateAbs);
  } catch {
    return { kind: 'INVALID', reason: `No se pudo resolver la ruta real para "${rawTarget}".` };
  }

  const lexicallyInArtifacts = isStrictSubpathOrEqual(artifactsAbs, candidateAbs, { allowEqual: false });
  const reallyInArtifacts = isStrictSubpathOrEqual(artifactsReal, candidateReal, { allowEqual: false });

  if (lexicallyInArtifacts && !reallyInArtifacts) {
    return {
      kind: 'INVALID',
      reason: `Escape mediante symlink detectado fuera de ${ARTIFACTS_SUBDIR} en "${rawTarget}".`,
    };
  }

  const reallyInWorkspace = isStrictSubpathOrEqual(workspaceReal, candidateReal, { allowEqual: false });
  if (!reallyInWorkspace) {
    return {
      kind: 'INVALID',
      reason: `El destino "${rawTarget}" resuelve fuera del workspace actual (${projectDir}).`,
    };
  }

  const workspaceRel = normalizePosixRel(path.relative(workspaceReal, candidateReal));

  if (reallyInArtifacts) {
    const artifactRel = normalizePosixRel(path.relative(artifactsReal, candidateReal));
    return { kind: 'INSIDE_ARTIFACTS', artifactRel, workspaceRel };
  }

  return { kind: 'INSIDE_WORKSPACE', workspaceRel };
}

function isPlannerWritableArtifact(artifactRel) {
  return PHASE2_MASTER_ARTIFACTS.has(artifactRel) || PHASE_PLAN_ARTIFACT_REGEX.test(artifactRel);
}

/**
 * Evaluates a preToolUse hook event into one of three explicit outcomes:
 *   - { decision: 'DENY', reason }
 *   - { decision: 'NO_DECISION' }
 *   - { decision: 'REQUIRE_GATE', gatePhase, classifications? }
 */
function evaluateToolCall(event, projectDir, phase) {
  if (!VALID_HOOK_PHASES.has(phase)) {
    return {
      decision: 'DENY',
      reason: `Fase de hook inválida "${phase}" (se esperaba "orchestrate", "audit", "plan" o "migrate").`,
    };
  }

  if (!event || typeof event !== 'object' || Array.isArray(event)) {
    return {
      decision: 'DENY',
      reason: 'Payload de hook preToolUse inválido o vacío (denegación fail-closed).',
    };
  }

  if (typeof event.toolName !== 'string' || !event.toolName.trim()) {
    return {
      decision: 'DENY',
      reason: 'Falta el campo oficial "toolName" en el evento preToolUse (denegación fail-closed).',
    };
  }

  const toolName = event.toolName.trim().toLowerCase();

  // Orchestrator-only tools (task delegation and VS Code askQuestions widget)
  if (ORCHESTRATOR_ONLY_TOOLS.has(toolName)) {
    if (phase === 'orchestrate') {
      return { decision: 'NO_DECISION' };
    }
    if (BLOCKED_DELEGATION_TOOLS.has(toolName)) {
      return {
        decision: 'DENY',
        reason: `La herramienta de delegación "${toolName}" está bloqueada en fase "${phase}" para evitar mutaciones no auditadas en subagentes.`,
      };
    }
    return {
      decision: 'DENY',
      reason: `Herramienta "${event.toolName}" solo autorizada para el Orquestador (denegada en "${phase}").`,
    };
  }

  // Officially documented read-only / non-mutating runtime tools
  if (READ_ONLY_RUNTIME_TOOLS.has(toolName)) {
    return { decision: 'NO_DECISION' };
  }

  // Known shell runtime tools (bash, powershell)
  if (SHELL_RUNTIME_TOOLS.has(toolName)) {
    const argsObj = parseToolArgsObject(event);
    const command =
      argsObj && typeof argsObj.command === 'string' && argsObj.command.trim()
        ? argsObj.command
        : null;

    if (!command) {
      return {
        decision: 'DENY',
        reason: `Argumentos inválidos o sin campo "command" para la herramienta "${toolName}".`,
      };
    }

    const trusted = inspectTrustedPluginScriptInvocation(command, projectDir);
    const allowedScripts = ALLOWED_SCRIPTS_BY_PHASE.get(phase);

    if (trusted) {
      if (!trusted.validArgs) {
        return {
          decision: 'DENY',
          reason: `Argumentos inválidos o fuera de contrato para el script "${trusted.matchedScriptName}".`,
        };
      }
      if (!allowedScripts.has(trusted.matchedScriptName)) {
        return {
          decision: 'DENY',
          reason: `El script "${trusted.matchedScriptName}" no está autorizado en la fase "${phase}".`,
        };
      }
      // Generating migration plan in Phase 2 still requires Phase 1 gate (READY + APPROVED)
      if (phase === 'plan' && trusted.matchedScriptName === 'generate-migration-plan.mjs') {
        return { decision: 'REQUIRE_GATE', gatePhase: 'plan' };
      }
      return { decision: 'NO_DECISION' };
    }

    // Orchestrator, Analyst, and Planner may NEVER run arbitrary shell commands
    if (phase !== 'migrate') {
      return {
        decision: 'DENY',
        reason: `Comandos shell arbitrarios bloqueados en fase "${phase}". Solo se permiten los scripts oficiales autorizados para este agente.`,
      };
    }

    // Extra defense: never allow invoking approve-artifact.mjs by any alias inside Migrator
    if (command.includes('approve-artifact.mjs')) {
      return {
        decision: 'DENY',
        reason: 'Karma-Vitest Migrator no puede ejecutar approve-artifact.mjs (prohibida la auto-aprobación).',
      };
    }

    return { decision: 'REQUIRE_GATE', gatePhase: 'migrate' };
  }

  // Known file mutation tools with dedicated per-tool adapters
  if (FILE_MUTATION_ADAPTERS.has(toolName)) {
    // Orchestrator and Analyst must NEVER mutate files via file-mutation tools
    if (phase === 'orchestrate' || phase === 'audit') {
      return {
        decision: 'DENY',
        reason: `La herramienta de escritura "${toolName}" está estrictamente bloqueada en fase "${phase}".`,
      };
    }

    const argsObj = parseToolArgsObject(event);
    if (!argsObj) {
      return {
        decision: 'DENY',
        reason: `Argumentos "toolArgs" inválidos o vacíos para la herramienta "${toolName}".`,
      };
    }

    const extractTargets = FILE_MUTATION_ADAPTERS.get(toolName);
    const targets = extractTargets(argsObj);
    if (!targets || targets.length === 0) {
      return {
        decision: 'DENY',
        reason: `No se pudieron verificar todos los destinos de la herramienta "${toolName}" según su esquema esperado.`,
      };
    }

    const classifications = [];
    for (const target of targets) {
      const classification = classifyTargetPath(target, projectDir);
      if (classification.kind === 'INVALID') {
        return { decision: 'DENY', reason: classification.reason };
      }

      // Phase 1 diagnosis artifacts are immutable during Planner and Migrator
      if (
        classification.kind === 'INSIDE_ARTIFACTS' &&
        PHASE1_IMMUTABLE_ARTIFACTS.has(classification.artifactRel)
      ) {
        return {
          decision: 'DENY',
          reason: `Los artefactos de diagnóstico de Fase 1 (${classification.artifactRel}) son inmutables y no pueden ser modificados por el agente.`,
        };
      }

      // In Phase 2 (Planner): ONLY 02-migration-plan.{json,md} and plans/phase-XX-*.{json,md}
      if (phase === 'plan') {
        if (
          classification.kind !== 'INSIDE_ARTIFACTS' ||
          !isPlannerWritableArtifact(classification.artifactRel)
        ) {
          return {
            decision: 'DENY',
            reason: `Karma-Vitest Planner solo puede escribir ${PLAN_JSON}, ${PLAN_MD} y plans/phase-XX-*.{json,md} dentro de ${ARTIFACTS_SUBDIR}. Destino bloqueado: "${target}".`,
          };
        }
      }

      classifications.push({ rawTarget: target, ...classification });
    }

    return { decision: 'REQUIRE_GATE', gatePhase: phase, classifications };
  }

  // Unknown tool -> UNCONDITIONAL DENY
  return {
    decision: 'DENY',
    reason: `Herramienta desconocida o no autorizada "${event.toolName}" (default-deny).`,
  };
}

function validateMigratorTargetScope(classifications, gateResult) {
  if (!Array.isArray(classifications) || classifications.length === 0) {
    return { allowed: true };
  }

  const allowedTargets = gateResult.allowedTargetFiles || new Set();
  const enforceWorkspaceTargets = allowedTargets.size > 0;
  const activePhaseRel = gateResult.activePhaseId
    ? `plans/${gateResult.activePhaseId}.json`
    : null;

  for (const item of classifications) {
    if (item.kind === 'INSIDE_ARTIFACTS') {
      if (gateResult.planMode === 'multi-phase') {
        if (item.artifactRel !== PLAN_JSON && item.artifactRel !== activePhaseRel) {
          return {
            allowed: false,
            reason: `Durante la fase activa "${gateResult.activePhaseId}", Migrator solo puede actualizar ${PLAN_JSON} o ${activePhaseRel}. Destino bloqueado: "${item.rawTarget}".`,
          };
        }
      } else {
        if (item.artifactRel !== PLAN_JSON) {
          return {
            allowed: false,
            reason: `Migrator solo puede actualizar el estado de tareas en ${PLAN_JSON}. Destino bloqueado: "${item.rawTarget}".`,
          };
        }
      }
      continue;
    }

    if (item.kind === 'INSIDE_WORKSPACE' && enforceWorkspaceTargets) {
      if (!allowedTargets.has(item.workspaceRel)) {
        const phaseLabel = gateResult.activePhaseId ? ` de la fase aprobada "${gateResult.activePhaseId}"` : ' del plan aprobado';
        return {
          allowed: false,
          reason: `El archivo "${item.workspaceRel}" no figura en targetFiles${phaseLabel}. Edición fuera de alcance denegada.`,
        };
      }
    }
  }

  return { allowed: true };
}

function emitDeny(reason) {
  process.stdout.write(
    `${JSON.stringify({
      permissionDecision: 'deny',
      permissionDecisionReason: reason,
    })}\n`
  );
}

function runHookMode(defaultProjectDir, phase, planPhase) {
  let stdinText = '';
  try {
    stdinText = fs.readFileSync(0, 'utf8').trim();
  } catch {
    stdinText = '';
  }

  let event = null;
  if (stdinText) {
    try {
      event = JSON.parse(stdinText);
    } catch {
      event = null;
    }
  }

  const projectDir =
    event && typeof event === 'object' && typeof event.cwd === 'string' && event.cwd.trim()
      ? path.resolve(event.cwd)
      : defaultProjectDir;

  const evaluation = evaluateToolCall(event, projectDir, phase);

  if (evaluation.decision === 'NO_DECISION') {
    process.stdout.write('{}\n');
    return;
  }

  if (evaluation.decision === 'DENY') {
    emitDeny(evaluation.reason);
    return;
  }

  const check = validateGate(projectDir, evaluation.gatePhase, planPhase);
  if (!check.allowed) {
    emitDeny(check.reason);
    return;
  }

  if (evaluation.gatePhase === 'migrate' && evaluation.classifications) {
    const scopeCheck = validateMigratorTargetScope(evaluation.classifications, check);
    if (!scopeCheck.allowed) {
      emitDeny(scopeCheck.reason);
      return;
    }
  }

  process.stdout.write('{}\n');
}

function main() {
  const { projectDir, phase, planPhase, isHook } = parseArgs(process.argv);

  if (isHook) {
    runHookMode(projectDir, phase, planPhase);
    return;
  }

  const result = validateGate(projectDir, phase, planPhase);
  if (result.allowed) {
    process.stdout.write(
      `${JSON.stringify(
        {
          status: 'ALLOWED',
          phase,
          planMode: result.planMode || null,
          activePhaseId: result.activePhaseId || null,
          message: result.reason,
        },
        null,
        2
      )}\n`
    );
    process.exit(0);
  } else {
    process.stderr.write(
      `${JSON.stringify({ status: 'DENIED', phase, message: result.reason }, null, 2)}\n`
    );
    process.exit(1);
  }
}

main();
