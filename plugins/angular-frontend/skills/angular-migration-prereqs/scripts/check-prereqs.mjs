#!/usr/bin/env node
/**
 * Deterministically checks whether an Angular repository meets the official
 * minimum requirements (Angular >= 21.0.0 and compatible Node.js) to migrate
 * from Jasmine/Karma to the stable Vitest runner (@angular/build:unit-test).
 *
 * Zero external dependencies — uses only built-in Node.js modules.
 */
import fs from 'node:fs';
import path from 'node:path';

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

function countSpecFiles(dir, acc = []) {
  if (!fs.existsSync(dir)) return acc;
  const ignored = new Set(['node_modules', '.git', 'dist', '.angular', '.migration-artifacts']);
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (ignored.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      countSpecFiles(full, acc);
    } else if (entry.isFile() && entry.name.endsWith('.spec.ts')) {
      acc.push(path.relative(dir, full));
    }
  }
  return acc;
}

function detectTestBuilder(angularJson) {
  if (!angularJson || typeof angularJson.projects !== 'object') {
    return { builder: null, projectName: null };
  }
  for (const [projName, projConfig] of Object.entries(angularJson.projects)) {
    const targets = projConfig?.architect || projConfig?.targets;
    if (targets?.test?.builder) {
      return { builder: targets.test.builder, projectName: projName };
    }
  }
  return { builder: null, projectName: Object.keys(angularJson.projects)[0] || null };
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
      schemaVersion: '1.0.0',
      projectPath: projectDir,
      status: 'BLOCKED',
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

  const { builder: testBuilder, projectName } = detectTestBuilder(angularJson);
  const specFiles = countSpecFiles(projectDir);
  const hasKarmaDeps = Object.keys(allDeps).some((k) => k.startsWith('karma'));
  const hasJasmineDeps = Object.keys(allDeps).some((k) => k.startsWith('jasmine'));
  const hasKarmaConf = fs.existsSync(karmaConfPath);

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
      remediation: 'Primero migra el proyecto a Angular 21+ (por ejemplo con "npx ng update @angular/core@21 @angular/cli@21") antes de migrar de Jasmine/Karma a Vitest.',
    });
  } else if (angularCore.major === 20) {
    blockers.push({
      code: 'ANGULAR_VERSION_EXPERIMENTAL_VITEST',
      severity: 'error',
      message: `Se detectó Angular ${angularCore.version} (${angularCoreRaw}). En Angular 20 el soporte de Vitest en @angular/build:unit-test es solo experimental y Karma sigue siendo el runner por defecto.`,
      remediation: 'Actualiza el proyecto a Angular 21.0.0 o superior (donde Vitest es estable y el test runner por defecto) antes de ejecutar esta migración.',
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
  const summary =
    status === 'READY'
      ? `Proyecto en Angular ${angularCore.version} compatible con la migración estable a Vitest (@angular/build:unit-test). Se detectaron ${specFiles.length} archivos *.spec.ts.`
      : blockers.map((b) => b.message).join(' ');

  const report = {
    schemaVersion: '1.0.0',
    evaluatedAt: new Date().toISOString(),
    projectPath: projectDir,
    status,
    summary,
    detected: {
      projectName,
      angularCoreVersion: angularCore ? angularCore.version : null,
      angularCoreRaw,
      angularCliVersion: angularCli ? angularCli.version : null,
      angularBuildRaw,
      nodeVersion: process.versions.node,
      testBuilder,
      hasKarmaDeps,
      hasJasmineDeps,
      hasKarmaConf,
      specFileCount: specFiles.length,
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
