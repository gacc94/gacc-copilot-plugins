# GACC Copilot Plugins (`gacc-copilot-plugins`)

Repositorio catálogo (**Marketplace multi-plugin**) de **GACC** para **GitHub Copilot Chat en VS Code** y clientes compatibles con plugins de agentes.

Este repositorio centraliza plugins especializados por tecnología bajo `plugins/<nombre-plugin>/`, con un manifiesto global `marketplace.json` en la raíz del proyecto.

---

## 1. Requisitos Globales

* **Visual Studio Code** con **GitHub Copilot Chat** (harness **Copilot**).
* **Node.js `>= 20.19.0`** (recomendado `22.x LTS` o `24.x LTS`; para proyectos con Angular 22 se requiere Node.js `>= 22.22.3`).
  * Verifica tu instalación local con:
    ```bash
    node -v
    ```
* **Repositorio Git con al menos un commit (para uso local):** VS Code valida la revisión Git de un marketplace local antes de instalar sus plugins. Asegúrate de tener el repositorio inicializado y con cambios commiteados (`git init && git add -A && git commit`).
* **Ejecución 100% local (sin servidores MCP ni dependencias externas):** Los scripts incluidos en las skills están escritos en **JavaScript ESM puro (`.mjs`)** utilizando únicamente módulos nativos de Node.js (`node:fs`, `node:path`). No requieren compilación ni `npm install`.

---

## 2. Estructura del Repositorio

```text
gacc-copilot-plugins/
├── marketplace.json                  # Catálogo global multi-plugin (raíz)
├── README.md                         # Guía de configuración global del marketplace
└── plugins/
    └── angular-frontend/             # Plugin para proyectos Angular (Karma → Vitest)
        ├── plugin.json
        ├── README.md
        ├── agents/                   # Incluye agent-scoped hook en karma-vitest-migrator
        └── skills/
```

---

## 3. Cómo Configurar los Plugins en VS Code (Copilot Harness)

### Opción A — Desde Copilot Chat con `/plugin` (Recomendado)

Con el harness **Copilot** activo en VS Code Copilot Chat, registra el marketplace e instala el plugin directamente:

```text
/plugin marketplace add /Users/gustavocaqui/Development/gacc/projects/plugins/gacc-copilot-plugins
/plugin marketplace list
/plugin marketplace browse gacc-copilot-plugins
/plugin install angular-frontend@gacc-copilot-plugins
```

> Si publicas el repositorio en GitHub (por ejemplo `gacc-org/gacc-copilot-plugins`), reemplaza la ruta local por `gacc-org/gacc-copilot-plugins`.

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
| **`angular-frontend`** | `./plugins/angular-frontend` | `1.1.0` | Diagnóstico visual/estructurado (`.json`, `.md`, `.html`), planificación ejecutable y migración determinista de Karma a Vitest (Angular 21+). | [Ver README](./plugins/angular-frontend/README.md) |

---

## 5. Cómo Añadir un Nuevo Plugin al Repositorio

1. Crea una nueva carpeta bajo `plugins/<tecnologia>-<rol>/` (por ejemplo, `plugins/nestjs-backend/` o `plugins/java-backend/`).
2. Añade su manifiesto `plugin.json`, su `README.md` y sus carpetas portables (`agents/`, `skills/`, `hooks.json`).
3. Registra la nueva entrada dentro del arreglo `plugins` en `marketplace.json` con su ruta relativa en `source`.
4. Haz commit de los cambios en Git para que el marketplace refleje la nueva revisión.
