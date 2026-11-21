# Matriz Oficial de Compatibilidad: Angular, Vitest y Node.js

Referencias oficiales verificadas:
* [Angular Docs — Testing Overview](https://angular.dev/guide/testing)
* [Angular Docs — Migrating from Karma to Vitest](https://angular.dev/guide/testing/migrating-to-vitest)
* [Angular v20 Docs — Unit Tests](https://v20.angular.dev/guide/testing/unit-tests)
* [Angular Docs — Version Compatibility](https://angular.dev/reference/versions)

---

## 1. Estado del Runner de Vitest (`@angular/build:unit-test`) por Versión de Angular

| Versión de Angular | Estado de Vitest en Angular CLI | Runner por defecto en `ng new` | Estatus de Elegibilidad | Acción requerida |
| :--- | :--- | :--- | :---: | :--- |
| **Angular 18.x / 19.x** | No disponible oficialmente | Karma + Jasmine (`@angular-devkit/build-angular:karma`) | `BLOCKED` | Actualizar primero el workspace a **Angular 21+** (`ng update`). |
| **Angular 20.x** | **Experimental** | Karma + Jasmine | `BLOCKED` | Actualizar a **Angular 21+** para contar con el target estable `@angular/build:unit-test`. |
| **Angular 21.x** | **Estable** | **Vitest** (`@angular/build:unit-test`) | `READY` | Proceder con el diagnóstico y plan de migración a Vitest. |
| **Angular 22.x+** | **Estable** | **Vitest** (`@angular/build:unit-test`) | `READY` | Proceder con el diagnóstico y plan de migración a Vitest. |

---

## 2. Requisitos Oficiales de Node.js, TypeScript y RxJS

| Versión de Angular | Node.js requerido | TypeScript requerido | RxJS requerido |
| :--- | :--- | :--- | :--- |
| **Angular 22.x** | `^22.22.3 \|\| ^24.15.0 \|\| ^26.0.0` | `>=6.0.0 <6.1.0` | `^6.5.3 \|\| ^7.4.0` |
| **Angular 21.x** | `^20.19.0 \|\| ^22.12.0 \|\| ^24.0.0` | `>=5.9.0 <6.0.0` | `^6.5.3 \|\| ^7.4.0` |
| **Angular 20.x** | `^20.19.0 \|\| ^22.12.0 \|\| ^24.0.0` | `>=5.8.0 <6.0.0` | `^6.5.3 \|\| ^7.4.0` |
| **Angular 19.x** | `^18.19.1 \|\| ^20.11.1 \|\| ^22.0.0` | `>=5.5.0 <5.9.0` | `^6.5.3 \|\| ^7.4.0` |
| **Angular 18.x** | `^18.19.1 \|\| ^20.11.1 \|\| ^22.0.0` | `>=5.4.0 <5.6.0` | `^6.5.3 \|\| ^7.4.0` |

---

## 3. Configuración Objetivo en `angular.json` (Angular 21+)

```json
"test": {
  "builder": "@angular/build:unit-test",
  "options": {
    "tsConfig": "tsconfig.spec.json",
    "runner": "vitest",
    "buildTarget": "<nombre-proyecto>:development"
  }
}
```
