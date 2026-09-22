import { mkdirSync } from 'node:fs'
// SOLO TIPOS: se borran al compilar, no cargan nada en tiempo de ejecucion.
import type { WASocket, WAMessage, Chat } from 'baileys'
import type { Contact, Msg, MessagingProvider, EstadoMensajero, Pendiente } from './port'
import type { ChatGuardado, MsgGuardado, ContactoGuardado } from './store'
import {
  guardarChats, guardarMensajes, guardarContactos, listarChats, historial,
  chatsSinNombre, nombreGuardado, guardarLidMap, chatsLid,
  noLeidos, clavesNoLeidas, limpiarNoLeidos, sumarNoLeido,
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

/**
 * Personas y grupos. Fuera estados, canales y difusiones.
 *
 * `@lid` es OBLIGATORIO aceptarlo: WhatsApp esta migrando a ese identificador
 * -- que no expone el numero -- y ya crea con el las conversaciones nuevas.
 * Rechazarlo hacia que los mensajes llegaran y se tiraran en silencio.
 */
function esChatUtil(jid: string | null | undefined): jid is string {
  if (!jid) return false
  if (jid === 'status@broadcast') return false
  if (jid.endsWith('@newsletter') || jid.endsWith('@broadcast')) return false
  return jid.endsWith('@s.whatsapp.net') || jid.endsWith('@g.us') || jid.endsWith('@lid')
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
      // `== null` y no `num()`: WhatsApp manda actualizaciones PARCIALES, y un
      // campo ausente convertido a cero vaciaria la bandeja sola. Ausente se
      // deja pasar como undefined para que el almacen conserve lo que tenia.
      ...(c.unreadCount == null ? {} : { unread: num(c.unreadCount) }),
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

/** Diagnostico: cuenta lo que llega y lo que se descarta, con el motivo. */
const descartes = new Map<string, number>()
function anotarDescarte(motivo: string): void {
  descartes.set(motivo, (descartes.get(motivo) ?? 0) + 1)
}

/**
 * `enVivo` distingue un mensaje que ACABA de llegar de uno que viene en la
 * sincronizacion de historial. Solo el primero suma a los no leidos: contar los
 * del historial pondria la bandeja llena de cosas ya leidas hace meses.
 */
function volcarMensajes(msgs: WAMessage[], enVivo = false): void {
  const filas: MsgGuardado[] = []
  for (const m of msgs) {
    const jid = m.key?.remoteJid
    const id = m.key?.id
    const t = texto(m)
    // El sufijo se calcula ANTES de la guarda a proposito: `esChatUtil` declara
    // `jid is string`, asi que TypeScript cree que en la rama negativa no puede
    // haber strings. Es falso -- un "@lid" es un string que la guarda rechaza --
    // y esa mentira del tipo tapaba justo el dato que hace falta para depurar.
    const sufijo = typeof jid === 'string' && jid.includes('@')
      ? jid.slice(jid.indexOf('@'))
      : '(sin jid)'
    if (!esChatUtil(jid)) { anotarDescarte(`jid ${sufijo}`); continue }
    if (!id) { anotarDescarte('sin id'); continue }
    if (!t) { anotarDescarte('sin texto'); continue }
    const ts = num(m.messageTimestamp)
    const esGrupo = jid.endsWith('@g.us')
    const fromMe = Boolean(m.key?.fromMe)
    // En grupos, pushName es el nombre de QUIEN escribio ese mensaje. Es la
    // unica forma de distinguir participantes: sin esto todos se ven iguales.
    const quien = esGrupo && !fromMe ? (m.pushName ?? '') : ''
    filas.push({
      id, chatId: jid, out: fromMe, text: t, ts,
      ...(quien ? { sender: quien } : {}),
      // Jid del participante, distinto del nombre: marcar leido lo exige.
      ...(m.key?.participant ? { participant: m.key.participant } : {}),
    })
    // Un mensaje nuevo tambien mueve el chat hacia arriba en la lista.
    guardarChats([{ id: jid, name: '', updatedAt: ts }])
    // El contador sube aqui por si WhatsApp no manda su chats.update. Cuando
    // llega, ese valor MANDA y corrige lo que hayamos contado de mas.
    if (enVivo && !fromMe) sumarNoLeido(jid)
    // En un chat 1 a 1, pushName es el nombre de quien escribe: sirve para
    // ponerle cara al numero cuando no lo tenemos en la agenda. En grupos NO,
    // porque ahi pushName es el del participante, no el del grupo.
    if (!esGrupo && !fromMe && m.pushName) {
      guardarContactos([{ id: jid, name: m.pushName }])
    }
    // Una identidad @lid recien vista puede no estar unida a su telefono
    // todavia. Mientras no lo este, TU etiqueta -que vive contra el telefono-
    // no la alcanza, y en pantalla sale el pushName. Ver pedirMapeoLids().
    if (jid.endsWith('@lid')) pedirMapeoLids()
  }
  guardarMensajes(filas)
}

/**
 * Vuelve a unir identidades @lid con su telefono, con freno.
 *
 * POR QUE EXISTE: `mapearLids()` corria UNA sola vez, 45 s despues de
 * conectar, y nunca mas. Un @lid que aparecia despues -alguien que te escribe
 * por primera vez desde esa identidad- se quedaba sin unir hasta el proximo
 * reinicio. Y mientras no este unido, tu etiqueta de `mis_nombres` (guardada
 * contra el TELEFONO) no lo alcanza: la cascada cae hasta `contacts`, que
 * tiene el pushName. El sintoma es que en la bandeja sale como se llama esa
 * persona a si misma en vez de como la tienes guardada, y que "se arregla
 * solo" dias despues -- cuando el servicio se reinicia por cualquier motivo.
 *
 * El freno no es adorno: una sincronizacion trae decenas de mensajes de golpe
 * y sin el saldria una consulta por cada uno. `chatsLid()` ya devuelve solo
 * los que faltan, asi que cuando no hay nada nuevo esto no cuesta nada.
 */
const FRENO_LIDS_MS = 8_000
let lidsEnCola: ReturnType<typeof setTimeout> | null = null

function pedirMapeoLids(): void {
  if (lidsEnCola) return
  lidsEnCola = setTimeout(() => {
    lidsEnCola = null
    mapearLids()
      .then(n => { if (n) console.log(`[whatsapp] ${n} identidad(es) @lid unificadas`) })
      // Si el socket esta caido no pasa nada: el proximo mensaje lo reintenta,
      // y al reconectar corre la pasada de los 45 s de todos modos.
      .catch(() => {})
  }, FRENO_LIDS_MS)
}

let sock: WASocket | null = null
let conectando: Promise<WASocket> | null = null
let reintentos = 0
let vigilante: ReturnType<typeof setInterval> | null = null
/**
 * Lo que reportamos hacia afuera. Se actualiza en CADA transicion, no se
 * deduce mirando el socket: un socket muerto y uno que todavia no nacio se ven
 * igual desde afuera, y significan cosas opuestas.
 */
let estadoActual: EstadoMensajero = 'conectando'
const MAX_REINTENTOS = 10
const SALUD_MS = 60_000

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
    estadoActual = 'desvinculado'
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
      // Tambien en NUESTRA base: Baileys lo guarda para cifrar, nosotros lo
      // necesitamos para no mostrar a la misma persona dos veces.
      guardarLidMap(lidPnMappings)
      void s.signalRepository.lidMapping.storeLIDPNMappings(lidPnMappings).catch(() => {})
    }
  })
  s.ev.on('contacts.upsert', volcarContactos)
  s.ev.on('contacts.update', volcarContactos)
  s.ev.on('chats.upsert', volcarChats)
  s.ev.on('chats.update', updates => {
    volcarChats(updates.filter(u => u.id) as Chat[])
  })
  s.ev.on('messages.upsert', ({ messages, type }) => {
    volcarMensajes(messages, type === 'notify')
    // Solo se avisa cuando algo se TIRA. En el camino feliz el log queda
    // callado; cuando algo se cae, dice que y por que. Un descarte silencioso
    // es peor que un error ruidoso: este bug nos costo dos horas justamente
    // porque los mensajes llegaban y desaparecian sin dejar rastro.
    if (descartes.size) {
      console.warn('[whatsapp] mensajes descartados:', JSON.stringify(Object.fromEntries(descartes)))
      descartes.clear()
    }
  })

  s.ev.on('connection.update', ({ connection, lastDisconnect }) => {
    if (connection === 'open') {
      reintentos = 0
      estadoActual = 'listo'
      console.log('[whatsapp] conectado')
      // La agenda llega de a poco despues de conectar, asi que se le da tiempo
      // antes de cruzarla. No es urgente: solo mejora los nombres.
      setTimeout(() => {
        vincularNombresLid()
          .then(n => { if (n) console.log(`[whatsapp] ${n} chats nombrados via @lid`) })
          .catch(() => {})
        mapearLids()
          .then(n => { if (n) console.log(`[whatsapp] ${n} identidades @lid unificadas`) })
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
      estadoActual = 'desvinculado'
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
      estadoActual = 'caido'
      console.error(`[whatsapp] ${MAX_REINTENTOS} reconexiones fallidas seguidas; me detengo`)
      return
    }
    reintentos++
    estadoActual = 'conectando'
    const espera = Math.min(3000 * reintentos, 30_000)
    console.warn(`[whatsapp] caida (${codigo ?? '?'}); reconectando en ${espera / 1000}s (${reintentos}/${MAX_REINTENTOS})`)
    setTimeout(() => { void getSocket().catch(() => {}) }, espera)
  })

  return s
}

/**
 * Vigilante de salud.
 *
 * El evento 'close' NO siempre llega: un socket puede morirse en silencio y
 * quedarse ahi, guardado y aparentemente sano. Sin esto seguimos devolviendo un
 * socket muerto, dejamos de recibir mensajes y NADIE se entera -- que es
 * exactamente lo que paso: 1h44 sin un solo mensaje nuevo y ni una linea en el
 * log. En WhatsApp lo que no se recibe conectado no se puede pedir despues.
 */
function vigilar(): void {
  if (vigilante) return
  vigilante = setInterval(() => {
    if (!sock || !sock.ws.isClosed) return
    console.warn('[whatsapp] el socket murio sin avisar; reconectando')
    estadoActual = 'conectando'
    sock = null
    conectando = null
    void getSocket().catch(() => {})
  }, SALUD_MS)
}

/** Socket unico y reutilizado, igual que el cliente de Telegram. */
async function getSocket(): Promise<WASocket> {
  // isClosed y no isOpen: recien creado el socket esta CONECTANDO, y tratarlo
  // como muerto ahi nos metia en un ciclo de reconexion.
  if (sock && !sock.ws.isClosed) return sock
  if (sock) { sock = null; conectando = null }
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
 * Conecta al arrancar el servidor y deja el vigilante corriendo.
 *
 * Antes la conexion era PEREZOSA: solo se abria cuando llegaba un pedido HTTP.
 * Para una app que tiene que RECIBIR mensajes eso esta mal: con los lentes
 * cerrados, el backend no escuchaba a nadie.
 */
export function iniciar(): void {
  vigilar()
  void getSocket().catch(err => {
    console.warn('[whatsapp] no se pudo conectar al arrancar:', String(err).slice(0, 120))
  })
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
  const filas: ContactoGuardado[] = []

  // Ida: chat identificado por telefono -> nombre que llego bajo su @lid.
  const porTelefono = pendientes.filter(j => j.endsWith('@s.whatsapp.net'))
  if (porTelefono.length) {
    const mapas = await s.signalRepository.lidMapping.getLIDsForPNs(porTelefono)
    if (mapas?.length) guardarLidMap(mapas)
    for (const m of mapas ?? []) {
      const nombre = nombreGuardado(m.lid)
      if (nombre) filas.push({ id: m.pn, name: nombre })
    }
  }

  // Vuelta: chat identificado por @lid -> nombre que tengamos por telefono.
  for (const lid of pendientes.filter(j => j.endsWith('@lid'))) {
    const pn = await s.signalRepository.lidMapping.getPNForLID(lid).catch(() => null)
    if (!pn) continue
    guardarLidMap([{ lid, pn }])
    const nombre = nombreGuardado(pn)
    if (nombre) filas.push({ id: lid, name: nombre })
  }

  guardarContactos(filas)
  return filas.length
}

/**
 * Aprende la equivalencia de los chats @lid que aun no la tienen.
 *
 * Hace falta APARTE de vincularNombresLid porque aquel solo mira los chats SIN
 * nombre -- su trabajo es ponerles uno. Los duplicados que molestan en la lista
 * son justo los contrarios: los que YA tienen nombre y aparecen dos veces.
 * Se resuelven por lote; uno por uno serian cientos de idas y vueltas.
 */
export async function mapearLids(): Promise<number> {
  const lids = chatsLid()
  if (lids.length === 0) return 0
  const s = await getSocket()
  const mapas = await s.signalRepository.lidMapping.getPNsForLIDs(lids)
  if (!mapas?.length) return 0
  guardarLidMap(mapas)
  return mapas.length
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

  // Sale del almacen, sin tocar la red: WhatsApp no permite consultar nada.
  async noLeidos(limite = 10): Promise<Pendiente[]> {
    await getSocket()
    return noLeidos(limite)
  },

  /**
   * Marca leido en WhatsApp Y en el almacen local.
   *
   * Los dos hacen falta: si solo se marcara remoto, el contador local seguiria
   * en alto hasta la proxima sincronizacion y el mensaje volveria a salir en
   * la bandeja despues de haberlo leido.
   */
  async marcarLeido(peer: string): Promise<void> {
    const claves = clavesNoLeidas(peer)
    limpiarNoLeidos(peer)
    if (claves.length === 0) return
    const s = await getSocket()
    await s.readMessages(claves.map(c => ({
      remoteJid: peer,
      id: c.id,
      fromMe: false,
      // Solo en grupos. Sin participant, WhatsApp ignora la marca.
      ...(c.participant ? { participant: c.participant } : {}),
    })))
  },

  estado: () => estadoActual,
}
