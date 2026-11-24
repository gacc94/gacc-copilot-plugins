# Catálogo de Reglas y Equivalencias: Jasmine / Karma → Vitest en Angular 21+

Referencia oficial principal: [Angular — Migrating from Karma to Vitest](https://angular.dev/guide/testing/migrating-to-vitest) y [Vitest — Mock Functions (`mockClear` / `mockReset` / `mockRestore`)](https://vitest.dev/api/mock.html).

> **Principio fundamental del migrador:** **Equivalencia sintáctica no siempre significa equivalencia de comportamiento.** No apliques reemplazos ciegos por regex sobre tipos, firmas ni semántica de spies; apoya las transformaciones de tipos y referencias en análisis AST / TypeScript Compiler API (o verificación de tipos con `tsc` / `ng build` + ejecución real de pruebas).

---

## 1. Taxonomía de Transformaciones y Resultados

### A. Cuatro categorías de transformación

| Categoría | Ejemplos | Estrategia requerida |
| :--- | :--- | :--- |
| **AST Transformation** | `spyOn`, `jasmine.createSpy`, `jasmine.any`, `toBeTrue`/`toBeFalse`, `fit`/`fdescribe` | Automática sobre AST (evitando reemplazos textuales frágiles) |
| **Type Transformation** | `jasmine.Spy`, `jasmine.SpyObj<T>` → `Mock`, `Mocked<T>` | AST + TypeScript Type Checker (resolución de imports, genéricos y firmas) |
| **Semantic Transformation** | `.and.returnValues`, `.and.callFake`, `spy.calls.reset()`, `fakeAsync`/`tick`, `jasmine.clock()`, `done` | Análisis de comportamiento y verificación en ejecución |
| **Configuration Migration** | `angular.json`, `tsconfig.spec*.json`, `package.json`, `karma.conf.js`, `src/test.ts` | Validación estructural previa antes de modificar o eliminar archivos |

### B. Clasificación obligatoria de resultado (`migrationOutcome`)

| Resultado | Significado | Acción del Migrator / Revisor |
| :--- | :--- | :--- |
| **`automatically_migrated`** | Transformación segura con equivalencia directa y determinista. | Aplicar y validar con `test-vitest` + `ng build`. |
| **`requires_review`** | Transformación con posibles diferencias semánticas o de tipado (ej. `Mocked<T>`, `and.returnValues`, `callFake`, `fakeAsync`/`tick`). | Aplicar con criterio técnico y señalar explícitamente en el resumen de fase para revisión humana. |
| **`manual_migration`** | Patrón sin equivalencia directa o que requiere rediseño (ej. `jasmine.isSpy()`, `jasmine.addMatchers()`, plugins/proxies custom en `karma.conf.js`). | Documentar explícitamente y requerir intervención/validación manual del especialista. |

---

## 2. Tipos de Spies y Mocks (Type Transformation)

| Jasmine | Vitest | Categoría / Resultado | Observación |
| :--- | :--- | :--- | :--- |
| `jasmine.Spy` | `Mock` *(importado de `'vitest'`)* | `Type Transformation` (`requires_review`) | Tipo de mock de una función individual. |
| `jasmine.SpyObj<T>` | `Mocked<T>` *(importado de `'vitest'`)* | `Type Transformation` (`requires_review`) | Equivalencia de tipo más cercana y natural. Nota: existe `MockedObject<T>`, pero **no** debe asumirse como sustitución textual universal de `SpyObj<T>`. |
| `jasmine.createSpyObj<T>(...)` | Objeto literal con métodos `vi.fn()` | `Type Transformation` (`requires_review`) | Requiere construir explícitamente los métodos (y propiedades si existía el 3.er argumento). |
| `jasmine.createSpy('fn')` | `vi.fn()` | `AST Transformation` (`automatically_migrated`) | Mock de función simple. |
| `jasmine.isSpy(x)` | *Sin equivalente directo* | `Semantic Transformation` (`manual_migration`) | Requiere inspección o estrategia propia (no sustituir a ciegas sin validar semántica; evaluar `vi.isMockFunction(x)` solo tras revisar el uso). |

### Ejemplo de migración de `jasmine.SpyObj<T>` → `Mocked<T>`

```ts
// Jasmine
const service: jasmine.SpyObj<UserService> = jasmine.createSpyObj('UserService', ['getUser']);

// Vitest
import { vi, type Mocked } from 'vitest';
const service: Mocked<UserService> = {
  getUser: vi.fn(),
};
```

---

## 3. Spies, Comportamiento y Limpieza de Estado

| Patrón en Jasmine | Equivalente en Vitest | Categoría / Resultado | Nota técnica |
| :--- | :--- | :--- | :--- |
| `spyOn(service, 'get').and.callThrough()` | `vi.spyOn(service, 'get')` | `AST Transformation` (`automatically_migrated`) | `vi.spyOn(...)` conserva la implementación original por defecto. |
| `spyOn(service, 'get').and.returnValue(v)` | `vi.spyOn(service, 'get').mockReturnValue(v)` | `AST Transformation` (`automatically_migrated`) | Equivalencia directa. |
| `spyOn(service, 'get').and.returnValues(a, b)` | `vi.spyOn(service, 'get').mockReturnValueOnce(a).mockReturnValueOnce(b)` | `Semantic Transformation` (`requires_review`) | Verificar qué debe devolver en llamadas posteriores a la última (`undefined` vs. valor previo). |
| `spyOn(service, 'get').and.callFake(fn)` | `vi.spyOn(service, 'get').mockImplementation(fn)` | `Semantic Transformation` (`requires_review`) | Revisar contexto `this` y ciclo de vida entre tests. |
| `spyOn(service, 'get').and.throwError('err')` | `vi.spyOn(service, 'get').mockImplementation(() => { throw new Error('err'); })` | `Semantic Transformation` (`requires_review`) | Validar tipo de error esperado si el argumento no es string. |
| `spyOn(service, 'get').and.resolveTo(val)` | `vi.spyOn(service, 'get').mockResolvedValue(val)` | `AST Transformation` (`automatically_migrated`) | Equivalencia directa para promesas resueltas. |
| `spyOn(service, 'get').and.rejectWith(err)` | `vi.spyOn(service, 'get').mockRejectedValue(err)` | `AST Transformation` (`automatically_migrated`) | Equivalencia directa para promesas rechazadas. |
| `spyOnProperty(obj, 'prop', 'get').and.returnValue(v)` | `vi.spyOn(obj, 'prop', 'get').mockReturnValue(v)` | `Semantic Transformation` (`requires_review`) | Verificar configurabilidad de la propiedad y restauración en `afterEach`. |
| `spy.calls.count()` | `spy.mock.calls.length` | `AST Transformation` (`automatically_migrated`) | Conteo exacto de invocaciones. |
| `spy.calls.mostRecent().args` | `spy.mock.lastCall` | `AST Transformation` (`automatically_migrated`) | Devuelve el arreglo de argumentos de la última llamada (o `undefined` si no hubo llamadas). |
| **`spy.calls.reset()`** | **`spy.mockClear()`** *(NO `mockReset()` ni `mockRestore()`)* | `Semantic Transformation` (`requires_review`) | **Crítico:** ver distinción abajo; no son intercambiables. |

### Distinción crítica: `mockClear()` vs. `mockReset()` vs. `mockRestore()`

* **`spy.mockClear()`** *(equivalente a `spy.calls.reset()`)*: Limpia únicamente el historial de llamadas (`mock.calls`, `mock.results`, etc.), **conservando** la implementación personalizada o valores de retorno configurados.
* **`spy.mockReset()`**: Limpia el historial **y además elimina** la implementación personalizada y los valores de retorno del mock (vuelve a devolver `undefined`).
* **`spy.mockRestore()`**: Hace todo lo de `mockReset()` **y además restaura la implementación original** del método espiado con `vi.spyOn()`.

---

## 4. Matchers y Asymmetrical Matchers

| Patrón en Jasmine | Equivalente en Vitest | Categoría / Resultado |
| :--- | :--- | :--- |
| `expect(x).toBeTrue()` | `expect(x).toBe(true)` | `AST Transformation` (`automatically_migrated`) |
| `expect(x).toBeFalse()` | `expect(x).toBe(false)` | `AST Transformation` (`automatically_migrated`) |
| `expect(x).toBePositive()` / `toBeNegative()` | `expect(x).toBeGreaterThan(0)` / `expect(x).toBeLessThan(0)` | `AST Transformation` (`automatically_migrated`) |
| `jasmine.any(MyClass)` | `expect.any(MyClass)` | `AST Transformation` (`automatically_migrated`) |
| `jasmine.anything()` | `expect.anything()` | `AST Transformation` (`automatically_migrated`) |
| `jasmine.objectContaining({ a: 1 })` | `expect.objectContaining({ a: 1 })` | `AST Transformation` (`automatically_migrated`) |
| `jasmine.arrayContaining([1, 2])` | `expect.arrayContaining([1, 2])` | `AST Transformation` (`automatically_migrated`) |
| `jasmine.stringMatching(/abc/)` | `expect.stringMatching(/abc/)` | `AST Transformation` (`automatically_migrated`) |

---

## 5. Timers y Asincronía

| Patrón en Jasmine | Equivalente en Vitest | Categoría / Resultado |
| :--- | :--- | :--- |
| `jasmine.clock().install()` | `vi.useFakeTimers()` | `Semantic Transformation` (`manual_migration` / `requires_review`) |
| `jasmine.clock().tick(500)` | `vi.advanceTimersByTime(500)` | `Semantic Transformation` (`requires_review`) |
| `jasmine.clock().uninstall()` | `vi.useRealTimers()` | `Semantic Transformation` (`requires_review`) |
| `it('async', (done) => { ... done(); })` | `it('async', async () => { ... })` o `new Promise<void>((resolve) => ...)` | `Semantic Transformation` (`manual_migration`) |

---

## 6. Configuración Angular (`@angular/build:unit-test`) y Advertencias Oficiales

### Advertencias oficiales de Angular
* **Sistema de construcción `application` requerido:** La migración oficial desde Karma a Vitest requiere utilizar el sistema de construcción **`application`** (`@angular/build:application` / `@angular-devkit/build-angular:application`). Si el proyecto aún usa el builder clásico `browser`, debe migrarse primero al sistema `application`.
* **Schematic `refactor-jasmine-vitest` (experimental):** Angular provee `ng g @schematics/angular:refactor-jasmine-vitest`, pero advierte explícitamente que la migración desde Karma sigue en evolución y el schematic **no cubre todos los escenarios complejos** de spies, tipos y mocks.

### Configuración mínima vs. convivencia incremental
1. **`angular.json`:**
   * **Configuración mínima oficial (ideal para el cutover final en `"test"`):**
     ```json
     {
       "test": {
         "builder": "@angular/build:unit-test"
       }
     }
     ```
     El builder aplica valores predeterminados para `tsConfig`, `buildTarget` y `runner` (`"vitest"` es el runner por defecto, por lo que `runner: "vitest"` puede omitirse).
   * **Durante la convivencia paralela (target `"test-vitest"`):** Sí se declaran explícitamente `tsConfig` (`tsconfig.spec.vitest.json`) e `include` para aislar cada lote migrado sin afectar `"test"` (Karma).
2. **Entorno DOM (`package.json`):**
   * Angular admite tanto **`happy-dom`** como **`jsdom`** en `devDependencies` (Angular CLI prefiere automáticamente `happy-dom` si está instalado, y usa `jsdom` como alternativa).
3. **Tipos de Vitest (`tsconfig.spec*.json`):**
   * `"types": ["vitest/globals"]` aplica cuando el proyecto utiliza los globals implícitos de Vitest (`describe`, `it`, `expect`, `vi`). **No es obligatorio** si los archivos `*.spec.ts` importan explícitamente esas APIs desde `'vitest'`.
4. **Limpieza segura (solo en fase `cutover-cleanup`):**
   * **Antes de eliminar `karma.conf.js`:** Inspeccionar obligatoriamente proxies, plugins, `customLaunchers`, `preprocessors` o variables globales personalizadas y migrar lo necesario.
   * **Antes de eliminar `src/test.ts`:** Comprobar que no contenga inicializaciones globales necesarias (mocks globales de `window`, polyfills, setup de `TestBed` personalizado o helpers compartidos).
   * **Dependencias heredadas:** Desinstalar `karma*`, `jasmine*` y `@types/jasmine` únicamente cuando el 100% de los lotes hayan pasado a Vitest.
