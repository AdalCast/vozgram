/**
 * GramJS arma con esto el `systemVersion` que le reporta a Telegram. OJO: ese
 * valor es el que el usuario ve en "Dispositivos activos" de su Telegram, asi
 * que tiene que decir algo reconocible. Un Linux inventado ahi solo confunde a
 * quien revisa sus sesiones abiertas.
 */
export const type = () => 'EvenG2'
export const release = () => '1.0'
export const platform = () => 'browser'
export const arch = () => 'wasm'
export default { type, release, platform, arch }
