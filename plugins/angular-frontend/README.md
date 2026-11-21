# Plugin `angular-frontend`

Plugin para **VS Code Copilot Chat** enfocado en proyectos **Angular**. Proporciona un flujo guiado, seguro y determinista en 3 fases para analizar, planificar y migrar suites de pruebas unitarias de **Jasmine/Karma a Vitest** (`@angular/build:unit-test`), exigiendo **Angular 21+** como versión estable oficial.

---

## 1. Requisitos de Uso

* **VS Code** con **GitHub Copilot Chat** (harness **Copilot**) y `"chat.plugins.enabled": true`.
* **Node.js `>= 20.19.0`** instalado en el entorno local (`node -v`).
  * Para proyectos en **Angular 21**: Node.js `^20.19.0 || ^22.12.0 || ^24.0.0`.
  * Para proyectos en **Angular 22**: Node.js `^22.22.3 || ^24.15.0 || ^26.0.0`.
* **Sin dependencias adicionales ni MCP:** Los scripts de validación (`.mjs`) se ejecutan localmente con módulos nativos de Node.js.

---

## 2. Configuración del Plugin en VS Code

### Desde el Marketplace `gacc-copilot-plugins`
Si ya registraste el repositorio raíz en `"chat.plugins.marketplaces"`, instala o habilita este plugin en Copilot Chat con:

```text
/plugin install angular-frontend@gacc-copilot-plugins
```

### Carga directa en local (`settings.json`)
Para habilitar únicamente este plugin desde tu disco local:

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

El plugin expone **un único agente orquestador visible** en el selector de Copilot Chat y **tres subagentes internos** (`user-invocable: false`) a los que el orquestador delega cada fase:

| Agente | Visibilidad en UI | Rol a alto nivel |
| :--- | :---: | :--- |
| **`Angular Karma-to-Vitest`** (`karma-vitest-orchestrator`) | **Visible** | Punto de entrada único para el desarrollador. Coordina las 3 fases y solicita confirmación humana en cada checkpoint antes de avanzar. |
| **`Karma-Vitest Analyst`** (`karma-vitest-analyst`) | Subagente interno | **Fase 1 (Diagnóstico):** Evalúa si el repositorio cumple los requisitos mínimos (Angular 21+) y genera el reporte de hallazgos en `.migration-artifacts/karma-to-vitest/01-diagnosis-report.{json,md}` sin tocar código fuente. |
| **`Karma-Vitest Planner`** (`karma-vitest-planner`) | Subagente interno | **Fase 2 (Planificación):** Una vez aprobado el diagnóstico, genera la lista ejecutable de tareas y archivos a migrar en `02-migration-plan.{json,md}`. |
| **`Karma-Vitest Migrator`** (`karma-vitest-migrator`) | Subagente interno | **Fase 3 (Implementación):** Protegido por el hook `preToolUse` y el gate de artefactos; aplica estrictamente los pasos del plan aprobado cuando ambos artefactos previos están en estado `APPROVED`. |

---

## 4. Guía de Alto Nivel: Skills (`skills/`) y Hook (`hooks.json`)

Las skills encapsulan las reglas, esquemas y scripts deterministas en Node.js que utilizan los agentes bajo demanda:

* **`angular-migration-prereqs`**: Ejecuta `scripts/check-prereqs.mjs` para inspeccionar `package.json` y `angular.json`. Si detecta una versión inferior a Angular 21 (por ejemplo, Angular 18, 19 o 20), marca el estado como `BLOCKED` indicando que se debe actualizar primero a Angular 21+.
* **`karma-vitest-audit`**: Define la estructura y los JSON Schemas de los artefactos (`01-diagnosis-report.json` y `02-migration-plan.json`), así como el catálogo de equivalencias de Jasmine/Karma a Vitest.
* **`karma-vitest-migrate`**: Contiene las reglas de transformación determinista y el validador `scripts/verify-artifacts-gate.mjs` (usado tanto por CLI como por el hook `preToolUse` en `hooks.json`) que impide modificar archivos del proyecto si el diagnóstico o el plan no existen o no han sido aprobados por el especialista.

---

## 5. Flujo Rápido de Uso en Copilot Chat

1. **Diagnóstico:** Selecciona el agente **`Angular Karma-to-Vitest`** en Copilot Chat y escribe:
   > *"Analiza este repositorio para migrar de Jasmine/Karma a Vitest."*
2. **Aprobación del Diagnóstico y Generación del Plan:** Revisa `.migration-artifacts/karma-to-vitest/01-diagnosis-report.md` (y `.json`). Si el estado es `READY`, cambia `approval.status` a `"APPROVED"` (o indícaselo al especialista) y pide en el chat:
   > *"El diagnóstico está aprobado, genera el plan de migración."*
3. **Aprobación del Plan y Ejecución:** Revisa `.migration-artifacts/karma-to-vitest/02-migration-plan.md` (y `.json`), aprueba el plan (`approval.status: "APPROVED"`) y pide en el chat:
   > *"El plan está aprobado, ejecuta la migración."*
