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
        ├── hooks.json
        ├── README.md
        ├── agents/
        └── skills/
```

---

## 3. Cómo Configurar los Plugins en VS Code

### Opción A — Registrar el Marketplace completo (Recomendado para equipos)

Agrega la ruta local (con esquema `file:///`) o el repositorio de GitHub en tu `settings.json` de VS Code:

```json
{
  "chat.plugins.enabled": true,
  "chat.plugins.marketplaces": [
    "file:///Users/gustavocaqui/Development/gacc/projects/plugins/gacc-copilot-plugins"
  ]
}
```

> Si el repositorio está publicado en GitHub (por ejemplo `gacc-org/gacc-copilot-plugins`), puedes usar `"gacc-org/gacc-copilot-plugins"` en `"chat.plugins.marketplaces"`.

Una vez registrado el marketplace, puedes explorar e instalar sus plugins desde el editor (**`Chat: Open Customizations` → `Plugins`**) o desde la entrada de **Copilot Chat**:

```text
/plugin marketplace list
/plugin marketplace browse gacc-copilot-plugins
/plugin install angular-frontend@gacc-copilot-plugins
```

### Opción B — Cargar un plugin directamente en desarrollo local

Para probar cambios locales sobre un plugin sin reinstalarlo desde el catálogo, usa `"chat.pluginLocations"` en `settings.json`:

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
| **`angular-frontend`** | `./plugins/angular-frontend` | `1.0.0` | Diagnóstico, planificación ejecutable y migración determinista de Jasmine/Karma a Vitest (Angular 21+). | [Ver README](./plugins/angular-frontend/README.md) |

---

## 5. Cómo Añadir un Nuevo Plugin al Repositorio

1. Crea una nueva carpeta bajo `plugins/<tecnologia>-<rol>/` (por ejemplo, `plugins/nestjs-backend/` o `plugins/java-backend/`).
2. Añade su manifiesto `plugin.json`, su `README.md` y sus carpetas portables (`agents/`, `skills/`, `hooks.json`).
3. Registra la nueva entrada dentro del arreglo `plugins` en `marketplace.json` con su ruta relativa en `source`.
