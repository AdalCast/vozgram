import { mkdirSync } from 'node:fs'
// SOLO TIPOS: se borran al compilar, no cargan nada en tiempo de ejecucion.
import type { WASocket, WAMessage, Chat } from 'baileys'
import type { Contact, Msg, MessagingProvider } from './port'
import type { ChatGuardado, MsgGuardado, ContactoGuardado } from './store'
import {
  guardarChats, guardarMensajes, guardarContactos, listarChats, historial,
  chatsSinNombre, nombreGuardado,
} from './store'

/**
 * Baileys exige un logger con esta forma. No importamos su tipo ILogger porque
 * el paquete no lo expone en la raiz; TypeScript compara FORMAS, no nombres,
 * asi que declararlo aca alcanza y nos evita depender de rutas internas suyas.
 */
interface LoggerBaileys {
  level: string
  child(obj: Record<string, unknown>): LoggerBaileys
  trace(obj: unknown, msg?: string): void
  debug(obj: unknown, msg?: string): void
  info(obj: unknown, msg?: string): void
  warn(obj: unknown, msg?: string): void
  error(obj: unknown, msg?: string): void
}

export const AUTH_DIR = process.env.WA_AUTH_DIR ?? './data/wa-auth'

/**
 * Logger mudo. Baileys exige uno y por defecto escupe cada paquete del
 * protocolo; en un journal compartido eso es ruido puro. Solo dejamos pasar
 * los errores.
 */
export const loggerMudo: LoggerBaileys = {
  level: 'silent',
  child: () => loggerMudo,
  trace: () => {},
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
}

/** Protobuf omite los ceros y a veces manda Long en vez de number. */
function num(v: unknown): number {
  if (typeof v === 'number') return v
  if (typeof v === 'bigint') return Number(v)
  if (v && typeof v === 'object' && 'toNumber' in v) {
    return (v as { toNumber(): number }).toNumber()
  }
  return 0
}

/** El texto de un mensaje vive en distintos lugares segun el tipo. */
function texto(m: WAMessage): string {
  const c = m.message
  if (!c) return ''
  return (
    c.conversation ??
    c.extendedTextMessage?.text ??
    c.imageMessage?.caption ??
    c.videoMessage?.caption ??
    c.documentMessage?.caption ??
    ''
  )
}

/** Personas y grupos. Fuera estados, canales y difusiones. */
function esChatUtil(jid: string | null | undefined): jid is string {
  if (!jid) return false
  if (jid === 'status@broadcast') return false
  if (jid.endsWith('@newsletter') || jid.endsWith('@broadcast')) return false
  return jid.endsWith('@s.whatsapp.net') || jid.endsWith('@g.us')
}

function volcarChats(chats: Chat[]): void {
  const filas: ChatGuardado[] = []
  for (const c of chats) {
    // TypeScript NO estrecha a traves de .filter() cuando la guarda mira una
    // PROPIEDAD. Con for + continue si lo hace, y sin castear nada.
    if (!esChatUtil(c.id)) continue
    filas.push({
      id: c.id,
      name: c.name ?? '',
      updatedAt: num(c.conversationTimestamp) || num(c.lastMessageRecvTimestamp),
    })
  }
  guardarChats(filas)
}

/** El nombre de una persona puede venir en name, notify o verifiedName. */
function volcarContactos(cs: { id?: string | null; name?: string | null; notify?: string | null; verifiedName?: string | null }[]): void {
  const filas: ContactoGuardado[] = []
  for (const c of cs) {
    if (!c.id) continue
    const nombre = c.name || c.notify || c.verifiedName || ''
    if (!nombre) continue
    filas.push({ id: c.id, name: nombre })
  }
  guardarContactos(filas)
}

function volcarMensajes(msgs: WAMessage[]): void {
  const filas: MsgGuardado[] = []
  for (const m of msgs) {
    const jid = m.key?.remoteJid
    const id = m.key?.id
    const t = texto(m)
    if (!esChatUtil(jid) || !id || !t) continue
    const ts = num(m.messageTimestamp)
    const esGrupo = jid.endsWith('@g.us')
    const fromMe = Boolean(m.key?.fromMe)
    // En grupos, pushName es el nombre de QUIEN escribio ese mensaje. Es la
    // unica forma de distinguir participantes: sin esto todos se ven iguales.
    const quien = esGrupo && !fromMe ? (m.pushName ?? '') : ''
    filas.push({
      id, chatId: jid, out: fromMe, text: t, ts,
      ...(quien ? { sender: quien } : {}),
    })
    // Un mensaje nuevo tambien mueve el chat hacia arriba en la lista.
    guardarChats([{ id: jid, name: '', updatedAt: ts }])
    // En un chat 1 a 1, pushName es el nombre de quien escribe: sirve para
    // ponerle cara al numero cuando no lo tenemos en la agenda. En grupos NO,
    // porque ahi pushName es el del participante, no el del grupo.
    if (!esGrupo && !fromMe && m.pushName) {
      guardarContactos([{ id: jid, name: m.pushName }])
    }
  }
  guardarMensajes(filas)
}

let sock: WASocket | null = null
let conectando: Promise<WASocket> | null = null
let reintentos = 0
const MAX_REINTENTOS = 10

async function abrir(): Promise<WASocket> {
  // Baileys 7 arrastra whatsapp-rust-bridge, que es SOLO-ESM (su package.json
  // no declara condicion "require"). Este backend corre como CommonJS, asi que
  // un import estatico lo tumba al arrancar -- y se llevaria a Telegram puesto.
  // Con import() dinamico Node lo carga como ESM de verdad, y ademas los 9 MB
  // de Baileys solo entran a memoria si alguien usa WhatsApp.
  const { default: makeWASocket, useMultiFileAuthState, DisconnectReason } =
    await import('baileys')

  mkdirSync(AUTH_DIR, { recursive: true, mode: 0o700 })
  const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR)

  if (!state.creds.registered) {
    throw new Error(
      'WhatsApp no esta vinculado. Corre `npm run login-whatsapp` una vez.',
    )
  }

  const s = makeWASocket({
    auth: state,
    logger: loggerMudo,
    // Pide todo el historial que WhatsApp este dispuesto a mandar al vincular.
    syncFullHistory: true,
    // CRITICO: si nos marcamos "en linea", WhatsApp deja de mandar
    // notificaciones al telefono porque cree que ya las estas viendo aca.
    markOnlineOnConnect: false,
  })

  s.ev.on('creds.update', saveCreds)
  s.ev.on('messaging-history.set', ({ chats, contacts, messages, lidPnMappings }) => {
    volcarChats(chats)
    volcarContactos(contacts)
    volcarMensajes(messages)
    // Las equivalencias entre identificador nuevo y telefono viajan aca.
    if (lidPnMappings?.length) {
      void s.signalRepository.lidMapping.storeLIDPNMappings(lidPnMappings).catch(() => {})
    }
  })
  s.ev.on('contacts.upsert', volcarContactos)
  s.ev.on('contacts.update', volcarContactos)
  s.ev.on('chats.upsert', volcarChats)
  s.ev.on('chats.update', updates => {
    volcarChats(updates.filter(u => u.id) as Chat[])
  })
  s.ev.on('messages.upsert', ({ messages }) => volcarMensajes(messages))

  s.ev.on('connection.update', ({ connection, lastDisconnect }) => {
    if (connection === 'open') {
      reintentos = 0
      console.log('[whatsapp] conectado')
      // La agenda llega de a poco despues de conectar, asi que se le da tiempo
      // antes de cruzarla. No es urgente: solo mejora los nombres.
      setTimeout(() => {
        vincularNombresLid()
          .then(n => { if (n) console.log(`[whatsapp] ${n} chats nombrados via @lid`) })
          .catch(() => {})
      }, 45_000)
      return
    }

    if (connection !== 'close') return

    const codigo = (lastDisconnect?.error as { output?: { statusCode?: number } })
      ?.output?.statusCode
    sock = null
    conectando = null

    if (codigo === DisconnectReason.loggedOut) {
      console.error('[whatsapp] sesion cerrada desde el telefono: hay que vincular de nuevo')
      return
    }

    // RECONEXION ACTIVA, no perezosa. Si esperaramos al proximo pedido HTTP,
    // una caida de madrugada nos dejaria sin recibir mensajes hasta que
    // alguien abriera la app -- y en WhatsApp los mensajes que no se reciben
    // mientras estas desconectado no se pueden pedir despues.
    // El 515 (restartRequired) es NORMAL: WhatsApp cierra a proposito y espera
    // que el cliente vuelva a conectarse.
    if (reintentos >= MAX_REINTENTOS) {
      console.error(`[whatsapp] ${MAX_REINTENTOS} reconexiones fallidas seguidas; me detengo`)
      return
    }
    reintentos++
    const espera = Math.min(3000 * reintentos, 30_000)
    console.warn(`[whatsapp] caida (${codigo ?? '?'}); reconectando en ${espera / 1000}s (${reintentos}/${MAX_REINTENTOS})`)
    setTimeout(() => { void getSocket().catch(() => {}) }, espera)
  })

  return s
}

/** Socket unico y reutilizado, igual que el cliente de Telegram. */
async function getSocket(): Promise<WASocket> {
  if (sock) return sock
  if (!conectando) {
    conectando = abrir()
      .then(s => { sock = s; return s })
      .catch(err => { conectando = null; throw err })
  }
  return conectando
}

/**
 * Pide a WhatsApp que reenvie el estado de la cuenta, que es donde viajan los
 * NOMBRES de los contactos. Hace falta porque esos nombres llegan una sola vez,
 * en la sincronizacion inicial: si el proceso que estaba escuchando en ese
 * momento no los guardo, no vuelven solos.
 */
export async function resincronizarContactos(): Promise<void> {
  const s = await getSocket()
  await s.resyncAppState(
    ['critical_block', 'critical_unblock_low', 'regular_high', 'regular_low', 'regular'],
    true,
  )
}

/**
 * Cruza los chats sin nombre contra los contactos que llegaron identificados
 * con @lid.
 *
 * WhatsApp esta migrando a un identificador nuevo (@lid) que NO expone el
 * numero. La agenda llega casi toda con esa identidad, mientras que los chats
 * siguen identificados por telefono (@s.whatsapp.net), asi que jamas coinciden
 * por igualdad. El propio Baileys guarda la tabla de equivalencias; esto la
 * consulta por lote y le pone el nombre al chat.
 */
export async function vincularNombresLid(): Promise<number> {
  const pendientes = chatsSinNombre()
  if (pendientes.length === 0) return 0

  const s = await getSocket()
  const mapas = await s.signalRepository.lidMapping.getLIDsForPNs(pendientes)
  if (!mapas?.length) return 0

  const filas: ContactoGuardado[] = []
  for (const m of mapas) {
    const nombre = nombreGuardado(m.lid)
    if (nombre) filas.push({ id: m.pn, name: nombre })
  }
  guardarContactos(filas)
  return filas.length
}

/**
 * Adaptador de WhatsApp.
 *
 * Diferencia de fondo con Telegram: WhatsApp NO permite consultar historial.
 * Los mensajes llegan por eventos, asi que este adaptador los va guardando en
 * el almacen y las lecturas salen de ahi, no de la red.
 */
export const whatsapp: MessagingProvider = {
  id: 'whatsapp',
  label: 'WhatsApp',

  async listContacts(limit = 20, q?: string): Promise<Contact[]> {
    await getSocket()
    return listarChats(limit, q)
  },

  async getHistory(peer: string, limit = 10): Promise<Msg[]> {
    await getSocket()
    return historial(peer, limit)
  },

  async sendMessage(peer: string, text: string): Promise<void> {
    const s = await getSocket()
    await s.sendMessage(peer, { text })
  },
}
