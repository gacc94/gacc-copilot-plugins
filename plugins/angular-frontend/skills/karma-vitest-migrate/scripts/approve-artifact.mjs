#!/usr/bin/env node
/**
 * Deterministic, auditable human-approval recorder for Angular Karma-to-Vitest artifacts.
 *
 * Invoked ONLY by the Orchestrator (`Angular Karma-to-Vitest`) after explicit interactive
 * user confirmation in Copilot Chat (`#vscode/askQuestions` / Copilot CLI prompt), as the
 * chat-assisted counterpart to manual JSON editing.
 *
 * Usage:
 *   node scripts/approve-artifact.mjs --project "." --artifact diagnosis --reviewer "<name>" --mode chat-confirmed
 *   node scripts/approve-artifact.mjs --project "." --artifact phase --plan-phase phase-01-coexistence --reviewer "<name>" --mode chat-confirmed
 *
 * Hard safeguards (cannot bypass workflow state):
 *   - Refuses to approve 01-diagnosis-report.json if status !== "READY" (BLOCKED is never approvable).
 *   - Refuses to approve a phase plan if diagnosis is not READY + APPROVED, if diagnosisHash drifted,
 *     or if dependsOnPhase / any prior phase is not COMPLETED.
 *
 * Zero external dependencies — pure Node.js ESM.
 */
import fs from 'node:fs';
import path from 'node:path';

const ARTIFACTS_SUBDIR = path.join('.migration-artifacts', 'karma-to-vitest');
const PLANS_SUBDIR = 'plans';
const DIAGNOSIS_JSON = '01-diagnosis-report.json';
const MASTER_JSON = '02-migration-plan.json';
const PHASE_ID_REGEX = /^phase-\d{2}-[a-z0-9-]+$/;
const SAFE_REVIEWER_REGEX = /^[a-zA-Z0-9._@ -]{1,80}$/;

function parseArgs(argv) {
  let projectDir = process.cwd();
  let artifact = null;
  let planPhase = null;
  let reviewer = 'user';
  let mode = 'chat-confirmed';
  let notes = null;

  for (let i = 2; i < argv.length; i++) {
    const arg = argv[i];
    if ((arg === '--project' || arg === '-p') && argv[i + 1]) {
      projectDir = path.resolve(argv[++i]);
    } else if (arg === '--artifact' && argv[i + 1]) {
      artifact = argv[++i].trim();
    } else if (arg === '--plan-phase' && argv[i + 1]) {
      planPhase = argv[++i].trim();
    } else if (arg === '--reviewer' && argv[i + 1]) {
      reviewer = argv[++i].trim();
    } else if (arg === '--mode' && argv[i + 1]) {
      mode = argv[++i].trim();
    } else if (arg === '--notes' && argv[i + 1]) {
      notes = argv[++i].trim();
    }
  }

  return { projectDir, artifact, planPhase, reviewer, mode, notes };
}

function fail(message) {
  process.stderr.write(`${JSON.stringify({ status: 'ERROR', message }, null, 2)}\n`);
  process.exit(1);
}

function readJsonOrFail(filePath, label) {
  if (!fs.existsSync(filePath)) {
    fail(`No existe ${label} en ${filePath}.`);
  }
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (err) {
    fail(`${label} no contiene JSON válido: ${err.message}`);
  }
}

function main() {
  const { projectDir, artifact, planPhase, reviewer, mode, notes } = parseArgs(process.argv);

  if (artifact !== 'diagnosis' && artifact !== 'phase') {
    fail('Parámetro --artifact inválido. Usa "diagnosis" o "phase".');
  }
  if (mode !== 'chat-confirmed' && mode !== 'manual-json') {
    fail('Parámetro --mode inválido. Usa "chat-confirmed" o "manual-json".');
  }
  if (!SAFE_REVIEWER_REGEX.test(reviewer)) {
    fail('Parámetro --reviewer contiene caracteres no permitidos.');
  }

  const artifactsDir = path.join(projectDir, ARTIFACTS_SUBDIR);
  const diagPath = path.join(artifactsDir, DIAGNOSIS_JSON);
  const diag = readJsonOrFail(diagPath, DIAGNOSIS_JSON);

  if (diag.status !== 'READY') {
    fail(
      `No se puede aprobar ${DIAGNOSIS_JSON} porque su estado es "${diag.status}" (se requiere "READY"). Actualiza Angular a 21+ primero.`
    );
  }

  const approvedAt = new Date().toISOString();

  if (artifact === 'diagnosis') {
    diag.approval = {
      status: 'APPROVED',
      reviewer,
      approvedAt,
      mode,
      notes: notes || 'Aprobado explícitamente por el especialista vía Copilot Chat.',
    };
    fs.writeFileSync(diagPath, `${JSON.stringify(diag, null, 2)}\n`, 'utf8');
    process.stdout.write(
      `${JSON.stringify(
        {
          status: 'APPROVED',
          artifact: 'diagnosis',
          file: path.posix.join(ARTIFACTS_SUBDIR.replace(/\\/g, '/'), DIAGNOSIS_JSON),
          diagnosisHash: diag.diagnosisHash || null,
          reviewer,
          mode,
          approvedAt,
        },
        null,
        2
      )}\n`
    );
    return;
  }

  // artifact === 'phase'
  if (diag?.approval?.status !== 'APPROVED') {
    fail(`El diagnóstico (${DIAGNOSIS_JSON}) debe estar en approval.status="APPROVED" antes de aprobar una fase.`);
  }

  if (!planPhase || !PHASE_ID_REGEX.test(planPhase)) {
    fail('Para --artifact phase debes indicar un --plan-phase válido (ej. phase-01-coexistence).');
  }

  const masterPath = path.join(artifactsDir, MASTER_JSON);
  const master = readJsonOrFail(masterPath, MASTER_JSON);
  if (master.planMode !== 'multi-phase' || !Array.isArray(master.phases)) {
    fail(`${MASTER_JSON} no corresponde a un plan multi-fase válido (planMode: "multi-phase").`);
  }

  const masterEntry = master.phases.find((p) => p.phaseId === planPhase);
  if (!masterEntry) {
    fail(`La fase "${planPhase}" no existe en ${MASTER_JSON}.`);
  }

  const phasePath = path.join(artifactsDir, PLANS_SUBDIR, `${planPhase}.json`);
  const phaseObj = readJsonOrFail(phasePath, `plans/${planPhase}.json`);

  if (diag.diagnosisHash && phaseObj.diagnosisHash && diag.diagnosisHash !== phaseObj.diagnosisHash) {
    fail(
      `Deriva detectada (diagnosisHash distinto: diagnóstico=${diag.diagnosisHash}, fase=${phaseObj.diagnosisHash}). Regenera el plan antes de aprobar.`
    );
  }

  // Verify sequential prerequisites: every prior phase in master.phases must be COMPLETED
  for (const prev of master.phases) {
    if (prev.order >= masterEntry.order) continue;
    const prevPath = path.join(artifactsDir, PLANS_SUBDIR, `${prev.phaseId}.json`);
    const prevObj = readJsonOrFail(prevPath, `plans/${prev.phaseId}.json`);
    if (prevObj.status !== 'COMPLETED') {
      fail(
        `No se puede aprobar "${planPhase}" porque la fase previa "${prev.phaseId}" está en estado "${prevObj.status}" (debe ser "COMPLETED").`
      );
    }
  }

  phaseObj.approval = {
    status: 'APPROVED',
    reviewer,
    approvedAt,
    mode,
    notes: notes || `Fase ${planPhase} aprobada explícitamente por el especialista vía Copilot Chat.`,
  };
  fs.writeFileSync(phasePath, `${JSON.stringify(phaseObj, null, 2)}\n`, 'utf8');

  process.stdout.write(
    `${JSON.stringify(
      {
        status: 'APPROVED',
        artifact: 'phase',
        planPhase,
        file: path.posix.join(ARTIFACTS_SUBDIR.replace(/\\/g, '/'), PLANS_SUBDIR, `${planPhase}.json`),
        diagnosisHash: phaseObj.diagnosisHash || null,
        reviewer,
        mode,
        approvedAt,
      },
      null,
      2
    )}\n`
  );
}

main();
