import type { Contact, MessagingProvider } from './port'
import { telegram } from './telegram'
import { whatsapp } from './whatsapp'

export type { Contact, Msg, MessagingProvider } from './port'

/** Todos los mensajeros disponibles, indexados por su id. */
const registro: Record<string, MessagingProvider> = {
  [telegram.id]: telegram,
  [whatsapp.id]: whatsapp,
}

/**
 * Marca corta para distinguir el origen en la lista de los lentes. Es una
 * decision de PRESENTACION y vive aca, en el agregador, porque es el agregador
 * el que crea la ambiguedad al mezclar dos fuentes. Los adaptadores no saben
 * ni les importa que existan otros.
 */
const MARCA: Record<string, string> = { telegram: 'TG', whatsapp: 'WA' }

const SEP = ':'

/**
 * Mensajeros activos. Por defecto TODOS los registrados: si alguno no esta
 * configurado (WhatsApp sin vincular, por ejemplo) simplemente falla y se lo
 * omite, sin tumbar a los demas. MESSAGING_PROVIDERS permite acotarlos.
 */
export function activos(): MessagingProvider[] {
  const crudo = process.env.MESSAGING_PROVIDERS ?? process.env.MESSAGING_PROVIDER
  if (!crudo) return Object.values(registro)
  return crudo
    .split(',')
    .map(s => s.trim())
    .filter(Boolean)
    .map(id => {
      const p = registro[id]
      if (!p) {
        throw new Error(
          `mensajero desconocido: "${id}". Disponibles: ${Object.keys(registro).join(', ')}`,
        )
      }
      return p
    })
}

/**
 * Traduce un peer de la API al mensajero que le corresponde.
 *
 * Formato nuevo: "whatsapp:5215512345678@s.whatsapp.net"
 * Formato viejo: "12345"  -> Telegram
 *
 * La compatibilidad hacia atras NO es opcional: el .ehpk instalado en los
 * lentes manda ids sin prefijo, y cambiar el formato de golpe romperia la app
 * que el usuario tiene funcionando hoy.
 */
export function resolver(peer: string): { proveedor: MessagingProvider; peer: string } {
  const i = peer.indexOf(SEP)
  if (i > 0) {
    const p = registro[peer.slice(0, i)]
    if (p) return { proveedor: p, peer: peer.slice(i + 1) }
  }
  return { proveedor: telegram, peer }
}

/**
 * Chats de TODOS los mensajeros activos, en una sola lista ordenada por
 * actividad. Cada id viaja prefijado para que resolver() sepa despues a quien
 * mandarle el mensaje.
 *
 * Usa allSettled a proposito: si WhatsApp esta caido, la lista debe seguir
 * mostrando Telegram. Un mensajero roto no puede dejar al usuario sin app.
 */
export async function listarTodo(limitPorMensajero = 20): Promise<Contact[]> {
  const proveedores = activos()

  const resultados = await Promise.allSettled(
    proveedores.map(p => p.listContacts(limitPorMensajero)),
  )

  const aportaron: MessagingProvider[] = []
  const juntos: Contact[] = []

  resultados.forEach((r, i) => {
    const p = proveedores[i]!
    if (r.status === 'rejected') {
      console.warn(`[mensajeria] ${p.id} no respondio: ${String(r.reason).slice(0, 120)}`)
      return
    }
    if (r.value.length > 0) aportaron.push(p)
    for (const c of r.value) {
      juntos.push({ ...c, id: `${p.id}${SEP}${c.id}` })
    }
  })

  // La marca solo tiene sentido si hay mas de una fuente. Con un solo
  // mensajero seria ruido: 3 caracteres desperdiciados en una pantalla chica.
  if (aportaron.length > 1) {
    for (const c of juntos) {
      const marca = MARCA[c.id.slice(0, c.id.indexOf(SEP))]
      if (marca) c.name = `${marca} ${c.name}`
    }
  }

  return juntos.sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0))
}
