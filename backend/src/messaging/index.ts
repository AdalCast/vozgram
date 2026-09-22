import type { Contact, MessagingProvider, EstadoMensajero, Pendiente } from './port'
import { telegram } from './telegram'
import { whatsapp } from './whatsapp'

export type { Contact, Msg, MessagingProvider, EstadoMensajero, Pendiente } from './port'

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
export async function listarTodo(limitPorMensajero = 20, q?: string): Promise<Contact[]> {
  const proveedores = activos()

  const resultados = await Promise.allSettled(
    proveedores.map(p => p.listContacts(limitPorMensajero, q)),
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

/**
 * La bandeja: lo sin leer de TODOS los mensajeros, mezclado por hora.
 *
 * Mezclar es el punto. Dos bandejas separadas obligan a revisar las dos para
 * saber si alguien espera respuesta, y entonces no ahorran nada frente a
 * entrar a cada app.
 *
 * allSettled igual que en la lista de chats: si un mensajero esta caido, la
 * bandeja sigue mostrando el otro en vez de quedarse vacia.
 */
export async function bandeja(limite = 10): Promise<Pendiente[]> {
  const proveedores = activos().filter(p => typeof p.noLeidos === 'function')

  const resultados = await Promise.allSettled(
    proveedores.map(p => p.noLeidos!(limite)),
  )

  const juntos: Pendiente[] = []
  resultados.forEach((r, i) => {
    const p = proveedores[i]!
    if (r.status === 'rejected') {
      console.warn(`[bandeja] ${p.id} no respondio: ${String(r.reason).slice(0, 120)}`)
      return
    }
    // El peer viaja PREFIJADO, igual que en la lista de chats: al elegir un
    // mensaje se entra a su conversacion sin traducir nada.
    for (const x of r.value) juntos.push({ ...x, peer: `${p.id}${SEP}${x.peer}` })
  })

  return juntos.sort((a, b) => b.ts - a.ts).slice(0, limite)
}

/** Marca leido un chat, enrutando al mensajero que le toque. */
export async function marcarLeido(peerCrudo: string): Promise<void> {
  const { proveedor, peer } = resolver(peerCrudo)
  if (!proveedor.marcarLeido) return
  await proveedor.marcarLeido(peer)
}

/**
 * Mensajeros disponibles, para armar el menu de apps en los lentes.
 *
 * Viaja tambien el estado: sin el, los lentes ofrecen entrar a un mensajero
 * muerto y lo unico que recibe el usuario es un error sin explicacion. El
 * servidor YA sabe que esta roto; esto es solamente contarlo.
 *
 * `estado` es un campo NUEVO: los .ehpk ya instalados lo ignoran y siguen
 * funcionando igual. Agregar no rompe; quitar o renombrar si.
 */
export function mensajeros(): { id: string; label: string; estado: EstadoMensajero }[] {
  return activos().map(p => ({
    id: p.id,
    label: p.label,
    // Quien no reporta estado se asume listo. No sabemos que este mal, y
    // adivinar que lo esta seria peor que callarse.
    estado: p.estado?.() ?? 'listo',
  }))
}

/**
 * Chats de UN solo mensajero, con los ids igual de prefijados que en la lista
 * mezclada: asi el peer que vuelve se enruta igual, sin casos especiales.
 */
export async function listarDe(id: string, limit = 20, q?: string): Promise<Contact[]> {
  const p = registro[id]
  if (!p) {
    throw new Error(
      `mensajero desconocido: "${id}". Disponibles: ${Object.keys(registro).join(', ')}`,
    )
  }
  const chats = await p.listContacts(limit, q)
  // Sin marca TG/WA: dentro de una lista de un solo mensajero seria ruido.
  return chats.map(c => ({ ...c, id: `${p.id}${SEP}${c.id}` }))
}
