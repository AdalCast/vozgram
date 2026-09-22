/**
 * GramJS usa `util.inspect.custom` para imprimir bonito sus objetos. En el
 * navegador `util` no existe y el empaquetador lo deja en `undefined`: leer
 * `.custom` de ahi revienta al cargar. Con el simbolo alcanza; nadie invoca
 * esto en el camino de red.
 */
export const inspect = Object.assign((x: unknown) => String(x), {
  custom: Symbol.for('nodejs.util.inspect.custom'),
})
export const promisify =
  (f: Function) =>
  (...a: unknown[]) =>
    new Promise((res, rej) => f(...a, (e: unknown, v: unknown) => (e ? rej(e) : res(v))))
export default { inspect, promisify }
