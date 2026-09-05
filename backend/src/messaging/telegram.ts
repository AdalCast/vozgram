import { TelegramClient } from 'telegram'
import { StringSession } from 'telegram/sessions'
import type { Contact, Msg, MessagingProvider } from './port'

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

  async listContacts(limit = 20): Promise<Contact[]> {
    const c = await getClient()
    const dialogs = await c.getDialogs({ limit })
    return dialogs
      .filter(d => d.isUser || d.isGroup)
      .map(d => ({ id: String(d.id), name: d.title ?? 'sin nombre', updatedAt: d.date }))
  },

  /**
   * GramJS los devuelve del mas nuevo al mas viejo, por eso el reverse:
   * el contrato pide orden cronologico.
   */
  async getHistory(peer: string, limit = 10): Promise<Msg[]> {
    const c = await getClient()
    const msgs = await c.getMessages(peer, { limit })
    return msgs
      .filter(m => typeof m.message === 'string' && m.message.length > 0)
      .map(m => ({ out: Boolean(m.out), text: String(m.message) }))
      .reverse()
  },

  async sendMessage(peer: string, text: string): Promise<void> {
    const c = await getClient()
    await c.sendMessage(peer, { message: text })
  },
}
