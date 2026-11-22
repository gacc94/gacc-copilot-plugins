#!/usr/bin/env node
/**
 * Gate validator for the 3-phase Angular Karma-to-Vitest migration workflow.
 *
 * Modes:
 * 1. CLI mode:
 *    node verify-artifacts-gate.mjs --project <dir> --phase <plan|migrate>
 *    Exits with 0 if the required artifacts exist and are APPROVED, or 1 otherwise.
 *
 * 2. Copilot harness preToolUse Hook mode (agent-scoped):
 *    - Planner (Phase 2):  node verify-artifacts-gate.mjs --hook --phase plan [--project <dir>]
 *    - Migrator (Phase 3): node verify-artifacts-gate.mjs --hook --phase migrate [--project <dir>]
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
 *       * Subagent delegation via "task" (neither Planner nor Migrator may spawn subagents).
 *       * Unverifiable/malformed file targets, non-file URIs, UNC paths, symlink escapes,
 *         or mutations targeting paths outside the workspace root.
 *       * Phase 1 diagnosis artifacts (01-diagnosis-report.*) are immutable in both
 *         Planner and Migrator hooks (prevents self-approval).
 *       * In --phase plan (Planner): ANY file write outside 02-migration-plan.{json,md}
 *         and ANY shell command outside the 3 trusted plugin scripts.
 *   - NO_DECISION ({}):
 *       * Officially documented read-only/non-mutating runtime tools (view, glob, grep,
 *         ask_user, web_fetch, update_todo).
 *       * Exact invocations of the 3 trusted plugin scripts (verified via canonical
 *         realpath, closed grammar, strict per-script contract, and --project constrained
 *         within the current workspace).
 *   - REQUIRE_GATE:
 *       * In --phase plan (Planner): writing 02-migration-plan.{json,md} inside
 *         .migration-artifacts/karma-to-vitest requires diagnosis READY + APPROVED.
 *       * In --phase migrate (Migrator): workspace file mutations (including updating
 *         02-migration-plan.json task status, never before approval) and shell commands
 *         require diagnosis READY + APPROVED AND plan APPROVED with tasks.
 *
 * Known runtime limitations (documented intentionally):
 *   - Command hook timeouts in Copilot are fail-open (errors/non-zero exit are fail-closed).
 *   - Symlink resolution at preToolUse time cannot eliminate TOCTOU race conditions; OS
 *     permissions and sandboxing (Level 2) remain mandatory for hard isolation.
 *   - Allowing bare "node"/"node.exe" relies on the environment PATH; process.execPath
 *     is prioritized and validated via realpathSync.
 *
 * Zero external dependencies — uses only built-in Node.js modules.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ARTIFACTS_SUBDIR = path.join('.migration-artifacts', 'karma-to-vitest');
const DIAGNOSIS_JSON = '01-diagnosis-report.json';
const DIAGNOSIS_MD = '01-diagnosis-report.md';
const DIAGNOSIS_HTML = '01-diagnosis-report.html';
const PLAN_JSON = '02-migration-plan.json';
const PLAN_MD = '02-migration-plan.md';

const PHASE1_IMMUTABLE_ARTIFACTS = new Set([DIAGNOSIS_JSON, DIAGNOSIS_MD, DIAGNOSIS_HTML]);
const PHASE2_WRITABLE_ARTIFACTS = new Set([PLAN_JSON, PLAN_MD]);

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
    name: 'verify-artifacts-gate.mjs',
    relPath: path.join('skills', 'karma-vitest-migrate', 'scripts', 'verify-artifacts-gate.mjs'),
  },
];

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
// (strictly separated from agent frontmatter `tools:` aliases such as read/search/todo/agent)
const READ_ONLY_RUNTIME_TOOLS = new Set([
  'view',
  'glob',
  'grep',
  'ask_user',
  'web_fetch',
  'update_todo',
]);

// Subagent delegation tool in Copilot runtime: unconditionally denied inside Planner & Migrator
const BLOCKED_DELEGATION_TOOLS = new Set(['task']);

// Official shell execution tools in Copilot preToolUse runtime
const SHELL_RUNTIME_TOOLS = new Set(['bash', 'powershell']);

// Closed grammar: disallow Bash, PowerShell, and Windows CMD metacharacters / expansions
// On POSIX, backslashes are also disallowed to eliminate shell escape ambiguity.
const FORBIDDEN_SHELL_CHARS_REGEX =
  process.platform === 'win32'
    ? /[$`%!&|;<>(){}*?~#^\r\n\0]/
    : /[$`%!&|;<>(){}*?~#^\\\r\n\0]/;

const SAFE_ANGULAR_PROJECT_NAME_REGEX = /^[a-zA-Z0-9._/@-]+$/;

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

/**
 * Strict camelCase contract for Copilot preToolUse: reads ONLY event.toolArgs.
 * Accepts either a plain object or a JSON-serialized object string defensively
 * (the official schema types toolArgs as `unknown`).
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

/**
 * Resolves the real filesystem path even when trailing segments do not exist yet,
 * catching existing symlinks anywhere along the ancestor chain.
 * Note: preToolUse path checks cannot prevent TOCTOU races between check and write.
 */
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

/**
 * Closed grammar tokenizer for authorized plugin script invocations only.
 * Disallows shell metacharacters, variable expansions, and escape ambiguity.
 */
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

  // Priority 1: explicit absolute path matching the current Node.js runtime binary
  if (path.isAbsolute(execToken)) {
    try {
      return realpathNative(execToken) === realpathNative(process.execPath);
    } catch {
      return false;
    }
  }

  // Priority 2: bare `node` / `node.exe` (relies on environment PATH; relative paths like ./node are rejected)
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
  let seenProject = false;
  let seenPhase = false;
  let seenHook = false;
  let seenAngularProject = false;

  for (let i = 0; i < args.length; i++) {
    const flag = args[i];

    if (flag === '--project' || flag === '-p') {
      if (seenProject) return false;
      const val = args[i + 1];
      if (!val || !isProjectArgWithinWorkspace(val, projectDir)) {
        return false;
      }
      seenProject = true;
      i++;
      continue;
    }

    if (scriptName === 'generate-diagnosis-report.mjs' && flag === '--angular-project') {
      if (seenAngularProject) return false;
      const val = args[i + 1];
      if (
        !val ||
        val.startsWith('-') ||
        val.includes('..') ||
        !SAFE_ANGULAR_PROJECT_NAME_REGEX.test(val)
      ) {
        return false;
      }
      seenAngularProject = true;
      i++;
      continue;
    }

    if (scriptName === 'verify-artifacts-gate.mjs' && flag === '--phase') {
      if (seenPhase) return false;
      const val = args[i + 1];
      if (val !== 'plan' && val !== 'migrate') return false;
      seenPhase = true;
      i++;
      continue;
    }

    if (scriptName === 'verify-artifacts-gate.mjs' && flag === '--hook') {
      if (seenHook) return false;
      seenHook = true;
      continue;
    }

    return false;
  }

  return true;
}

function isApprovedPluginScriptInvocation(command, projectDir) {
  const tokens = tokenizeClosedCommand(command);
  if (!tokens || tokens.length < 2) return false;

  const [execToken, scriptToken, ...restArgs] = tokens;
  if (!isAllowedNodeExecutable(execToken)) return false;

  // Reject any Node CLI option before the script path (e.g., node -e, node --eval, node -r)
  if (scriptToken.startsWith('-')) return false;

  const resolvedScript = path.resolve(projectDir, scriptToken);
  let realScript;
  try {
    realScript = realpathNative(resolvedScript);
  } catch {
    return false;
  }

  const matchedScriptName = TRUSTED_SCRIPT_REALPATHS.get(realScript);
  if (!matchedScriptName) {
    return false;
  }

  return validateScriptContractArgs(matchedScriptName, restArgs, projectDir);
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

function extractRenameTargets(argsObj) {
  return extractPairTargets(argsObj);
}

function extractMoveTargets(argsObj) {
  return extractPairTargets(argsObj);
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
  ['rename', extractRenameTargets],
  ['move', extractMoveTargets],
  ['apply_patch', extractPatchTargets],
  ['patch', extractPatchTargets],
]);

/**
 * Classifies a single target path into:
 *   - { kind: 'INVALID', reason }
 *   - { kind: 'INSIDE_ARTIFACTS', artifactRel }
 *   - { kind: 'INSIDE_WORKSPACE' }
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

  if (reallyInArtifacts) {
    const artifactRel = path.relative(artifactsReal, candidateReal).replace(/\\/g, '/');
    return { kind: 'INSIDE_ARTIFACTS', artifactRel };
  }

  return { kind: 'INSIDE_WORKSPACE' };
}

/**
 * Evaluates a preToolUse hook event into one of three explicit outcomes:
 *   - { decision: 'DENY', reason }               -> Unconditional deny (never bypassed by workflow approval)
 *   - { decision: 'NO_DECISION' }                -> Emit {} (delegate to normal harness permission flow)
 *   - { decision: 'REQUIRE_GATE', gatePhase }    -> Allow NO_DECISION only if validateGate(gatePhase) passes
 */
function evaluateToolCall(event, projectDir, phase) {
  if (phase !== 'plan' && phase !== 'migrate') {
    return {
      decision: 'DENY',
      reason: `Fase de hook inválida "${phase}" (se esperaba "plan" o "migrate").`,
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

  // Unconditionally block subagent delegation inside Planner and Migrator
  if (BLOCKED_DELEGATION_TOOLS.has(toolName)) {
    return {
      decision: 'DENY',
      reason: `La herramienta de delegación "${toolName}" está bloqueada en Fase ${phase === 'plan' ? '2 (Planner)' : '3 (Migrator)'} para evitar mutaciones no auditadas en subagentes.`,
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

    if (isApprovedPluginScriptInvocation(command, projectDir)) {
      return { decision: 'NO_DECISION' };
    }

    // Planner is strictly read-only on source code: arbitrary shell commands are unconditionally denied
    if (phase === 'plan') {
      return {
        decision: 'DENY',
        reason: 'Karma-Vitest Planner solo puede ejecutar scripts oficiales del plugin; los comandos shell arbitrarios están bloqueados en Fase 2.',
      };
    }

    return { decision: 'REQUIRE_GATE', gatePhase: 'migrate' };
  }

  // Known file mutation tools with dedicated per-tool adapters
  if (FILE_MUTATION_ADAPTERS.has(toolName)) {
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

    for (const target of targets) {
      const classification = classifyTargetPath(target, projectDir);
      if (classification.kind === 'INVALID') {
        return { decision: 'DENY', reason: classification.reason };
      }

      // Phase 1 diagnosis artifacts are immutable during both Phase 2 (Planner) and Phase 3 (Migrator)
      // to prevent self-approval or tampering.
      if (
        classification.kind === 'INSIDE_ARTIFACTS' &&
        PHASE1_IMMUTABLE_ARTIFACTS.has(classification.artifactRel)
      ) {
        return {
          decision: 'DENY',
          reason: `Los artefactos de diagnóstico de Fase 1 (${classification.artifactRel}) son inmutables y no pueden ser modificados por el agente.`,
        };
      }

      // In Phase 2 (Planner): ONLY 02-migration-plan.json and 02-migration-plan.md are writable
      if (phase === 'plan') {
        if (
          classification.kind !== 'INSIDE_ARTIFACTS' ||
          !PHASE2_WRITABLE_ARTIFACTS.has(classification.artifactRel)
        ) {
          return {
            decision: 'DENY',
            reason: `Karma-Vitest Planner solo puede escribir ${PLAN_JSON} y ${PLAN_MD} dentro de ${ARTIFACTS_SUBDIR}. Destino bloqueado: "${target}".`,
          };
        }
      }
    }

    // Phase 2 requires diagnosis READY + APPROVED before writing 02-migration-plan.*
    // Phase 3 requires diagnosis READY + APPROVED AND plan APPROVED before ANY mutation
    // (including 02-migration-plan.json, preventing Migrator self-approval).
    return { decision: 'REQUIRE_GATE', gatePhase: phase };
  }

  // Unknown tool -> UNCONDITIONAL DENY (never bypassed by workflow approval)
  return {
    decision: 'DENY',
    reason: `Herramienta desconocida o no autorizada "${event.toolName}" (default-deny).`,
  };
}

function emitDeny(reason) {
  process.stdout.write(
    `${JSON.stringify({
      permissionDecision: 'deny',
      permissionDecisionReason: reason,
    })}\n`
  );
}

function runHookMode(defaultProjectDir, phase) {
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

  const check = validateGate(projectDir, evaluation.gatePhase);
  if (check.allowed) {
    process.stdout.write('{}\n');
  } else {
    emitDeny(check.reason);
  }
}

function main() {
  const { projectDir, phase, isHook } = parseArgs(process.argv);

  if (isHook) {
    runHookMode(projectDir, phase);
    return;
  }

  const result = validateGate(projectDir, phase);
  if (result.allowed) {
    process.stdout.write(
      `${JSON.stringify({ status: 'ALLOWED', phase, message: result.reason }, null, 2)}\n`
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
