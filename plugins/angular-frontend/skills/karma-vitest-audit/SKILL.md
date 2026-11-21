---
name: karma-vitest-audit
description: Ejecuta el generador determinista de diagnóstico (01-diagnosis-report.json, .md y .html autocontenido con 0 tokens extra), audita Karma/Jasmine y define los esquemas oficiales de Fase 1 y Fase 2
user-invocable: false
---
# Skill: `karma-vitest-audit`

Esta skill centraliza la auditoría determinista de proyectos Angular con Jasmine/Karma y la generación de los artefactos de **Fase 1 (Diagnóstico Visual + Estructurado)** y **Fase 2 (Plan de Migración Ejecutable)**.

## 1. Generador Determinista de Fase 1 (`generate-diagnosis-report.mjs`)

En lugar de que el modelo lea decenas de `*.spec.ts` y redacte los reportes token por token, ejecuta **un único script local en Node.js ESM** (sin dependencias externas y con **0 gasto de tokens extra para el HTML**):

```bash
node "<ruta-del-plugin>/skills/karma-vitest-audit/scripts/generate-diagnosis-report.mjs" --project "."
```

### Artefactos generados automáticamente en `.migration-artifacts/karma-to-vitest/`

| Archivo generado | Propósito |
| :--- | :--- |
| **`01-diagnosis-report.json`** | Contrato estructurado (`schemaVersion: 1.2.0`) consumido por el Gate, Fase 2 y scripts. |
| **`01-diagnosis-report.md`** | Reporte ejecutivo en Markdown enriquecido (KPIs, hallazgos, barras Unicode de complejidad, inventario y hoja de ruta) ideal para Copilot Chat y Pull Requests. |
| **`01-diagnosis-report.html`** | **Dashboard visual autocontenido** (100% offline, tema oscuro/claro, tarjetas KPI, barras Baja/Media/Alta, buscador y filtros por archivo `*.spec.ts`, badge `READY`/`BLOCKED` y roadmap) listo para abrir en el navegador o presentar a Tech Leads. |

Por `stdout`, el script imprime únicamente un resumen JSON compacto (~15 líneas) con `status`, `recommendedStrategy`, KPIs y rutas generadas.

## 2. Esquemas y Referencias de Fase 1 y Fase 2

| Fase | Artefacto JSON | Esquema / Guía |
| :---: | :--- | :--- |
| **Fase 1** | `01-diagnosis-report.json` | [diagnosis-report.schema.json](./references/diagnosis-report.schema.json) |
| **Fase 2** | `02-migration-plan.json` | [migration-plan.schema.json](./references/migration-plan.schema.json) |
| **Referencia** | Equivalencias Jasmine → Vitest | [jasmine-to-vitest-patterns.md](./references/jasmine-to-vitest-patterns.md) |

## 3. Reglas de Aprobación Humana (Checkpoints)

* Al generar `01-diagnosis-report.json` o `02-migration-plan.json`, `approval.status` inicia siempre en `"PENDING"`.
* Ningún agente puede avanzar a Fase 2 o Fase 3 si `status === "BLOCKED"` o si `approval.status !== "APPROVED"`.
