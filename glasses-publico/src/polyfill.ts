/**
 * GramJS asume `Buffer`, `process` y `global` (herencia de Node). Tienen que
 * existir ANTES de que se evalue cualquier modulo suyo, por eso este archivo
 * se importa en la PRIMERA linea del entrypoint y no en ninguna otra parte.
 *
 * Sin esto el sintoma es `ReferenceError: Can't find variable: Buffer`, y en
 * los lentes no hay consola para verlo: la pantalla simplemente no avanza.
 */
import { Buffer } from 'buffer'

const g = globalThis as Record<string, unknown>
g.Buffer = g.Buffer ?? Buffer
g.global = globalThis
g.process = g.process ?? { env: {}, version: '', nextTick: (f: () => void) => setTimeout(f, 0) }

export {}
