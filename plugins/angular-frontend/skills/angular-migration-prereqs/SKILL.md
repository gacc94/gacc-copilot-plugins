---
name: angular-migration-prereqs
description: Evalúa de forma determinista si un proyecto Angular cumple los requisitos mínimos oficiales (Angular 21.0.0+ y Node.js) y determina si basta con el schematic oficial refactor-jasmine-vitest o si se requiere migración híbrida con agente
user-invocable: false
---
# Skill: `angular-migration-prereqs`

Esta skill valida los requisitos técnicos mínimos de un workspace Angular y clasifica la estrategia recomendada antes de permitir la generación de planes o la migración de Jasmine/Karma a Vitest (`@angular/build:unit-test`).

## 1. Regla Oficial de Versiones (Angular 21+ Estable)

De acuerdo con la documentación oficial de Angular ([angular.dev/guide/testing](https://angular.dev/guide/testing), [angular.dev/guide/testing/migrating-to-vitest](https://angular.dev/guide/testing/migrating-to-vitest) y [angular.dev/reference/versions](https://angular.dev/reference/versions)):

* **Angular `< 20.0.0` (ej. Angular 18, 19):** **NO SOPORTADO (`BLOCKED` / `UPGRADE_FIRST`)**.
* **Angular `20.x`:** **EXPERIMENTAL (`BLOCKED` / `UPGRADE_FIRST`)**. Karma seguía siendo el runner por defecto.
* **Angular `>= 21.0.0` (ej. Angular 21, Angular 22):** **ESTABLE (`READY`)**. Vitest es el runner oficial y por defecto en Angular CLI.

Consulta la matriz completa en [angular-vitest-matrix.md](./references/angular-vitest-matrix.md).

## 2. Estrategia Recomendada (`recommendedStrategy`)

El script evalúa además si la solución oficial de Angular (`ng g @schematics/angular:refactor-jasmine-vitest`) es suficiente:

| Estrategia | Significado | Acción |
| :--- | :--- | :--- |
| **`UPGRADE_FIRST`** | `status: "BLOCKED"` (Angular `< 21.0.0` o workspace inválido). | Detener flujo; prohibido generar planes. Derivar primero a un flujo/agente de upgrade de Angular. |
| **`OFFICIAL_SCHEMATIC_SUFFICIENT`** | `status: "READY"`, sin `karma.conf.js` personalizado, sin múltiples targets complejos ni patrones avanzados de Jasmine. | Basta con configurar `@angular/build:unit-test` y ejecutar `ng g @schematics/angular:refactor-jasmine-vitest` manualmente. |
| **`HYBRID_SCHEMATIC_PLUS_AGENT`** | `status: "READY"`, pero con `karma.conf.js` custom, múltiples targets o patrones complejos (`jasmine.clock()`, `spyOnProperty`, `jasmine.addMatchers`, `done()`, etc.). | Usar el schematic oficial como base + Fase 2 (Plan Ejecutable) y Fase 3 (Subagente Migrador) del plugin. |

## 3. Ejecución del Script Determinista

Resuelve la ruta de `scripts/check-prereqs.mjs` **directamente junto al archivo `SKILL.md` de esta skill** (sin adivinar rutas del plugin):

```bash
node "<directorio-de-esta-skill>/scripts/check-prereqs.mjs" --project "<ruta-del-proyecto-angular>"
```
