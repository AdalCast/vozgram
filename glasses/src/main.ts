import {
  waitForEvenAppBridge,
  TextContainerUpgrade,
  AudioInputSource,
  OsEventTypeList,
} from '@evenrealities/even_hub_sdk'
import { SonioxStream } from './soniox'
import {
  getProviders, getContacts, getMessages, sendMessage,
  type Provider, type Contact, type Msg,
} from './api'
import { TEXT_ID, TEXT_NAME, CLOCK_ID, CLOCK_NAME, startUpWithText, rebuildWithText, rebuildWithList } from './ui'

// ---------------------------------------------------------------------------
// VozGram — push-to-talk, dos mensajeros.
//
//   APPS    lista   tap = elegir app          doble = salir (sistema)
//   PICK    lista   tap = elegir chat         doble = atras
//                   MANTENER = buscar por voz
//   SEARCH  texto   SOLTAR = buscar
//   READ    texto   swipe = paginar           doble = volver a la lista
//                   MANTENER = responder
//   DICTATE texto   SOLTAR = terminar
//   CONFIRM texto   tap = ENVIAR              doble = repetir
//
// El microfono SOLO se enciende mientras se mantiene presionado. Nunca escucha solo.
// ---------------------------------------------------------------------------

type Screen = 'APPS' | 'PICK' | 'SEARCH' | 'READ' | 'DICTATE' | 'CONFIRM'

const STORAGE_KEY = 'vozgram.draft'
const MAX_VISIBLE = 400
const BLE_TIMEOUT_MS = 4000
const CLICK_GUARD_MS = 700   // ignora el tap espurio que puede seguir al soltar
// La pantalla NO se llena por caracteres sino por RENGLONES: un mensaje de
// 3 letras ocupa una linea igual que uno de 50. Presupuestamos en lineas.
const CHARS_PER_LINE = 56    // ancho util a 576px con la fuente del firmware
const BODY_LINES = 6         // cabecera + blanco + cuerpo + blanco + pie
const SDK_TEXT_MAX = 1900    // textContainerUpgrade admite 2000; dejamos margen
const HISTORY = 10           // ultimos mensajes a traer
const POLL_MS = 10_000       // cada cuanto revisamos si llego respuesta
const CLOCK_MS = 15_000      // cada cuanto revisamos si cambio el minuto

let screen: Screen = 'APPS'
let providers: Provider[] = []
let provider: Provider | null = null
let query = ''               // busqueda activa, '' = sin filtro
let contacts: Contact[] = []
let target: Contact | null = null
let draft = ''
let lastRendered = ''
let busy = false
let lastReleaseAt = 0
let pages: string[] = []     // conversacion ya paginada
let page = 0
let pollTimer: number | undefined
let clockShown = ''          // ultima hora dibujada, para no repintar de mas

// --- Diagnostico -----------------------------------------------------------
// La pantalla decia "Grabando" aunque el mic estuviera apagado, porque yo
// ignoraba el boolean que devuelve audioControl. Ahora se mide todo y se
// muestra: si algo falla, se ve en el lente, no hay que adivinar.
let micOk: boolean | null = null   // que devolvio audioControl(true)
let chunks = 0                     // cuantos buffers de PCM llegaron
let bytes = 0                      // cuanto audio en total
let lastNote = ''                  // ultimo aviso (cierre de socket, error)

// --- Serializacion de llamadas al bridge -----------------------------------
let chain: Promise<unknown> = Promise.resolve()
function bleCall<T>(fn: () => Promise<T>, label: string): Promise<T | null> {
  const next = chain.then(() =>
    Promise.race([
      fn(),
      new Promise<null>(r => setTimeout(() => r(null), BLE_TIMEOUT_MS)),
    ]).catch(err => { console.warn(`[ble] ${label}:`, err); return null }),
  )
  chain = next
  return next as Promise<T | null>
}

// --- Espejo en el telefono ---------------------------------------------
// Todo se dibuja en los lentes por el bridge, asi que la WebView quedaba en
// BLANCO. Ademas de verse mal, "first launch shows black screen" es causal
// de rechazo en el review de Even Hub. Reflejamos lo mismo que va al lente.
const $screen = document.getElementById('screen')
const $state = document.getElementById('state')
function mirror(text: string): void { if ($screen) $screen.textContent = text }
function note(text: string): void { if ($state) $state.textContent = text }

note('Conectando con los lentes...')
const bridge = await waitForEvenAppBridge()
note('Lentes conectados')

// --- Reloj ------------------------------------------------------------------
// Vive en su propio contenedor, arriba a la derecha, en todas las pantallas.
// El WebView corre en el telefono, asi que Date() da la hora local del usuario.
function hhmm(): string {
  const d = new Date()
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

/** Solo toca el enlace BLE cuando el minuto efectivamente cambio. */
async function tickClock(): Promise<void> {
  const ahora = hhmm()
  if (ahora === clockShown) return
  clockShown = ahora
  await bleCall(() => bridge.textContainerUpgrade(new TextContainerUpgrade({
    containerID: CLOCK_ID,
    containerName: CLOCK_NAME,
    contentOffset: 0,
    contentLength: 0,
    content: ahora,
  })), 'reloj')
}

// --- Render -----------------------------------------------------------------
/** Recorta por el FINAL, para no comerse la cabecera. Solo tope del SDK. */
const fit = (t: string) => (t.length > SDK_TEXT_MAX ? t.slice(0, SDK_TEXT_MAX) : t)
/** Para el dictado si queremos la COLA: lo ultimo que dijiste. */
const tail = (t: string) => (t.length > MAX_VISIBLE ? t.slice(-MAX_VISIBLE) : t)

async function setText(content: string): Promise<void> {
  const c = fit(content)
  if (c === lastRendered) return
  lastRendered = c
  mirror(c)
  await bleCall(() => bridge.textContainerUpgrade(new TextContainerUpgrade({
    containerID: TEXT_ID, containerName: TEXT_NAME,
    contentOffset: 0, contentLength: 0, content: c,
  })), 'textContainerUpgrade')
}

async function gotoText(content: string): Promise<void> {
  lastRendered = fit(content)
  mirror(lastRendered)
  clockShown = hhmm()
  await bleCall(() => bridge.rebuildPageContainer(rebuildWithText(lastRendered, clockShown)), 'rebuild:text')
}

async function gotoList(names: string[], title: string): Promise<void> {
  lastRendered = ''
  mirror(`${title}\n\n${names.map((n, i) => `${i === 0 ? '>' : ' '} ${n}`).join('\n')}`)
  clockShown = hhmm()
  await bleCall(() => bridge.rebuildPageContainer(rebuildWithList(names, clockShown, title)), 'rebuild:list')
}

// --- Persistencia -----------------------------------------------------------
let saveTimer: number | undefined
function persist(): void {
  clearTimeout(saveTimer)
  saveTimer = setTimeout(() => {
    bleCall(() => bridge.setLocalStorage(STORAGE_KEY, draft), 'setLocalStorage')
  }, 1500) as unknown as number
}

// --- Vistas -----------------------------------------------------------------
const who = () => target?.name ?? '?'
const firstName = () => who().split(' ')[0] ?? '?'

/** Titulo de la lista: en que app estas y, si hay busqueda, que buscaste. */
const tituloLista = () => {
  const app = provider?.label ?? 'Chats'
  return query ? `${app}: ${query}` : app
}

/** PICK es la raiz solo cuando no hay menu de apps que mostrar. */
const pickEsRaiz = () => providers.length <= 1

/** Cuantos renglones ocupa realmente un mensaje al renderizarse. */
const renglones = (t: string) => Math.max(1, Math.ceil(t.length / CHARS_PER_LINE))

/**
 * Parte la conversacion en paginas que entren en pantalla, cortando SIEMPRE
 * entre mensajes: nunca a mitad de una frase. Presupuesta por RENGLONES.
 */
function paginate(msgs: Msg[]): string[] {
  if (msgs.length === 0) return ['(sin mensajes)']
  const out: string[] = []
  let buf: string[] = []
  let usadas = 0
  // El firmware NO tiene negritas (verificado en la doc del SDK). Para separar
  // un mensaje del siguiente usamos lo que si funciona en monocromo:
  // MAYUSCULAS en el nombre y una linea en blanco entre mensajes.
  for (const m of msgs) {
    // En un GRUPO, sender dice quien hablo. Sin eso, todos los mensajes ajenos
    // saldrian con el nombre del grupo y no se sabria quien dijo que.
    const bruto = m.sender ? (m.sender.split(' ')[0] ?? m.sender) : firstName()
    const quien = m.out ? 'YO' : bruto.toUpperCase()
    const linea = `${quien}: ${m.text}`
    const n = renglones(linea) + (buf.length > 0 ? 1 : 0)   // +1 por el blanco
    if (buf.length > 0 && usadas + n > BODY_LINES) {
      out.push(buf.join('\n\n')); buf = [linea]; usadas = renglones(linea)
    } else {
      buf.push(linea); usadas += n
    }
  }
  if (buf.length) out.push(buf.join('\n\n'))
  return out
}

const readView = () => {
  const nav = pages.length > 1 ? `  ${page + 1}/${pages.length}` : ''
  return `${who()}${nav}\n\n${pages[page] ?? ''}\n\n*mantener tap para responder`
}

/** Diagnostico compartido: solo aparece cuando algo NO esta bien. */
function diagnostico(): string {
  const sano = micOk === true && soniox?.state === 'OPEN' && !lastNote
  if (sano) return ''
  const mic = micOk === null ? '...' : micOk ? 'ON' : 'FALLO'
  const aviso = lastNote ? `\n${lastNote}` : ''
  return `  [mic:${mic} ws:${soniox?.state ?? 'NULL'} chunks:${chunks}]${aviso}`
}

function dictateView(t: string): string {
  const cuerpo = tail(t.trim())
  return `> ${who()}${diagnostico()}\n\n${cuerpo || 'Habla... (suelta para terminar)'}`
}

function searchView(t: string): string {
  const cuerpo = tail(t.trim())
  const app = provider?.label ?? 'los chats'
  return `Buscar en ${app}${diagnostico()}\n\n${cuerpo || 'Di un nombre... (suelta para buscar)'}`
}

/** Repinta la pantalla de voz que corresponda, sea dictado o busqueda. */
function pintarVoz(t: string): void {
  if (screen === 'DICTATE') setText(dictateView(t))
  else if (screen === 'SEARCH') setText(searchView(t))
}

// --- Soniox -----------------------------------------------------------------
let soniox: SonioxStream | null = null

/** Se conecta al entrar, pero SIN prender el microfono. */
async function prepare(): Promise<void> {
  soniox = new SonioxStream({
    onPartial: t => pintarVoz(t),
    onFinal: t => { draft = t; pintarVoz(t); if (screen === 'DICTATE') persist() },
    onError: m => { lastNote = `STT: ${m}`; pintarVoz(draft) },
    onClosed: c => { lastNote = `socket cerrado (${c})`; pintarVoz(draft) },
  })
  await soniox.connect()
}

/** Enciende el microfono. Comun al dictado y a la busqueda. */
async function encenderMic(): Promise<void> {
  micOk = null; chunks = 0; bytes = 0; lastNote = ''; draft = ''
  if (!soniox) { try { await prepare() } catch { /* ya se mostro el error */ } }
  // audioControl devuelve boolean. Ignorarlo fue el bug: la pantalla decia
  // "Grabando" con el microfono apagado.
  try {
    micOk = await bridge.audioControl(true, AudioInputSource.Glasses)
  } catch (err) {
    micOk = false
    lastNote = `audioControl: ${String(err).slice(0, 60)}`
  }
}

async function apagarMic(): Promise<void> {
  lastReleaseAt = Date.now()
  await bridge.audioControl(false)
  soniox?.close()
  soniox = null
}

/**
 * Vuelve a pedir el historial y actualiza la vista SOLO si cambio.
 * Si el usuario estaba leyendo hacia atras no lo movemos de pagina;
 * si estaba en la ultima, lo llevamos a lo nuevo.
 */
async function refresh(): Promise<void> {
  if (screen !== 'READ' || !target) return
  let msgs: Msg[]
  try { msgs = (await getMessages(target.id, HISTORY)).messages } catch { return }
  if (screen !== 'READ') return

  const nuevas = paginate(msgs)
  if (nuevas.join('|') === pages.join('|')) return   // nada cambio

  const estabaAlFinal = page >= pages.length - 1
  pages = nuevas
  page = estabaAlFinal ? pages.length - 1 : Math.min(page, pages.length - 1)
  await setText(readView())
}

function startPolling(): void {
  stopPolling()
  pollTimer = setInterval(refresh, POLL_MS) as unknown as number
}
function stopPolling(): void {
  if (pollTimer !== undefined) { clearInterval(pollTimer); pollTimer = undefined }
}

// --- Navegacion -------------------------------------------------------------
async function toApps(): Promise<void> {
  stopPolling()
  screen = 'APPS'
  target = null; provider = null; query = ''
  await apagarMic()
  await gotoList(providers.map(p => p.label), 'VozGram')
}

/**
 * Lista de chats. `recargar` en false reusa lo que ya trajimos: volver desde
 * un chat no justifica otra vuelta a la red.
 */
async function toPick(recargar = true): Promise<void> {
  stopPolling()
  screen = 'PICK'
  target = null
  await apagarMic()

  if (recargar) {
    await gotoList(['cargando...'], tituloLista())
    try {
      contacts = (await getContacts(provider?.id, query || undefined)).contacts
    } catch (err) {
      await gotoText(`No se pudo cargar la lista.\n${String(err)}\n\n(doble tap = atras)`)
      return
    }
    if (screen !== 'PICK') return
  }

  await gotoList(
    contacts.length ? contacts.map(c => c.name) : ['(sin resultados)'],
    tituloLista(),
  )
}

async function toRead(): Promise<void> {
  screen = 'READ'
  draft = ''
  pages = ['cargando...']; page = 0
  await gotoText(readView())

  // El historial y el socket de voz se piden en paralelo: no tiene sentido
  // esperar uno para empezar el otro.
  const historia = target
    ? getMessages(target.id, HISTORY).then(r => r.messages).catch(() => [] as Msg[])
    : Promise.resolve([] as Msg[])
  const voz = prepare().catch(err => { lastNote = `voz: ${String(err).slice(0, 50)}` })

  const msgs = await historia
  pages = paginate(msgs)
  page = pages.length - 1           // arranca en lo MAS RECIENTE
  if (screen === 'READ') await setText(readView())
  startPolling()                    // las respuestas aparecen solas
  await voz
}

// --- Voz --------------------------------------------------------------------
/** MANTENER en READ: recien aca se enciende el microfono. */
async function startListening(): Promise<void> {
  if (screen !== 'READ') return
  stopPolling()
  screen = 'DICTATE'
  await setText(dictateView(''))
  await encenderMic()
  await setText(dictateView(''))
}

/** SOLTAR en DICTATE: se apaga el microfono y se pasa a confirmar. */
async function stopListening(): Promise<void> {
  if (screen !== 'DICTATE') return
  await apagarMic()
  screen = 'CONFIRM'
  const cuerpo = draft.trim() || '(no se escuchó nada)'
  await gotoText(`Enviar a ${who()}:\n\n${cuerpo}\n\ntap = ENVIAR · doble = repetir`)
}

/** MANTENER en PICK: dictar un nombre para filtrar la lista. */
async function startSearch(): Promise<void> {
  if (screen !== 'PICK') return
  screen = 'SEARCH'
  await gotoText(searchView(''))
  await encenderMic()
  await setText(searchView(''))
}

/** SOLTAR en SEARCH: se busca y se vuelve a la lista ya filtrada. */
async function endSearch(): Promise<void> {
  if (screen !== 'SEARCH') return
  await apagarMic()
  query = draft.trim()
  draft = ''
  await toPick()
}

async function doSend(): Promise<void> {
  if (busy || !target || !draft.trim()) return
  busy = true
  await setText(`Enviando a ${who()}...`)
  try {
    await sendMessage(target.id, draft.trim())
    await setText('Enviado ✓')
    draft = ''
    persist()
    // Volver AL CHAT, no al menu: acabas de escribir, quieres ver la respuesta.
    setTimeout(() => { toRead() }, 1200)
  } catch (err) {
    await setText(`FALLÓ el envío.\n${String(err)}\n\n(doble tap = volver)`)
  } finally {
    busy = false
  }
}

// --- Arranque ---------------------------------------------------------------
clockShown = hhmm()
const ok = await bridge.createStartUpPageContainer(startUpWithText('VozGram\n\nCargando...', clockShown))
if (ok !== 0) throw new Error(`createStartUpPageContainer fallo: ${ok}`)
lastRendered = 'VozGram\n\nCargando...'
mirror(lastRendered)

draft = (await bridge.getLocalStorage(STORAGE_KEY)) || ''

// El reloj corre siempre, en todas las pantallas.
const clockTimer = setInterval(tickClock, CLOCK_MS)

try {
  // Si el backend no conoce /api/providers seguimos con la lista mezclada:
  // preferimos una app que funcione de menos a una app que no arranque.
  try {
    providers = (await getProviders()).providers
  } catch {
    providers = []
  }

  if (providers.length > 1) {
    await toApps()
  } else {
    // Un solo mensajero (o backend viejo): el menu de apps seria una lista de
    // un elemento, o sea un paso regalado. Vamos directo a los chats.
    provider = providers[0] ?? null
    await toPick()
  }
} catch (err) {
  await gotoText(`No se pudo hablar con el backend.\n${String(err)}`)
}

// --- Eventos ----------------------------------------------------------------
// PROTOBUF: los ceros llegan como undefined. El `?? 0` NO es opcional.
const unsubscribe = bridge.onEvenHubEvent(event => {
  if (event.audioEvent?.audioPcm) {
    chunks++
    bytes += event.audioEvent.audioPcm.length
    soniox?.send(event.audioEvent.audioPcm)
    if ((screen === 'DICTATE' || screen === 'SEARCH') && chunks % 10 === 0) pintarVoz(draft)
    return
  }

  if (event.listEvent) {
    const i = event.listEvent.currentSelectItemIndex ?? 0
    if (screen === 'APPS') {
      provider = providers[i] ?? null
      if (provider) toPick()
    } else if (screen === 'PICK') {
      target = contacts[i] ?? null
      if (target) toRead()
    }
    return
  }

  // Los swipes llegan por textEvent; los taps por sysEvent. No confundirlos.
  if (event.textEvent && screen === 'READ') {
    const t = event.textEvent.eventType ?? 0
    if (t === 1 && page > 0) { page--; setText(readView()) }                    // swipe arriba
    if (t === 2 && page < pages.length - 1) { page++; setText(readView()) }     // swipe abajo
    return
  }

  if (!event.sysEvent) return
  const type = event.sysEvent.eventType ?? 0

  if (type === OsEventTypeList.LONG_PRESS_EVENT) {
    if (screen === 'PICK') { note('Di un nombre...'); startSearch() }
    else { note('Grabando...'); startListening() }
    return
  }
  if (type === OsEventTypeList.LONG_PRESS_RELEASE_EVENT) {
    if (screen === 'SEARCH') { note('Buscando'); endSearch() }
    else { note('Revisa y confirma'); stopListening() }
    return
  }

  if (type === OsEventTypeList.DOUBLE_CLICK_EVENT) {
    if (screen === 'APPS') {
      bridge.shutDownPageContainer(1)          // dialogo de salida del sistema
    } else if (screen === 'PICK') {
      // Atras en dos tiempos: primero se suelta la busqueda, despues se sale.
      if (query) { query = ''; toPick() }
      else if (pickEsRaiz()) bridge.shutDownPageContainer(1)
      else toApps()
    } else if (screen === 'CONFIRM') {
      toRead()                                  // repetir el dictado
    } else {
      toPick(false)                             // desde READ: sin recargar
    }
    return
  }

  if (type === OsEventTypeList.CLICK_EVENT) {
    // Al soltar un long press puede colarse un click: no queremos que envie solo.
    if (Date.now() - lastReleaseAt < CLICK_GUARD_MS) return
    if (screen === 'CONFIRM') doSend()
    return
  }

  if (type === OsEventTypeList.FOREGROUND_EXIT_EVENT) { persist(); return }
  if (type === OsEventTypeList.ABNORMAL_EXIT_EVENT || type === OsEventTypeList.SYSTEM_EXIT_EVENT) {
    cleanup()
  }
})

function cleanup(): void {
  clearInterval(clockTimer)
  stopPolling()
  bridge.audioControl(false)
  soniox?.close()
  unsubscribe()
}
window.addEventListener('beforeunload', cleanup)
