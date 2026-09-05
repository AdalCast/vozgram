import { TelegramClient } from 'telegram'
import { StringSession } from 'telegram/sessions'
import type { Contact, Msg, MessagingProvider } from './port'
import { normalizar } from './texto'

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
      .map(d => ({ id: String(d.id), name: d.title ?? 'sin nombre', updatedAt: d.date }))
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

  async sendMessage(peer: string, text: string): Promise<void> {
    const c = await getClient()
    await c.sendMessage(peer, { message: text })
  },
}
