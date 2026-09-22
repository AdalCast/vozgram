import { TelegramClient } from 'telegram'
import { StringSession } from 'telegram/sessions'
import type { Contact, Msg, MessagingProvider, Pendiente } from './port'
import { normalizar, soloLegible } from './texto'

/** Nombre para mostrar de una entidad de Telegram (persona, grupo o canal). */
function nombreDe(e: unknown): string {
  const x = e as { firstName?: string; lastName?: string; title?: string; username?: string } | undefined
  if (!x) return ''
  if (x.title) return x.title
  const n = [x.firstName, x.lastName].filter(Boolean).join(' ').trim()
  return n || x.username || ''
}

let client: TelegramClient | null = null

/** Cliente unico y reutilizado. Conectar es caro; no lo hagas por request. */
async function getClient(): Promise<TelegramClient> {
  if (client?.connected) return client

  const apiId = Number(process.env.TG_API_ID)
  const apiHash = process.env.TG_API_HASH ?? ''
  const session = process.env.TG_SESSION ?? ''

  if (!apiId || !apiHash) throw new Error('faltan TG_API_ID / TG_API_HASH')
  if (!session) throw new Error('falta TG_SESSION: corre `npm run login`')

  client = new TelegramClient(new StringSession(session), apiId, apiHash, {
    connectionRetries: 5,
  })
  await client.connect()
  return client
}

/** Adaptador de Telegram: habla MTProto por debajo y cumple el contrato por arriba. */
export const telegram: MessagingProvider = {
  id: 'telegram',
  label: 'Telegram',

  async listContacts(limit = 20, q?: string): Promise<Contact[]> {
    const c = await getClient()
    // Al buscar hay que mirar mas alla de los recientes: el sentido de buscar
    // es justamente llegar a quien NO esta arriba de la lista.
    const dialogs = await c.getDialogs({ limit: q ? 200 : limit })
    let salida = dialogs
      .filter(d => d.isUser || d.isGroup)
      .map(d => ({
        id: String(d.id),
        // Mismo filtro que en WhatsApp: un titulo con emoji deja cajitas, y
        // uno que es solo emoji deja el renglon mudo.
        name: soloLegible(d.title ?? '') || 'sin nombre',
        updatedAt: d.date,
        kind: d.isGroup ? ('grupo' as const) : ('persona' as const),
      }))
    if (q) {
      const aguja = normalizar(q)
      salida = salida.filter(x => normalizar(x.name).includes(aguja)).slice(0, limit)
    }
    return salida
  },

  /**
   * GramJS los devuelve del mas nuevo al mas viejo, por eso el reverse:
   * el contrato pide orden cronologico.
   */
  async getHistory(peer: string, limit = 10): Promise<Msg[]> {
    const c = await getClient()
    const msgs = await c.getMessages(peer, { limit })
    // En un chat de a dos, `out` ya dice todo y el nombre seria ruido. En un
    // grupo, sin el nombre no se sabe quien hablo.
    const esGrupo = msgs.some(m => {
      const cn = (m.peerId as { className?: string } | undefined)?.className
      return cn === 'PeerChat' || cn === 'PeerChannel'
    })
    return msgs
      .filter(m => typeof m.message === 'string' && m.message.length > 0)
      .map(m => {
        const base = { out: Boolean(m.out), text: String(m.message) }
        if (!esGrupo || m.out) return base
        const quien = nombreDe(m.sender)
        return quien ? { ...base, sender: quien } : base
      })
      .reverse()
  },

  /**
   * Al reves que WhatsApp: aqui SE PREGUNTA. Los dialogos ya traen el contador,
   * y de los que tienen pendientes se pide el ultimo mensaje.
   *
   * Se acota a los chats mas recientes con pendientes porque cada uno es una
   * ida y vuelta a la red: veinte chats serian veinte llamadas, y la bandeja
   * tiene que abrirse rapido o no sirve caminando.
   */
  async noLeidos(limite = 10): Promise<Pendiente[]> {
    const c = await getClient()
    const conPendientes = (await c.getDialogs({ limit: 100 }))
      .filter(d => (d.isUser || d.isGroup) && d.unreadCount > 0)
      .slice(0, limite)

    const salida: Pendiente[] = []
    for (const d of conPendientes) {
      const msgs = await c.getMessages(d.id!, { limit: 1 }).catch(() => [])
      const m = msgs[0]
      if (!m?.message) continue
      salida.push({
        peer: String(d.id),
        quien: soloLegible(d.title ?? '') || 'sin nombre',
        text: soloLegible(m.message),
        ts: m.date,
        kind: d.isGroup ? 'grupo' : 'persona',
      })
    }
    return salida
  },

  async marcarLeido(peer: string): Promise<void> {
    const c = await getClient()
    await c.markAsRead(peer)
  },

  async sendMessage(peer: string, text: string): Promise<void> {
    const c = await getClient()
    await c.sendMessage(peer, { message: text })
  },
}
