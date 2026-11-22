# Plugin `angular-frontend`

Plugin en formato **Agent Plugins 1.0** para **GitHub Copilot (VS Code con Copilot harness y GitHub Copilot CLI)** enfocado en proyectos **Angular**. Proporciona un flujo guiado, seguro y determinista en 3 fases para analizar, planificar y migrar suites de pruebas unitarias de **Jasmine/Karma a Vitest** (`@angular/build:unit-test`), exigiendo **Angular 21+** como versión estable oficial.

---

## 1. Requisitos de Uso

* **VS Code** con **GitHub Copilot Chat** (harness **Copilot**) o **GitHub Copilot CLI**.
* **Node.js `>= 20.19.0`** instalado en el entorno local (`node -v`).
  * Para proyectos en **Angular 21**: Node.js `^20.19.0 || ^22.12.0 || ^24.0.0`.
  * Para proyectos en **Angular 22**: Node.js `^22.22.3 || ^24.15.0 || ^26.0.0`.
* **Sin dependencias adicionales ni MCP:** Los scripts de validación (`.mjs`) se ejecutan localmente con módulos nativos de Node.js.

---

## 2. Configuración del Plugin

### Desde el Marketplace `gacc-copilot-plugins` (Recomendado)
Si ya registraste el marketplace raíz (con `.github/plugin/marketplace.json` en `~/.copilot/settings.json`, vía `/plugin marketplace add` en VS Code o `copilot plugin marketplace add` en Copilot CLI), instala y habilita este plugin:

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

## 3. Guía de Alto Nivel: Agentes (`com.github.copilot/agents/`)

El plugin se utiliza seleccionando el **agente orquestador** en el **menú desplegable `Agents`** de Copilot Chat (o desde Copilot CLI).

Solo aparece **1 agente visible** en el selector; los otros **3 subagentes internos** (`user-invocable: false`) permanecen ocultos del menú y son invocados automáticamente por el orquestador en cada fase mediante la delegación nativa del **Copilot harness** (`task`):

| Agente | Visibilidad en `Agents` | Hook de migración | Rol a alto nivel |
| :--- | :---: | :---: | :--- |
| **`Angular Karma-to-Vitest`** (`karma-vitest-orchestrator`) | **Visible en el selector** | No | Punto de entrada único para el desarrollador. Coordina las 3 fases, utiliza **`#vscode/askQuestions`** para preguntas/confirmaciones interactivas, bloquea el avance ante `BLOCKED` y exige aprobación humana en cada checkpoint. |
| **`Karma-Vitest Analyst`** (`karma-vitest-analyst`) | Subagente interno | No | **Fase 1 (Diagnóstico Visual + Estructurado):** Ejecuta `generate-diagnosis-report.mjs` sin tocar código fuente para evaluar Angular 21+ (`READY` vs `BLOCKED`), clasificar si basta el schematic oficial (`ng g @schematics/angular:refactor-jasmine-vitest`) y generar `.migration-artifacts/karma-to-vitest/01-diagnosis-report.{json,md,html}` con 0 gasto de tokens extra para el dashboard HTML. |
| **`Karma-Vitest Planner`** (`karma-vitest-planner`) | Subagente interno | No | **Fase 2 (Planificación):** Tras la aprobación del diagnóstico, valida el gate (`--phase plan`) y genera el plan ejecutable paso a paso en `02-migration-plan.{json,md}`. |
| **`Karma-Vitest Migrator`** (`karma-vitest-migrator`) | Subagente interno | **Sí (`preToolUse` agent-scoped)** | **Fase 3 (Implementación):** Protegido por el hook agent-scoped `preToolUse` y el gate de artefactos; aplica estrictamente los pasos del plan aprobado cuando ambos artefactos previos están en estado `APPROVED`. |

---

## 4. Guía de Alto Nivel: Skills (`skills/`) y Modelo de Seguridad

Las skills encapsulan las reglas, esquemas y scripts deterministas en Node.js que cargan los agentes bajo demanda (`user-invocable: false`):

* **`angular-migration-prereqs`**: Ejecuta `scripts/check-prereqs.mjs` para inspeccionar `package.json`, `angular.json`, `karma.conf.js` y `*.spec.ts`, clasificando la estrategia en **`UPGRADE_FIRST`** (`BLOCKED` si Angular `< 21`), **`OFFICIAL_SCHEMATIC_SUFFICIENT`** (basta el schematic oficial de Angular) o **`HYBRID_SCHEMATIC_PLUS_AGENT`** (requiere Fase 2 y Fase 3 del plugin).
* **`karma-vitest-audit`**: Incluye `scripts/generate-diagnosis-report.mjs` (que genera en una sola corrida local `01-diagnosis-report.json`, `01-diagnosis-report.md` y el dashboard visual autocontenido `01-diagnosis-report.html` con KPIs, hallazgos, barras Baja/Media/Alta, buscador de specs y hoja de ruta), además de los JSON Schemas y equivalencias Jasmine → Vitest.
* **`karma-vitest-migrate`**: Contiene las reglas de transformación determinista y el validador `scripts/verify-artifacts-gate.mjs` (CLI + **agent-scoped hook** `preToolUse` en `com.github.copilot/agents/karma-vitest-migrator.agent.md`) bajo un modelo de **3 estados de decisión** (`DENY` incondicional, `REQUIRE_GATE` y `NO_DECISION` `{}`) alineado exclusivamente a los nombres reales de herramientas del runtime del Copilot harness.

### Separación de Niveles de Seguridad y Limitaciones

* **Nivel 1 — Control de Workflow del Plugin (alcance de `verify-artifacts-gate.mjs`):** El hook `preToolUse` está acotado exclusivamente al agente migrador para controlar las fases de migración, bloquear delegación por `task` y exigir aprobación humana sin interferir con conversaciones normales de desarrollo.
* **Nivel 2 — Gobernanza Organizacional (fuera del alcance del plugin):** Las políticas obligatorias de seguridad a nivel de organización (políticas administradas de GitHub Copilot Enterprise, permisos del sistema operativo, sandboxing, branch protection y CI) son independientes del plugin.
* **Limitaciones conocidas:** Los command hooks `preToolUse` tienen timeouts **fail-open** en el runtime de Copilot (los errores/salidas no cero son fail-closed) y la validación de symlinks previa a la escritura no elimina condiciones de carrera **TOCTOU**; por ello el gate no sustituye al sandboxing del entorno.

---

## 5. Flujo Rápido de Uso

1. **Abrir el selector de Agentes:** En **GitHub Copilot Chat** en VS Code (con el harness **Copilot** seleccionado) o en **Copilot CLI**, selecciona **`Angular Karma-to-Vitest`**.
2. **Fase 1 — Diagnóstico:** Escribe en el chat:
   > *"Analiza este repositorio para migrar de Jasmine/Karma a Vitest."*
3. **Fase 2 — Planificación Ejecutable:** Revisa `.migration-artifacts/karma-to-vitest/01-diagnosis-report.md` (y `.json`). Si el estado es `READY`, cambia `approval.status` a `"APPROVED"` y escribe en el chat:
   > *"El diagnóstico está aprobado, genera el plan de migración."*
4. **Fase 3 — Ejecución Determinista:** Revisa `.migration-artifacts/karma-to-vitest/02-migration-plan.md` (y `.json`), cambia `approval.status` a `"APPROVED"` y escribe en el chat:
   > *"El plan está aprobado, ejecuta la migración."*

---

## 6. Verificación de Integridad, Seguridad y Diagnóstico

### Suite automatizada (sin dependencias)
Desde la raíz del repositorio `gacc-copilot-plugins`, ejecuta:

```bash
node --test tests/verify-artifacts-gate.test.mjs tests/plugin-structure.test.mjs
```

### Validación en vivo (VS Code Copilot Harness y Copilot CLI)
Dado que los hooks de agentes están en *preview*, valida en los **registros de depuración del agente y diagnósticos del proveedor** en VS Code (no en el canal legacy de hooks del Local harness) y en una prueba independiente con **Copilot CLI**:
1. Plugin visible en **Agent Customizations** (`Chat: Open Customizations`), con `Angular Karma-to-Vitest` seleccionable y los 3 subagentes ocultos.
2. `Analyst`, `Planner` y sesiones normales **no** disparan el hook del Migrator.
3. `Migrator` sin aprobación deniega ediciones/comandos (`permissionDecision: "deny"`), bloquea delegación por `task` y tras aprobación permite únicamente operaciones válidas dentro del workspace.
4. Reproducir/documentar el comportamiento de timeout (fail-open) en entorno de pruebas si se audita resiliencia del harness.
