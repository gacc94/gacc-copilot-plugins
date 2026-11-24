---
name: karma-vitest-audit
description: Ejecuta los generadores deterministas de Fase 1 (diagnóstico .json con diagnosisHash y complexityScore 1-10, .md y dashboard .html) y Fase 2 (plan maestro multi-fase con convivencia Karma+Vitest)
user-invocable: false
---
# Skill: `karma-vitest-audit`

Esta skill centraliza la auditoría determinista de proyectos Angular con Jasmine/Karma (**Fase 1**) y la generación determinista de planes incrementales con convivencia Karma + Vitest (**Fase 2**). Se mantiene `user-invocable: false` para que solo el Orquestador y sus subagentes gobiernen el flujo.

## 1. Generador Determinista de Fase 1 (`scripts/generate-diagnosis-report.mjs`)

Ejecuta el script `scripts/generate-diagnosis-report.mjs` ubicado en el directorio de esta skill (ruta relativa al directorio que contiene este `SKILL.md`) en una sola llamada local en Node.js ESM (0 dependencias externas, 0 tokens extra para el HTML):

```bash
# Workspace completo:
node scripts/generate-diagnosis-report.mjs --project "."

# Proyecto específico dentro de un monorepo angular.json:
node scripts/generate-diagnosis-report.mjs --project "." --angular-project "<nombre-proyecto>"
```

### Artefactos generados automáticamente en `.migration-artifacts/karma-to-vitest/`

| Archivo generado | Propósito |
| :--- | :--- |
| **`01-diagnosis-report.json`** | Contrato estructurado (`schemaVersion: 1.3.0`) con huella `diagnosisHash` y `specInventory` que asigna a cada `*.spec.ts` su categoría (`low`/`medium`/`high`) y puntaje numérico `complexityScore` (`1–10`). |
| **`01-diagnosis-report.md`** | Reporte ejecutivo en Markdown enriquecido (KPIs, hallazgos, barras Unicode, inventario con score 1–10 y hoja de ruta). |
| **`01-diagnosis-report.html`** | **Dashboard visual autocontenido** (100% offline, tema oscuro/claro, KPIs, buscador y filtros por archivo `*.spec.ts`, badge `READY`/`BLOCKED`). |

Por `stdout`, imprime un resumen JSON compacto con `status`, `diagnosisHash`, `recommendedStrategy`, KPIs y rutas generadas.

## 2. Generador Determinista de Fase 2 (`scripts/generate-migration-plan.mjs`)

Requiere que `01-diagnosis-report.json` exista en `status: "READY"` y `approval.status: "APPROVED"`. Particiona el 100% de `specInventory` (0 omisiones, 0 duplicados) en fases incrementales con convivencia paralela Karma + Vitest:

```bash
# Generar índice maestro + planes dinámicos por fase:
node scripts/generate-migration-plan.mjs --project "."

# Si se acotó a un proyecto específico de angular.json:
node scripts/generate-migration-plan.mjs --project "." --angular-project "<nombre-proyecto>"
```

### Artefactos generados en `.migration-artifacts/karma-to-vitest/`

| Archivo generado | Propósito |
| :--- | :--- |
| **`02-migration-plan.json`** | Índice maestro multi-fase (`schemaVersion: 2.0.0`, `planMode: "multi-phase"`) con `diagnosisHash`, estrategia de convivencia (`test` + `test-vitest` + `tsconfig.spec.vitest.json`) y tabla de fases. |
| **`02-migration-plan.md`** | Vista ejecutiva del plan maestro y reglas de aprobación híbrida. |
| **`plans/phase-XX-*.json`** | Contrato ejecutable independiente por fase (`schemaVersion: 1.0.0`) con `dependsOnPhase`, `tasks[*].targetFiles`, `verificationCommands[]` y `approval.status: "PENDING"`. |
| **`plans/phase-XX-*.md`** | Checklist legible por fase para revisión en PR / CI. |

## 3. Esquemas y Referencias de Fase 1 y Fase 2

| Fase | Artefacto JSON | Esquema / Guía |
| :---: | :--- | :--- |
| **Fase 1** | `01-diagnosis-report.json` | [diagnosis-report.schema.json](./references/diagnosis-report.schema.json) |
| **Fase 2 (Maestro)** | `02-migration-plan.json` | [migration-plan.schema.json](./references/migration-plan.schema.json) |
| **Fase 2 (Por fase)** | `plans/phase-XX-*.json` | [migration-phase.schema.json](./references/migration-phase.schema.json) |
| **Reglas (`migration-rules`)** | Catálogo declarativo de reglas | [migration-rules.json](./references/migration-rules.json) ([esquema](./references/migration-rules.schema.json)) |
| **Especificación funcional** | Equivalencias y riesgos Jasmine → Vitest | [jasmine-to-vitest-patterns.md](./references/jasmine-to-vitest-patterns.md) |

## 4. Reglas de Aprobación Humana (Checkpoints)
* Ningún artefacto nace aprobado (`approval.status` siempre inicia en `"PENDING"`).
* Si `01-diagnosis-report.json` tiene `status: "BLOCKED"`, queda estrictamente prohibido generar `02-migration-plan.json` o `plans/phase-XX-*.json`.
