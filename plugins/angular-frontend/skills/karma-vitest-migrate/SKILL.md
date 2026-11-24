---
name: karma-vitest-migrate
description: Controla la ejecución determinista por fases aprobadas, registra aprobaciones humanas confirmadas en Copilot Chat (approve-artifact.mjs) y provee el validador y hooks preToolUse (verify-artifacts-gate.mjs)
user-invocable: false
---
# Skill: `karma-vitest-migrate`

Esta skill controla la ejecución determinista de la **Fase 3 (Implementación por fases aprobadas)**, provee el validador de gate y hooks `preToolUse` (`scripts/verify-artifacts-gate.mjs`) para los 4 agentes del **Copilot harness** (VS Code y Copilot CLI), y expone el registrador auditable de aprobaciones híbridas (`scripts/approve-artifact.mjs`). Se mantiene `user-invocable: false` para impedir invocaciones fuera del Orquestador.

## 1. Verificación del Gate de Artefactos (`scripts/verify-artifacts-gate.mjs`)

Ejecuta `scripts/verify-artifacts-gate.mjs` ubicado en el directorio de esta skill (ruta relativa al directorio que contiene este `SKILL.md`). Soporta dos modos:

### A. Modo CLI (`--phase plan` o `--phase migrate`)
```bash
# Validar antes de generar el plan (Fase 2): exige 01-diagnosis-report.json con status=READY y approval.status=APPROVED
node scripts/verify-artifacts-gate.mjs --project "." --phase plan

# Validar antes de ejecutar una fase específica de migración (Fase 3 multi-fase):
node scripts/verify-artifacts-gate.mjs --project "." --phase migrate --plan-phase phase-01-coexistence
```

### B. Modo Hook `preToolUse` del Copilot Harness (`--hook --phase <orchestrate|audit|plan|migrate>`)
Declarado como **agent-scoped hook** en el frontmatter `hooks.preToolUse` de los 4 agentes del plugin (sin afectar sesiones normales de desarrollo):
* **`karma-vitest-orchestrator.agent.md` (`--hook --phase orchestrate`):** permite solo lectura, `task`, `vscode/askQuestions` y el script `approve-artifact.mjs`; bloquea cualquier edición directa de archivos y cualquier otro comando shell.
* **`karma-vitest-analyst.agent.md` (`--hook --phase audit`):** permite solo lectura y los scripts `generate-diagnosis-report.mjs` / `check-prereqs.mjs`; bloquea ediciones, `task` y comandos shell arbitrarios.
* **`karma-vitest-planner.agent.md` (`--hook --phase plan`):** bloquea código fuente, `01-diagnosis-report.*`, `task`, `approve-artifact.mjs` y shell arbitrario; exige diagnóstico `READY` + `APPROVED` antes de ejecutar `generate-migration-plan.mjs` o escribir `02-migration-plan.{json,md}` y `plans/phase-XX-*.{json,md}`.
* **`karma-vitest-migrator.agent.md` (`--hook --phase migrate`):** bloquea `01-diagnosis-report.*`, `task`, `approve-artifact.mjs` y fases no activas; exige diagnóstico `READY` + `APPROVED`, `diagnosisHash` coincidente, fases previas `COMPLETED`, fase activa `APPROVED` con tareas y valida que toda edición en el repositorio esté dentro de `tasks[*].targetFiles` de la fase aprobada.

* Implementa el contrato camelCase oficial de **GitHub Copilot** (`preToolUse`):
  * Lee por `stdin` `{ sessionId, timestamp, cwd, toolName, toolArgs }`.
  * Emite por `stdout`:
    * `{}` (**`NO_DECISION`**): deja continuar el flujo normal de permisos del harness.
    * Formato JSON plano oficial para denegar (**`DENY`**):
      ```json
      {
        "permissionDecision": "deny",
        "permissionDecisionReason": "..."
      }
      ```

## 2. Registro de Aprobación Humana Confirmada en Chat (`scripts/approve-artifact.mjs`)

Script determinista reservado **exclusivamente al Orquestador** (bloqueado por hook en Analyst, Planner y Migrator) para registrar la aprobación humana solo después de una confirmación explícita del usuario en `#vscode/askQuestions` o Copilot CLI:

```bash
# Aprobar diagnóstico (falla automáticamente si status !== "READY"):
node scripts/approve-artifact.mjs --project "." --artifact diagnosis --reviewer "user" --mode chat-confirmed

# Aprobar una fase específica (falla si el diagnóstico no está APPROVED, si diagnosisHash derivó o si una fase previa no está COMPLETED):
node scripts/approve-artifact.mjs --project "." --artifact phase --plan-phase phase-01-coexistence --reviewer "user" --mode chat-confirmed
```

## 3. Reglas de Ejecución Determinista del Migrator
1. Nunca ejecutes ni modifiques archivos si `verify-artifacts-gate.mjs` devuelve código distinto de `0`.
2. Ejecuta **exactamente una fase aprobada por invocación** (`plans/<phaseId>.json`), respetando la convivencia Karma + Vitest hasta la fase `cutover-cleanup`.
3. Edita **únicamente** los archivos declarados en `tasks[*].targetFiles` de la fase activa.
4. Ejecuta todos los comandos en `verificationCommands[]` de la fase antes de marcar `status: "COMPLETED"` en `plans/<phaseId>.json` y `02-migration-plan.json`.
