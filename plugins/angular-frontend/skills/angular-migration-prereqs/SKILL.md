---
name: angular-migration-prereqs
description: Evalúa de forma determinista si un proyecto Angular cumple los requisitos mínimos oficiales (Angular 21.0.0+ y Node.js compatible) para migrar de Jasmine/Karma al runner estable de Vitest
user-invocable: false
---
# Skill: `angular-migration-prereqs`

Esta skill valida los requisitos técnicos mínimos de un workspace Angular antes de permitir una migración de Jasmine/Karma a Vitest (`@angular/build:unit-test`).

## 1. Regla Oficial de Versiones (Angular 21+ Estable)

De acuerdo con la documentación oficial de Angular ([angular.dev/guide/testing](https://angular.dev/guide/testing), [angular.dev/guide/testing/migrating-to-vitest](https://angular.dev/guide/testing/migrating-to-vitest) y [angular.dev/reference/versions](https://angular.dev/reference/versions)):

* **Angular `< 20.0.0` (ej. Angular 18, 19):** **NO SOPORTADO (`BLOCKED`)**. No existe el builder oficial `@angular/build:unit-test`.
* **Angular `20.x`:** **NO ESTABLE (`BLOCKED`)**. En Angular 20 el builder `@angular/build:unit-test` con Vitest era únicamente **experimental** y Karma seguía siendo el runner por defecto.
* **Angular `>= 21.0.0` (ej. Angular 21, Angular 22):** **ESTABLE (`READY`)**. Vitest es el runner oficial, estable y por defecto en Angular CLI.

Consulta los detalles completos de compatibilidad de Node.js, TypeScript y RxJS en [angular-vitest-matrix.md](./references/angular-vitest-matrix.md).

## 2. Ejecución del Script Determinista

Para evaluar un repositorio sin depender de suposiciones, ejecuta siempre el script Node.js ESM incluido en esta skill:

```bash
node "<ruta-del-plugin>/skills/angular-migration-prereqs/scripts/check-prereqs.mjs" --project "<ruta-del-proyecto-angular>"
```

### Salida del script (`stdout` JSON)
El script inspecciona `package.json`, `angular.json`, `karma.conf.js` y el conteo de archivos `*.spec.ts`, devolviendo un JSON estructurado con:
* `status`: `"READY"` o `"BLOCKED"`
* `summary`: explicación clara del resultado
* `detected`: versiones detectadas de `@angular/core`, `@angular/cli`, `nodeVersion`, `testBuilder`, paquetes Karma/Jasmine y total de `*.spec.ts`
* `requirements`: versión mínima estable requerida (`21.0.0`) y builder objetivo (`@angular/build:unit-test`)
* `blockers`: lista detallada de bloqueadores con `code`, `severity`, `message` y `remediation`

## 3. Interpretación Obligatoria

* Si `status === "BLOCKED"`, el agente debe generar el artefacto `.migration-artifacts/karma-to-vitest/01-diagnosis-report.json` (y `.md`) reflejando exactamente los bloqueadores devueltos por el script y recomendando actualizar primero el proyecto a **Angular 21+** mediante `ng update`.
