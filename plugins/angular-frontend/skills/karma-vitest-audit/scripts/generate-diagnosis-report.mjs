#!/usr/bin/env node
/**
 * Deterministic Phase 1 Diagnosis Report Generator for Angular Karma-to-Vitest migration.
 *
 * Scans package.json, angular.json, karma.conf.js, and all *.spec.ts files locally
 * (zero external dependencies, zero LLM tokens for report generation) and writes
 * three synchronized artifacts into <project>/.migration-artifacts/karma-to-vitest/:
 *   1. 01-diagnosis-report.json  (structured contract for Gate & Phase 2)
 *   2. 01-diagnosis-report.md    (enriched Markdown for Copilot Chat & GitHub PRs)
 *   3. 01-diagnosis-report.html  (self-contained visual executive dashboard, offline-ready)
 *
 * Prints only a compact JSON summary (~15 lines) to stdout so the LLM context stays minimal.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const SCHEMA_VERSION = '1.3.0';
const OFFICIAL_SCHEMATIC_CMD = 'ng g @schematics/angular:refactor-jasmine-vitest';
const ARTIFACTS_SUBDIR = path.join('.migration-artifacts', 'karma-to-vitest');

const JASMINE_API_PATTERNS = [
  { name: 'spyOn', regex: /\bspyOn\s*\(/g },
  { name: 'jasmine.SpyObj<T>', regex: /\bjasmine\.SpyObj\s*</g },
  { name: 'jasmine.Spy', regex: /\bjasmine\.Spy\b(?!Obj)/g },
  { name: 'jasmine.createSpy', regex: /\bjasmine\.createSpy\s*\(/g },
  { name: 'jasmine.createSpyObj', regex: /\bjasmine\.createSpyObj\s*\(/g },
  { name: 'jasmine.any', regex: /\bjasmine\.any\s*\(/g },
  { name: 'jasmine.anything', regex: /\bjasmine\.anything\s*\(/g },
  { name: 'jasmine.objectContaining', regex: /\bjasmine\.objectContaining\s*\(/g },
  { name: 'jasmine.arrayContaining', regex: /\bjasmine\.arrayContaining\s*\(/g },
  { name: 'jasmine.stringMatching', regex: /\bjasmine\.stringMatching\s*\(/g },
  { name: 'toBeTrue/toBeFalse', regex: /\.toBe(?:True|False)\s*\(/g },
  { name: 'spy.calls.reset', regex: /\.calls\.reset\s*\(/g },
  { name: 'spy.calls.mostRecent', regex: /\.calls\.mostRecent\s*\(/g },
  { name: 'spy.and.*', regex: /\.and\.(?:returnValue|returnValues|callFake|callThrough|throwError|resolveTo|rejectWith|stub)\s*\(/g },
];

const ASYNC_TIMER_PATTERNS = [
  { name: 'fakeAsync', regex: /\bfakeAsync\s*\(/g },
  { name: 'tick', regex: /\btick\s*\(/g },
  { name: 'flush', regex: /\bflush(?:Microtasks)?\s*\(/g },
  { name: 'jasmine.clock', regex: /\bjasmine\.clock\s*\(/g },
];

const COMPLEX_SPEC_PATTERNS = [
  { name: 'jasmine.clock', regex: /\bjasmine\.clock\s*\(/ },
  { name: 'jasmine.isSpy', regex: /\bjasmine\.isSpy\s*\(/ },
  { name: 'spyOnProperty', regex: /\bspyOnProperty\s*\(/ },
  { name: 'spyOnAllFunctions', regex: /\bspyOnAllFunctions\s*\(/ },
  { name: 'jasmine.addMatchers', regex: /\bjasmine\.addMatchers\s*\(/ },
  { name: 'jasmine.createSpyObj-with-properties', regex: /\bjasmine\.createSpyObj\s*\([^)]*,[^)]*,[^)]*\)/ },
  { name: 'async-done-callback', regex: /\b(?:it|fit|beforeEach|afterEach)\s*\([^,]+,\s*(?:async\s*)?\(\s*done\b/ },
];

const MANUAL_MIGRATION_PATTERNS = new Set([
  'jasmine.isSpy',
  'jasmine.addMatchers',
  'jasmine.clock',
  'async-done-callback',
]);

const REVIEW_REQUIRED_PATTERNS = new Set([
  'jasmine.SpyObj<T>',
  'jasmine.Spy',
  'spy.calls.reset',
  'spy.and.*',
  'spyOnProperty',
  'spyOnAllFunctions',
  'jasmine.createSpyObj-with-properties',
  'fakeAsync',
  'tick',
  'flush',
]);

const CUSTOM_KARMA_PATTERNS = [
  { name: 'proxies', regex: /\bproxies\s*:/ },
  { name: 'customLaunchers', regex: /\bcustomLaunchers\s*:/ },
  { name: 'preprocessors', regex: /\bpreprocessors\s*:/ },
  { name: 'files', regex: /\bfiles\s*:\s*\[/ },
  { name: 'webpack', regex: /\bwebpack\s*:/ },
];

function parseArgs(argv) {
  let projectDir = process.cwd();
  let angularProject = null;
  for (let i = 2; i < argv.length; i++) {
    if ((argv[i] === '--project' || argv[i] === '-p') && argv[i + 1]) {
      projectDir = path.resolve(argv[++i]);
    } else if (argv[i] === '--angular-project' && argv[i + 1]) {
      angularProject = argv[++i].trim();
    }
  }
  return { projectDir, angularProject };
}

function parseSemver(raw) {
  if (!raw || typeof raw !== 'string') return null;
  const cleaned = raw.replace(/^[^\d]*/, '').trim();
  const match = cleaned.match(/^(\d+)\.(\d+)\.(\d+)/);
  if (!match) {
    const majorOnly = cleaned.match(/^(\d+)/);
    if (!majorOnly) return null;
    return {
      major: Number(majorOnly[1]),
      minor: 0,
      patch: 0,
      version: `${majorOnly[1]}.0.0`,
    };
  }
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    version: `${match[1]}.${match[2]}.${match[3]}`,
  };
}

function countMatches(content, regex) {
  const m = content.match(regex);
  return m ? m.length : 0;
}

function collectSpecFiles(rootDir, currentDir = rootDir, acc = []) {
  if (!fs.existsSync(currentDir)) return acc;
  const ignored = new Set(['node_modules', '.git', 'dist', '.angular', '.migration-artifacts', 'coverage']);
  for (const entry of fs.readdirSync(currentDir, { withFileTypes: true })) {
    if (ignored.has(entry.name)) continue;
    const full = path.join(currentDir, entry.name);
    if (entry.isDirectory()) {
      collectSpecFiles(rootDir, full, acc);
    } else if (entry.isFile() && entry.name.endsWith('.spec.ts')) {
      acc.push({
        relativePath: path.relative(rootDir, full).replace(/\\/g, '/'),
        absolutePath: full,
      });
    }
  }
  return acc;
}

function inspectAllSpecs(specFiles) {
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

    const detectedPatterns = new Set();
    let fileJasmineCount = 0;
    let fileAsyncTimerCount = 0;

    for (const p of JASMINE_API_PATTERNS) {
      const c = countMatches(content, p.regex);
      if (c > 0) {
        fileJasmineCount += c;
        detectedPatterns.add(p.name);
      }
    }

    for (const p of ASYNC_TIMER_PATTERNS) {
      const c = countMatches(content, p.regex);
      if (c > 0) {
        fileAsyncTimerCount += c;
        detectedPatterns.add(p.name);
      }
    }

    const fileComplexPatterns = [];
    for (const p of COMPLEX_SPEC_PATTERNS) {
      if (p.regex.test(content)) {
        fileComplexPatterns.push(p.name);
        complexPatternsSet.add(p.name);
        detectedPatterns.add(p.name);
      }
    }

    totalJasmineApiUsages += fileJasmineCount;
    totalFakeAsyncTickUsages += fileAsyncTimerCount;

    let complexity = 'low';
    const hasSpyObjType = detectedPatterns.has('jasmine.SpyObj<T>') || detectedPatterns.has('jasmine.Spy');
    if (fileComplexPatterns.length > 0 || fileJasmineCount >= 12) {
      complexity = 'high';
    } else if (fileAsyncTimerCount > 0 || fileJasmineCount >= 4 || hasSpyObjType) {
      complexity = 'medium';
    }

    let expectedOutcome = 'automatically_migrated';
    if (fileComplexPatterns.some((p) => MANUAL_MIGRATION_PATTERNS.has(p))) {
      expectedOutcome = 'manual_migration';
    } else if (
      complexity !== 'low' ||
      [...detectedPatterns].some((p) => REVIEW_REQUIRED_PATTERNS.has(p))
    ) {
      expectedOutcome = 'requires_review';
    }

    // Deterministic 1-10 numeric complexity score aligned with low (1-3), medium (4-6), high (7-10)
    let rawScore =
      1 +
      Math.min(4, Math.ceil(fileJasmineCount / 3)) +
      (fileAsyncTimerCount >= 3 ? 2 : fileAsyncTimerCount > 0 ? 1 : 0) +
      Math.min(3, fileComplexPatterns.length * 2);
    let complexityScore;
    if (complexity === 'high') {
      complexityScore = Math.max(7, Math.min(10, rawScore + 2));
    } else if (complexity === 'medium') {
      complexityScore = Math.max(4, Math.min(6, rawScore));
    } else {
      complexityScore = Math.max(1, Math.min(3, rawScore));
    }

    counts[complexity] += 1;

    if (fileComplexPatterns.length > 0) {
      complexSpecFiles.push({
        file: spec.relativePath,
        patterns: fileComplexPatterns,
      });
    }

    specInventory.push({
      file: spec.relativePath,
      jasminePatterns: [...detectedPatterns],
      jasmineApiCount: fileJasmineCount,
      fakeAsyncTickCount: fileAsyncTimerCount,
      complexity,
      complexityScore,
      expectedOutcome,
    });
  }

  // Sort inventory: high -> medium -> low, higher score first, then alphabetical
  const rank = { high: 0, medium: 1, low: 2 };
  specInventory.sort(
    (a, b) =>
      rank[a.complexity] - rank[b.complexity] ||
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

function inspectKarmaConfig(karmaConfPath) {
  if (!fs.existsSync(karmaConfPath)) {
    return { exists: false, isCustom: false, customFeatures: [] };
  }
  let content = '';
  try {
    content = fs.readFileSync(karmaConfPath, 'utf8');
  } catch {
    return { exists: true, isCustom: true, customFeatures: ['unreadable-karma-conf'] };
  }
  const features = [];
  for (const p of CUSTOM_KARMA_PATTERNS) {
    if (p.regex.test(content)) {
      features.push(p.name);
    }
  }
  const nonDefaultPlugins = content.match(/require\(['"]karma-(?!jasmine|chrome-launcher|coverage|jasmine-html-reporter)[^'"]+['"]\)/g);
  if (nonDefaultPlugins && nonDefaultPlugins.length > 0) {
    features.push('non-default-karma-plugins');
  }
  return {
    exists: true,
    isCustom: features.length > 0,
    customFeatures: features,
  };
}

function detectProjectsAndTargets(angularJson, selectedProject = null) {
  if (!angularJson || typeof angularJson.projects !== 'object') {
    return {
      angularProjectCount: 0,
      testTargets: [],
      primaryBuilder: null,
      primaryBuildBuilder: null,
      projectName: null,
      selectedProjectRoot: null,
      selectedKarmaConfig: null,
      selectedProjectNotFound: false,
      availableProjects: [],
    };
  }
  const projectNames = Object.keys(angularJson.projects);

  if (selectedProject && !Object.prototype.hasOwnProperty.call(angularJson.projects, selectedProject)) {
    return {
      angularProjectCount: projectNames.length,
      testTargets: [],
      primaryBuilder: null,
      primaryBuildBuilder: null,
      projectName: selectedProject,
      selectedProjectRoot: null,
      selectedKarmaConfig: null,
      selectedProjectNotFound: true,
      availableProjects: projectNames,
    };
  }

  const entries = selectedProject
    ? [[selectedProject, angularJson.projects[selectedProject]]]
    : Object.entries(angularJson.projects);

  const testTargets = [];
  let primaryBuildBuilder = null;
  for (const [projName, projConfig] of entries) {
    const targets = projConfig?.architect || projConfig?.targets;
    if (!primaryBuildBuilder && targets?.build?.builder) {
      primaryBuildBuilder = targets.build.builder;
    }
    if (targets?.test?.builder) {
      testTargets.push({
        project: projName,
        builder: targets.test.builder,
        buildBuilder: targets.build?.builder || null,
        hasKarmaConfigOption: Boolean(targets.test.options?.karmaConfig),
        karmaConfigPath: targets.test.options?.karmaConfig || null,
        hasCustomAssetsOrStyles: Boolean(
          (Array.isArray(targets.test.options?.styles) && targets.test.options.styles.length > 0) ||
          (Array.isArray(targets.test.options?.scripts) && targets.test.options.scripts.length > 0)
        ),
      });
    }
  }
  const primary = testTargets[0] || null;
  const selectedConfig = selectedProject ? angularJson.projects[selectedProject] : null;
  const selectedProjectRoot = selectedConfig
    ? selectedConfig.root || selectedConfig.sourceRoot || ''
    : null;
  return {
    angularProjectCount: selectedProject ? 1 : projectNames.length,
    testTargets,
    primaryBuilder: primary ? primary.builder : null,
    primaryBuildBuilder: primary?.buildBuilder || primaryBuildBuilder,
    projectName: selectedProject || (primary ? primary.project : projectNames[0] || null),
    selectedProjectRoot,
    selectedKarmaConfig: primary?.karmaConfigPath || null,
    selectedProjectNotFound: false,
    availableProjects: projectNames,
  };
}

function buildRoadmap(status, recommendedStrategy, detected, findings) {
  const steps = [];
  if (status === 'BLOCKED') {
    steps.push({
      step: 0,
      phase: 'Prerrequisito Bloqueante — Actualizar Angular',
      description: `Versión detectada: Angular ${detected.angularCoreVersion || 'desconocida'}. Ejecuta primero el flujo de upgrade de Angular (ng update) hacia Angular 21+ antes de planificar la migración a Vitest.`,
      state: 'BLOCKING',
    });
  }
  steps.push(
    {
      step: 1,
      phase: 'Fase 1 — Preparación',
      description: `Revisar compatibilidad de Angular (${detected.angularCoreVersion || 'N/D'}), builder (${detected.testBuilder || 'N/D'}), Node.js (${detected.nodeVersion}) y ${findings.dependenciesToReview.length} dependencia(s) de Karma/Jasmine.`,
      state: status === 'BLOCKED' ? 'LOCKED' : 'COMPLETED',
    },
    {
      step: 2,
      phase: 'Fase 2 — Infraestructura',
      description: 'Instalar vitest + jsdom/happy-dom, configurar @angular/build:unit-test (runner: "vitest") en angular.json y ajustar tsconfig.spec.json.',
      state: status === 'BLOCKED' ? 'LOCKED' : 'PENDING',
    },
    {
      step: 3,
      phase: 'Fase 3 — Refactorización',
      description:
        recommendedStrategy === 'OFFICIAL_SCHEMATIC_SUFFICIENT'
          ? `Ejecutar "${OFFICIAL_SCHEMATIC_CMD}" sobre los ${detected.specFileCount} archivo(s) *.spec.ts.`
          : `Ejecutar "${OFFICIAL_SCHEMATIC_CMD}" como base y migrar con el subagente los ${findings.jasmineApiUsages} usos de Jasmine, ${findings.fakeAsyncTickUsages} usos de fakeAsync/tick y configuraciones Karma personalizadas.`,
      state: status === 'BLOCKED' ? 'LOCKED' : 'PENDING',
    },
    {
      step: 4,
      phase: 'Fase 4 — Validación',
      description: 'Ejecutar npx ng test --watch=false, validar cobertura (--coverage) y verificar cero regresiones.',
      state: status === 'BLOCKED' ? 'LOCKED' : 'PENDING',
    },
    {
      step: 5,
      phase: 'Fase 5 — Limpieza',
      description: `Retirar karma.conf.js, src/test.ts (si aplica) y desinstalar los ${findings.dependenciesToReview.length} paquete(s) heredados de Karma/Jasmine.`,
      state: status === 'BLOCKED' ? 'LOCKED' : 'PENDING',
    }
  );
  return steps;
}

function makeUnicodeBar(percentage, width = 20) {
  const filled = Math.round((percentage / 100) * width);
  return `${'█'.repeat(filled)}${'░'.repeat(Math.max(0, width - filled))}`;
}

function renderMarkdown(report) {
  const statusIcon = report.status === 'READY' ? '🟢 READY' : '🔴 BLOCKED';
  const strategyLabels = {
    UPGRADE_FIRST: 'Actualizar Angular primero (`UPGRADE_FIRST`)',
    OFFICIAL_SCHEMATIC_SUFFICIENT: 'Suficiente con Schematic oficial (`OFFICIAL_SCHEMATIC_SUFFICIENT`)',
    HYBRID_SCHEMATIC_PLUS_AGENT: 'Híbrido: Schematic oficial + Subagente (`HYBRID_SCHEMATIC_PLUS_AGENT`)',
  };

  const lines = [
    `# Migration Assessment Report — \`${report.detected.projectName || path.basename(report.projectPath)}\``,
    '',
    `> **Estado:** ${statusIcon} · **Estrategia recomendada:** ${strategyLabels[report.recommendedStrategy] || report.recommendedStrategy} · **Evaluado:** \`${report.evaluatedAt}\` · **Huella:** \`${report.diagnosisHash}\``,
    '',
    '---',
    '',
    '## 1. Resumen Ejecutivo',
    '',
    '| Métrica | Valor |',
    '| :--- | :---: |',
    `| **Archivos de pruebas (\`*.spec.ts\`)** | **${report.metrics.specFileCount}** |`,
    `| **Proyectos Angular** | **${report.metrics.angularProjectCount}** |`,
    `| **Patrones de baja complejidad** | **${report.metrics.lowComplexityPct}%** |`,
    `| **Patrones que requieren revisión (Media + Alta)** | **${report.metrics.needsReviewPct}%** |`,
    `| **Angular Core / Node.js detectado** | \`${report.detected.angularCoreVersion || 'N/D'}\` / \`${report.detected.nodeVersion}\` |`,
    `| **Builder actual de test** | \`${report.detected.testBuilder || 'N/D'}\` |`,
    '',
  ];

  if (report.blockers.length > 0) {
    lines.push('## 2. Bloqueadores Detectados (Flujo Detenido)', '');
    for (const b of report.blockers) {
      lines.push(`* **\`${b.code}\`**: ${b.message}`);
      lines.push(`  * *Remediación:* ${b.remediation}`);
    }
    lines.push('');
  }

  lines.push(
    '## 3. Estrategia y Schematic Oficial de Angular',
    '',
    `* **Comando oficial:** \`${report.officialSchematic.command}\``,
    `* **¿Es suficiente por sí solo?:** **${report.officialSchematic.sufficient ? 'Sí' : 'No'}**`,
    `* **Detalle:** ${report.officialSchematic.notes}`,
    '',
    '**Motivos de la clasificación:**',
    ...report.strategyReasons.map((r) => `* ${r}`),
    '',
    '## 4. Hallazgos Cuantificados',
    '',
    '| Hallazgo | Cantidad |',
    '| :--- | :---: |',
    `| Uso de Jasmine APIs | **${report.findings.jasmineApiUsages}** |`,
    `| Uso de \`fakeAsync\` / \`tick\` / \`jasmine.clock\` | **${report.findings.fakeAsyncTickUsages}** |`,
    `| Configuraciones Karma personalizadas | **${report.findings.customKarmaConfigs}** |`,
    `| Dependencias por revisar (${report.findings.dependenciesToReview.join(', ') || 'ninguna'}) | **${report.findings.dependenciesToReview.length}** |`,
    '',
    '## 5. Clasificación de Migración',
    '',
    '| Complejidad | Distribución | Archivos | Porcentaje |',
    '| :--- | :--- | :---: | :---: |',
    `| 🟢 **Baja** | \`${makeUnicodeBar(report.complexityBreakdown.low.percentage)}\` | ${report.complexityBreakdown.low.count} | **${report.complexityBreakdown.low.percentage}%** |`,
    `| 🟠 **Media** | \`${makeUnicodeBar(report.complexityBreakdown.medium.percentage)}\` | ${report.complexityBreakdown.medium.count} | **${report.complexityBreakdown.medium.percentage}%** |`,
    `| 🔴 **Alta** | \`${makeUnicodeBar(report.complexityBreakdown.high.percentage)}\` | ${report.complexityBreakdown.high.count} | **${report.complexityBreakdown.high.percentage}%** |`,
    ''
  );

  if (report.specInventory.length > 0) {
    lines.push(
      '## 6. Inventario de Archivos `*.spec.ts`',
      '',
      '| Archivo | Complejidad | Score (1-10) | Jasmine APIs | `fakeAsync`/timers | Patrones detectados |',
      '| :--- | :---: | :---: | :---: | :---: | :--- |'
    );
    for (const s of report.specInventory) {
      const badge = s.complexity === 'high' ? '🔴 Alta' : s.complexity === 'medium' ? '🟠 Media' : '🟢 Baja';
      lines.push(
        `| \`${s.file}\` | ${badge} | **${s.complexityScore}/10** | ${s.jasmineApiCount} | ${s.fakeAsyncTickCount} | ${s.jasminePatterns.join(', ') || 'Estándar'} |`
      );
    }
    lines.push('');
  }

  lines.push('## 7. Hoja de Ruta Orientativa', '');
  for (const step of report.roadmap) {
    const tag = step.state === 'BLOCKING' ? '🚫' : step.state === 'LOCKED' ? '🔒' : step.state === 'COMPLETED' ? '✅' : '⬜';
    lines.push(`${step.step}. ${tag} **${step.phase}** — ${step.description}`);
  }
  lines.push('');

  lines.push(
    '---',
    '',
    '## 8. Checkpoint de Aprobación Humana',
    '',
    report.status === 'BLOCKED'
      ? '> ⚠️ **Fase 2 y Fase 3 bloqueadas:** Este repositorio debe actualizar primero su versión de Angular a **21+** antes de aprobar o generar un plan de migración a Vitest.'
      : '> Para habilitar la **Fase 2 (Plan Ejecutable)**, revisa este reporte (y el dashboard visual `01-diagnosis-report.html`) y cambia `"approval.status"` de `"PENDING"` a `"APPROVED"` en `01-diagnosis-report.json`.',
    ''
  );

  return `${lines.join('\n')}\n`;
}

function escapeHtml(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function renderHtml(report) {
  const projectTitle = report.detected.projectName || path.basename(report.projectPath);
  const isBlocked = report.status === 'BLOCKED';
  const strategyNames = {
    UPGRADE_FIRST: 'Actualizar Angular primero',
    OFFICIAL_SCHEMATIC_SUFFICIENT: 'Schematic oficial suficiente',
    HYBRID_SCHEMATIC_PLUS_AGENT: 'Híbrido: Schematic + Agente',
  };

  const blockerBanner = isBlocked
    ? `<section class="card notice-card notice-blocked">
        <div class="notice-head">
          <div class="notice-title"><span class="dot dot-danger"></span>Flujo bloqueado — Se requiere actualizar Angular primero</div>
          <span class="badge badge-secondary">UPGRADE_FIRST</span>
        </div>
        <ul class="blocker-list">${report.blockers
          .map(
            (b) =>
              `<li><strong>${escapeHtml(b.code)}:</strong> ${escapeHtml(b.message)}<br><span class="muted">Remediación: ${escapeHtml(b.remediation)}</span></li>`
          )
          .join('')}</ul>
       </section>`
    : `<section class="card notice-card">
        <div class="notice-head">
          <div>
            <div class="notice-title">${escapeHtml(strategyNames[report.recommendedStrategy] || report.recommendedStrategy)}</div>
            <p class="notice-desc">${escapeHtml(report.officialSchematic.notes)}</p>
          </div>
          <span class="badge badge-primary">${report.officialSchematic.sufficient ? 'Schematic oficial' : 'Híbrido'}</span>
        </div>
        <div class="cmd-row">
          <div class="cmd-box"><code id="schematicCmd">${escapeHtml(report.officialSchematic.command)}</code></div>
          <button class="btn-primary" id="copyCmdBtn" type="button">Copiar comando</button>
        </div>
       </section>`;

  const depsHtml =
    report.findings.dependenciesToReview.length > 0
      ? `<div class="chips">${report.findings.dependenciesToReview.map((d) => `<span class="chip">${escapeHtml(d)}</span>`).join('')}</div>`
      : '<span class="muted small">Sin paquetes Karma/Jasmine detectados</span>';

  const specRows = report.specInventory
    .map((s) => {
      const cls = s.complexity;
      const label = cls === 'high' ? 'Alta' : cls === 'medium' ? 'Media' : 'Baja';
      const patterns =
        s.jasminePatterns.length > 0
          ? s.jasminePatterns.map((p) => `<span class="chip-sm">${escapeHtml(p)}</span>`).join(' ')
          : '<span class="muted">Estándar</span>';
      return `<tr data-complexity="${cls}" data-file="${escapeHtml(s.file.toLowerCase())}">
        <td class="mono">${escapeHtml(s.file)}</td>
        <td><span class="badge badge-${cls}"><span class="dot dot-${cls}"></span>${label}</span></td>
        <td class="num">${s.jasmineApiCount}</td>
        <td class="num">${s.fakeAsyncTickCount}</td>
        <td>${patterns}</td>
      </tr>`;
    })
    .join('\n');

  const roadmapHtml = report.roadmap
    .map((r) => {
      const stateClass = r.state.toLowerCase();
      return `<div class="step step-${stateClass}">
        <div class="step-num">${escapeHtml(r.step)}</div>
        <div class="step-body">
          <div class="step-title">
            <span>${escapeHtml(r.phase)}</span>
            <span class="state-tag state-${stateClass}">${escapeHtml(r.state)}</span>
          </div>
          <div class="step-desc">${escapeHtml(r.description)}</div>
        </div>
      </div>`;
    })
    .join('\n');

  return `<!DOCTYPE html>
<html lang="es">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Migration Assessment Report — ${escapeHtml(projectTitle)}</title>
  <style>
    :root {
      --bg: #09090b;
      --card: #121214;
      --secondary: #1c1c1f;
      --secondary-hover: #27272a;
      --border: rgba(255, 255, 255, 0.08);
      --border-strong: rgba(255, 255, 255, 0.14);
      --foreground: #fafafa;
      --muted: #8e8e93;
      --primary: #3b82f6;
      --primary-hover: #2563eb;
      --primary-soft: rgba(59, 130, 246, 0.14);
      --primary-border: rgba(59, 130, 246, 0.32);
      --bar-medium: #a1a1aa;
      --bar-high: #52525b;
      --track: #222226;
      --danger-dot: #ef4444;
      --danger-border: rgba(239, 68, 68, 0.28);
      --row-hover: rgba(255, 255, 255, 0.025);
      --radius-card: 16px;
      --radius-inner: 10px;
      --radius-control: 8px;
    }
    body.light {
      --bg: #f4f4f5;
      --card: #ffffff;
      --secondary: #f4f4f5;
      --secondary-hover: #e4e4e7;
      --border: #e4e4e7;
      --border-strong: #d4d4d8;
      --foreground: #09090b;
      --muted: #71717a;
      --primary: #2563eb;
      --primary-hover: #1d4ed8;
      --primary-soft: rgba(37, 99, 235, 0.09);
      --primary-border: rgba(37, 99, 235, 0.26);
      --bar-medium: #52525b;
      --bar-high: #a1a1aa;
      --track: #e4e4e7;
      --danger-dot: #dc2626;
      --danger-border: rgba(220, 38, 38, 0.26);
      --row-hover: rgba(9, 9, 11, 0.02);
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      font-family: Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      -webkit-font-smoothing: antialiased;
      background: var(--bg);
      color: var(--foreground);
      line-height: 1.5;
      padding: 32px 20px 72px;
    }
    .container { max-width: 1024px; margin: 0 auto; }

    /* Header */
    .topbar {
      display: flex;
      justify-content: space-between;
      align-items: center;
      flex-wrap: wrap;
      gap: 12px;
      margin-bottom: 12px;
    }
    .eyebrow {
      font-size: 11px;
      font-weight: 600;
      letter-spacing: 0.08em;
      text-transform: uppercase;
      color: var(--muted);
    }
    .badges { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
    .badge {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      padding: 4px 10px;
      border-radius: 999px;
      font-size: 12px;
      font-weight: 500;
      border: 1px solid var(--border);
      background: var(--card);
      color: var(--foreground);
      white-space: nowrap;
    }
    .badge-primary {
      background: var(--primary-soft);
      border-color: var(--primary-border);
      color: var(--primary);
    }
    .badge-secondary {
      background: var(--secondary);
      border-color: var(--border);
      color: var(--muted);
    }
    .badge-low {
      background: var(--primary-soft);
      border-color: var(--primary-border);
      color: var(--primary);
    }
    .badge-medium {
      background: var(--secondary);
      border-color: var(--border-strong);
      color: var(--foreground);
    }
    .badge-high {
      background: var(--secondary);
      border-color: var(--border-strong);
      color: var(--foreground);
    }
    .dot {
      width: 6px;
      height: 6px;
      border-radius: 999px;
      flex-shrink: 0;
      background: var(--muted);
    }
    .dot-ready, .dot-low { background: var(--primary); }
    .dot-medium { background: var(--bar-medium); }
    .dot-high { background: var(--foreground); }
    .dot-danger { background: var(--danger-dot); }

    .btn-secondary {
      background: var(--secondary);
      color: var(--foreground);
      border: 1px solid var(--border);
      border-radius: var(--radius-control);
      padding: 6px 12px;
      font-size: 12px;
      font-weight: 500;
      cursor: pointer;
      transition: background 0.15s ease, border-color 0.15s ease;
    }
    .btn-secondary:hover { background: var(--secondary-hover); border-color: var(--border-strong); }
    .btn-primary {
      background: var(--primary);
      color: #ffffff;
      border: 1px solid transparent;
      border-radius: var(--radius-control);
      padding: 8px 14px;
      font-size: 12px;
      font-weight: 600;
      cursor: pointer;
      white-space: nowrap;
      transition: background 0.15s ease;
    }
    .btn-primary:hover { background: var(--primary-hover); }

    h1 {
      margin: 4px 0 6px;
      font-size: 28px;
      font-weight: 600;
      letter-spacing: -0.025em;
    }
    .subtitle {
      color: var(--muted);
      font-size: 13px;
      margin-bottom: 24px;
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      gap: 6px;
    }
    .subtitle code {
      background: var(--secondary);
      border: 1px solid var(--border);
      border-radius: 6px;
      padding: 1px 6px;
      font-size: 12px;
      color: var(--foreground);
    }
    .section-title {
      font-size: 12px;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.06em;
      color: var(--muted);
      margin: 28px 0 12px;
    }

    /* Cards (16px radius) */
    .card {
      background: var(--card);
      border: 1px solid var(--border);
      border-radius: var(--radius-card);
      padding: 20px;
    }
    .notice-card { margin: 18px 0 24px; }
    .notice-blocked { border-color: var(--danger-border); }
    .notice-head {
      display: flex;
      justify-content: space-between;
      align-items: flex-start;
      gap: 12px;
      flex-wrap: wrap;
      margin-bottom: 14px;
    }
    .notice-title {
      display: inline-flex;
      align-items: center;
      gap: 8px;
      font-size: 15px;
      font-weight: 600;
      letter-spacing: -0.01em;
    }
    .notice-desc { margin: 4px 0 0; font-size: 13px; color: var(--muted); max-width: 720px; }
    .blocker-list { margin: 8px 0 0 18px; padding: 0; font-size: 13px; display: flex; flex-direction: column; gap: 8px; }
    .cmd-row { display: flex; gap: 10px; align-items: center; flex-wrap: wrap; }
    .cmd-box {
      flex: 1;
      min-width: 240px;
      background: var(--bg);
      border: 1px solid var(--border);
      border-radius: var(--radius-inner);
      padding: 9px 12px;
      font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
      font-size: 12.5px;
      color: var(--foreground);
      overflow-x: auto;
    }

    /* KPIs & Findings */
    .kpi-grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(210px, 1fr));
      gap: 14px;
    }
    .kpi-eyebrow {
      font-size: 11px;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.05em;
      color: var(--muted);
    }
    .kpi-val {
      font-size: 30px;
      font-weight: 600;
      letter-spacing: -0.03em;
      font-variant-numeric: tabular-nums;
      line-height: 1.15;
      margin-top: 8px;
    }
    .kpi-sub { font-size: 12px; color: var(--muted); margin-top: 4px; }

    .findings-list {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(210px, 1fr));
      gap: 14px;
    }
    .finding-num {
      font-size: 24px;
      font-weight: 600;
      letter-spacing: -0.02em;
      font-variant-numeric: tabular-nums;
      margin-top: 8px;
    }
    .chips { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 12px; }
    .chip {
      background: var(--secondary);
      border: 1px solid var(--border);
      border-radius: 6px;
      padding: 2px 8px;
      font-size: 11px;
      color: var(--muted);
      font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    }
    .chip-sm {
      display: inline-block;
      background: var(--secondary);
      border: 1px solid var(--border);
      border-radius: 6px;
      padding: 2px 7px;
      font-size: 11px;
      color: var(--muted);
      font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
      margin: 2px 2px 2px 0;
    }

    /* Progress Bars ("Savings Targets" style) */
    .bar-group { margin-bottom: 18px; }
    .bar-group:last-child { margin-bottom: 0; }
    .bar-head {
      display: flex;
      justify-content: space-between;
      align-items: baseline;
      margin-bottom: 8px;
      font-size: 13px;
    }
    .bar-label { display: inline-flex; align-items: center; gap: 8px; font-weight: 500; }
    .bar-pct { font-weight: 600; font-variant-numeric: tabular-nums; }
    .bar-track {
      height: 6px;
      border-radius: 999px;
      background: var(--track);
      overflow: hidden;
    }
    .bar-fill { height: 100%; border-radius: 999px; transition: width 0.25s ease; }
    .fill-low { background: var(--primary); }
    .fill-medium { background: var(--bar-medium); }
    .fill-high { background: var(--bar-high); }

    /* Table Card + Segmented Tabs */
    .table-card { padding: 0; overflow: hidden; }
    .table-toolbar {
      display: flex;
      justify-content: space-between;
      align-items: center;
      flex-wrap: wrap;
      gap: 12px;
      padding: 16px 20px;
      border-bottom: 1px solid var(--border);
    }
    .tabs-list {
      display: inline-flex;
      gap: 4px;
      padding: 4px;
      background: var(--secondary);
      border: 1px solid var(--border);
      border-radius: var(--radius-inner);
      flex-wrap: wrap;
    }
    .fbtn {
      background: transparent;
      color: var(--muted);
      border: 1px solid transparent;
      border-radius: var(--radius-control);
      padding: 5px 11px;
      font-size: 12px;
      font-weight: 500;
      cursor: pointer;
      transition: background 0.15s ease, color 0.15s ease;
    }
    .fbtn:hover { color: var(--foreground); }
    .fbtn.active {
      background: var(--primary);
      color: #ffffff;
      font-weight: 600;
    }
    .search-input {
      background: var(--bg);
      color: var(--foreground);
      border: 1px solid var(--border);
      border-radius: var(--radius-control);
      padding: 7px 12px;
      font-size: 13px;
      min-width: 240px;
      outline: none;
      transition: border-color 0.15s ease, box-shadow 0.15s ease;
    }
    .search-input::placeholder { color: var(--muted); }
    .search-input:focus {
      border-color: var(--primary);
      box-shadow: 0 0 0 3px var(--primary-soft);
    }
    .table-scroll { overflow-x: auto; }
    table { width: 100%; border-collapse: collapse; font-size: 13px; }
    th, td { padding: 12px 16px; text-align: left; border-bottom: 1px solid var(--border); vertical-align: middle; }
    th {
      color: var(--muted);
      font-size: 11px;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.05em;
      background: var(--secondary);
    }
    tbody tr { transition: background 0.12s ease; }
    tbody tr:hover { background: var(--row-hover); }
    tr:last-child td { border-bottom: none; }
    .mono { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px; color: var(--foreground); }
    .num { text-align: right; font-variant-numeric: tabular-nums; font-weight: 500; }

    /* Roadmap */
    .roadmap { display: flex; flex-direction: column; gap: 16px; }
    .step { display: flex; gap: 14px; align-items: flex-start; }
    .step-num {
      width: 28px;
      height: 28px;
      border-radius: 999px;
      background: var(--secondary);
      border: 1px solid var(--border-strong);
      color: var(--muted);
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 12px;
      font-weight: 600;
      flex-shrink: 0;
    }
    .step-completed .step-num {
      background: var(--primary);
      border-color: var(--primary);
      color: #ffffff;
    }
    .step-blocking .step-num {
      background: var(--secondary);
      border-color: var(--danger-border);
      color: var(--danger-dot);
    }
    .step-body { flex: 1; }
    .step-title {
      display: flex;
      align-items: center;
      gap: 8px;
      flex-wrap: wrap;
      font-weight: 600;
      font-size: 14px;
    }
    .step-desc { font-size: 13px; color: var(--muted); margin-top: 3px; }
    .state-tag {
      font-size: 10px;
      font-weight: 600;
      padding: 2px 7px;
      border-radius: 999px;
      text-transform: uppercase;
      letter-spacing: 0.04em;
      background: var(--secondary);
      border: 1px solid var(--border);
      color: var(--muted);
    }
    .state-completed {
      background: var(--primary-soft);
      border-color: var(--primary-border);
      color: var(--primary);
    }
    .state-blocking {
      border-color: var(--danger-border);
      color: var(--danger-dot);
    }

    .muted { color: var(--muted); }
    .small { font-size: 12px; }
    footer {
      margin-top: 36px;
      padding-top: 16px;
      border-top: 1px solid var(--border);
      font-size: 12px;
      color: var(--muted);
      display: flex;
      justify-content: space-between;
      flex-wrap: wrap;
      gap: 8px;
    }
  </style>
</head>
<body>
  <div class="container">
    <div class="topbar">
      <div class="eyebrow">Angular Migration Assessment · GACC Plugin</div>
      <div class="badges">
        <span class="badge"><span class="dot ${isBlocked ? 'dot-danger' : 'dot-ready'}"></span>${escapeHtml(report.status)}</span>
        <span class="badge badge-primary">${escapeHtml(strategyNames[report.recommendedStrategy] || report.recommendedStrategy)}</span>
        <button class="btn-secondary" id="themeToggle" type="button">Tema claro / oscuro</button>
      </div>
    </div>

    <h1>Migration Assessment Report</h1>
    <div class="subtitle">
      <span>Proyecto: <strong style="color:var(--foreground)">${escapeHtml(projectTitle)}</strong></span>
      <span>·</span>
      <span>Angular <code>${escapeHtml(report.detected.angularCoreVersion || 'N/D')}</code></span>
      <span>·</span>
      <span>Node.js <code>${escapeHtml(report.detected.nodeVersion)}</code></span>
      <span>·</span>
      <span>Builder <code>${escapeHtml(report.detected.testBuilder || 'N/D')}</code></span>
    </div>

    ${blockerBanner}

    <div class="section-title">Resumen ejecutivo</div>
    <div class="kpi-grid">
      <div class="card">
        <div class="kpi-eyebrow">Archivos de pruebas</div>
        <div class="kpi-val">${report.metrics.specFileCount}</div>
        <div class="kpi-sub">Specs *.spec.ts detectados</div>
      </div>
      <div class="card">
        <div class="kpi-eyebrow">Proyectos Angular</div>
        <div class="kpi-val">${report.metrics.angularProjectCount}</div>
        <div class="kpi-sub">Definidos en angular.json</div>
      </div>
      <div class="card">
        <div class="kpi-eyebrow">Baja complejidad</div>
        <div class="kpi-val">${report.metrics.lowComplexityPct}%</div>
        <div class="kpi-sub">Migración directa con schematic</div>
      </div>
      <div class="card">
        <div class="kpi-eyebrow">Requieren revisión</div>
        <div class="kpi-val">${report.metrics.needsReviewPct}%</div>
        <div class="kpi-sub">Patrones medios o avanzados</div>
      </div>
    </div>

    <div class="section-title">Hallazgos</div>
    <div class="findings-list">
      <div class="card">
        <div class="kpi-eyebrow">Uso de Jasmine APIs</div>
        <div class="finding-num">${report.findings.jasmineApiUsages}</div>
        <div class="kpi-sub">Spies, matchers y helpers</div>
      </div>
      <div class="card">
        <div class="kpi-eyebrow">fakeAsync / timers</div>
        <div class="finding-num">${report.findings.fakeAsyncTickUsages}</div>
        <div class="kpi-sub">fakeAsync, tick, flush y clock</div>
      </div>
      <div class="card">
        <div class="kpi-eyebrow">Karma personalizado</div>
        <div class="finding-num">${report.findings.customKarmaConfigs}</div>
        <div class="kpi-sub">Configuraciones no estándar</div>
      </div>
      <div class="card">
        <div class="kpi-eyebrow">Dependencias por revisar</div>
        <div class="finding-num">${report.findings.dependenciesToReview.length}</div>
        ${depsHtml}
      </div>
    </div>

    <div class="section-title">Clasificación de migración</div>
    <div class="card">
      <div class="bar-group">
        <div class="bar-head">
          <span class="bar-label"><span class="dot dot-low"></span>Baja <span class="muted">(${report.complexityBreakdown.low.count} archivo(s))</span></span>
          <span class="bar-pct">${report.complexityBreakdown.low.percentage}%</span>
        </div>
        <div class="bar-track"><div class="bar-fill fill-low" style="width:${report.complexityBreakdown.low.percentage}%"></div></div>
      </div>
      <div class="bar-group">
        <div class="bar-head">
          <span class="bar-label"><span class="dot dot-medium"></span>Media <span class="muted">(${report.complexityBreakdown.medium.count} archivo(s))</span></span>
          <span class="bar-pct">${report.complexityBreakdown.medium.percentage}%</span>
        </div>
        <div class="bar-track"><div class="bar-fill fill-medium" style="width:${report.complexityBreakdown.medium.percentage}%"></div></div>
      </div>
      <div class="bar-group">
        <div class="bar-head">
          <span class="bar-label"><span class="dot dot-high"></span>Alta <span class="muted">(${report.complexityBreakdown.high.count} archivo(s))</span></span>
          <span class="bar-pct">${report.complexityBreakdown.high.percentage}%</span>
        </div>
        <div class="bar-track"><div class="bar-fill fill-high" style="width:${report.complexityBreakdown.high.percentage}%"></div></div>
      </div>
    </div>

    <div class="section-title">Inventario de archivos *.spec.ts (${report.specInventory.length})</div>
    <div class="card table-card">
      <div class="table-toolbar">
        <div class="tabs-list" role="tablist">
          <button class="fbtn active" data-filter="all" type="button">Todos (${report.specInventory.length})</button>
          <button class="fbtn" data-filter="high" type="button">Alta (${report.complexityBreakdown.high.count})</button>
          <button class="fbtn" data-filter="medium" type="button">Media (${report.complexityBreakdown.medium.count})</button>
          <button class="fbtn" data-filter="low" type="button">Baja (${report.complexityBreakdown.low.count})</button>
        </div>
        <input class="search-input" id="specSearch" type="search" placeholder="Filtrar archivo..." />
      </div>
      <div class="table-scroll">
        <table>
          <thead>
            <tr>
              <th>Archivo</th>
              <th>Complejidad</th>
              <th class="num">Jasmine APIs</th>
              <th class="num">fakeAsync / timers</th>
              <th>Patrones detectados</th>
            </tr>
          </thead>
          <tbody id="specTableBody">
            ${specRows || '<tr><td colspan="5" class="muted">No se encontraron archivos *.spec.ts en el workspace.</td></tr>'}
          </tbody>
        </table>
      </div>
    </div>

    <div class="section-title">Plan de migración propuesto</div>
    <div class="card roadmap">
      ${roadmapHtml}
    </div>

    <footer>
      <span>Generado determinísticamente desde el análisis real del repositorio · Schema v${SCHEMA_VERSION}</span>
      <span>Evaluado: ${escapeHtml(report.evaluatedAt)} · Aprobación: <strong style="color:var(--foreground)">${escapeHtml(report.approval.status)}</strong></span>
    </footer>
  </div>

  <script>
    (function () {
      const toggle = document.getElementById('themeToggle');
      if (toggle) {
        toggle.addEventListener('click', () => document.body.classList.toggle('light'));
      }
      const copyBtn = document.getElementById('copyCmdBtn');
      const cmdEl = document.getElementById('schematicCmd');
      if (copyBtn && cmdEl && navigator.clipboard) {
        copyBtn.addEventListener('click', async () => {
          try {
            await navigator.clipboard.writeText(cmdEl.textContent || '');
            const prev = copyBtn.textContent;
            copyBtn.textContent = 'Copiado';
            setTimeout(() => { copyBtn.textContent = prev; }, 1600);
          } catch {}
        });
      }
      let activeFilter = 'all';
      const search = document.getElementById('specSearch');
      const rows = Array.from(document.querySelectorAll('#specTableBody tr[data-complexity]'));
      function applyFilters() {
        const q = (search?.value || '').trim().toLowerCase();
        for (const r of rows) {
          const matchC = activeFilter === 'all' || r.dataset.complexity === activeFilter;
          const matchQ = !q || (r.dataset.file || '').includes(q);
          r.style.display = matchC && matchQ ? '' : 'none';
        }
      }
      for (const btn of document.querySelectorAll('.fbtn')) {
        btn.addEventListener('click', () => {
          document.querySelectorAll('.fbtn').forEach((b) => b.classList.remove('active'));
          btn.classList.add('active');
          activeFilter = btn.dataset.filter || 'all';
          applyFilters();
        });
      }
      if (search) search.addEventListener('input', applyFilters);
    })();
  </script>
</body>
</html>
`;
}

function main() {
  const { projectDir, angularProject } = parseArgs(process.argv);
  const pkgPath = path.join(projectDir, 'package.json');
  const angularJsonPath = path.join(projectDir, 'angular.json');
  const defaultKarmaConfPath = path.join(projectDir, 'karma.conf.js');

  const blockers = [];
  const warnings = [];

  let pkg = {};
  if (fs.existsSync(pkgPath)) {
    pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
  } else {
    blockers.push({
      code: 'PACKAGE_JSON_MISSING',
      severity: 'error',
      message: `No existe package.json en ${projectDir}.`,
      remediation: 'Ejecuta el análisis en la raíz de un workspace Angular válido.',
    });
  }

  let angularJson = null;
  if (fs.existsSync(angularJsonPath)) {
    try {
      angularJson = JSON.parse(fs.readFileSync(angularJsonPath, 'utf8'));
    } catch (err) {
      blockers.push({
        code: 'ANGULAR_JSON_INVALID',
        severity: 'error',
        message: `No se pudo parsear angular.json: ${err.message}`,
        remediation: 'Corrige la sintaxis JSON de angular.json antes de continuar.',
      });
    }
  } else {
    blockers.push({
      code: 'ANGULAR_JSON_MISSING',
      severity: 'error',
      message: 'No se encontró angular.json en la raíz del proyecto.',
      remediation: 'Verifica que el repositorio sea un workspace de Angular CLI.',
    });
  }

  const allDeps = {
    ...(pkg.dependencies || {}),
    ...(pkg.devDependencies || {}),
  };

  const angularCoreRaw = allDeps['@angular/core'] || null;
  const angularCliRaw = allDeps['@angular/cli'] || null;
  const angularBuildRaw = allDeps['@angular/build'] || null;
  const angularCore = parseSemver(angularCoreRaw);
  const angularCli = parseSemver(angularCliRaw);
  const nodeSemver = parseSemver(process.versions.node);

  const dependenciesToReview = Object.keys(allDeps)
    .filter((k) => k === 'karma' || k.startsWith('karma-') || k === 'jasmine-core' || k.startsWith('jasmine-') || k === '@types/jasmine')
    .sort();

  const {
    angularProjectCount,
    testTargets,
    primaryBuilder: testBuilder,
    primaryBuildBuilder: buildBuilder,
    projectName,
    selectedProjectRoot,
    selectedKarmaConfig,
    selectedProjectNotFound,
    availableProjects,
  } = detectProjectsAndTargets(angularJson, angularProject);

  const isLegacyBuildSystem =
    Boolean(buildBuilder) &&
    buildBuilder !== '@angular/build:application' &&
    buildBuilder !== '@angular-devkit/build-angular:application';
  if (isLegacyBuildSystem) {
    warnings.push({
      code: 'LEGACY_BUILD_SYSTEM_DETECTED',
      message: `El target "build" utiliza "${buildBuilder}". La migración oficial de Karma a Vitest (@angular/build:unit-test) requiere el sistema de construcción "application" (@angular/build:application).`,
    });
  }

  if (selectedProjectNotFound) {
    blockers.push({
      code: 'ANGULAR_PROJECT_NOT_FOUND',
      severity: 'error',
      message: `El proyecto "${angularProject}" no existe en angular.json. Proyectos disponibles: ${availableProjects.join(', ') || 'ninguno'}.`,
      remediation: 'Indica un nombre de proyecto válido definido bajo "projects" en angular.json.',
    });
  }

  const specSearchRoot =
    selectedProjectRoot !== null && selectedProjectRoot !== ''
      ? path.resolve(projectDir, selectedProjectRoot)
      : projectDir;
  const specFiles = collectSpecFiles(projectDir, specSearchRoot);
  const specAnalysis = inspectAllSpecs(specFiles);

  const karmaConfPath = selectedKarmaConfig
    ? path.resolve(projectDir, selectedKarmaConfig)
    : selectedProjectRoot
      ? (fs.existsSync(path.resolve(projectDir, selectedProjectRoot, 'karma.conf.js'))
          ? path.resolve(projectDir, selectedProjectRoot, 'karma.conf.js')
          : defaultKarmaConfPath)
      : defaultKarmaConfPath;
  const karmaConfInfo = inspectKarmaConfig(karmaConfPath);

  if (!angularCore) {
    blockers.push({
      code: 'ANGULAR_CORE_NOT_FOUND',
      severity: 'error',
      message: 'No se detectó @angular/core en dependencies o devDependencies.',
      remediation: 'Asegúrate de analizar un proyecto Angular con @angular/core declarado en package.json.',
    });
  } else if (angularCore.major < 20) {
    blockers.push({
      code: 'ANGULAR_VERSION_UNSUPPORTED',
      severity: 'error',
      message: `Se detectó Angular ${angularCore.version} (${angularCoreRaw}). En Angular < 20 no existe el builder oficial @angular/build:unit-test y el runner estable de Vitest requiere Angular 21.0.0+.`,
      remediation: 'Usa primero un flujo/agente de actualización de Angular (ng update) para migrar el workspace a Angular 21+ antes de migrar de Jasmine/Karma a Vitest.',
    });
  } else if (angularCore.major === 20) {
    blockers.push({
      code: 'ANGULAR_VERSION_EXPERIMENTAL_VITEST',
      severity: 'error',
      message: `Se detectó Angular ${angularCore.version} (${angularCoreRaw}). En Angular 20 el soporte de Vitest en @angular/build:unit-test es solo experimental y Karma sigue siendo el runner por defecto.`,
      remediation: 'Actualiza primero el proyecto a Angular 21.0.0 o superior (donde Vitest es estable y el test runner por defecto) mediante un flujo/agente de upgrade de Angular antes de migrar a Vitest.',
    });
  }

  if (nodeSemver) {
    const isNodeValidFor21 =
      (nodeSemver.major === 20 && nodeSemver.minor >= 19) ||
      (nodeSemver.major === 22 && nodeSemver.minor >= 12) ||
      nodeSemver.major >= 24;
    if (!isNodeValidFor21) {
      warnings.push({
        code: 'NODE_VERSION_BELOW_RECOMMENDED',
        message: `Node.js ${process.versions.node} detectado. Angular 21 requiere oficialmente Node.js ^20.19.0 || ^22.12.0 || ^24.0.0.`,
      });
    }
  }

  const status = blockers.length === 0 ? 'READY' : 'BLOCKED';
  const multiProjectTestTargets = testTargets.length > 1;
  const customTargetCount = testTargets.filter((t) => t.hasKarmaConfigOption || t.hasCustomAssetsOrStyles).length;
  const hasCustomTargetOptions = customTargetCount > 0;
  const customKarmaConfigs = (karmaConfInfo.isCustom ? karmaConfInfo.customFeatures.length : 0) + customTargetCount;

  let recommendedStrategy;
  const strategyReasons = [];
  let officialSchematicSufficient = false;
  let officialSchematicNotes = '';

  if (status === 'BLOCKED') {
    recommendedStrategy = 'UPGRADE_FIRST';
    for (const b of blockers) strategyReasons.push(b.message);
    officialSchematicNotes = 'Bloqueado: el proyecto debe migrar primero a Angular 21+ antes de usar @angular/build:unit-test o el schematic oficial.';
  } else {
    if (isLegacyBuildSystem) {
      strategyReasons.push(`El target "build" utiliza "${buildBuilder}" en lugar del sistema "application" (@angular/build:application), requerido por @angular/build:unit-test.`);
    }
    if (karmaConfInfo.isCustom) {
      strategyReasons.push(`Se detectó karma.conf.js personalizado (${karmaConfInfo.customFeatures.join(', ')}) que el schematic oficial no migra automáticamente.`);
    }
    if (multiProjectTestTargets) {
      strategyReasons.push(`El workspace contiene ${testTargets.length} proyectos con target "test" (${testTargets.map((t) => t.project).join(', ')}).`);
    }
    if (hasCustomTargetOptions) {
      strategyReasons.push('angular.json define opciones específicas en el target "test" (karmaConfig/styles/scripts) que requieren revisión.');
    }
    if (specAnalysis.complexSpecPatterns.length > 0) {
      strategyReasons.push(`Se detectaron patrones complejos de Jasmine en ${specAnalysis.complexSpecFiles.length} archivo(s) (${specAnalysis.complexSpecPatterns.join(', ')}).`);
    }

    if (strategyReasons.length === 0) {
      recommendedStrategy = 'OFFICIAL_SCHEMATIC_SUFFICIENT';
      officialSchematicSufficient = true;
      strategyReasons.push('No se detectaron configuraciones Karma personalizadas, múltiples targets complejos ni patrones avanzados de Jasmine.');
      officialSchematicNotes = 'Suficiente con la solución oficial de Angular: configurar @angular/build:unit-test, instalar vitest/jsdom y ejecutar "ng g @schematics/angular:refactor-jasmine-vitest".';
    } else {
      recommendedStrategy = 'HYBRID_SCHEMATIC_PLUS_AGENT';
      officialSchematicSufficient = false;
      officialSchematicNotes = 'Usar "ng g @schematics/angular:refactor-jasmine-vitest" como base para specs estándar y continuar con Fase 2 y Fase 3 del plugin para casos complejos.';
    }
  }

  const detected = {
    projectName: angularProject || pkg.name || projectName || path.basename(projectDir),
    selectedAngularProject: angularProject || projectName || null,
    angularCoreVersion: angularCore ? angularCore.version : null,
    angularCoreRaw,
    angularCliVersion: angularCli ? angularCli.version : null,
    angularBuildRaw,
    nodeVersion: process.versions.node,
    testBuilder,
    buildBuilder,
    angularProjectCount,
    testTargetCount: testTargets.length,
    hasKarmaDeps: dependenciesToReview.some((d) => d.startsWith('karma')),
    hasJasmineDeps: dependenciesToReview.some((d) => d.includes('jasmine')),
    hasKarmaConf: karmaConfInfo.exists,
    specFileCount: specAnalysis.specInventory.length,
  };

  const diagnosisFingerprintPayload = {
    selectedAngularProject: detected.selectedAngularProject,
    angularCoreVersion: detected.angularCoreVersion,
    testBuilder: detected.testBuilder,
    hasKarmaConf: detected.hasKarmaConf,
    customKarmaFeatures: [...karmaConfInfo.customFeatures].sort(),
    dependenciesToReview: [...dependenciesToReview].sort(),
    specInventory: specAnalysis.specInventory.map((s) => ({
      file: s.file,
      complexity: s.complexity,
      complexityScore: s.complexityScore,
      jasmineApiCount: s.jasmineApiCount,
      fakeAsyncTickCount: s.fakeAsyncTickCount,
    })),
  };
  const diagnosisHash = `sha256:${crypto
    .createHash('sha256')
    .update(JSON.stringify(diagnosisFingerprintPayload))
    .digest('hex')
    .slice(0, 16)}`;

  const findings = {
    jasmineApiUsages: specAnalysis.totalJasmineApiUsages,
    fakeAsyncTickUsages: specAnalysis.totalFakeAsyncTickUsages,
    customKarmaConfigs,
    dependenciesToReview,
  };

  const lowPct = specAnalysis.complexityBreakdown.low.percentage;
  const needsReviewPct =
    specAnalysis.specInventory.length === 0
      ? 0
      : specAnalysis.complexityBreakdown.medium.percentage + specAnalysis.complexityBreakdown.high.percentage;

  const metrics = {
    specFileCount: specAnalysis.specInventory.length,
    angularProjectCount,
    lowComplexityPct: lowPct,
    needsReviewPct,
  };

  const roadmap = buildRoadmap(status, recommendedStrategy, detected, findings);

  const summary =
    status === 'READY'
      ? `Proyecto "${detected.projectName}" en Angular ${detected.angularCoreVersion} elegible (READY). Estrategia: ${recommendedStrategy}. ${metrics.specFileCount} specs (${metrics.lowComplexityPct}% baja complejidad, ${metrics.needsReviewPct}% requieren revisión).`
      : blockers.map((b) => b.message).join(' ');

  const artifactsDir = path.join(projectDir, ARTIFACTS_SUBDIR);
  fs.mkdirSync(artifactsDir, { recursive: true });

  const jsonRel = path.join(ARTIFACTS_SUBDIR, '01-diagnosis-report.json').replace(/\\/g, '/');
  const mdRel = path.join(ARTIFACTS_SUBDIR, '01-diagnosis-report.md').replace(/\\/g, '/');
  const htmlRel = path.join(ARTIFACTS_SUBDIR, '01-diagnosis-report.html').replace(/\\/g, '/');

  const report = {
    schemaVersion: SCHEMA_VERSION,
    diagnosisHash,
    evaluatedAt: new Date().toISOString(),
    projectPath: projectDir,
    status,
    recommendedStrategy,
    strategyReasons,
    officialSchematic: {
      command: OFFICIAL_SCHEMATIC_CMD,
      sufficient: officialSchematicSufficient,
      notes: officialSchematicNotes,
    },
    summary,
    metrics,
    findings,
    complexityBreakdown: specAnalysis.complexityBreakdown,
    detected,
    complexitySignals: {
      customKarmaConfig: karmaConfInfo.isCustom,
      customKarmaFeatures: karmaConfInfo.customFeatures,
      multiProjectTestTargets,
      hasCustomTargetOptions,
      complexSpecPatterns: specAnalysis.complexSpecPatterns,
      complexSpecFiles: specAnalysis.complexSpecFiles,
    },
    requirements: {
      minStableAngularVersion: '21.0.0',
      requiredNodeRange: '^20.19.0 || ^22.12.0 || ^24.0.0',
      targetBuilder: '@angular/build:unit-test',
      targetRunner: 'vitest',
    },
    blockers,
    warnings,
    specInventory: specAnalysis.specInventory,
    roadmap,
    generatedFiles: {
      json: jsonRel,
      markdown: mdRel,
      html: htmlRel,
    },
    approval: {
      status: 'PENDING',
      reviewer: null,
      approvedAt: null,
      mode: null,
      notes:
        status === 'BLOCKED'
          ? 'Bloqueado: requiere upgrade previo a Angular 21+ antes de poder aprobarse.'
          : 'Pendiente de revisión y aprobación por el especialista.',
    },
  };

  fs.writeFileSync(path.join(artifactsDir, '01-diagnosis-report.json'), `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  fs.writeFileSync(path.join(artifactsDir, '01-diagnosis-report.md'), renderMarkdown(report), 'utf8');
  fs.writeFileSync(path.join(artifactsDir, '01-diagnosis-report.html'), renderHtml(report), 'utf8');

  // Print ONLY a compact summary to stdout to keep LLM token usage minimal
  const compactSummary = {
    status: report.status,
    diagnosisHash: report.diagnosisHash,
    recommendedStrategy: report.recommendedStrategy,
    angularCoreVersion: report.detected.angularCoreVersion,
    metrics: report.metrics,
    findings: {
      jasmineApiUsages: report.findings.jasmineApiUsages,
      fakeAsyncTickUsages: report.findings.fakeAsyncTickUsages,
      customKarmaConfigs: report.findings.customKarmaConfigs,
      dependenciesToReviewCount: report.findings.dependenciesToReview.length,
    },
    complexityBreakdown: report.complexityBreakdown,
    blockers: report.blockers.map((b) => ({ code: b.code, remediation: b.remediation })),
    generatedFiles: report.generatedFiles,
  };

  process.stdout.write(`${JSON.stringify(compactSummary, null, 2)}\n`);
}

main();
