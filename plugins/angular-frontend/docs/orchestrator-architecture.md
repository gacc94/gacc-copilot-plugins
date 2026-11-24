# Arquitectura del Orquestador (`Angular Karma-to-Vitest`)

Este documento describe mediante diagramas **Mermaid** el funcionamiento del agente orquestador ([karma-vitest-orchestrator.agent.md](../com.github.copilot/agents/karma-vitest-orchestrator.agent.md)), su delegación aislada a los 3 subagentes internos (`user-invocable: false`), la **aprobación humana híbrida** (`#vscode/askQuestions` + [approve-artifact.mjs](../skills/karma-vitest-migrate/scripts/approve-artifact.mjs) o edición manual en JSON), la **planificación incremental con convivencia Karma + Vitest** ([generate-migration-plan.mjs](../skills/karma-vitest-audit/scripts/generate-migration-plan.mjs)) y los 4 hooks agent-scoped `preToolUse` de [verify-artifacts-gate.mjs](../skills/karma-vitest-migrate/scripts/verify-artifacts-gate.mjs).

---

## 1. Diagrama de Flujo (Decisiones, Aprobación Híbrida y Bucle por Fases)

```mermaid
flowchart TD
    Start(["Desarrollador selecciona Angular Karma-to-Vitest\nHook preToolUse --phase orchestrate"]) --> MultiProj{"Multiples proyectos en angular.json sin especificar?"}
    MultiProj -- "Si" --> AskProj["Preguntar proyecto objetivo con vscode/askQuestions"]
    MultiProj -- "No" --> Phase1
    AskProj --> Phase1

    Phase1["Fase 1: Delegar a Karma-Vitest Analyst\nHook preToolUse --phase audit"]
    Phase1 --> RunDiag["Analyst ejecuta scripts/generate-diagnosis-report.mjs\nGenera 01-diagnosis-report.json, .md y .html\nIncluye diagnosisHash y complexityScore 1-10"]
    RunDiag --> ReadDiag["Orquestador verifica 01-diagnosis-report.json con read"]
    ReadDiag --> CheckStatus{"Estado del diagnostico?"}

    CheckStatus -- "BLOCKED / UPGRADE_FIRST\nAngular menor a 21" --> StopBlocked(["Flujo detenido: prohibido aprobar o invocar Planner/Migrator\nDerivar a upgrade de Angular 21+"])

    CheckStatus -- "READY / OFFICIAL_SCHEMATIC_SUFFICIENT" --> AskOfficial{"Usuario elige schematic oficial manual?"}
    AskOfficial -- "Si - Recomendado" --> EndOfficial(["Finalizar y ejecutar ng g @schematics/angular:refactor-jasmine-vitest"])
    AskOfficial -- "No - Quiere plan auditado" --> CP1

    CheckStatus -- "READY / HYBRID_SCHEMATIC_PLUS_AGENT" --> CP1["Checkpoint 1 - Aprobacion Humana Hibrida\nvscode/askQuestions o prompt CLI"]

    CP1 --> CP1Choice{"Decision del especialista"}
    CP1Choice -- "Aprobar en Chat" --> ApproveDiag["Orquestador ejecuta approve-artifact.mjs --artifact diagnosis"]
    CP1Choice -- "Aprobar manual en JSON" --> ManualDiag["Usuario edita approval.status=APPROVED en JSON"]
    CP1Choice -- "Rechazar / Detener" --> StopCP1(["Flujo detenido sin planificar"])
    ApproveDiag --> Phase2
    ManualDiag --> Phase2

    Phase2["Fase 2: Delegar a Karma-Vitest Planner\nHook preToolUse --phase plan"]
    Phase2 --> RunPlan["Planner ejecuta verify-artifacts-gate.mjs y generate-migration-plan.mjs\nParticiona 100% de specInventory por score y modulo"]
    RunPlan --> GenArt2["Escribe 02-migration-plan.json maestro\n+ plans/phase-01-coexistence ... plans/phase-N-cutover-cleanup"]
    GenArt2 --> ReadPlan["Orquestador lee 02-migration-plan.json con read"]

    ReadPlan --> NextPhase{"Queda alguna fase pendiente en plans/?"}
    NextPhase -- "No" --> Done(["Migracion completa: 100% Vitest + limpieza Karma"])
    NextPhase -- "Si: phase-XX" --> CP2["Checkpoint 2.k - Aprobacion Humana Hibrida de phase-XX\nMuestra targetFiles y verificationCommands"]

    CP2 --> CP2Choice{"Decision del especialista"}
    CP2Choice -- "Aprobar fase en Chat" --> ApprovePhase["Orquestador ejecuta approve-artifact.mjs --artifact phase --plan-phase phase-XX"]
    CP2Choice -- "Aprobar manual en JSON" --> ManualPhase["Usuario edita approval.status=APPROVED en plans/phase-XX.json"]
    CP2Choice -- "Pausar para CI / Preprod" --> PauseFlow(["Flujo pausado de forma segura hasta retomar"])
    ApprovePhase --> Phase3
    ManualPhase --> Phase3

    Phase3["Fase 3: Delegar UNA fase a Karma-Vitest Migrator\nHook preToolUse --phase migrate"]
    Phase3 --> HookMig{"Hook valida:\n1. Diagnostico READY+APPROVED y diagnosisHash\n2. Fases previas COMPLETED\n3. Fase activa APPROVED\n4. Ediciones dentro de targetFiles"}
    HookMig -- "Fallo o fuera de targetFiles" --> DenyMig["DENY incondicional\npermissionDecision: deny"]
    HookMig -- "Valido" --> ExecMig["Ejecuta tareas de phase-XX\nCorre ambos runners test + test-vitest + ng build\nMarca phase-XX COMPLETED"]
    ExecMig --> ReadPost["Orquestador verifica phase-XX COMPLETED con read\nConfirma validacion CI/Preprod"]
    ReadPost --> NextPhase
```

---

## 2. Diagrama de Secuencia (Interacción entre Agentes, Hooks y Artefactos)

```mermaid
sequenceDiagram
    autonumber
    actor User as Desarrollador
    participant Orch as Angular Karma-to-Vitest (Orquestador)
    participant Analyst as Karma-Vitest Analyst (Fase 1)
    participant Planner as Karma-Vitest Planner (Fase 2)
    participant Migrator as Karma-Vitest Migrator (Fase 3)
    participant Gate as verify-artifacts-gate.mjs (CLI y 4 Hooks)
    participant Disk as .migration-artifacts/karma-to-vitest/

    User->>Orch: Solicita migrar Jasmine/Karma a Vitest
    opt Monorepo con varios proyectos en angular.json
        Orch->>User: Pregunta proyecto objetivo (vscode/askQuestions)
        User-->>Orch: Indica proyecto seleccionado
    end

    Note over Orch,Analyst: Fase 1 - Diagnostico (hook --phase audit, solo lectura + scripts autorizados)
    Orch->>Analyst: Delega via task con workspace, --angular-project y salida esperada
    Analyst->>Gate: Hook preToolUse --phase audit valida generate-diagnosis-report.mjs
    Gate-->>Analyst: NO_DECISION {} (DENY a ediciones o shell arbitrario)
    Analyst->>Disk: Genera 01-diagnosis-report.json (diagnosisHash + complexityScore 1-10), .md y .html
    Analyst-->>Orch: Devuelve resumen compacto y rutas
    Orch->>Disk: Lee 01-diagnosis-report.json con read

    alt status == BLOCKED (Angular < 21)
        Orch-->>User: Detiene el flujo y reporta bloqueadores (UPGRADE_FIRST)
    else status == READY
        Orch->>User: Checkpoint 1 Hibrido (vscode/askQuestions): Aprobar en Chat / Manual JSON / Detener
        alt Usuario elige Aprobar en Chat
            User-->>Orch: Confirma aprobacion explicita
            Orch->>Gate: Hook --phase orchestrate valida approve-artifact.mjs --artifact diagnosis
            Gate-->>Orch: NO_DECISION {}
            Orch->>Disk: Registra approval.status=APPROVED (mode: chat-confirmed)
        else Usuario elige Aprobar manual en JSON
            User->>Disk: Edita approval.status=APPROVED en 01-diagnosis-report.json
            User-->>Orch: Confirma continuacion
        end

        Note over Orch,Planner: Fase 2 - Planificacion Dinamica (hook --phase plan)
        Orch->>Planner: Delega con workspace, proyecto y ruta de 01-diagnosis-report.json
        Planner->>Gate: Ejecuta CLI --phase plan y hook valida generate-migration-plan.mjs
        Gate->>Disk: Verifica 01-diagnosis-report.json (READY + APPROVED)
        Gate-->>Planner: ALLOWED / NO_DECISION {}
        Planner->>Disk: Escribe 02-migration-plan.{json,md} + plans/phase-01..phase-N.{json,md}
        Planner-->>Orch: Devuelve resumen de fases, scores y rutas
        Orch->>Disk: Lee 02-migration-plan.json con read

        loop Por cada fase secuencial (phase-01-coexistence ... phase-N-cutover-cleanup)
            Orch->>User: Checkpoint 2.k Hibrido (vscode/askQuestions) para phase-XX
            alt Aprobar fase en Chat
                User-->>Orch: Confirma aprobacion de phase-XX
                Orch->>Disk: approve-artifact.mjs --artifact phase --plan-phase phase-XX
            else Aprobar manual en JSON
                User->>Disk: Edita approval.status=APPROVED en plans/phase-XX.json
                User-->>Orch: Confirma ejecucion de phase-XX
            end

            Note over Orch,Migrator: Fase 3 - Ejecucion acotada a phase-XX (hook --phase migrate)
            Orch->>Migrator: Delega phase-XX con rutas exactas de Fase 1 y Fase 2
            Migrator->>Gate: CLI --phase migrate --plan-phase phase-XX + hook preToolUse
            Gate->>Disk: Verifica READY+APPROVED, diagnosisHash, fases previas COMPLETED y targetFiles
            Gate-->>Migrator: ALLOWED / NO_DECISION {} (DENY fuera de targetFiles o sin aprobacion)
            Migrator->>Disk: Aplica tareas de phase-XX, corre ambos runners + ng build y marca COMPLETED
            Migrator-->>Orch: Reporta resultados de verificacion de phase-XX
            Orch->>Disk: Verifica phase-XX COMPLETED con read
            Orch-->>User: Entrega resumen de phase-XX (listo para CI/preproduccion)
        end
    end
```
