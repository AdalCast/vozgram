import {
  waitForEvenAppBridge,
  TextContainerUpgrade,
  AudioInputSource,
  OsEventTypeList,
} from '@evenrealities/even_hub_sdk'
import { SonioxStream } from './soniox'
import { getContacts, getMessages, sendMessage, type Contact, type Msg } from './api'
import { TEXT_ID, TEXT_NAME, CLOCK_ID, CLOCK_NAME, startUpWithText, rebuildWithText, rebuildWithList } from './ui'

// ---------------------------------------------------------------------------
// VozGram — push-to-talk.
//
//   PICK    lista      tap = elegir contacto      doble = salir (sistema)
//   READY   texto      MANTENER = hablar          doble = volver a PICK
//   DICTATE texto      SOLTAR   = terminar
//   CONFIRM texto      tap = ENVIAR               doble = redictar
//
// El microfono SOLO se enciende mientras se mantiene presionado. Nunca escucha solo.
// ---------------------------------------------------------------------------

type Screen = 'PICK' | 'READ' | 'DICTATE' | 'CONFIRM'

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

let screen: Screen = 'PICK'
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

async function gotoList(names: string[]): Promise<void> {
  lastRendered = ''
  mirror(names.map((n, i) => `${i === 0 ? '>' : ' '} ${n}`).join('\n'))
  clockShown = hhmm()
  await bleCall(() => bridge.rebuildPageContainer(rebuildWithList(names, clockShown)), 'rebuild:list')
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
const firstName = () => who().split(' ')[0]

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
    const linea = `${m.out ? 'YO' : firstName().toUpperCase()}: ${m.text}`
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
/**
 * Vista de grabacion. El diagnostico solo aparece cuando algo NO esta bien:
 * con todo funcionando la pantalla queda limpia, y si falla algo te dice que.
 */
function dictateView(t: string): string {
  const cuerpo = tail(t.trim())
  const sano = micOk === true && soniox?.state === 'OPEN' && !lastNote
  if (!sano) {
    const mic = micOk === null ? '...' : micOk ? 'ON' : 'FALLO'
    const diag = `mic:${mic} ws:${soniox?.state ?? 'NULL'} chunks:${chunks}`
    const aviso = lastNote ? `\n${lastNote}` : ''
    return `> ${who()}  [${diag}]${aviso}\n\n${cuerpo || 'Habla... (suelta para terminar)'}`
  }
  return `> ${who()}\n\n${cuerpo || 'Habla... (suelta para terminar)'}`
}

// --- Soniox -----------------------------------------------------------------
let soniox: SonioxStream | null = null

/** Se conecta al entrar en READ, pero SIN prender el microfono. */
async function prepare(): Promise<void> {
  soniox = new SonioxStream({
    onPartial: t => { if (screen === 'DICTATE') setText(dictateView(t)) },
    onFinal: t => {
      draft = t
      if (screen === 'DICTATE') setText(dictateView(t))
      persist()
    },
    onError: m => { lastNote = `STT: ${m}`; if (screen === 'DICTATE') setText(dictateView(draft)) },
    onClosed: c => { lastNote = `socket cerrado (${c})`; if (screen === 'DICTATE') setText(dictateView(draft)) },
  })
  await soniox.connect()
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
  if (nuevas.join('\u0000') === pages.join('\u0000')) return   // nada cambio

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

/** MANTENER presionado: recien aca se enciende el microfono. */
async function startListening(): Promise<void> {
  if (screen !== 'READ') return
  stopPolling()
  screen = 'DICTATE'
  micOk = null; chunks = 0; bytes = 0; lastNote = ''
  await setText(dictateView(''))
  if (!soniox) { try { await prepare() } catch { /* ya se mostro el error */ } }

  // audioControl devuelve boolean. Ignorarlo fue el bug: la pantalla decia
  // "Grabando" con el microfono apagado.
  try {
    micOk = await bridge.audioControl(true, AudioInputSource.Glasses)
  } catch (err) {
    micOk = false
    lastNote = `audioControl: ${String(err).slice(0, 60)}`
  }
  await setText(dictateView(''))
}

/** SOLTAR: se apaga el microfono y se pasa a confirmar. */
async function stopListening(): Promise<void> {
  if (screen !== 'DICTATE') return
  lastReleaseAt = Date.now()
  await bridge.audioControl(false)
  soniox?.close()
  soniox = null
  screen = 'CONFIRM'
  const cuerpo = draft.trim() || '(no se escuchó nada)'
  await gotoText(`Enviar a ${who()}:\n\n${cuerpo}\n\ntap = ENVIAR · doble = repetir`)
}

async function toPick(): Promise<void> {
  stopPolling()
  screen = 'PICK'
  target = null
  await bridge.audioControl(false)
  soniox?.close(); soniox = null
  await gotoList(contacts.map(c => c.name))
}

async function doSend(): Promise<void> {
  if (busy || !target || !draft.trim()) return
  busy = true
  await setText(`Enviando a ${who()}...`)
  try {
    await sendMessage(target.id, draft.trim())
    await setText(`Enviado ✓`)
    draft = ''
    persist()
    // Volver AL CHAT, no al menu: acabas de escribir, queres ver la respuesta.
    setTimeout(() => { toRead() }, 1200)
  } catch (err) {
    await setText(`FALLÓ el envío.\n${String(err)}\n\n(doble tap = volver)`)
  } finally {
    busy = false
  }
}

// --- Arranque ---------------------------------------------------------------
clockShown = hhmm()
const ok = await bridge.createStartUpPageContainer(startUpWithText('VozGram\n\nCargando contactos...', clockShown))
if (ok !== 0) throw new Error(`createStartUpPageContainer fallo: ${ok}`)
lastRendered = 'VozGram\n\nCargando contactos...'
mirror(lastRendered)

draft = (await bridge.getLocalStorage(STORAGE_KEY)) || ''

// El reloj corre siempre, en todas las pantallas.
const clockTimer = setInterval(tickClock, CLOCK_MS)

try {
  contacts = (await getContacts()).contacts
  if (contacts.length === 0) await setText('Sin chats disponibles.')
  else await toPick()
} catch (err) {
  await setText(`No se pudo hablar con el backend.\n${String(err)}`)
}

// --- Eventos ----------------------------------------------------------------
// PROTOBUF: los ceros llegan como undefined. El `?? 0` NO es opcional.
const unsubscribe = bridge.onEvenHubEvent(event => {
  if (event.audioEvent?.audioPcm) {
    chunks++
    bytes += event.audioEvent.audioPcm.length
    soniox?.send(event.audioEvent.audioPcm)
    if (screen === 'DICTATE' && chunks % 10 === 0) setText(dictateView(draft))
    return
  }

  if (event.listEvent && screen === 'PICK') {
    target = contacts[event.listEvent.currentSelectItemIndex ?? 0] ?? null
    if (target) toRead()
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

  if (type === OsEventTypeList.LONG_PRESS_EVENT) { note('Grabando...'); startListening(); return }
  if (type === OsEventTypeList.LONG_PRESS_RELEASE_EVENT) { note('Revisa y confirma'); stopListening(); return }

  if (type === OsEventTypeList.DOUBLE_CLICK_EVENT) {
    if (screen === 'PICK') bridge.shutDownPageContainer(1)  // dialogo del sistema
    else if (screen === 'CONFIRM') toRead()                 // repetir
    else toPick()
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
