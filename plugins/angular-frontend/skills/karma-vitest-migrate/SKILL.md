---
name: karma-vitest-migrate
description: Ejecuta de manera determinista la migración de Jasmine/Karma a Vitest siguiendo el plan aprobado (02-migration-plan.json), protegida por el validador y hook preToolUse verify-artifacts-gate.mjs
user-invocable: false
---
# Skill: `karma-vitest-migrate`

Esta skill controla la ejecución determinista de la **Fase 3 (Implementación)** y provee el validador de gate (`scripts/verify-artifacts-gate.mjs`) utilizado tanto en CLI como en los hooks agent-scoped `preToolUse` del **Copilot harness** (compartido entre VS Code y GitHub Copilot CLI).

## 1. Verificación del Gate de Artefactos (`scripts/verify-artifacts-gate.mjs`)

Resuelve el script `scripts/verify-artifacts-gate.mjs` **directamente junto al archivo `SKILL.md` de esta skill** (sin adivinar rutas del plugin). Soporta dos modos de operación:

### A. Modo CLI (`--phase plan` o `--phase migrate`)
```bash
# Validar antes de generar el plan (Fase 2): exige 01-diagnosis-report.json con status=READY y approval.status=APPROVED
node "<directorio-de-esta-skill>/scripts/verify-artifacts-gate.mjs" --project "." --phase plan

# Validar antes de ejecutar la migración (Fase 3): exige además 02-migration-plan.json con approval.status=APPROVED
node "<directorio-de-esta-skill>/scripts/verify-artifacts-gate.mjs" --project "." --phase migrate
```

### B. Modo Hook `preToolUse` del Copilot Harness (`--hook --phase <plan|migrate>`)
* Declarado como **agent-scoped hook** en el frontmatter `hooks.preToolUse` de dos subagentes (dejando intactas las sesiones normales de desarrollo y la Fase 1):
  * `com.github.copilot/agents/karma-vitest-planner.agent.md` (`--hook --phase plan`): impide modificar código fuente, ejecutar comandos shell arbitrarios o alterar `01-diagnosis-report.*`, y exige que el diagnóstico esté `READY` + `APPROVED` antes de escribir `02-migration-plan.{json,md}`.
  * `com.github.copilot/agents/karma-vitest-migrator.agent.md` (`--hook --phase migrate`): impide alterar `01-diagnosis-report.*` (inmutable) y exige que diagnóstico (`READY` + `APPROVED`) y plan (`APPROVED` + `tasks`) estén aprobados antes de cualquier edición (incluyendo `02-migration-plan.json`, evitando auto-aprobación) o comando shell fuera de los scripts del plugin.
* Implementa el contrato camelCase oficial de **GitHub Copilot** (`preToolUse`):
  * Lee por `stdin` el payload JSON del evento (`{ sessionId, timestamp, cwd, toolName, toolArgs }`, aceptando defensivamente `toolArgs` como objeto o string JSON).
  * Emite por `stdout`:
    * `{}` (**`NO_DECISION`**): deja continuar el flujo normal de permisos del harness (no equivale a conceder permiso incondicional).
    * Formato JSON plano oficial para denegar (**`DENY`**):
      ```json
      {
        "permissionDecision": "deny",
        "permissionDecisionReason": "..."
      }
      ```
* **Modelo de decisión en 3 estados:**
  1. **`DENY` incondicional** *(nunca se omite, aunque el diagnóstico y el plan estén `APPROVED`)*:
     * `stdin` vacío/inválido, ausencia de `toolName`, `--phase` inválido o `toolArgs` malformados.
     * Herramienta desconocida o alias de configuración no pertenecientes a los identificadores reales del runtime (`read`, `search`, `todo`, `agent`, `agent/runSubagent`, herramientas desconocidas).
     * Delegación mediante `task`: bloqueada incondicionalmente en Planner y Migrator para evitar mutaciones no auditadas en subagentes.
     * Mutación de `01-diagnosis-report.{json,md,html}` (inmutables tras Fase 1).
     * En `--phase plan`: cualquier escritura fuera de `02-migration-plan.{json,md}` y cualquier comando shell fuera de los 3 scripts confiables del plugin.
     * Destinos de archivo no verificables, esquemas URI distintos de `file://`, rutas UNC, parches incompletos, escapes por symlink desde `.migration-artifacts/karma-to-vitest` o rutas fuera del workspace.
  2. **`NO_DECISION` (`{}`)** *(exento del gate de aprobación)*:
     * Herramientas de solo lectura / no mutantes documentadas en el runtime de hooks (`view`, `glob`, `grep`, `ask_user`, `web_fetch`, `update_todo`).
     * Invocaciones directas vía `bash` o `powershell` hacia las **rutas canónicas reales (`realpath`)** de los 3 scripts confiables del plugin (`check-prereqs.mjs`, `generate-diagnosis-report.mjs`, `verify-artifacts-gate.mjs`), usando gramática cerrada sin metacaracteres de Bash/PowerShell/CMD, sin opciones previas de Node, priorizando `process.execPath` y restringiendo `--project` dentro del workspace actual.
  3. **`REQUIRE_GATE`**:
     * En `--phase plan`: escribir `02-migration-plan.{json,md}` requiere `validateGate('plan')` (`01-diagnosis-report.json` en `READY` + `APPROVED`).
     * En `--phase migrate`: editar archivos del workspace (incluyendo `02-migration-plan.json` para actualizar `tasks[*].status`) o ejecutar comandos shell de migración requiere `validateGate('migrate')` (`01-diagnosis-report.json` `READY` + `APPROVED` y `02-migration-plan.json` `APPROVED` con `tasks`).

## 2. Separación de Niveles de Seguridad y Limitaciones Conocidas

* **Nivel 1 — Control de Workflow del Plugin (`verify-artifacts-gate.mjs` + hooks agent-scoped):** Controla la disciplina de las 3 fases mientras operan `Karma-Vitest Planner` y `Karma-Vitest Migrator`, sin bloquear sesiones normales de desarrollo.
* **Nivel 2 — Gobernanza Organizacional (fuera del alcance del plugin):** Políticas administradas de GitHub Copilot Enterprise, permisos del sistema operativo, sandboxing, branch protection y CI. Estos hooks complementan pero **no sustituyen** controles organizacionales ni de sandbox.
* **Limitaciones documentadas del runtime:**
  * **Timeout fail-open:** En GitHub Copilot, los errores / códigos de salida distintos de `0` en command hooks `preToolUse` son fail-closed, pero los **timeouts son fail-open** (continúa el flujo normal de permisos). Por ello el script mantiene ejecución local rápida y sin llamadas de red.
  * **Condiciones de carrera TOCTOU:** Validar symlinks en `preToolUse` no elimina condiciones de carrera entre verificación y escritura si otro proceso modifica un symlink concurrentemente; el aislamiento duro requiere sandboxing del entorno.
  * **Confianza en `PATH`:** Si el agente invoca `node` / `node.exe` por nombre en lugar de la ruta absoluta de `process.execPath`, la resolución depende del `PATH` del entorno.

## 3. Reglas de Ejecución Determinista en Fase 3

1. **Cero desviaciones respecto al plan:** Solo pueden modificarse los archivos listados en `tasks[*].targetFiles` dentro de `.migration-artifacts/karma-to-vitest/02-migration-plan.json`.
2. **Orden estricto:** Ejecutar las tareas siguiendo `tasks[*].order`.
3. **Trazabilidad:** Actualizar `tasks[*].status` a `"COMPLETED"` en `02-migration-plan.json` conforme cada paso finalice y verificar con `npx ng test --watch=false`.
