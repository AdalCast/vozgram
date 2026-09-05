import type { MessagingProvider } from './port'
import { telegram } from './telegram'
import { whatsapp } from './whatsapp'

export type { Contact, Msg, MessagingProvider } from './port'

/** Todos los mensajeros disponibles, indexados por su id. */
const registro: Record<string, MessagingProvider> = {
  [telegram.id]: telegram,
  [whatsapp.id]: whatsapp,
}

/**
 * Devuelve el mensajero activo, segun MESSAGING_PROVIDER. Agregar otro es
 * escribir un archivo que cumpla el contrato y sumarlo al registro de arriba:
 * server.ts no se toca.
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
