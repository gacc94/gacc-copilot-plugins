---
name: karma-vitest-migrate
description: Ejecuta de manera determinista la migración de Jasmine/Karma a Vitest siguiendo el plan aprobado (02-migration-plan.json), protegida por el validador y hook preToolUse verify-artifacts-gate.mjs
user-invocable: false
---
# Skill: `karma-vitest-migrate`

Esta skill controla la ejecución determinista de la **Fase 3 (Implementación)** y provee el validador de gate (`verify-artifacts-gate.mjs`) utilizado tanto en CLI como en el hook `preToolUse` del **Copilot harness** (compartido entre VS Code y GitHub Copilot CLI).

## 1. Verificación del Gate de Artefactos (`verify-artifacts-gate.mjs`)

El script soporta dos modos de operación:

### A. Modo CLI (`--phase plan` o `--phase migrate`)
```bash
# Validar antes de generar el plan (Fase 2): exige 01-diagnosis-report.json con status=READY y approval.status=APPROVED
node "<ruta-del-plugin>/skills/karma-vitest-migrate/scripts/verify-artifacts-gate.mjs" --project "." --phase plan

# Validar antes de ejecutar la migración (Fase 3): exige además 02-migration-plan.json con approval.status=APPROVED
node "<ruta-del-plugin>/skills/karma-vitest-migrate/scripts/verify-artifacts-gate.mjs" --project "." --phase migrate
```

### B. Modo Hook `preToolUse` del Copilot Harness (`--hook`)
* Declarado exclusivamente como **agent-scoped hook** en el frontmatter `hooks.preToolUse` de `com.github.copilot/agents/karma-vitest-migrator.agent.md` (evitando bloquear el análisis en Fase 1, la planificación en Fase 2 o sesiones normales de desarrollo).
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
     * `stdin` vacío/inválido, ausencia de `toolName`, o `toolArgs` malformados.
     * Herramienta desconocida o alias de configuración no pertenecientes a los identificadores reales del runtime (`read`, `search`, `todo`, `agent`, `agent/runSubagent`, herramientas desconocidas).
     * Delegación mediante `task`: bloqueada incondicionalmente en el Migrator para evitar mutaciones no auditadas en subagentes.
     * Destinos de archivo no verificables, esquemas URI distintos de `file://`, rutas UNC, parches incompletos, escapes por symlink desde `.migration-artifacts/karma-to-vitest` o rutas fuera del workspace.
  2. **`NO_DECISION` (`{}`)** *(exento del gate de aprobación)*:
     * Herramientas de solo lectura / no mutantes documentadas en el runtime de hooks (`view`, `glob`, `grep`, `ask_user`, `web_fetch`, `update_todo`).
     * Invocaciones directas vía `bash` o `powershell` hacia las **rutas canónicas reales (`realpath`)** de los 3 scripts confiables del plugin (`check-prereqs.mjs`, `generate-diagnosis-report.mjs`, `verify-artifacts-gate.mjs`), usando gramática cerrada sin metacaracteres de Bash/PowerShell/CMD, sin opciones previas de Node, priorizando `process.execPath` y restringiendo `--project` dentro del workspace actual.
     * Mutaciones mediante adaptadores dedicados por herramienta (`edit`, `create`, `delete`, `rename`, `move`, `apply_patch`, `patch`) donde **todos** los destinos resuelven estrictamente dentro de `.migration-artifacts/karma-to-vitest/`.
  3. **`REQUIRE_GATE`**:
     * Herramientas conocidas (`bash`, `powershell`, `edit`, `create`, `delete`, `rename`, `move`, `apply_patch`, `patch`) operando dentro del workspace fuera de artefactos: emiten `{}` (`NO_DECISION`) solo si `01-diagnosis-report.json` (`READY` + `APPROVED`) y `02-migration-plan.json` (`APPROVED` + `tasks`) superan `validateGate()`; de lo contrario emiten `DENY`.

## 2. Separación de Niveles de Seguridad y Limitaciones Conocidas

* **Nivel 1 — Control de Workflow del Plugin (`verify-artifacts-gate.mjs` + hook agent-scoped):** Controla la disciplina de las 3 fases mientras opera `Karma-Vitest Migrator`, sin bloquear sesiones normales de desarrollo.
* **Nivel 2 — Gobernanza Organizacional (fuera del alcance del plugin):** Políticas administradas de GitHub Copilot Enterprise, permisos del sistema operativo, sandboxing, branch protection y CI. Este hook complementa pero **no sustituye** controles organizacionales ni de sandbox.
* **Limitaciones documentadas del runtime:**
  * **Timeout fail-open:** En GitHub Copilot, los errores / códigos de salida distintos de `0` en command hooks `preToolUse` son fail-closed, pero los **timeouts son fail-open** (continúa el flujo normal de permisos). Por ello el script mantiene ejecución local rápida y sin llamadas de red.
  * **Condiciones de carrera TOCTOU:** Validar symlinks en `preToolUse` no elimina condiciones de carrera entre verificación y escritura si otro proceso modifica un symlink concurrentemente; el aislamiento duro requiere sandboxing del entorno.
  * **Confianza en `PATH`:** Si el agente invoca `node` / `node.exe` por nombre en lugar de la ruta absoluta de `process.execPath`, la resolución depende del `PATH` del entorno.

## 3. Reglas de Ejecución Determinista en Fase 3

1. **Cero desviaciones respecto al plan:** Solo pueden modificarse los archivos listados en `tasks[*].targetFiles` dentro de `.migration-artifacts/karma-to-vitest/02-migration-plan.json`.
2. **Orden estricto:** Ejecutar las tareas siguiendo `tasks[*].order`.
3. **Trazabilidad:** Actualizar `tasks[*].status` a `"COMPLETED"` en `02-migration-plan.json` conforme cada paso finalice y verificar con `npx ng test --watch=false`.
