#!/usr/bin/env node
/**
 * Deterministic Phase 2 Multi-Phase Migration Plan Generator for Angular Karma-to-Vitest.
 *
 * Reads the approved Phase 1 diagnosis report (.migration-artifacts/karma-to-vitest/01-diagnosis-report.json)
 * and deterministically partitions all *.spec.ts files into safe, deployable coexistence phases:
 *   - phase-01-coexistence: Adds parallel @angular/build:unit-test ("test-vitest") + tsconfig.spec.vitest.json
 *                           without breaking existing Karma ("test").
 *   - phase-02..K:          Deterministic spec batches grouped by complexity (low -> medium -> high),
 *                           feature folder, effort score budget, and max-file cap.
 *                           Each phase isolates specs via angular.json include/exclude + tsconfig.spec.vitest.json
 *                           and verifies BOTH runners + ng build.
 *   - phase-N-cutover-cleanup: Switches primary "test" target to Vitest and removes Karma/Jasmine artifacts.
 *
 * Writes:
 *   - .migration-artifacts/karma-to-vitest/02-migration-plan.json (Master index, schemaVersion 2.0.0)
 *   - .migration-artifacts/karma-to-vitest/02-migration-plan.md
 *   - .migration-artifacts/karma-to-vitest/plans/<phaseId>.json   (Per-phase plan, schemaVersion 1.0.0)
 *   - .migration-artifacts/karma-to-vitest/plans/<phaseId>.md
 *
 * Zero external dependencies — pure Node.js ESM.
 */
import fs from 'node:fs';
import path from 'node:path';

const MASTER_SCHEMA_VERSION = '2.0.0';
const PHASE_SCHEMA_VERSION = '1.0.0';
const ARTIFACTS_SUBDIR = path.join('.migration-artifacts', 'karma-to-vitest');
const PLANS_SUBDIR = 'plans';
const DIAGNOSIS_JSON = '01-diagnosis-report.json';
const MASTER_JSON = '02-migration-plan.json';
const MASTER_MD = '02-migration-plan.md';

const BATCH_LIMITS = {
  low: { maxFiles: 25, maxScore: 50 },
  medium: { maxFiles: 15, maxScore: 65 },
  high: { maxFiles: 8, maxScore: 56 },
};

function parseArgs(argv) {
  let projectDir = process.cwd();
  let angularProject = null;
  for (let i = 2; i < argv.length; i++) {
    const arg = argv[i];
    if ((arg === '--project' || arg === '-p') && argv[i + 1]) {
      projectDir = path.resolve(argv[++i]);
    } else if (arg === '--angular-project' && argv[i + 1]) {
      angularProject = argv[++i].trim();
    }
  }
  return { projectDir, angularProject };
}

function pad2(n) {
  return String(n).padStart(2, '0');
}

function getSpecScore(spec) {
  if (typeof spec.complexityScore === 'number' && Number.isFinite(spec.complexityScore)) {
    return Math.max(1, Math.min(10, Math.round(spec.complexityScore)));
  }
  if (spec.complexity === 'high') return 8;
  if (spec.complexity === 'medium') return 5;
  return 2;
}

function getFeatureFolder(filePath) {
  const normalized = String(filePath || '').replace(/\\/g, '/');
  const dir = path.posix.dirname(normalized);
  return dir === '.' ? '' : dir;
}

function partitionTierSpecs(specs, tier) {
  if (specs.length === 0) return [];
  const { maxFiles, maxScore } = BATCH_LIMITS[tier];

  // Sort deterministically by feature folder first so related specs stay together, then filename
  const sorted = [...specs].sort((a, b) => {
    const dirCmp = getFeatureFolder(a.file).localeCompare(getFeatureFolder(b.file));
    return dirCmp !== 0 ? dirCmp : a.file.localeCompare(b.file);
  });

  const batches = [];
  let current = [];
  let currentScore = 0;

  for (const spec of sorted) {
    const score = getSpecScore(spec);
    const exceedsFiles = current.length >= maxFiles;
    const exceedsScore = current.length > 0 && currentScore + score > maxScore;
    if (exceedsFiles || exceedsScore) {
      batches.push(current);
      current = [];
      currentScore = 0;
    }
    current.push(spec);
    currentScore += score;
  }
  if (current.length > 0) {
    batches.push(current);
  }
  return batches;
}

function resolveAngularTargets(projectDir, angularProject) {
  const angularJsonPath = path.join(projectDir, 'angular.json');
  let projectRoot = '';
  let specTsConfig = 'tsconfig.spec.json';
  let vitestTsConfig = 'tsconfig.spec.vitest.json';
  let karmaConfFile = 'karma.conf.js';
  let resolvedProject = angularProject || null;

  if (fs.existsSync(angularJsonPath)) {
    try {
      const angularJson = JSON.parse(fs.readFileSync(angularJsonPath, 'utf8'));
      const projects = angularJson?.projects || {};
      const names = Object.keys(projects);
      if (!resolvedProject && names.length > 0) {
        resolvedProject = names[0];
      }
      const proj = resolvedProject ? projects[resolvedProject] : null;
      if (proj) {
        projectRoot = (proj.root || '').replace(/\\/g, '/').replace(/\/$/, '');
        const targets = proj.architect || proj.targets || {};
        const testOpts = targets.test?.options || {};
        if (typeof testOpts.tsConfig === 'string' && testOpts.tsConfig.trim()) {
          specTsConfig = testOpts.tsConfig.replace(/\\/g, '/');
        } else if (projectRoot) {
          specTsConfig = `${projectRoot}/tsconfig.spec.json`;
        }
        const tsDir = path.posix.dirname(specTsConfig);
        vitestTsConfig = tsDir === '.' ? 'tsconfig.spec.vitest.json' : `${tsDir}/tsconfig.spec.vitest.json`;
        if (typeof testOpts.karmaConfig === 'string' && testOpts.karmaConfig.trim()) {
          karmaConfFile = testOpts.karmaConfig.replace(/\\/g, '/');
        } else if (projectRoot) {
          karmaConfFile = `${projectRoot}/karma.conf.js`;
        }
      }
    } catch {
      // Fall back to standard root conventions
    }
  }

  return {
    resolvedProject,
    projectRoot,
    specTsConfig,
    vitestTsConfig,
    karmaConfFile,
  };
}

function buildCommands(resolvedProject) {
  const projArg = resolvedProject ? ` ${resolvedProject}` : '';
  const runTarget = resolvedProject ? `${resolvedProject}:test-vitest` : 'test-vitest';
  return {
    karmaTest: `npx ng test${projArg} --watch=false`,
    vitestTest: `npx ng run ${runTarget} --watch=false`,
    build: `npx ng build${projArg}`,
  };
}

function renderPhaseMarkdown(phase) {
  const lines = [
    `# ${phase.title} (\`${phase.phaseId}\`)`,
    '',
    `> **Orden:** ${phase.order} · **Tipo:** \`${phase.kind}\` · **Depende de:** ${phase.dependsOnPhase ? `\`${phase.dependsOnPhase}\`` : 'Ninguna (fase inicial)'} · **Specs:** ${phase.specCount} · **Score acumulado:** ${phase.totalComplexityScore} · **Aprobación:** \`${phase.approval.status}\``,
    '',
    '## Tareas Ejecutables',
    '',
  ];

  for (const task of phase.tasks) {
    lines.push(
      `### ${task.order}. \`${task.id}\` — ${task.title} (\`${task.category}\`)`,
      '',
      `**Archivos objetivo (\`targetFiles\`):**`,
      ...task.targetFiles.map((f) => `* \`${f}\``),
      '',
      '**Acciones:**',
      ...task.actions.map((a) => `* ${a}`),
      '',
      `**Verificación:** ${task.verification}`,
      ''
    );
  }

  lines.push(
    '## Comandos de Verificación Obligatorios',
    '',
    '```bash',
    ...phase.verificationCommands,
    '```',
    '',
    '## Aprobación Humana (Checkpoint)',
    '',
    `> Para habilitar esta fase en el Migrator, aprueba vía el asistente interactivo en Copilot Chat o cambia \`"approval.status"\` a \`"APPROVED"\` en \`.migration-artifacts/karma-to-vitest/plans/${phase.phaseId}.json\`.`,
    ''
  );

  return `${lines.join('\n')}\n`;
}

function renderMasterMarkdown(master, phases) {
  const lines = [
    `# Plan Maestro de Migración Incremental — \`${master.projectName}\``,
    '',
    `> **Modo:** \`${master.planMode}\` · **Huella de diagnóstico:** \`${master.diagnosisHash}\` · **Total specs:** ${master.totalSpecFiles} · **Score acumulado:** ${master.totalComplexityScore} · **Fases:** ${phases.length}`,
    '',
    '## Estrategia de Convivencia (Karma + Vitest)',
    '',
    `* **Target Karma (intacto hasta el cutover):** \`${master.coexistenceStrategy.karmaTarget}\``,
    `* **Target Vitest paralelo:** \`${master.coexistenceStrategy.vitestTarget}\` (\`@angular/build:unit-test\`, \`runner: "vitest"\`)`,
    `* **TSConfig aislado para Vitest:** \`${master.coexistenceStrategy.vitestTsConfig}\` (\`types: ["vitest/globals"]\`)`,
    `* **Aislamiento de specs:** \`${master.coexistenceStrategy.specIsolation}\` (sin renombrar archivos \`*.spec.ts\`; cada fase mueve un lote exacto de Karma hacia Vitest manteniendo ambos runners y \`ng build\` en verde).`,
    '',
    '## Fases Generadas Dinámicamente',
    '',
    '| Orden | Phase ID | Tipo | Complejidad | Specs | Score | Depende de | Estado | Plan |',
    '| :---: | :--- | :--- | :---: | :---: | :---: | :--- | :---: | :--- |',
  ];

  for (const p of master.phases) {
    lines.push(
      `| ${p.order} | \`${p.phaseId}\` | \`${p.kind}\` | ${p.complexityTier || '—'} | ${p.specCount} | ${p.totalComplexityScore} | ${p.dependsOnPhase ? `\`${p.dependsOnPhase}\`` : '—'} | \`${p.status}\` | \`${p.planFile}\` |`
    );
  }

  lines.push(
    '',
    '## Flujo de Aprobación Híbrida y Despliegue por Fase',
    '',
    '1. Cada fase en `plans/phase-XX-*.json` inicia con `approval.status: "PENDING"` y requiere aprobación humana independiente antes de ejecutarse.',
    '2. Puedes aprobar cada fase **directamente desde el prompt interactivo de Copilot Chat** (el Orquestador registra la aprobación mediante `approve-artifact.mjs`) o **manualmente** editando `approval.status = "APPROVED"` en el JSON de la fase.',
    '3. Tras cada fase, valida ambos runners (`test` + `test-vitest`) y `ng build` en tu pipeline CI/preproducción antes de aprobar la siguiente fase.',
    ''
  );

  return `${lines.join('\n')}\n`;
}

function main() {
  const { projectDir, angularProject: cliAngularProject } = parseArgs(process.argv);
  const artifactsDir = path.join(projectDir, ARTIFACTS_SUBDIR);
  const diagPath = path.join(artifactsDir, DIAGNOSIS_JSON);

  if (!fs.existsSync(diagPath)) {
    process.stderr.write(`ERROR: No existe ${DIAGNOSIS_JSON} en ${artifactsDir}. Ejecuta primero el diagnóstico (Fase 1).\n`);
    process.exit(1);
  }

  let diag;
  try {
    diag = JSON.parse(fs.readFileSync(diagPath, 'utf8'));
  } catch (err) {
    process.stderr.write(`ERROR: ${DIAGNOSIS_JSON} no es JSON válido: ${err.message}\n`);
    process.exit(1);
  }

  if (diag.status !== 'READY') {
    process.stderr.write(`ERROR: El diagnóstico está en estado "${diag.status}" (se requiere "READY").\n`);
    process.exit(1);
  }

  if (diag?.approval?.status !== 'APPROVED') {
    process.stderr.write(
      `ERROR: El diagnóstico tiene approval.status="${diag?.approval?.status || 'PENDING'}". Debe ser "APPROVED" antes de generar el plan.\n`
    );
    process.exit(1);
  }

  const diagnosisHash =
    typeof diag.diagnosisHash === 'string' && /^sha256:[a-f0-9]{16}$/.test(diag.diagnosisHash)
      ? diag.diagnosisHash
      : 'sha256:0000000000000000';

  const angularProject = cliAngularProject || diag?.detected?.selectedAngularProject || null;
  const targets = resolveAngularTargets(projectDir, angularProject);
  const projectName = diag?.detected?.projectName || targets.resolvedProject || path.basename(projectDir);
  const cmds = buildCommands(targets.resolvedProject);

  const specInventory = Array.isArray(diag.specInventory) ? diag.specInventory : [];
  const lowSpecs = specInventory.filter((s) => s.complexity === 'low');
  const mediumSpecs = specInventory.filter((s) => s.complexity === 'medium');
  const highSpecs = specInventory.filter((s) => s.complexity === 'high');

  const lowBatches = partitionTierSpecs(lowSpecs, 'low');
  const mediumBatches = partitionTierSpecs(mediumSpecs, 'medium');
  const highBatches = partitionTierSpecs(highSpecs, 'high');

  const createdAt = new Date().toISOString();
  const phases = [];
  let order = 1;
  let prevPhaseId = null;

  const hasKarmaConf = Boolean(diag?.detected?.hasKarmaConf) || fs.existsSync(path.join(projectDir, targets.karmaConfFile));
  const legacyDeps = Array.isArray(diag?.findings?.dependenciesToReview) ? diag.findings.dependenciesToReview : [];

  // Phase 1: Coexistence setup (parallel Vitest target, Karma untouched)
  {
    const phaseId = `phase-${pad2(order)}-coexistence`;
    const phase = {
      schemaVersion: PHASE_SCHEMA_VERSION,
      phaseId,
      order,
      kind: 'coexistence-setup',
      complexityTier: null,
      title: 'Fase 1 — Configurar convivencia paralela Karma + Vitest',
      createdAt,
      basedOnDiagnosis: `${ARTIFACTS_SUBDIR.replace(/\\/g, '/')}/${DIAGNOSIS_JSON}`,
      diagnosisHash,
      projectName,
      angularProject: targets.resolvedProject,
      dependsOnPhase: null,
      status: 'PENDING',
      specCount: 0,
      totalComplexityScore: 0,
      specFiles: [],
      tasks: [
        {
          id: `P${pad2(order)}-T1`,
          order: 1,
          category: 'dependencies',
          title: 'Instalar vitest y entorno DOM (happy-dom o jsdom) manteniendo Karma/Jasmine intactos',
          targetFiles: ['package.json'],
          actions: [
            'Agregar "vitest" y "jsdom" (o "happy-dom", detectado preferentemente por Angular CLI) en devDependencies de package.json sin desinstalar todavía paquetes karma* ni jasmine*.',
            'Ejecutar instalación de dependencias para actualizar el lockfile.',
          ],
          verification: 'package.json contiene vitest y jsdom/happy-dom, y las dependencias Karma/Jasmine siguen intactas.',
          status: 'PENDING',
        },
        {
          id: `P${pad2(order)}-T2`,
          order: 2,
          category: 'tsconfig',
          title: `Crear ${targets.vitestTsConfig} aislado para Vitest`,
          targetFiles: [targets.vitestTsConfig],
          actions: [
            `Crear ${targets.vitestTsConfig} extendiendo la configuración base (usar "types": ["vitest/globals"] si los specs usan globals implícitos; omitible si importan explícitamente desde 'vitest') para evitar colisiones de tipos con @types/jasmine en ${targets.specTsConfig}.`,
            'Inicializar "include": [] (los lotes de specs se irán incorporando desde la Fase 2 en adelante).',
          ],
          verification: `${targets.vitestTsConfig} compila sin conflictos de tipos con Jasmine.`,
          status: 'PENDING',
        },
        {
          id: `P${pad2(order)}-T3`,
          order: 3,
          category: 'angular-config',
          title: 'Agregar target paralelo "test-vitest" en angular.json',
          targetFiles: ['angular.json'],
          actions: [
            `Mantener el target "test" actual (${diag?.detected?.testBuilder || 'Karma'}) sin alteraciones.`,
            `Agregar el target "test-vitest" usando "@angular/build:unit-test" (Vitest es el runner por defecto) con tsConfig "${targets.vitestTsConfig}" e "include": [] para aislar cada lote incremental.`,
            ...(diag?.complexitySignals?.customKarmaConfig
              ? [
                  `Inspeccionar opciones personalizadas detectadas en ${targets.karmaConfFile} (${(diag.complexitySignals.customKarmaFeatures || []).join(', ')}) antes de migrar o retirar configuraciones.`,
                ]
              : []),
          ],
          verification: 'angular.json es válido y conserva "test" (Karma) junto al nuevo target paralelo "test-vitest".',
          status: 'PENDING',
        },
        {
          id: `P${pad2(order)}-T4`,
          order: 4,
          category: 'verification',
          title: 'Verificar convivencia inicial sin regresiones',
          targetFiles: ['angular.json', 'package.json', targets.vitestTsConfig],
          actions: [
            `Ejecutar "${cmds.karmaTest}" y confirmar 100% de tests existentes en verde.`,
            `Ejecutar "${cmds.build}" y confirmar build limpio.`,
          ],
          verification: 'Karma y ng build pasan sin errores tras añadir la infraestructura paralela de Vitest.',
          status: 'PENDING',
        },
      ],
      verificationCommands: [cmds.karmaTest, cmds.build],
      approval: {
        status: 'PENDING',
        reviewer: null,
        approvedAt: null,
        mode: null,
        notes: 'Pendiente de aprobación humana (manual en JSON o confirmada vía Copilot Chat).',
      },
    };
    phases.push(phase);
    prevPhaseId = phaseId;
    order++;
  }

  // Intermediate phases: spec batches (low -> medium -> high)
  const batchGroups = [
    { tier: 'low', label: 'Baja complejidad', batches: lowBatches },
    { tier: 'medium', label: 'Complejidad media (Zone.js / APIs Jasmine)', batches: mediumBatches },
    { tier: 'high', label: 'Alta complejidad (patrones avanzados)', batches: highBatches },
  ];

  const totalSpecBatches = lowBatches.length + mediumBatches.length + highBatches.length;
  let processedBatches = 0;

  for (const group of batchGroups) {
    group.batches.forEach((batch, idx) => {
      processedBatches++;
      const batchNum = idx + 1;
      const phaseId = `phase-${pad2(order)}-${group.tier}-batch-${batchNum}`;
      const batchFiles = batch.map((s) => s.file);
      const batchScore = batch.reduce((sum, s) => sum + getSpecScore(s), 0);
      const isLastSpecBatch = processedBatches === totalSpecBatches;

      const patternNotes = batch
        .filter((s) => Array.isArray(s.jasminePatterns) && s.jasminePatterns.length > 0)
        .slice(0, 12)
        .map(
          (s) =>
            `${s.file} (score ${getSpecScore(s)}/10${s.expectedOutcome ? `, ${s.expectedOutcome}` : ''}: ${s.jasminePatterns.join(', ')})`
        );

      const transformActions =
        group.tier === 'low'
          ? [
              'Aplicar el schematic oficial "ng g @schematics/angular:refactor-jasmine-vitest" acotado a los archivos de este lote (o aplicar la transformación determinista equivalente según jasmine-to-vitest-patterns.md).',
              'Verificar que no queden referencias a spyOn/jasmine.* sin migrar en los archivos del lote.',
            ]
          : [
              'Migrar determinísticamente cada *.spec.ts del lote siguiendo references/jasmine-to-vitest-patterns.md (spies, matchers, fakeAsync/tick/vi.useFakeTimers, callbacks done -> async/await).',
              ...(patternNotes.length > 0
                ? [`Patrones prioritarios detectados en este lote: ${patternNotes.join(' | ')}.`]
                : []),
            ];

      const verifCmds = isLastSpecBatch
        ? [cmds.vitestTest, cmds.build]
        : [cmds.vitestTest, cmds.karmaTest, cmds.build];

      const phase = {
        schemaVersion: PHASE_SCHEMA_VERSION,
        phaseId,
        order,
        kind: 'spec-batch',
        complexityTier: group.tier,
        title: `Fase ${order} — Migrar lote ${batchNum} de ${group.label} (${batchFiles.length} specs)`,
        createdAt,
        basedOnDiagnosis: `${ARTIFACTS_SUBDIR.replace(/\\/g, '/')}/${DIAGNOSIS_JSON}`,
        diagnosisHash,
        projectName,
        angularProject: targets.resolvedProject,
        dependsOnPhase: prevPhaseId,
        status: 'PENDING',
        specCount: batchFiles.length,
        totalComplexityScore: batchScore,
        specFiles: batchFiles,
        tasks: [
          {
            id: `P${pad2(order)}-T1`,
            order: 1,
            category: 'angular-config',
            title: 'Actualizar include/exclude para mover este lote de Karma a Vitest',
            targetFiles: ['angular.json', targets.specTsConfig, targets.vitestTsConfig],
            actions: [
              `Agregar los ${batchFiles.length} archivo(s) del lote al arreglo "include" del target "test-vitest" en angular.json y en ${targets.vitestTsConfig}.`,
              `Excluir esos mismos ${batchFiles.length} archivo(s) de ${targets.specTsConfig} (Karma) para evitar doble ejecución sin renombrar archivos *.spec.ts.`,
            ],
            verification: 'El lote queda asignado exclusivamente a Vitest y el resto permanece en Karma.',
            status: 'PENDING',
          },
          {
            id: `P${pad2(order)}-T2`,
            order: 2,
            category: 'spec-transform',
            title: `Refactorizar ${batchFiles.length} spec(s) de Jasmine a Vitest`,
            targetFiles: batchFiles,
            actions: transformActions,
            verification: 'Todos los specs del lote compilan bajo tsconfig.spec.vitest.json sin APIs heredadas de Jasmine.',
            status: 'PENDING',
          },
          {
            id: `P${pad2(order)}-T3`,
            order: 3,
            category: 'verification',
            title: 'Validar ambos runners y build tras el lote',
            targetFiles: ['angular.json', targets.specTsConfig, targets.vitestTsConfig],
            actions: verifCmds.map((cmd) => `Ejecutar "${cmd}" y confirmar salida exitosa (exit code 0).`),
            verification: 'Todos los comandos de verificación de la fase pasan en verde; lote listo para CI/preproducción.',
            status: 'PENDING',
          },
        ],
        verificationCommands: verifCmds,
        approval: {
          status: 'PENDING',
          reviewer: null,
          approvedAt: null,
          mode: null,
          notes: `Requiere fase previa "${prevPhaseId}" COMPLETED y aprobación humana antes de ejecutarse.`,
        },
      };

      phases.push(phase);
      prevPhaseId = phaseId;
      order++;
    });
  }

  // Final phase: Cutover "test" target to Vitest + cleanup Karma/Jasmine
  {
    const phaseId = `phase-${pad2(order)}-cutover-cleanup`;
    const cleanupTargets = ['package.json', 'angular.json', targets.specTsConfig, targets.vitestTsConfig];
    if (hasKarmaConf) cleanupTargets.push(targets.karmaConfFile);
    const testTsCandidate = targets.projectRoot ? `${targets.projectRoot}/src/test.ts` : 'src/test.ts';
    if (fs.existsSync(path.join(projectDir, testTsCandidate))) {
      cleanupTargets.push(testTsCandidate);
    }

    const phase = {
      schemaVersion: PHASE_SCHEMA_VERSION,
      phaseId,
      order,
      kind: 'cutover-cleanup',
      complexityTier: null,
      title: `Fase ${order} — Cutover a "test" (Vitest) y limpieza de Karma/Jasmine`,
      createdAt,
      basedOnDiagnosis: `${ARTIFACTS_SUBDIR.replace(/\\/g, '/')}/${DIAGNOSIS_JSON}`,
      diagnosisHash,
      projectName,
      angularProject: targets.resolvedProject,
      dependsOnPhase: prevPhaseId,
      status: 'PENDING',
      specCount: 0,
      totalComplexityScore: 0,
      specFiles: [],
      tasks: [
        {
          id: `P${pad2(order)}-T1`,
          order: 1,
          category: 'angular-config',
          title: 'Promover Vitest al target principal "test" y retirar "test-vitest"',
          targetFiles: ['angular.json', targets.specTsConfig, targets.vitestTsConfig],
          actions: [
            `Reconfigurar el target "test" en angular.json hacia la configuración mínima oficial { "builder": "@angular/build:unit-test" } (tsConfig, buildTarget y runner: "vitest" tienen valores por defecto; añadir opciones explícitas solo si el proyecto difiere de los defaults).`,
            `Actualizar ${targets.specTsConfig} para retirar exclusiones temporales de convivencia y configurar "types": ["vitest/globals"] solo si los specs usan globals implícitos.`,
            `Eliminar el target temporal "test-vitest" de angular.json y borrar ${targets.vitestTsConfig}.`,
          ],
          verification: 'El target principal "test" ejecuta el 100% de la suite con Vitest.',
          status: 'PENDING',
        },
        {
          id: `P${pad2(order)}-T2`,
          order: 2,
          category: 'cleanup',
          title: 'Retirar dependencias y archivos heredados de Karma/Jasmine (previa inspección)',
          targetFiles: cleanupTargets,
          actions: [
            legacyDeps.length > 0
              ? `Desinstalar y remover de package.json las dependencias heredadas: ${legacyDeps.join(', ')}.`
              : 'Verificar que package.json no conserve dependencias heredadas de karma* o jasmine*.',
            ...(hasKarmaConf
              ? [`Inspeccionar ${targets.karmaConfFile} para confirmar que no queden configuraciones personalizadas sin migrar antes de eliminarlo.`]
              : []),
            ...(cleanupTargets.includes(testTsCandidate)
              ? [`Inspeccionar ${testTsCandidate} y comprobar que no contenga inicializaciones globales necesarias (polyfills, mocks globales o setup de TestBed) antes de eliminarlo.`]
              : []),
          ],
          verification: 'Sin rastros de Karma/Jasmine en package.json ni configuración residual.',
          status: 'PENDING',
        },
        {
          id: `P${pad2(order)}-T3`,
          order: 3,
          category: 'verification',
          title: 'Verificación final de suite completa y build de producción',
          targetFiles: ['angular.json', 'package.json'],
          actions: [
            `Ejecutar "${cmds.karmaTest}" (ahora respaldado por Vitest) y confirmar 100% en verde.`,
            `Ejecutar "${cmds.build}" y confirmar build limpio.`,
          ],
          verification: 'Suite completa en Vitest + ng build pasan con exit code 0.',
          status: 'PENDING',
        },
      ],
      verificationCommands: [cmds.karmaTest, cmds.build],
      approval: {
        status: 'PENDING',
        reviewer: null,
        approvedAt: null,
        mode: null,
        notes: `Fase final destructiva (cutover y limpieza de Karma). Requiere "${prevPhaseId}" COMPLETED y aprobación humana explícita.`,
      },
    };
    phases.push(phase);
  }

  // Coverage invariant: verify 100% of specInventory is covered with zero duplicates or omissions
  const plannedSpecSet = new Set();
  for (const p of phases) {
    for (const f of p.specFiles) {
      if (plannedSpecSet.has(f)) {
        process.stderr.write(`ERROR interno: spec duplicado en particionado determinista: ${f}\n`);
        process.exit(1);
      }
      plannedSpecSet.add(f);
    }
  }
  if (plannedSpecSet.size !== specInventory.length) {
    process.stderr.write(
      `ERROR interno: cobertura incompleta de specs (${plannedSpecSet.size} planificados vs ${specInventory.length} diagnosticados).\n`
    );
    process.exit(1);
  }

  const plansDir = path.join(artifactsDir, PLANS_SUBDIR);
  fs.mkdirSync(plansDir, { recursive: true });

  // Clean stale phase-*.{json,md} files from previous plan generations
  for (const entry of fs.readdirSync(plansDir, { withFileTypes: true })) {
    if (entry.isFile() && /^phase-\d{2}-[a-z0-9-]+\.(json|md)$/.test(entry.name)) {
      fs.unlinkSync(path.join(plansDir, entry.name));
    }
  }

  const generatedPhaseFiles = [];
  const masterPhasesSummary = [];

  for (const phase of phases) {
    const jsonRel = path.posix.join(ARTIFACTS_SUBDIR.replace(/\\/g, '/'), PLANS_SUBDIR, `${phase.phaseId}.json`);
    const mdRel = path.posix.join(ARTIFACTS_SUBDIR.replace(/\\/g, '/'), PLANS_SUBDIR, `${phase.phaseId}.md`);
    fs.writeFileSync(path.join(plansDir, `${phase.phaseId}.json`), `${JSON.stringify(phase, null, 2)}\n`, 'utf8');
    fs.writeFileSync(path.join(plansDir, `${phase.phaseId}.md`), renderPhaseMarkdown(phase), 'utf8');
    generatedPhaseFiles.push(jsonRel, mdRel);

    masterPhasesSummary.push({
      phaseId: phase.phaseId,
      order: phase.order,
      kind: phase.kind,
      complexityTier: phase.complexityTier,
      title: phase.title,
      dependsOnPhase: phase.dependsOnPhase,
      planFile: jsonRel,
      markdownFile: mdRel,
      specCount: phase.specCount,
      totalComplexityScore: phase.totalComplexityScore,
      status: phase.status,
    });
  }

  const totalComplexityScore = specInventory.reduce((sum, s) => sum + getSpecScore(s), 0);
  const masterJsonRel = path.posix.join(ARTIFACTS_SUBDIR.replace(/\\/g, '/'), MASTER_JSON);
  const masterMdRel = path.posix.join(ARTIFACTS_SUBDIR.replace(/\\/g, '/'), MASTER_MD);

  const masterPlan = {
    schemaVersion: MASTER_SCHEMA_VERSION,
    planMode: 'multi-phase',
    createdAt,
    basedOnDiagnosis: `${ARTIFACTS_SUBDIR.replace(/\\/g, '/')}/${DIAGNOSIS_JSON}`,
    diagnosisHash,
    projectName,
    angularProject: targets.resolvedProject,
    coexistenceStrategy: {
      mode: 'parallel-angular-target',
      karmaTarget: 'test',
      vitestTarget: 'test-vitest',
      vitestTsConfig: targets.vitestTsConfig,
      specIsolation: 'include-exclude-config',
    },
    totalSpecFiles: specInventory.length,
    totalComplexityScore,
    phases: masterPhasesSummary,
    generatedFiles: {
      masterJson: masterJsonRel,
      masterMarkdown: masterMdRel,
      phaseFiles: generatedPhaseFiles,
    },
  };

  fs.writeFileSync(path.join(artifactsDir, MASTER_JSON), `${JSON.stringify(masterPlan, null, 2)}\n`, 'utf8');
  fs.writeFileSync(path.join(artifactsDir, MASTER_MD), renderMasterMarkdown(masterPlan, phases), 'utf8');

  const compactSummary = {
    planMode: masterPlan.planMode,
    diagnosisHash: masterPlan.diagnosisHash,
    projectName: masterPlan.projectName,
    angularProject: masterPlan.angularProject,
    totalSpecFiles: masterPlan.totalSpecFiles,
    totalComplexityScore: masterPlan.totalComplexityScore,
    phaseCount: phases.length,
    phases: masterPhasesSummary.map((p) => ({
      phaseId: p.phaseId,
      kind: p.kind,
      complexityTier: p.complexityTier,
      specCount: p.specCount,
      totalComplexityScore: p.totalComplexityScore,
      planFile: p.planFile,
    })),
    masterJson: masterJsonRel,
    masterMarkdown: masterMdRel,
  };

  process.stdout.write(`${JSON.stringify(compactSummary, null, 2)}\n`);
}

main();
