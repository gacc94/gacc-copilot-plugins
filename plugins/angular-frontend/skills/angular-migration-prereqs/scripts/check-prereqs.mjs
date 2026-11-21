#!/usr/bin/env node
/**
 * Deterministically checks whether an Angular repository meets the official
 * minimum requirements (Angular >= 21.0.0 and compatible Node.js) to migrate
 * from Jasmine/Karma to the stable Vitest runner (@angular/build:unit-test),
 * and classifies the recommended migration strategy:
 *   - UPGRADE_FIRST (Angular < 21.0.0 -> BLOCKED)
 *   - OFFICIAL_SCHEMATIC_SUFFICIENT (Angular >= 21.0.0, simple setup)
 *   - HYBRID_SCHEMATIC_PLUS_AGENT (Angular >= 21.0.0, custom Karma or complex Jasmine patterns)
 *
 * Zero external dependencies — uses only built-in Node.js modules.
 */
import fs from 'node:fs';
import path from 'node:path';

const OFFICIAL_SCHEMATIC_CMD = 'ng g @schematics/angular:refactor-jasmine-vitest';

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

function collectSpecFiles(rootDir, currentDir = rootDir, acc = []) {
  if (!fs.existsSync(currentDir)) return acc;
  const ignored = new Set(['node_modules', '.git', 'dist', '.angular', '.migration-artifacts']);
  for (const entry of fs.readdirSync(currentDir, { withFileTypes: true })) {
    if (ignored.has(entry.name)) continue;
    const full = path.join(currentDir, entry.name);
    if (entry.isDirectory()) {
      collectSpecFiles(rootDir, full, acc);
    } else if (entry.isFile() && entry.name.endsWith('.spec.ts')) {
      acc.push({
        relativePath: path.relative(rootDir, full),
        absolutePath: full,
      });
    }
  }
  return acc;
}

function inspectSpecs(specFiles) {
  const complexSpecFiles = [];
  const complexPatternsSet = new Set();

  for (const spec of specFiles) {
    let content = '';
    try {
      content = fs.readFileSync(spec.absolutePath, 'utf8');
    } catch {
      continue;
    }
    const matched = [];
    for (const pattern of COMPLEX_SPEC_PATTERNS) {
      if (pattern.regex.test(content)) {
        matched.push(pattern.name);
        complexPatternsSet.add(pattern.name);
      }
    }
    if (matched.length > 0) {
      complexSpecFiles.push({
        file: spec.relativePath,
        patterns: matched,
      });
    }
  }

  return {
    complexSpecPatterns: [...complexPatternsSet],
    complexSpecFiles,
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
  // Check for non-default karma plugins
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

function detectTestTargets(angularJson) {
  if (!angularJson || typeof angularJson.projects !== 'object') {
    return { testTargets: [], primaryBuilder: null, projectName: null };
  }
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
    testTargets,
    primaryBuilder: primary ? primary.builder : null,
    projectName: primary ? primary.project : Object.keys(angularJson.projects)[0] || null,
  };
}

function main() {
  const { projectDir } = parseArgs(process.argv);
  const pkgPath = path.join(projectDir, 'package.json');
  const angularJsonPath = path.join(projectDir, 'angular.json');
  const karmaConfPath = path.join(projectDir, 'karma.conf.js');

  const blockers = [];
  const warnings = [];

  if (!fs.existsSync(pkgPath)) {
    const result = {
      schemaVersion: '1.1.0',
      evaluatedAt: new Date().toISOString(),
      projectPath: projectDir,
      status: 'BLOCKED',
      recommendedStrategy: 'UPGRADE_FIRST',
      strategyReasons: ['No se encontró package.json en el directorio especificado.'],
      officialSchematic: {
        command: OFFICIAL_SCHEMATIC_CMD,
        sufficient: false,
        notes: 'Requiere un workspace Angular 21+ válido antes de evaluar o ejecutar el schematic oficial.',
      },
      summary: 'No se encontró package.json en el directorio especificado.',
      blockers: [
        {
          code: 'PACKAGE_JSON_MISSING',
          severity: 'error',
          message: `No existe package.json en ${projectDir}.`,
          remediation: 'Ejecuta el análisis en la raíz de un workspace Angular válido.',
        },
      ],
    };
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    process.exit(0);
  }

  const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
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

  const { testTargets, primaryBuilder: testBuilder, projectName } = detectTestTargets(angularJson);
  const specFiles = collectSpecFiles(projectDir);
  const specComplexity = inspectSpecs(specFiles);
  const karmaConfInfo = inspectKarmaConfig(karmaConfPath);
  const hasKarmaDeps = Object.keys(allDeps).some((k) => k.startsWith('karma'));
  const hasJasmineDeps = Object.keys(allDeps).some((k) => k.startsWith('jasmine'));

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
  const hasCustomTargetOptions = testTargets.some((t) => t.hasKarmaConfigOption || t.hasCustomAssetsOrStyles);

  let recommendedStrategy;
  const strategyReasons = [];
  let officialSchematicSufficient = false;
  let officialSchematicNotes = '';

  if (status === 'BLOCKED') {
    recommendedStrategy = 'UPGRADE_FIRST';
    for (const b of blockers) {
      strategyReasons.push(b.message);
    }
    officialSchematicNotes = 'Bloqueado: el proyecto debe migrar primero a Angular 21+ antes de utilizar el builder @angular/build:unit-test o el schematic oficial.';
  } else {
    if (karmaConfInfo.isCustom) {
      strategyReasons.push(
        `Se detectó karma.conf.js con configuración personalizada (${karmaConfInfo.customFeatures.join(', ')}) que el schematic oficial no migra automáticamente.`
      );
    }
    if (multiProjectTestTargets) {
      strategyReasons.push(
        `El workspace contiene ${testTargets.length} proyectos con target "test" (${testTargets.map((t) => t.project).join(', ')}), requiriendo coordinación por proyecto.`
      );
    }
    if (hasCustomTargetOptions) {
      strategyReasons.push(
        'angular.json define opciones específicas en el target "test" (karmaConfig/styles/scripts) que requieren revisión y migración manual o asistida.'
      );
    }
    if (specComplexity.complexSpecPatterns.length > 0) {
      strategyReasons.push(
        `Se detectaron patrones complejos de Jasmine en ${specComplexity.complexSpecFiles.length} archivo(s) (${specComplexity.complexSpecPatterns.join(', ')}) fuera del alcance garantizado del schematic oficial.`
      );
    }

    if (strategyReasons.length === 0) {
      recommendedStrategy = 'OFFICIAL_SCHEMATIC_SUFFICIENT';
      officialSchematicSufficient = true;
      strategyReasons.push(
        'No se detectaron configuraciones personalizadas en karma.conf.js, múltiples targets complejos ni patrones avanzados de Jasmine.'
      );
      officialSchematicNotes =
        'Suficiente con la solución oficial de Angular: configurar @angular/build:unit-test en angular.json, instalar vitest/jsdom y ejecutar "ng g @schematics/angular:refactor-jasmine-vitest". No es necesario ejecutar Fase 2/3 del plugin salvo que el equipo desee automatizarlo.';
    } else {
      recommendedStrategy = 'HYBRID_SCHEMATIC_PLUS_AGENT';
      officialSchematicSufficient = false;
      officialSchematicNotes =
        'Usar el schematic oficial "ng g @schematics/angular:refactor-jasmine-vitest" como base para refactorizar specs estándar y continuar con Fase 2 (Plan) y Fase 3 (Migrador) del plugin para migrar configuraciones y patrones complejos.';
    }
  }

  const summary =
    status === 'READY'
      ? `Proyecto en Angular ${angularCore.version} elegible (READY). Estrategia recomendada: ${recommendedStrategy}. Se detectaron ${specFiles.length} archivo(s) *.spec.ts.`
      : blockers.map((b) => b.message).join(' ');

  const report = {
    schemaVersion: '1.1.0',
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
    detected: {
      projectName,
      angularCoreVersion: angularCore ? angularCore.version : null,
      angularCoreRaw,
      angularCliVersion: angularCli ? angularCli.version : null,
      angularBuildRaw,
      nodeVersion: process.versions.node,
      testBuilder,
      testTargetCount: testTargets.length,
      hasKarmaDeps,
      hasJasmineDeps,
      hasKarmaConf: karmaConfInfo.exists,
      specFileCount: specFiles.length,
    },
    complexitySignals: {
      customKarmaConfig: karmaConfInfo.isCustom,
      customKarmaFeatures: karmaConfInfo.customFeatures,
      multiProjectTestTargets,
      hasCustomTargetOptions,
      complexSpecPatterns: specComplexity.complexSpecPatterns,
      complexSpecFiles: specComplexity.complexSpecFiles,
    },
    requirements: {
      minStableAngularVersion: '21.0.0',
      requiredNodeRange: '^20.19.0 || ^22.12.0 || ^24.0.0',
      targetBuilder: '@angular/build:unit-test',
      targetRunner: 'vitest',
    },
    blockers,
    warnings,
  };

  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}

main();
