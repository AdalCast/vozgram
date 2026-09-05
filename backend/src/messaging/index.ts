import type { MessagingProvider } from './port'
import { telegram } from './telegram'

export type { Contact, Msg, MessagingProvider } from './port'

/** Todos los mensajeros disponibles, indexados por su id. */
const registro: Record<string, MessagingProvider> = {
  [telegram.id]: telegram,
}

/**
 * Devuelve el mensajero activo. Hoy siempre es Telegram; el dia que exista
 * otro adaptador basta con registrarlo arriba y cambiar la variable.
 */
export function proveedor(): MessagingProvider {
  const id = process.env.MESSAGING_PROVIDER ?? 'telegram'
  const p = registro[id]
  if (!p) {
    throw new Error(
      `mensajero desconocido: "${id}". Disponibles: ${Object.keys(registro).join(', ')}`,
    )
  }
  return p
}
