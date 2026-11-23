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
    └── angular-frontend/                     # Plugin Angular (Karma → Vitest, v2.0.2)
        ├── plugin.json                       # Manifiesto Agent Plugins 1.0 ($schema)
        ├── README.md
        ├── skills/                           # Skills portables (con sus scripts/ y references/)
        └── com.github.copilot/
            └── agents/                       # Custom agents específicos de Copilot (incluye hooks agent-scoped)
```

---

## 3. Instalación desde Repositorio Remoto (Recomendado)

Usa esta opción si quieres incorporar el marketplace e instalar plugins directamente desde GitHub **sin clonar el repositorio** (reemplaza `gacc94/gacc-copilot-plugins` por `<tu-org>/gacc-copilot-plugins` si alojas un fork u organización propia).

### A. Desde VS Code Copilot Chat (`/plugin`)

Con el harness **Copilot** activo en VS Code Copilot Chat:

```text
/plugin marketplace add gacc94/gacc-copilot-plugins
/plugin marketplace list
/plugin marketplace browse gacc-copilot-plugins
/plugin install angular-frontend@gacc-copilot-plugins
```

### B. Desde GitHub Copilot CLI

```bash
copilot plugin marketplace add gacc94/gacc-copilot-plugins
copilot plugin list --available
copilot plugin install angular-frontend@gacc-copilot-plugins
```

### C. Configuración declarativa en `~/.copilot/settings.json` (usuario) o `.github/copilot/settings.json` (proyecto)

Ideal para compartir el marketplace automáticamente con todo un equipo en un repositorio:

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

> **Nota sobre `settings.json` de VS Code:** Si agregas el marketplace en `"chat.plugins.marketplaces"` dentro del `settings.json` clásico de VS Code, el editor mostrará el aviso **Keep your customizations working** con el botón **Migrate...** para trasladarlo automáticamente a `~/.copilot/settings.json`.

---

## 4. Instalación desde Clon Local (Desarrollo o Uso Offline)

Usa esta opción si clonaste este repositorio en tu máquina (por ejemplo en `/Users/<usuario>/gacc-copilot-plugins` en macOS/Linux o `C:/Users/<usuario>/gacc-copilot-plugins` en Windows):

```bash
git clone https://github.com/gacc94/gacc-copilot-plugins.git
```

> **Requisito para marketplaces locales:** VS Code valida la revisión Git antes de instalar plugins desde un directorio local. Asegúrate de tener tus cambios locales commiteados (`git status` limpio / al menos un commit).

### A. Registrar el marketplace local con `/plugin` (VS Code) o `copilot plugin` (CLI)

En VS Code Copilot Chat:

```text
/plugin marketplace add /Users/<usuario>/gacc-copilot-plugins
/plugin marketplace list
/plugin marketplace browse gacc-copilot-plugins
/plugin install angular-frontend@gacc-copilot-plugins
```

O en GitHub Copilot CLI:

```bash
copilot plugin marketplace add /Users/<usuario>/gacc-copilot-plugins
copilot plugin install angular-frontend@gacc-copilot-plugins
```

### B. Configuración declarativa local en `~/.copilot/settings.json`

```json
{
  "extraKnownMarketplaces": {
    "gacc-copilot-plugins": {
      "source": {
        "source": "directory",
        "path": "/Users/<usuario>/gacc-copilot-plugins"
      }
    }
  },
  "enabledPlugins": {
    "angular-frontend@gacc-copilot-plugins": true
  }
}
```

### C. Carga directa de un plugin en desarrollo local (`settings.json` de VS Code)

Para iterar rápidamente sobre un plugin sin reinstalarlo desde el catálogo:

```json
{
  "chat.plugins.enabled": true,
  "chat.pluginLocations": {
    "/Users/<usuario>/gacc-copilot-plugins/plugins/angular-frontend": true
  }
}
```

---

## 5. Plugins Disponibles

| Plugin | Ruta (`source`) | Versión | Descripción | Documentación |
| :--- | :--- | :---: | :--- | :--- |
| **`angular-frontend`** | `./plugins/angular-frontend` | `2.0.2` | Diagnóstico visual/estructurado (`.json`, `.md`, `.html`), planificación ejecutable y migración determinista de Karma a Vitest (Angular 21+), en formato Agent Plugins 1.0 para VS Code y Copilot CLI. | [Ver README](./plugins/angular-frontend/README.md) |

---

## 6. Verificación Local y Diagnóstico

Ejecuta la suite completa de pruebas estructurales y de seguridad con el runner nativo de Node.js:

```bash
node --test tests/verify-artifacts-gate.test.mjs tests/plugin-structure.test.mjs
```

Para inspeccionar el descubrimiento y ejecución del plugin en VS Code (Copilot harness), usa **Agent Customizations** (`Chat: Open Customizations`) junto con los **registros de depuración del agente y diagnósticos del proveedor** (y valida por separado en **Copilot CLI** si distribuyes el catálogo para ambos entornos).

---

## 7. Cómo Añadir un Nuevo Plugin al Repositorio

1. Crea una nueva carpeta bajo `plugins/<tecnologia>-<rol>/` (por ejemplo, `plugins/nestjs-backend/` o `plugins/java-backend/`).
2. Añade su manifiesto `plugin.json` siguiendo **Agent Plugins 1.0** (`"$schema": "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json"`), su `README.md`, sus skills portables en `skills/` y sus componentes específicos de Copilot en `com.github.copilot/agents/`.
3. Registra la nueva entrada dentro del arreglo `plugins` en `.github/plugin/marketplace.json` con su ruta relativa en `source` y la misma versión que `plugin.json`.
4. Ejecuta `node --test tests/*.test.mjs` y haz commit de los cambios en Git para que el marketplace refleje la nueva revisión.
