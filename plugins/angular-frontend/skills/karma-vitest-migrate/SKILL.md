---
name: karma-vitest-migrate
description: Ejecuta de manera determinista la migración de Jasmine/Karma a Vitest siguiendo el plan aprobado (02-migration-plan.json), protegida por el validador y hook verify-artifacts-gate.mjs
user-invocable: false
---
# Skill: `karma-vitest-migrate`

Esta skill controla la ejecución determinista de la **Fase 3 (Implementación)** y provee el validador de gate (`verify-artifacts-gate.mjs`) utilizado tanto en CLI como en el hook `preToolUse` de Copilot.

## 1. Verificación del Gate de Artefactos (`verify-artifacts-gate.mjs`)

El script soporta dos modos de operación:

### A. Modo CLI (`--phase plan` o `--phase migrate`)
```bash
# Validar antes de generar el plan (Fase 2): exige 01-diagnosis-report.json con status=READY y approval.status=APPROVED
node "<ruta-del-plugin>/skills/karma-vitest-migrate/scripts/verify-artifacts-gate.mjs" --project "." --phase plan

# Validar antes de ejecutar la migración (Fase 3): exige además 02-migration-plan.json con approval.status=APPROVED
node "<ruta-del-plugin>/skills/karma-vitest-migrate/scripts/verify-artifacts-gate.mjs" --project "." --phase migrate
```

### B. Modo Hook `preToolUse` de Copilot (`--hook`)
* Invocado automáticamente por `hooks.json` y por el frontmatter `hooks.preToolUse` de `karma-vitest-migrator.agent.md`.
* Lee el payload JSON del evento desde `stdin`:
  * Si la herramienta es de solo lectura (`read`, `search`, etc.) o si se está escribiendo únicamente dentro de `.migration-artifacts/karma-to-vitest/`, devuelve `{}` en `stdout`.
  * Si un agente intenta editar archivos fuera de `.migration-artifacts/` cuando los artefactos `01-diagnosis-report.json` y `02-migration-plan.json` no están en estado `READY` + `APPROVED`, bloquea la llamada devolviendo:
    ```json
    {
      "permissionDecision": "deny",
      "permissionDecisionReason": "..."
    }
    ```

## 2. Reglas de Ejecución Determinista en Fase 3

1. **Cero desviaciones respecto al plan:** Solo pueden modificarse los archivos listados en `tasks[*].targetFiles` dentro de `.migration-artifacts/karma-to-vitest/02-migration-plan.json`.
2. **Orden estricto:** Ejecutar las tareas siguiendo `tasks[*].order`.
3. **Trazabilidad:** Actualizar `tasks[*].status` a `"COMPLETED"` en `02-migration-plan.json` conforme cada paso finalice y verificar con `npx ng test --watch=false`.
