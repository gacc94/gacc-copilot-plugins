# GACC Copilot Plugins (`gacc-copilot-plugins`)

Repositorio catálogo (**Marketplace multi-plugin**) de **GACC** para **GitHub Copilot en VS Code (Copilot harness)** y **GitHub Copilot CLI**, estructurado conforme al estándar **Agent Plugins 1.0**.

Este repositorio centraliza plugins especializados por tecnología bajo `plugins/<nombre-plugin>/`, con el catálogo oficial del marketplace en `.github/plugin/marketplace.json`.

---

## 1. Requisitos Globales

* **Visual Studio Code** con **GitHub Copilot Chat** (harness **Copilot**) o **GitHub Copilot CLI**.
* **Node.js `>= 20.19.0`** (recomendado `22.x LTS` o `24.x LTS`; para proyectos con Angular 22 se requiere Node.js `>= 22.22.3`).
  * Verifica tu instalación local con:
    ```bash
    node -v
    ```
* **Repositorio Git con al menos un commit (para uso local):** VS Code valida la revisión Git de un marketplace local antes de instalar sus plugins. Asegúrate de tener el repositorio inicializado y con cambios commiteados (`git init && git add -A && git commit`).
* **Ejecución 100% local (sin servidores MCP ni dependencias externas):** Tanto los scripts de las skills como la suite de pruebas están escritos en **JavaScript ESM puro (`.mjs`)** utilizando únicamente módulos nativos de Node.js (`node:fs`, `node:path`, `node:url`, `node:test`). No requieren compilación ni `npm install`.

---

## 2. Estructura del Repositorio

```text
gacc-copilot-plugins/
├── .github/
│   └── plugin/
│       └── marketplace.json                  # Catálogo oficial multi-plugin
├── README.md                                 # Guía de configuración global del marketplace
├── tests/
│   ├── verify-artifacts-gate.test.mjs        # Pruebas de seguridad y contrato del gate (node:test)
│   └── plugin-structure.test.mjs             # Pruebas de integridad Agent Plugins 1.0 y marketplace
└── plugins/
    └── angular-frontend/                     # Plugin Angular (Karma → Vitest, v2.0.1)
        ├── plugin.json                       # Manifiesto Agent Plugins 1.0 ($schema)
        ├── README.md
        ├── skills/                           # Skills portables (con sus scripts/ y references/)
        └── com.github.copilot/
            └── agents/                       # Custom agents específicos de Copilot (incluye hook agent-scoped)
```

---

## 3. Cómo Configurar los Plugins (VS Code Copilot Harness y Copilot CLI)

### Opción A — Desde Copilot Chat con `/plugin` (Recomendado)

Con el harness **Copilot** activo en VS Code Copilot Chat, registra el marketplace e instala el plugin directamente:

```text
/plugin marketplace add /Users/gustavocaqui/Development/gacc/projects/plugins/gacc-copilot-plugins
/plugin marketplace list
/plugin marketplace browse gacc-copilot-plugins
/plugin install angular-frontend@gacc-copilot-plugins
```

> Si publicas el repositorio en GitHub (por ejemplo `gacc-org/gacc-copilot-plugins`), reemplaza la ruta local por `gacc-org/gacc-copilot-plugins` (compatible también con `copilot plugin marketplace add gacc-org/gacc-copilot-plugins` y `copilot plugin install angular-frontend` gracias a `.github/plugin/marketplace.json`).

### Opción B — Configuración directa en `~/.copilot/settings.json`

El runtime de **Copilot** lee los marketplaces de usuario desde `~/.copilot/settings.json` (o `.github/copilot/settings.json` a nivel de proyecto):

```json
{
  "extraKnownMarketplaces": {
    "gacc-copilot-plugins": {
      "source": {
        "source": "directory",
        "path": "/Users/gustavocaqui/Development/gacc/projects/plugins/gacc-copilot-plugins"
      }
    }
  },
  "enabledPlugins": {
    "angular-frontend@gacc-copilot-plugins": true
  }
}
```

> **Si el repositorio está en GitHub:** cambia `"source"` por `{ "source": "github", "repo": "gacc-org/gacc-copilot-plugins" }`.
>
> **Nota sobre `settings.json` de VS Code:** si agregas el marketplace en `"chat.plugins.marketplaces"` dentro del `settings.json` clásico de VS Code, el editor mostrará el aviso **Keep your customizations working** con el botón **Migrate...** para trasladarlo automáticamente a `~/.copilot/settings.json`.

### Opción C — Carga directa de un plugin en desarrollo local (`settings.json` de VS Code)

Para iterar rápidamente sobre un plugin local sin reinstalarlo desde el catálogo:

```json
{
  "chat.plugins.enabled": true,
  "chat.pluginLocations": {
    "/Users/gustavocaqui/Development/gacc/projects/plugins/gacc-copilot-plugins/plugins/angular-frontend": true
  }
}
```

---

## 4. Plugins Disponibles

| Plugin | Ruta (`source`) | Versión | Descripción | Documentación |
| :--- | :--- | :---: | :--- | :--- |
| **`angular-frontend`** | `./plugins/angular-frontend` | `2.0.1` | Diagnóstico visual/estructurado (`.json`, `.md`, `.html`), planificación ejecutable y migración determinista de Karma a Vitest (Angular 21+), en formato Agent Plugins 1.0 para VS Code y Copilot CLI. | [Ver README](./plugins/angular-frontend/README.md) |

---

## 5. Verificación Local y Diagnóstico

Ejecuta la suite completa de pruebas estructurales y de seguridad con el runner nativo de Node.js:

```bash
node --test tests/verify-artifacts-gate.test.mjs tests/plugin-structure.test.mjs
```

Para inspeccionar el descubrimiento y ejecución del plugin en VS Code (Copilot harness), usa **Agent Customizations** (`Chat: Open Customizations`) junto con los **registros de depuración del agente y diagnósticos del proveedor** (y valida por separado en **Copilot CLI** si distribuyes el catálogo para ambos entornos).

---

## 6. Cómo Añadir un Nuevo Plugin al Repositorio

1. Crea una nueva carpeta bajo `plugins/<tecnologia>-<rol>/` (por ejemplo, `plugins/nestjs-backend/` o `plugins/java-backend/`).
2. Añade su manifiesto `plugin.json` siguiendo **Agent Plugins 1.0** (`"$schema": "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json"`), su `README.md`, sus skills portables en `skills/` y sus componentes específicos de Copilot en `com.github.copilot/agents/`.
3. Registra la nueva entrada dentro del arreglo `plugins` en `.github/plugin/marketplace.json` con su ruta relativa en `source` y la misma versión que `plugin.json`.
4. Ejecuta `node --test tests/*.test.mjs` y haz commit de los cambios en Git para que el marketplace refleje la nueva revisión.
