---
name: karma-vitest-audit
description: Audita configuraciones de Karma/Jasmine y archivos *.spec.ts en repositorios Angular, y define los esquemas oficiales de los artefactos 01-diagnosis-report.json y 02-migration-plan.json
user-invocable: false
---
# Skill: `karma-vitest-audit`

Esta skill estandariza la inspección de proyectos Angular que utilizan Jasmine/Karma y la generación de los artefactos de **Fase 1 (Diagnóstico)** y **Fase 2 (Plan de Migración Ejecutable)**.

## 1. Ubicación y Contratos de los Artefactos

Todos los artefactos se escriben dentro del proyecto Angular analizado en la carpeta `.migration-artifacts/karma-to-vitest/`:

| Fase | Artefacto JSON (máquina/gate) | Artefacto Markdown (revisión humana) | Esquema de referencia |
| :---: | :--- | :--- | :--- |
| **Fase 1** | `01-diagnosis-report.json` | `01-diagnosis-report.md` | [diagnosis-report.schema.json](./references/diagnosis-report.schema.json) |
| **Fase 2** | `02-migration-plan.json` | `02-migration-plan.md` | [migration-plan.schema.json](./references/migration-plan.schema.json) |

## 2. Qué Auditar en el Repositorio Angular

1. **Configuración de build y test (`angular.json`, `package.json`, `tsconfig.spec.json`, `karma.conf.js`, `src/test.ts`):**
   * Identificar el builder actual (ej. `@angular-devkit/build-angular:karma`).
   * Identificar paquetes de Karma y Jasmine a desinstalar (`karma`, `karma-chrome-launcher`, `karma-coverage`, `karma-jasmine`, `karma-jasmine-html-reporter`, `jasmine-core`, `@types/jasmine`).
   * Identificar opciones personalizadas en `karma.conf.js` (proxies, archivos globales, reporters de cobertura).
2. **Inventario de archivos `*.spec.ts`:**
   * Clasificar cada archivo `*.spec.ts` según los patrones que utiliza, consultando [jasmine-to-vitest-patterns.md](./references/jasmine-to-vitest-patterns.md):
     * `jasmine.createSpy` / `jasmine.createSpyObj`
     * `spyOn(obj, 'method').and.returnValue(...)` / `.and.callThrough()` / `.and.callFake(...)` / `.and.throwError(...)`
     * `jasmine.any(...)`, `jasmine.objectContaining(...)`, `jasmine.arrayContaining(...)`
     * `fakeAsync` / `tick` / `flush` o timers de Jasmine (`jasmine.clock()`)
     * `done()` callbacks asíncronos

## 3. Reglas de Aprobación Humana (Checkpoints)

* Al crear `01-diagnosis-report.json` o `02-migration-plan.json`, el bloque `approval` se inicializa siempre como:
  ```json
  "approval": {
    "status": "PENDING",
    "reviewer": null,
    "approvedAt": null,
    "notes": "Pendiente de revisión y aprobación por el especialista."
  }
  ```
* Ningún agente puede pasar a la fase siguiente mientras `approval.status` sea distinto de `"APPROVED"`.
