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

## 2. Configuración e Instalación del Plugin

### A. Desde Repositorio Remoto en GitHub (Recomendado)

Registra el marketplace remoto `gacc94/gacc-copilot-plugins` (o `<tu-org>/gacc-copilot-plugins` si usas un fork) e instala el plugin directamente sin clonar el repositorio.

* **En VS Code Copilot Chat:**
  ```text
  /plugin marketplace add gacc94/gacc-copilot-plugins
  /plugin install angular-frontend@gacc-copilot-plugins
  ```
* **En GitHub Copilot CLI:**
  ```bash
  copilot plugin marketplace add gacc94/gacc-copilot-plugins
  copilot plugin install angular-frontend@gacc-copilot-plugins
  ```
* **Declarativo en `~/.copilot/settings.json` (usuario) o `.github/copilot/settings.json` (proyecto):**
  ```json
  {
    "extraKnownMarketplaces": {
      "gacc-copilot-plugins": {
        "source": {
          "source": "github",
          "repo": "gacc94/gacc-copilot-plugins"
        }
      }
    },
    "enabledPlugins": {
      "angular-frontend@gacc-copilot-plugins": true
    }
  }
  ```

### B. Desde Clon Local (Desarrollo o Uso Offline)

Si clonaste el repositorio en tu máquina (por ejemplo `/Users/<usuario>/gacc-copilot-plugins`):

* **Vía marketplace local en VS Code Copilot Chat:**
  ```text
  /plugin marketplace add /Users/<usuario>/gacc-copilot-plugins
  /plugin install angular-frontend@gacc-copilot-plugins
  ```
* **Carga directa del plugin en desarrollo (`settings.json` de VS Code):**
  ```json
  {
    "chat.plugins.enabled": true,
    "chat.pluginLocations": {
      "/Users/<usuario>/gacc-copilot-plugins/plugins/angular-frontend": true
    }
  }
  ```

---

## 3. Guía de Alto Nivel: Agentes (`com.github.copilot/agents/`)

El plugin se utiliza seleccionando el **agente orquestador** en el **menú desplegable `Agents`** de Copilot Chat (o desde Copilot CLI).

Solo aparece **1 agente visible** en el selector; los otros **3 subagentes internos** (`user-invocable: false`) permanecen ocultos del menú y son invocados automáticamente por el orquestador en cada fase mediante la delegación nativa del **Copilot harness** (`task`), recibiendo explícitamente el contexto necesario (workspace, proyecto de `angular.json`, rutas de artefactos previos y formato esperado de retorno):

| Agente | Visibilidad en `Agents` | Hook de migración | Rol a alto nivel |
| :--- | :---: | :---: | :--- |
| **`Angular Karma-to-Vitest`** (`karma-vitest-orchestrator`) | **Visible en el selector** | No | Punto de entrada único para el desarrollador. Coordina las 3 fases, pasa contexto explícito a cada subagente (incluyendo el proyecto elegido en `angular.json`), bloquea el avance ante `BLOCKED` y exige aprobación humana en cada checkpoint. |
| **`Karma-Vitest Analyst`** (`karma-vitest-analyst`) | Subagente interno | No | **Fase 1 (Diagnóstico Visual + Estructurado):** Carga `karma-vitest-audit` y ejecuta `scripts/generate-diagnosis-report.mjs` (con `--angular-project` si aplica) sin tocar código fuente para evaluar Angular 21+ (`READY` vs `BLOCKED`), clasificar si basta el schematic oficial y generar `.migration-artifacts/karma-to-vitest/01-diagnosis-report.{json,md,html}`. |
| **`Karma-Vitest Planner`** (`karma-vitest-planner`) | Subagente interno | **Sí (`preToolUse --phase plan`)** | **Fase 2 (Planificación):** Protegido por hook agent-scoped que impide modificar código fuente, ejecutar shell arbitrario o alterar `01-diagnosis-report.*`, y exige diagnóstico `READY` + `APPROVED` antes de escribir `02-migration-plan.{json,md}`. |
| **`Karma-Vitest Migrator`** (`karma-vitest-migrator`) | Subagente interno | **Sí (`preToolUse --phase migrate`)** | **Fase 3 (Implementación):** Protegido por hook agent-scoped que impide modificar `01-diagnosis-report.*` o auto-aprobar `02-migration-plan.json`, exigiendo ambos artefactos `APPROVED` antes de aplicar las tareas del plan. |

---

## 4. Guía de Alto Nivel: Skills (`skills/`) y Modelo de Seguridad

Las skills encapsulan las reglas, esquemas y scripts deterministas en Node.js que cargan los agentes bajo demanda (`user-invocable: false`), ejecutando los scripts con rutas relativas a cada `SKILL.md`:

* **`angular-migration-prereqs`**: Ejecuta `scripts/check-prereqs.mjs` para inspeccionar `package.json`, `angular.json`, `karma.conf.js` y `*.spec.ts`, clasificando la estrategia en **`UPGRADE_FIRST`** (`BLOCKED` si Angular `< 21`), **`OFFICIAL_SCHEMATIC_SUFFICIENT`** (basta el schematic oficial de Angular) o **`HYBRID_SCHEMATIC_PLUS_AGENT`** (requiere Fase 2 y Fase 3 del plugin).
* **`karma-vitest-audit`**: Incluye `scripts/generate-diagnosis-report.mjs` (soporta `--project` y `--angular-project` para generar `01-diagnosis-report.{json,md,html}` con KPIs, hallazgos, barras Baja/Media/Alta, buscador de specs y hoja de ruta), además de los JSON Schemas y equivalencias Jasmine → Vitest.
* **`karma-vitest-migrate`**: Contiene las reglas de transformación determinista y el validador `scripts/verify-artifacts-gate.mjs` (CLI + **agent-scoped hooks** `preToolUse` en `karma-vitest-planner.agent.md` y `karma-vitest-migrator.agent.md`) bajo un modelo de **3 estados de decisión** (`DENY` incondicional, `REQUIRE_GATE` y `NO_DECISION` `{}`) alineado exclusivamente a los nombres reales de herramientas del runtime del Copilot harness.

### Separación de Niveles de Seguridad y Limitaciones

* **Nivel 1 — Control de Workflow del Plugin (alcance de `verify-artifacts-gate.mjs`):** Los hooks `preToolUse` están acotados exclusivamente a Planner (`--phase plan`) y Migrator (`--phase migrate`) para garantizar la disciplina de las 3 fases, bloquear auto-aprobación y delegación por `task`, y exigir aprobación humana sin interferir con conversaciones normales de desarrollo.
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

## 6. Verificación de Integridad, Seguridad y Confirmaciones en Vivo

### Suite automatizada (sin dependencias)
Desde la raíz del repositorio `gacc-copilot-plugins`, ejecuta:

```bash
node --test tests/verify-artifacts-gate.test.mjs tests/plugin-structure.test.mjs
```

### Puntos críticos a confirmar en prueba real (VS Code Copilot Harness y Copilot CLI)
Dado que los hooks definidos en frontmatter de `.agent.md` están en *preview* y las herramientas disponibles dependen de la versión del runtime, valida en **Agent Customizations** (`Chat: Open Customizations`), en los **registros de depuración del agente / diagnósticos del proveedor** en VS Code y en una prueba independiente con **Copilot CLI**:
1. **Advertencias de herramientas (`vscode/askQuestions`):** Abrir `Chat: Open Customizations` y comprobar que `Angular Karma-to-Vitest` no muestre ninguna advertencia de herramienta desconocida para `vscode/askQuestions` bajo el Copilot harness (en caso de advertencia, reemplazarla por la herramienta interactiva soportada por tu versión del harness).
2. **Ejecución real de hooks en frontmatter `.agent.md`:** Verificar en los registros de depuración del agente (y el ajuste `chat.useCustomAgentHooks` en VS Code si aplica) que `hooks.preToolUse` se dispara únicamente con `Planner` (`--phase plan`) y `Migrator` (`--phase migrate`), y **no** con `Orchestrator`, `Analyst` ni sesiones normales.
3. **Restricciones en vivo:** Confirmar que `Planner` no puede editar código fuente ni alterar `01-diagnosis-report.*`, y que `Migrator` sin aprobación deniega ediciones (incluida `02-migration-plan.json`), comandos shell y delegación por `task`.
4. **Timeout fail-open y Copilot CLI:** Reproducir en pruebas controladas el comportamiento fail-open ante timeout y repetir la verificación en **GitHub Copilot CLI**.
