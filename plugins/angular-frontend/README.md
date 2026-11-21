# Plugin `angular-frontend`

Plugin para **VS Code Copilot Chat** enfocado en proyectos **Angular**. Proporciona un flujo guiado, seguro y determinista en 3 fases para analizar, planificar y migrar suites de pruebas unitarias de **Jasmine/Karma a Vitest** (`@angular/build:unit-test`), exigiendo **Angular 21+** como versión estable oficial.

---

## 1. Requisitos de Uso

* **VS Code** con **GitHub Copilot Chat** (harness **Copilot**).
* **Node.js `>= 20.19.0`** instalado en el entorno local (`node -v`).
  * Para proyectos en **Angular 21**: Node.js `^20.19.0 || ^22.12.0 || ^24.0.0`.
  * Para proyectos en **Angular 22**: Node.js `^22.22.3 || ^24.15.0 || ^26.0.0`.
* **Sin dependencias adicionales ni MCP:** Los scripts de validación (`.mjs`) se ejecutan localmente con módulos nativos de Node.js.

---

## 2. Configuración del Plugin en VS Code

### Desde el Marketplace `gacc-copilot-plugins` (Recomendado)
Si ya registraste el marketplace raíz (en `~/.copilot/settings.json` o con `/plugin marketplace add`), instala y habilita este plugin en Copilot Chat:

```text
/plugin install angular-frontend@gacc-copilot-plugins
```

### Carga directa en local (`settings.json` de VS Code)
Para habilitar únicamente este plugin desde tu disco local durante el desarrollo:

```json
{
  "chat.plugins.enabled": true,
  "chat.pluginLocations": {
    "/Users/gustavocaqui/Development/gacc/projects/plugins/gacc-copilot-plugins/plugins/angular-frontend": true
  }
}
```

---

## 3. Guía de Alto Nivel: Agentes (`agents/`)

El plugin se utiliza seleccionando el **agente orquestador** en el **menú desplegable `Agents`** de Copilot Chat (no mediante un slash command `/`).

Solo aparece **1 agente visible** en el selector de Copilot Chat; los otros **3 subagentes internos** (`user-invocable: false`) permanecen ocultos del menú y son invocados automáticamente por el orquestador en cada fase:

| Agente | Visibilidad en `Agents` | Rol a alto nivel |
| :--- | :---: | :--- |
| **`Angular Karma-to-Vitest`** (`karma-vitest-orchestrator`) | **Visible en el selector** | Punto de entrada único para el desarrollador. Coordina las 3 fases y exige confirmación humana en cada checkpoint antes de avanzar. |
| **`Karma-Vitest Analyst`** (`karma-vitest-analyst`) | Subagente interno | **Fase 1 (Diagnóstico):** Evalúa si el repositorio cumple los requisitos mínimos (Angular 21+) y genera `.migration-artifacts/karma-to-vitest/01-diagnosis-report.{json,md}` sin tocar código fuente. |
| **`Karma-Vitest Planner`** (`karma-vitest-planner`) | Subagente interno | **Fase 2 (Planificación):** Tras la aprobación del diagnóstico, genera el plan ejecutable paso a paso en `02-migration-plan.{json,md}`. |
| **`Karma-Vitest Migrator`** (`karma-vitest-migrator`) | Subagente interno | **Fase 3 (Implementación):** Protegido por el hook `preToolUse` y el gate de artefactos; aplica estrictamente los pasos del plan aprobado cuando ambos artefactos previos están en estado `APPROVED`. |

---

## 4. Guía de Alto Nivel: Skills (`skills/`) y Hook (`hooks.json`)

Las skills encapsulan las reglas, esquemas y scripts deterministas en Node.js que cargan los agentes bajo demanda (`user-invocable: false`):

* **`angular-migration-prereqs`**: Ejecuta `scripts/check-prereqs.mjs` para inspeccionar `package.json` y `angular.json`. Si detecta una versión inferior a Angular 21 (por ejemplo, Angular 18, 19 o 20), marca el estado como `BLOCKED` indicando que se debe actualizar primero a Angular 21+.
* **`karma-vitest-audit`**: Define la estructura y los JSON Schemas de los artefactos (`01-diagnosis-report.json` y `02-migration-plan.json`), así como el catálogo de equivalencias de Jasmine/Karma a Vitest.
* **`karma-vitest-migrate`**: Contiene las reglas de transformación determinista y el validador `scripts/verify-artifacts-gate.mjs` (usado tanto por CLI como por el hook `preToolUse`) que impide modificar archivos del proyecto si el diagnóstico o el plan no existen o no han sido aprobados por el especialista.

---

## 5. Flujo Rápido de Uso en Copilot Chat

1. **Abrir el selector de Agentes:** En el chat de **GitHub Copilot** en VS Code (con el harness **Copilot** seleccionado), abre el desplegable **`Agents`** y selecciona **`Angular Karma-to-Vitest`**.
2. **Fase 1 — Diagnóstico:** Escribe en el chat:
   > *"Analiza este repositorio para migrar de Jasmine/Karma a Vitest."*
3. **Fase 2 — Planificación Ejecutable:** Revisa `.migration-artifacts/karma-to-vitest/01-diagnosis-report.md` (y `.json`). Si el estado es `READY`, cambia `approval.status` a `"APPROVED"` y escribe en el chat:
   > *"El diagnóstico está aprobado, genera el plan de migración."*
4. **Fase 3 — Ejecución Determinista:** Revisa `.migration-artifacts/karma-to-vitest/02-migration-plan.md` (y `.json`), cambia `approval.status` a `"APPROVED"` y escribe en el chat:
   > *"El plan está aprobado, ejecuta la migración."*
