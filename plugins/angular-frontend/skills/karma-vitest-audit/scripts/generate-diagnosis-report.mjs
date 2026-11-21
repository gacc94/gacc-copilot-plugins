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
import fs from 'node:fs';
import path from 'node:path';

const SCHEMA_VERSION = '1.2.0';
const OFFICIAL_SCHEMATIC_CMD = 'ng g @schematics/angular:refactor-jasmine-vitest';
const ARTIFACTS_SUBDIR = path.join('.migration-artifacts', 'karma-to-vitest');

const JASMINE_API_PATTERNS = [
  { name: 'spyOn', regex: /\bspyOn\s*\(/g },
  { name: 'jasmine.createSpy', regex: /\bjasmine\.createSpy\s*\(/g },
  { name: 'jasmine.createSpyObj', regex: /\bjasmine\.createSpyObj\s*\(/g },
  { name: 'jasmine.any', regex: /\bjasmine\.any\s*\(/g },
  { name: 'jasmine.anything', regex: /\bjasmine\.anything\s*\(/g },
  { name: 'jasmine.objectContaining', regex: /\bjasmine\.objectContaining\s*\(/g },
  { name: 'jasmine.arrayContaining', regex: /\bjasmine\.arrayContaining\s*\(/g },
  { name: 'jasmine.stringMatching', regex: /\bjasmine\.stringMatching\s*\(/g },
  { name: 'toBeTrue/toBeFalse', regex: /\.toBe(?:True|False)\s*\(/g },
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
  { name: 'spyOnProperty', regex: /\bspyOnProperty\s*\(/ },
  { name: 'spyOnAllFunctions', regex: /\bspyOnAllFunctions\s*\(/ },
  { name: 'jasmine.addMatchers', regex: /\bjasmine\.addMatchers\s*\(/ },
  { name: 'jasmine.createSpyObj-with-properties', regex: /\bjasmine\.createSpyObj\s*\([^)]*,[^)]*,[^)]*\)/ },
  { name: 'async-done-callback', regex: /\b(?:it|fit|beforeEach|afterEach)\s*\([^,]+,\s*(?:async\s*)?\(\s*done\b/ },
];

const CUSTOM_KARMA_PATTERNS = [
  { name: 'proxies', regex: /\bproxies\s*:/ },
  { name: 'customLaunchers', regex: /\bcustomLaunchers\s*:/ },
  { name: 'preprocessors', regex: /\bpreprocessors\s*:/ },
  { name: 'files', regex: /\bfiles\s*:\s*\[/ },
  { name: 'webpack', regex: /\bwebpack\s*:/ },
];

function parseArgs(argv) {
  let projectDir = process.cwd();
  for (let i = 2; i < argv.length; i++) {
    if ((argv[i] === '--project' || argv[i] === '-p') && argv[i + 1]) {
      projectDir = path.resolve(argv[++i]);
    }
  }
  return { projectDir };
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
    if (fileComplexPatterns.length > 0 || fileJasmineCount >= 12) {
      complexity = 'high';
    } else if (fileAsyncTimerCount > 0 || fileJasmineCount >= 4) {
      complexity = 'medium';
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
    });
  }

  // Sort inventory: high -> medium -> low, then alphabetical
  const rank = { high: 0, medium: 1, low: 2 };
  specInventory.sort((a, b) => rank[a.complexity] - rank[b.complexity] || a.file.localeCompare(b.file));

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

function detectProjectsAndTargets(angularJson) {
  if (!angularJson || typeof angularJson.projects !== 'object') {
    return { angularProjectCount: 0, testTargets: [], primaryBuilder: null, projectName: null };
  }
  const projectNames = Object.keys(angularJson.projects);
  const testTargets = [];
  for (const [projName, projConfig] of Object.entries(angularJson.projects)) {
    const targets = projConfig?.architect || projConfig?.targets;
    if (targets?.test?.builder) {
      testTargets.push({
        project: projName,
        builder: targets.test.builder,
        hasKarmaConfigOption: Boolean(targets.test.options?.karmaConfig),
        hasCustomAssetsOrStyles: Boolean(
          (Array.isArray(targets.test.options?.styles) && targets.test.options.styles.length > 0) ||
          (Array.isArray(targets.test.options?.scripts) && targets.test.options.scripts.length > 0)
        ),
      });
    }
  }
  const primary = testTargets[0] || null;
  return {
    angularProjectCount: projectNames.length,
    testTargets,
    primaryBuilder: primary ? primary.builder : null,
    projectName: primary ? primary.project : projectNames[0] || null,
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
    `> **Estado:** ${statusIcon} · **Estrategia recomendada:** ${strategyLabels[report.recommendedStrategy] || report.recommendedStrategy} · **Evaluado:** \`${report.evaluatedAt}\``,
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
      '| Archivo | Complejidad | Jasmine APIs | `fakeAsync`/timers | Patrones detectados |',
      '| :--- | :---: | :---: | :---: | :--- |'
    );
    for (const s of report.specInventory) {
      const badge = s.complexity === 'high' ? '🔴 Alta' : s.complexity === 'medium' ? '🟠 Media' : '🟢 Baja';
      lines.push(
        `| \`${s.file}\` | ${badge} | ${s.jasmineApiCount} | ${s.fakeAsyncTickCount} | ${s.jasminePatterns.join(', ') || 'Estándar'} |`
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
    ? `<section class="alert alert-danger">
        <div class="alert-title">Flujo bloqueado — Se requiere actualizar Angular primero</div>
        <ul>${report.blockers
          .map(
            (b) =>
              `<li><strong>${escapeHtml(b.code)}:</strong> ${escapeHtml(b.message)}<br><span class="muted">Remediación: ${escapeHtml(b.remediation)}</span></li>`
          )
          .join('')}</ul>
       </section>`
    : `<section class="alert ${report.officialSchematic.sufficient ? 'alert-success' : 'alert-info'}">
        <div class="alert-title">${escapeHtml(strategyNames[report.recommendedStrategy] || report.recommendedStrategy)}</div>
        <p>${escapeHtml(report.officialSchematic.notes)}</p>
        <div class="cmd-box"><code>${escapeHtml(report.officialSchematic.command)}</code></div>
       </section>`;

  const depsHtml =
    report.findings.dependenciesToReview.length > 0
      ? `<div class="chips">${report.findings.dependenciesToReview.map((d) => `<span class="chip">${escapeHtml(d)}</span>`).join('')}</div>`
      : '<span class="muted">Sin paquetes Karma/Jasmine detectados</span>';

  const specRows = report.specInventory
    .map((s) => {
      const cls = s.complexity;
      const label = cls === 'high' ? 'Alta' : cls === 'medium' ? 'Media' : 'Baja';
      const patterns = s.jasminePatterns.length > 0 ? s.jasminePatterns.map((p) => `<span class="chip-sm">${escapeHtml(p)}</span>`).join(' ') : '<span class="muted">Estándar</span>';
      return `<tr data-complexity="${cls}" data-file="${escapeHtml(s.file.toLowerCase())}">
        <td class="mono">${escapeHtml(s.file)}</td>
        <td><span class="pill pill-${cls}">${label}</span></td>
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
          <div class="step-title">${escapeHtml(r.phase)} <span class="state-tag state-${stateClass}">${escapeHtml(r.state)}</span></div>
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
      --bg: #0b0e14;
      --surface: #131822;
      --surface-2: #1a2130;
      --border: #263042;
      --text: #eef2f8;
      --muted: #93a1b7;
      --green: #16c47f;
      --green-bg: rgba(22, 196, 127, 0.14);
      --amber: #f59e0b;
      --amber-bg: rgba(245, 158, 11, 0.15);
      --red: #ef4444;
      --red-bg: rgba(239, 68, 68, 0.15);
      --blue: #3b82f6;
      --blue-bg: rgba(59, 130, 246, 0.15);
      --track: #232c3d;
    }
    body.light {
      --bg: #f5f7fb;
      --surface: #ffffff;
      --surface-2: #f0f4fa;
      --border: #dce3ef;
      --text: #0f172a;
      --muted: #475569;
      --track: #e2e8f0;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Inter, sans-serif;
      background: var(--bg);
      color: var(--text);
      line-height: 1.5;
      padding: 28px 18px 64px;
    }
    .container { max-width: 960px; margin: 0 auto; }
    .topbar {
      display: flex;
      justify-content: space-between;
      align-items: center;
      flex-wrap: wrap;
      gap: 12px;
      margin-bottom: 10px;
    }
    .eyebrow {
      font-size: 13px;
      font-weight: 600;
      letter-spacing: 0.04em;
      text-transform: uppercase;
      color: var(--muted);
    }
    .badges { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
    .pill {
      display: inline-flex;
      align-items: center;
      padding: 3px 10px;
      border-radius: 999px;
      font-size: 12px;
      font-weight: 700;
      letter-spacing: 0.02em;
    }
    .pill-ready, .pill-low { background: var(--green-bg); color: var(--green); }
    .pill-blocked, .pill-high { background: var(--red-bg); color: var(--red); }
    .pill-medium { background: var(--amber-bg); color: var(--amber); }
    .pill-strategy { background: var(--blue-bg); color: var(--blue); }
    .theme-btn {
      background: var(--surface);
      color: var(--text);
      border: 1px solid var(--border);
      border-radius: 8px;
      padding: 4px 10px;
      font-size: 12px;
      cursor: pointer;
    }
    h1 { margin: 4px 0 6px; font-size: 28px; font-weight: 700; }
    .subtitle { color: var(--muted); font-size: 14px; margin-bottom: 22px; }
    h2 {
      font-size: 16px;
      font-weight: 600;
      margin: 28px 0 14px;
      padding-bottom: 8px;
      border-bottom: 1px solid var(--border);
    }
    .alert {
      border-radius: 12px;
      padding: 16px 18px;
      margin: 18px 0 22px;
      border: 1px solid var(--border);
    }
    .alert-danger { background: var(--red-bg); border-color: rgba(239, 68, 68, 0.35); }
    .alert-success { background: var(--green-bg); border-color: rgba(22, 196, 127, 0.35); }
    .alert-info { background: var(--blue-bg); border-color: rgba(59, 130, 246, 0.35); }
    .alert-title { font-weight: 700; font-size: 15px; margin-bottom: 6px; }
    .alert ul { margin: 8px 0 0 18px; padding: 0; }
    .alert p { margin: 4px 0 10px; font-size: 14px; }
    .cmd-box {
      background: var(--surface);
      border: 1px solid var(--border);
      border-radius: 8px;
      padding: 8px 12px;
      font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
      font-size: 13px;
      overflow-x: auto;
    }
    .kpi-grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
      gap: 14px;
    }
    .card {
      background: var(--surface);
      border: 1px solid var(--border);
      border-radius: 12px;
      padding: 16px 18px;
    }
    .kpi-val { font-size: 30px; font-weight: 700; line-height: 1.15; }
    .kpi-label { font-size: 13px; color: var(--muted); margin-top: 6px; }
    .findings-list {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(210px, 1fr));
      gap: 12px;
    }
    .finding-item {
      background: var(--surface);
      border: 1px solid var(--border);
      border-radius: 10px;
      padding: 14px 16px;
    }
    .finding-title { font-size: 13px; color: var(--muted); }
    .finding-num { font-size: 22px; font-weight: 700; margin-top: 4px; }
    .chips { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 8px; }
    .chip {
      background: var(--surface-2);
      border: 1px solid var(--border);
      border-radius: 6px;
      padding: 2px 8px;
      font-size: 11px;
      font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    }
    .chip-sm {
      display: inline-block;
      background: var(--surface-2);
      border: 1px solid var(--border);
      border-radius: 5px;
      padding: 1px 6px;
      font-size: 11px;
      font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
      margin: 1px 2px;
    }
    .bar-group { margin-bottom: 16px; }
    .bar-head {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 6px;
      font-size: 13px;
    }
    .bar-track {
      height: 10px;
      border-radius: 999px;
      background: var(--track);
      overflow: hidden;
    }
    .bar-fill { height: 100%; border-radius: 999px; }
    .fill-low { background: var(--green); }
    .fill-medium { background: var(--amber); }
    .fill-high { background: var(--red); }
    .controls {
      display: flex;
      justify-content: space-between;
      align-items: center;
      flex-wrap: wrap;
      gap: 10px;
      margin-bottom: 12px;
    }
    .filter-btns { display: flex; gap: 6px; flex-wrap: wrap; }
    .fbtn {
      background: var(--surface);
      color: var(--text);
      border: 1px solid var(--border);
      border-radius: 8px;
      padding: 5px 11px;
      font-size: 12px;
      cursor: pointer;
    }
    .fbtn.active { background: var(--blue-bg); border-color: var(--blue); color: var(--blue); font-weight: 600; }
    .search-input {
      background: var(--surface);
      color: var(--text);
      border: 1px solid var(--border);
      border-radius: 8px;
      padding: 6px 10px;
      font-size: 13px;
      min-width: 220px;
    }
    .table-wrap {
      background: var(--surface);
      border: 1px solid var(--border);
      border-radius: 12px;
      overflow-x: auto;
    }
    table { width: 100%; border-collapse: collapse; font-size: 13px; }
    th, td { padding: 10px 12px; text-align: left; border-bottom: 1px solid var(--border); }
    th { color: var(--muted); font-weight: 600; background: var(--surface-2); }
    tr:last-child td { border-bottom: none; }
    .mono { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px; }
    .num { text-align: center; font-variant-numeric: tabular-nums; }
    .roadmap { display: flex; flex-direction: column; gap: 14px; }
    .step { display: flex; gap: 14px; align-items: flex-start; }
    .step-num {
      width: 28px;
      height: 28px;
      border-radius: 50%;
      background: var(--surface-2);
      border: 1px solid var(--border);
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 12px;
      font-weight: 700;
      flex-shrink: 0;
    }
    .step-blocking .step-num { background: var(--red-bg); color: var(--red); border-color: var(--red); }
    .step-completed .step-num { background: var(--green-bg); color: var(--green); border-color: var(--green); }
    .step-title { font-weight: 600; font-size: 14px; }
    .step-desc { font-size: 13px; color: var(--muted); margin-top: 2px; }
    .state-tag {
      font-size: 10px;
      padding: 2px 6px;
      border-radius: 4px;
      margin-left: 6px;
      text-transform: uppercase;
      background: var(--surface-2);
      color: var(--muted);
    }
    .state-blocking { background: var(--red-bg); color: var(--red); }
    .state-completed { background: var(--green-bg); color: var(--green); }
    .muted { color: var(--muted); }
    footer {
      margin-top: 32px;
      padding-top: 14px;
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
        <span class="pill ${isBlocked ? 'pill-blocked' : 'pill-ready'}">${escapeHtml(report.status)}</span>
        <span class="pill pill-strategy">${escapeHtml(strategyNames[report.recommendedStrategy] || report.recommendedStrategy)}</span>
        <button class="theme-btn" id="themeToggle" type="button">Tema claro / oscuro</button>
      </div>
    </div>

    <h1>Migration Assessment Report</h1>
    <div class="subtitle">
      Proyecto: <strong>${escapeHtml(projectTitle)}</strong> · Auditoría de Karma/Jasmine a Vitest ·
      Angular <code>${escapeHtml(report.detected.angularCoreVersion || 'N/D')}</code> ·
      Node.js <code>${escapeHtml(report.detected.nodeVersion)}</code> ·
      Builder <code>${escapeHtml(report.detected.testBuilder || 'N/D')}</code>
    </div>

    ${blockerBanner}

    <h2>Resumen ejecutivo</h2>
    <div class="kpi-grid">
      <div class="card">
        <div class="kpi-val">${report.metrics.specFileCount}</div>
        <div class="kpi-label">Archivos de pruebas (*.spec.ts)</div>
      </div>
      <div class="card">
        <div class="kpi-val">${report.metrics.angularProjectCount}</div>
        <div class="kpi-label">Proyectos Angular</div>
      </div>
      <div class="card">
        <div class="kpi-val">${report.metrics.lowComplexityPct}%</div>
        <div class="kpi-label">Patrones de baja complejidad</div>
      </div>
      <div class="card">
        <div class="kpi-val">${report.metrics.needsReviewPct}%</div>
        <div class="kpi-label">Patrones que requieren revisión</div>
      </div>
    </div>

    <h2>Hallazgos</h2>
    <div class="findings-list">
      <div class="finding-item">
        <div class="finding-title">Uso de Jasmine APIs</div>
        <div class="finding-num">${report.findings.jasmineApiUsages}</div>
      </div>
      <div class="finding-item">
        <div class="finding-title">Uso de fakeAsync / tick / clock</div>
        <div class="finding-num">${report.findings.fakeAsyncTickUsages}</div>
      </div>
      <div class="finding-item">
        <div class="finding-title">Configuraciones Karma personalizadas</div>
        <div class="finding-num">${report.findings.customKarmaConfigs}</div>
      </div>
      <div class="finding-item">
        <div class="finding-title">Dependencias por revisar</div>
        <div class="finding-num">${report.findings.dependenciesToReview.length}</div>
        ${depsHtml}
      </div>
    </div>

    <h2>Clasificación de migración</h2>
    <div class="card">
      <div class="bar-group">
        <div class="bar-head">
          <span><span class="pill pill-low">Baja</span> <span class="muted">(${report.complexityBreakdown.low.count} archivo(s))</span></span>
          <strong>${report.complexityBreakdown.low.percentage}%</strong>
        </div>
        <div class="bar-track"><div class="bar-fill fill-low" style="width:${report.complexityBreakdown.low.percentage}%"></div></div>
      </div>
      <div class="bar-group">
        <div class="bar-head">
          <span><span class="pill pill-medium">Media</span> <span class="muted">(${report.complexityBreakdown.medium.count} archivo(s))</span></span>
          <strong>${report.complexityBreakdown.medium.percentage}%</strong>
        </div>
        <div class="bar-track"><div class="bar-fill fill-medium" style="width:${report.complexityBreakdown.medium.percentage}%"></div></div>
      </div>
      <div class="bar-group" style="margin-bottom:0">
        <div class="bar-head">
          <span><span class="pill pill-high">Alta</span> <span class="muted">(${report.complexityBreakdown.high.count} archivo(s))</span></span>
          <strong>${report.complexityBreakdown.high.percentage}%</strong>
        </div>
        <div class="bar-track"><div class="bar-fill fill-high" style="width:${report.complexityBreakdown.high.percentage}%"></div></div>
      </div>
    </div>

    <h2>Inventario de archivos *.spec.ts (${report.specInventory.length})</h2>
    <div class="controls">
      <div class="filter-btns">
        <button class="fbtn active" data-filter="all" type="button">Todos (${report.specInventory.length})</button>
        <button class="fbtn" data-filter="high" type="button">Alta (${report.complexityBreakdown.high.count})</button>
        <button class="fbtn" data-filter="medium" type="button">Media (${report.complexityBreakdown.medium.count})</button>
        <button class="fbtn" data-filter="low" type="button">Baja (${report.complexityBreakdown.low.count})</button>
      </div>
      <input class="search-input" id="specSearch" type="search" placeholder="Filtrar archivo..." />
    </div>
    <div class="table-wrap">
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

    <h2>Plan de migración propuesto (Hoja de ruta orientativa)</h2>
    <div class="card roadmap">
      ${roadmapHtml}
    </div>

    <footer>
      <span>Generado determinísticamente desde el análisis real del repositorio · Schema v${SCHEMA_VERSION}</span>
      <span>Evaluado: ${escapeHtml(report.evaluatedAt)} · Aprobación: <strong>${escapeHtml(report.approval.status)}</strong></span>
    </footer>
  </div>

  <script>
    (function () {
      const toggle = document.getElementById('themeToggle');
      if (toggle) {
        toggle.addEventListener('click', () => document.body.classList.toggle('light'));
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
  const { projectDir } = parseArgs(process.argv);
  const pkgPath = path.join(projectDir, 'package.json');
  const angularJsonPath = path.join(projectDir, 'angular.json');
  const karmaConfPath = path.join(projectDir, 'karma.conf.js');

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

  const { angularProjectCount, testTargets, primaryBuilder: testBuilder, projectName } = detectProjectsAndTargets(angularJson);
  const specFiles = collectSpecFiles(projectDir);
  const specAnalysis = inspectAllSpecs(specFiles);
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
    projectName: pkg.name || projectName || path.basename(projectDir),
    angularCoreVersion: angularCore ? angularCore.version : null,
    angularCoreRaw,
    angularCliVersion: angularCli ? angularCli.version : null,
    angularBuildRaw,
    nodeVersion: process.versions.node,
    testBuilder,
    angularProjectCount,
    testTargetCount: testTargets.length,
    hasKarmaDeps: dependenciesToReview.some((d) => d.startsWith('karma')),
    hasJasmineDeps: dependenciesToReview.some((d) => d.includes('jasmine')),
    hasKarmaConf: karmaConfInfo.exists,
    specFileCount: specAnalysis.specInventory.length,
  };

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
