# Plugin `angular-frontend`

Plugin en formato **Agent Plugins 1.0** para **GitHub Copilot (VS Code con Copilot harness y GitHub Copilot CLI)** enfocado en proyectos **Angular**. Proporciona un flujo guiado, seguro y determinista en 3 fases para analizar, planificar y migrar suites de pruebas unitarias de **Jasmine/Karma a Vitest** (`@angular/build:unit-test`), exigiendo **Angular 21+** como versión estable oficial.

---

## 1. Requisitos de Uso

* **Visual Studio Code `>= 1.133.0`** *(recomendado **`>= 1.143.0`** / `>= 1.146.0`)* con **GitHub Copilot Chat** (harness **Copilot**) o **GitHub Copilot CLI**.
  * Verifica tu versión local con `code --version`.
  * **Mínimo por capacidad (notas oficiales de VS Code):** [`1.109+`](https://code.visualstudio.com/updates/v1_109) (`user-invocable`), [`1.110+`](https://code.visualstudio.com/updates/v1_110) (`chat.plugins.enabled`), [`1.111+`](https://code.visualstudio.com/updates/v1_111) (*agent-scoped hooks* en preview / `chat.useCustomAgentHooks`), [`1.133+`](https://code.visualstudio.com/updates/v1_133) (**Agent Plugins 1.0** y `com.github.copilot/agents/`), [`1.143+`](https://code.visualstudio.com/updates/v1_143) (**Copilot harness** por defecto; Local harness deprecado en [`1.146`](https://code.visualstudio.com/updates/v1_146)).
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

### C. Actualización del Marketplace y del Plugin

* **En VS Code Copilot Chat:**
  ```text
  /plugin marketplace update gacc-copilot-plugins
  /plugin update angular-frontend@gacc-copilot-plugins
  ```
  *(También disponible desde `Chat: Open Customizations` → **Plugins**.)*
* **En GitHub Copilot CLI:**
  ```bash
  copilot plugin marketplace update gacc-copilot-plugins
  copilot plugin update angular-frontend
  copilot plugin list
  ```
* Si usas un **clon local**, realiza primero `git pull` (o commitea tus cambios locales) antes de ejecutar la actualización.

---

## 3. Guía de Alto Nivel: Agentes (`com.github.copilot/agents/`)

El plugin se utiliza seleccionando el **agente orquestador** en el **menú desplegable `Agents`** de Copilot Chat (o desde Copilot CLI).

Solo aparece **1 agente visible** en el selector; los otros **3 subagentes internos** (`user-invocable: false`) permanecen ocultos del menú y son invocados automáticamente por el orquestador en cada fase mediante la delegación nativa del **Copilot harness** (`task`), recibiendo explícitamente el contexto necesario (workspace, proyecto de `angular.json`, rutas de artefactos previos y formato esperado de retorno).

> **Diagramas de arquitectura (Mermaid):** Consulta el diagrama de flujo y el diagrama de secuencia completos en [docs/orchestrator-architecture.md](./docs/orchestrator-architecture.md).

| Agente | Visibilidad en `Agents` | Hook de migración | Rol a alto nivel |
| :--- | :---: | :---: | :--- |
| **`Angular Karma-to-Vitest`** (`karma-vitest-orchestrator`) | **Visible en el selector** | **Sí (`preToolUse --phase orchestrate`)** | Punto de entrada único para el desarrollador. Coordina el flujo incremental por fases, lee con `read` cada JSON de salida, ofrece **aprobación humana híbrida** (`#vscode/askQuestions` + `approve-artifact.mjs` o edición manual en JSON) y tiene bloqueada cualquier edición directa o comando shell arbitrario. |
| **`Karma-Vitest Analyst`** (`karma-vitest-analyst`) | Subagente interno | **Sí (`preToolUse --phase audit`)** | **Fase 1 (Diagnóstico Visual + Puntaje 1–10):** Restringido por hook a solo lectura + `generate-diagnosis-report.mjs` / `check-prereqs.mjs`. Evalúa Angular 21+ (`READY` vs `BLOCKED`), calcula `diagnosisHash` y `complexityScore` (`1–10`) por spec y genera `01-diagnosis-report.{json,md,html}`. |
| **`Karma-Vitest Planner`** (`karma-vitest-planner`) | Subagente interno | **Sí (`preToolUse --phase plan`)** | **Fase 2 (Planificación Incremental Dinámica):** Ejecuta `generate-migration-plan.mjs` para particionar el 100% de `specInventory` en fases con convivencia (`test` + `test-vitest` + `tsconfig.spec.vitest.json`): `02-migration-plan.{json,md}` y `plans/phase-XX-*.{json,md}` (todas en `PENDING`). Bloquea código fuente, shell arbitrario y `01-diagnosis-report.*`. |
| **`Karma-Vitest Migrator`** (`karma-vitest-migrator`) | Subagente interno | **Sí (`preToolUse --phase migrate`)** | **Fase 3 (Implementación por Fase Aprobada):** Ejecuta **una sola fase aprobada por invocación**. Verifica `diagnosisHash`, orden secuencial (`dependsOnPhase` en `COMPLETED`), aprobación de la fase activa y restringe toda edición exclusivamente a los archivos declarados en `tasks[*].targetFiles`. |

---

## 4. Guía de Alto Nivel: Skills (`skills/`) y Modelo de Seguridad

Las skills encapsulan las reglas, esquemas y scripts deterministas en Node.js que cargan los agentes bajo demanda (todas con `user-invocable: false` para impedir ejecuciones fuera del Orquestador):

* **`angular-migration-prereqs`**: Ejecuta `scripts/check-prereqs.mjs` para inspeccionar `package.json`, `angular.json`, `karma.conf.js` y `*.spec.ts`, clasificando la estrategia en **`UPGRADE_FIRST`** (`BLOCKED` si Angular `< 21`), **`OFFICIAL_SCHEMATIC_SUFFICIENT`** o **`HYBRID_SCHEMATIC_PLUS_AGENT`**.
* **`karma-vitest-audit`**: Incluye `scripts/generate-diagnosis-report.mjs` (v1.3.0 con `diagnosisHash` y puntaje numérico `complexityScore` `1–10` por `*.spec.ts`) y `scripts/generate-migration-plan.mjs` (particionado determinista por complejidad, score y carpeta en `02-migration-plan.{json,md}` + `plans/phase-XX-*.{json,md}` con convivencia Karma + Vitest), además de los JSON Schemas (`diagnosis-report`, `migration-plan`, `migration-phase`) y equivalencias Jasmine → Vitest.
* **`karma-vitest-migrate`**: Contiene las reglas de ejecución por fase, el registrador auditable `scripts/approve-artifact.mjs` (reservado al Orquestador tras confirmación explícita del usuario) y el validador `scripts/verify-artifacts-gate.mjs` (CLI + **4 agent-scoped hooks `preToolUse`**: `orchestrate`, `audit`, `plan`, `migrate`) con validación de `diagnosisHash`, secuencialidad de fases y restricción estricta a `targetFiles`.

### Separación de Niveles de Seguridad y Limitaciones

* **Nivel 1 — Control de Workflow del Plugin (alcance de `verify-artifacts-gate.mjs`):** Los hooks `preToolUse` están declarados en el frontmatter de los 4 agentes del plugin (sin afectar sesiones normales de desarrollo) aplicando mínimo privilegio por rol, bloqueando auto-aprobación (`approve-artifact.mjs` prohibido en todos los subagentes), delegación `task` en subagentes y ediciones fuera de `targetFiles`.
* **Nivel 2 — Gobernanza Organizacional (fuera del alcance del plugin):** Las políticas obligatorias de seguridad a nivel de organización (políticas administradas de GitHub Copilot Enterprise, permisos del sistema operativo, sandboxing, branch protection y CI) son independientes del plugin.
* **Limitaciones conocidas:** Los command hooks `preToolUse` tienen timeouts **fail-open** en el runtime de Copilot (los errores/salidas no cero son fail-closed) y la validación de symlinks previa a la escritura no elimina condiciones de carrera **TOCTOU**; por ello el gate no sustituye al sandboxing del entorno.

---

## 5. Flujo Rápido de Uso

1. **Abrir el selector de Agentes:** En **GitHub Copilot Chat** en VS Code (con el harness **Copilot** seleccionado) o en **Copilot CLI**, selecciona **`Angular Karma-to-Vitest`**.
2. **Fase 1 — Diagnóstico:** Escribe en el chat:
   > *"Analiza este repositorio para migrar de Jasmine/Karma a Vitest."*
3. **Checkpoint 1 (Aprobación Híbrida) y Fase 2 — Planificación por Fases:** Revisa `01-diagnosis-report.html` / `.md`. Si el estado es `READY`, aprueba directamente desde el asistente interactivo en Copilot Chat (o edita `approval.status = "APPROVED"` en `01-diagnosis-report.json`) para generar el índice maestro `02-migration-plan.json` y los subplanes `plans/phase-XX-*.json`.
4. **Fase 3 — Ejecución Incremental con Convivencia:** Aprueba cada fase en orden (`phase-01-coexistence` → lotes `low`/`medium`/`high` → `cutover-cleanup`) desde Copilot Chat o en su JSON, valida ambos runners (`test` + `test-vitest`) + `ng build` en tu CI/preproducción tras cada fase y continúa con la siguiente cuando estés listo.

---

## 6. Verificación de Integridad, Seguridad y Confirmaciones en Vivo

### Suite automatizada (sin dependencias)
Desde la raíz del repositorio `gacc-copilot-plugins`, ejecuta:

```bash
node --test __tests__/*.test.mjs
```

### Puntos críticos a confirmar en prueba real (VS Code Copilot Harness y Copilot CLI)
Dado que los hooks definidos en frontmatter de `.agent.md` están en *preview* y las herramientas disponibles dependen de la versión del runtime, valida en **Agent Customizations** (`Chat: Open Customizations`), en los **registros de depuración del agente / diagnósticos del proveedor** en VS Code y en una prueba independiente con **Copilot CLI**:
1. **Advertencias de herramientas (`vscode/askQuestions`):** Abrir `Chat: Open Customizations` y comprobar que `Angular Karma-to-Vitest` no muestre ninguna advertencia de herramienta desconocida para `vscode/askQuestions` bajo el Copilot harness (en caso de advertencia, reemplazarla por la herramienta interactiva soportada por tu versión del harness).
2. **Ejecución real de hooks en frontmatter `.agent.md`:** Verificar en los registros de depuración del agente (y el ajuste `chat.useCustomAgentHooks` en VS Code si aplica) que `hooks.preToolUse` se dispara en los 4 agentes del plugin (`--phase orchestrate`, `audit`, `plan`, `migrate`) y **no** en sesiones normales fuera del plugin.
3. **Restricciones en vivo:** Confirmar que `Orchestrator` no puede editar archivos ni ejecutar comandos fuera de `approve-artifact.mjs`, que `Analyst` solo ejecuta `generate-diagnosis-report.mjs`/`check-prereqs.mjs`, que `Planner` no puede editar código fuente ni alterar `01-diagnosis-report.*`, y que `Migrator` sin aprobación de fase o fuera de `targetFiles` deniega ediciones, comandos shell y delegación por `task`.
4. **Timeout fail-open y Copilot CLI:** Reproducir en pruebas controladas el comportamiento fail-open ante timeout y repetir la verificación en **GitHub Copilot CLI**.
