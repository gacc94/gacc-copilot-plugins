# Guía de Equivalencias: Jasmine / Karma → Vitest en Angular 21+

Referencia oficial: [Angular Docs — Migrating from Karma to Vitest](https://angular.dev/guide/testing/migrating-to-vitest)

---

## 1. Spies y Mocks

| Patrón en Jasmine | Equivalente en Vitest |
| :--- | :--- |
| `jasmine.createSpy('fn')` | `vi.fn()` |
| `jasmine.createSpyObj('Svc', ['get', 'save'])` | `{ get: vi.fn(), save: vi.fn() }` |
| `jasmine.createSpyObj('Svc', ['get'], { prop: 1 })` | `{ get: vi.fn(), prop: 1 }` |
| `spyOn(service, 'get').and.returnValue(of(data))` | `vi.spyOn(service, 'get').mockReturnValue(of(data))` |
| `spyOn(service, 'get').and.returnValues(a, b)` | `vi.spyOn(service, 'get').mockReturnValueOnce(a).mockReturnValueOnce(b)` |
| `spyOn(service, 'get').and.callFake(fn)` | `vi.spyOn(service, 'get').mockImplementation(fn)` |
| `spyOn(service, 'get').and.callThrough()` | `vi.spyOn(service, 'get')` *(en Vitest llama a la implementación original por defecto)* |
| `spyOn(service, 'get').and.throwError('err')` | `vi.spyOn(service, 'get').mockImplementation(() => { throw new Error('err'); })` |
| `spyOn(service, 'get').and.resolveTo(val)` | `vi.spyOn(service, 'get').mockResolvedValue(val)` |
| `spyOn(service, 'get').and.rejectWith(err)` | `vi.spyOn(service, 'get').mockRejectedValue(err)` |
| `spyOnProperty(obj, 'prop', 'get').and.returnValue(v)` | `vi.spyOn(obj, 'prop', 'get').mockReturnValue(v)` |
| `spy.calls.count()` | `spy.mock.calls.length` |
| `spy.calls.mostRecent().args` | `spy.mock.lastCall` |
| `spy.calls.reset()` | `spy.mockClear()` o `spy.mockReset()` |

---

## 2. Matchers y Asymmetrical Matchers

| Patrón en Jasmine | Equivalente en Vitest |
| :--- | :--- |
| `expect(x).toBeTrue()` | `expect(x).toBe(true)` |
| `expect(x).toBeFalse()` | `expect(x).toBe(false)` |
| `expect(x).toBePositive()` / `toBeNegative()` | `expect(x).toBeGreaterThan(0)` / `expect(x).toBeLessThan(0)` |
| `jasmine.any( MyClass )` | `expect.any(MyClass)` |
| `jasmine.anything()` | `expect.anything()` |
| `jasmine.objectContaining({ a: 1 })` | `expect.objectContaining({ a: 1 })` |
| `jasmine.arrayContaining([1, 2])` | `expect.arrayContaining([1, 2])` |
| `jasmine.stringMatching(/abc/)` | `expect.stringMatching(/abc/)` |

---

## 3. Timers y Asincronía

| Patrón en Jasmine | Equivalente en Vitest |
| :--- | :--- |
| `jasmine.clock().install()` | `vi.useFakeTimers()` |
| `jasmine.clock().tick(500)` | `vi.advanceTimersByTime(500)` |
| `jasmine.clock().uninstall()` | `vi.useRealTimers()` |
| `it('async', (done) => { ... done(); })` | `it('async', async () => { ... })` o `new Promise<void>((resolve) => ...)` |

---

## 4. Configuración de Archivos del Proyecto

1. **`angular.json`**:
   * Reemplazar `"builder": "@angular-devkit/build-angular:karma"` por `"builder": "@angular/build:unit-test"`.
   * Configurar `"options": { "tsConfig": "tsconfig.spec.json", "runner": "vitest", "buildTarget": "<project>:development" }`.
2. **`tsconfig.spec.json`**:
   * En `"compilerOptions.types"`, reemplazar `"jasmine"` por `["vitest/globals"]`.
3. **`package.json`**:
   * Añadir en `devDependencies`: `"vitest"`, `"jsdom"`.
   * Eliminar: `"karma"`, `"karma-chrome-launcher"`, `"karma-coverage"`, `"karma-jasmine"`, `"karma-jasmine-html-reporter"`, `"jasmine-core"`, `"@types/jasmine"`.
4. **Archivos obsoletos**:
   * Eliminar `karma.conf.js` y `src/test.ts` (si no contiene inicialización global personalizada).
