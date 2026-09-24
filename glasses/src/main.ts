import {
  waitForEvenAppBridge,
  TextContainerUpgrade,
  AudioInputSource,
  OsEventTypeList,
  type EvenHubEvent,
} from '@evenrealities/even_hub_sdk'
import { SonioxStream } from './soniox'
import {
  getProviders, getContacts, getMessages, sendMessage,
  getUnread, marcarLeido,
  type Provider, type Contact, type Msg, type Pendiente,
  SinRespuesta,
} from './api'
import { TEXT_ID, TEXT_NAME, CLOCK_ID, CLOCK_NAME, PISTA_ID, PISTA_NAME, startUpWithText, rebuildWithText, rebuildWithList, rebuildInicio } from './ui'

// ---------------------------------------------------------------------------
// VozGram — push-to-talk, dos mensajeros.
//
//   APPS    lista   tap = elegir app          doble = salir (sistema)
//   INFO    texto   (mensajero no disponible) doble = volver a APPS
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

type Screen = 'INICIO' | 'APPS' | 'INFO' | 'PICK' | 'SEARCH' | 'READ' | 'DICTATE' | 'CONFIRM'

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

let screen: Screen = 'INICIO'
let providers: Provider[] = []
let provider: Provider | null = null
let query = ''               // busqueda activa, '' = sin filtro
let contacts: Contact[] = []
let target: Contact | null = null
let draft = ''
let lastRendered = ''
let busy = false
let lastReleaseAt = 0
let pendientes: Pendiente[] = []   // bandeja de no leidos, para el inicio
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

/**
 * La leyenda de gestos y marcas, en la pantalla del telefono.
 *
 * En los lentes solo caben las marcas -- `•` `••` `—` --, que quien ya uso los
 * lentes reconoce del tutorial de Even. El que no, necesita verlas explicadas
 * una vez, y el telefono es donde hay lugar para hacerlo sin apretar nada.
 *
 * Y los circulos de las listas: `●` grupo, `○` persona. Sin explicarlos, un
 * circulo relleno junto a un nombre se lee como "sin leer" -- es la convencion
 * de casi cualquier app de mensajes --, justo lo que NO significa aqui.
 *
 * Va cerrada: es una red de seguridad, no algo que estorbe todos los dias.
 */
function pintarLeyendaDeGestos(): void {
  const $gestos = document.getElementById('gestos') as HTMLDetailsElement | null
  if (!$gestos) return
  const fila = (marca: string, nombre: string, que: string) => `
    <div class="fila">
      <div class="marca">${marca}</div>
      <div><div class="nombre">${nombre}</div><div class="que">${que}</div></div>
    </div>`
  $gestos.innerHTML = `
    <summary>Gestos y marcas</summary>
    ${fila('\u2022', 'Toque simple', 'Elegir. Al confirmar, envía.')}
    ${fila('\u2022\u2022', 'Doble toque', 'Volver. En la bandeja, sale de la aplicación.')}
    ${fila('\u2014', 'Pulsación larga', 'En un chat, responder: mantén el dedo mientras hablas y suelta al terminar. En la lista de chats, buscar un contacto diciendo su nombre.')}
    ${fila('\u2500\u2500', 'Desliza', 'Moverte por la conversación.')}
    <div class="pie">Son los mismos gestos de la aplicación de Even, con las mismas marcas.</div>
    <div class="seccion">En las listas</div>
    ${fila('\u25cf', 'Grupo', 'Un chat de varias personas.')}
    ${fila('\u25cb', 'Persona', 'Un chat con una sola persona, o con un bot.')}
    <div class="pie">El círculo NO indica mensajes sin leer. Los pendientes están en la bandeja, con su último mensaje.</div>`
  $gestos.hidden = false
}
pintarLeyendaDeGestos()

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

async function gotoText(content: string, pista = ''): Promise<void> {
  lastRendered = fit(content)
  mirror(lastRendered)
  clockShown = hhmm()
  pistaPuesta = pista
  await bleCall(() => bridge.rebuildPageContainer(rebuildWithText(lastRendered, clockShown, pista)), 'rebuild:text')
}

/**
 * Las instrucciones de gestos, con las marcas del tutorial de Even: `•` toque,
 * `••` doble toque, `—` pulsacion larga. Van en la franja atenuada de abajo y
 * no dentro del texto: no le roban renglones al mensaje, y se cambian con un
 * upgrade sin reconstruir la pagina. Lo que significa cada marca se explica
 * una vez, en la leyenda del telefono.
 */
const PISTA_LEER = '\u2014 responder    \u2022\u2022 volver'
const PISTA_CONFIRMAR = '\u2022 enviar    \u2022\u2022 repetir'
const PISTA_REINTENTAR = '\u2022 reintentar    \u2022\u2022 volver'
const PISTA_VOLVER = '\u2022\u2022 volver'

/** Cambia la pista sin reconstruir la pagina. Vive en su propio contenedor. */
let pistaPuesta = ''
async function setPista(texto: string): Promise<void> {
  if (texto === pistaPuesta) return
  pistaPuesta = texto
  await bleCall(() => bridge.textContainerUpgrade(new TextContainerUpgrade({
    containerID: PISTA_ID, containerName: PISTA_NAME,
    contentOffset: 0, contentLength: 0, content: texto,
  })), 'pista')
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

/**
 * Titulo de la lista: en que app estas, que buscaste, y como se busca.
 *
 * La pista va aqui y no como un renglon aparte porque la lista es un
 * contenedor de items: cualquier linea que le agregue seria SELECCIONABLE, y
 * un elemento que no lleva a ningun chat es peor que no tener pista.
 *
 * Que exista importa: el buscador estaba desde la v0.10.0 y nada en pantalla
 * lo anunciaba, asi que no se usaba. Una funcion que no se descubre es una
 * funcion que no existe.
 *
 * El titulo comparte la barra con el reloj y quedan unos 45 caracteres utiles;
 * la busqueda se recorta para que la pista nunca se salga de pantalla.
 */
const tituloLista = () => {
  const app = provider?.label ?? 'Chats'
  return query
    ? `${app}: ${query.slice(0, 16)} · \u2022\u2022 limpiar`
    : `${app} · \u2014 buscar contacto`
}

/**
 * Marcador de tipo delante del nombre: relleno es grupo, hueco es persona.
 *
 * Los dos glifos existen en la fuente del firmware y MIDEN LO MISMO, asi que la
 * columna queda a plomo en los dos estados -- con figuras de ancho distinto se
 * descuadra, porque la fuente es proporcional.
 *
 * Sirve para no equivocarse de destinatario: mandar a un grupo lo que era para
 * una persona no tiene deshacer.
 */
const marcar = (c: Contact): string => `${c.kind === 'grupo' ? '●' : '○'} ${c.name}`


/**
 * Sufijo del menu cuando un mensajero NO esta listo.
 *
 * Corto a proposito: comparte renglon con el nombre y la pantalla mide 576 px.
 * Vale mas un aviso de una palabra que se lee de reojo caminando, que una
 * frase completa que obliga a detenerse.
 */
const AVISO: Record<string, string> = {
  desvinculado: 'sin vincular',
  conectando: 'conectando',
  caido: 'sin conexion',
}

const etiqueta = (p: Provider): string => {
  const a = p.estado && p.estado !== 'listo' ? AVISO[p.estado] : ''
  return a ? `${p.label} (${a})` : p.label
}

/**
 * Se puede entrar? 'conectando' SI: los chats salen del almacen del servidor y
 * la llamada espera sola a que el socket abra. Bloquear ahi seria negarle al
 * usuario algo que si funciona.
 */
const entrable = (p: Provider): boolean =>
  !p.estado || p.estado === 'listo' || p.estado === 'conectando'

/** Que hacer, dicho en los lentes, porque en los lentes no hay consola. */
function explicar(p: Provider): string {
  if (p.estado === 'desvinculado') {
    return [
      `${p.label.toUpperCase()} SIN VINCULAR`,
      '',
      'Se cerro la sesion desde el telefono.',
      'Hay que vincular de nuevo en el servidor.',
    ].join('\n')
  }
  return [
    `${p.label.toUpperCase()} SIN CONEXION`,
    '',
    'El servidor no logro reconectar.',
    'Se reintenta solo; vuelve a probar en un rato.',
  ].join('\n')
}

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
  return `${who()}${nav}\n\n${pages[page] ?? ''}`
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
  return `Buscar contacto en ${app}${diagnostico()}\n\n${cuerpo || 'Di un nombre... (suelta para buscar)'}`
}

/**
 * Lo ULTIMO que se dibujo, incluidos los parciales.
 *
 * Existe como red de seguridad: `draft` solo recibe lo que Soniox ya confirmo,
 * asi que si el usuario suelta el tap antes de esa confirmacion, draft esta
 * vacio pero la pantalla estaba llena. Vale mas lo que el VIO escrito que una
 * pantalla en blanco.
 */
let ultimoPintado = ''

/** Repinta la pantalla de voz que corresponda, sea dictado o busqueda. */
function pintarVoz(t: string): void {
  ultimoPintado = t
  if (screen === 'DICTATE') setText(dictateView(t))
  else if (screen === 'SEARCH') setText(searchView(t))
}

/**
 * El mas completo de los candidatos.
 *
 * `finalText` es acumulativo y lo pintado es `finalText + parcial`, asi que en
 * el caso normal el mas largo es el que mas alcanzo a decir el usuario.
 *
 * NO es infalible: Soniox puede CORREGIR un parcial por un final mas corto, y
 * ahi esto se quedaria con el texto viejo. Se acepta a proposito -- perder el
 * mensaje entero es mucho peor que una ultima palabra mal transcrita, y de
 * todos modos el usuario lo lee en la pantalla de confirmacion antes de
 * enviarlo.
 */
const masCompleto = (...cs: string[]): string =>
  cs.map(c => c.trim()).filter(Boolean).sort((a, b) => b.length - a.length)[0] ?? ''

// --- Soniox -----------------------------------------------------------------
let soniox: SonioxStream | null = null

/**
 * Distingue el primer intento de una reconexion.
 *
 * Sin esto, "reconectando" saldria tambien al abrir el chat por primera vez, y
 * un aviso que aparece cuando todo va bien deja de significar algo.
 */
let vozEstuvoLista = false

/**
 * Se conecta al entrar, pero SIN prender el microfono.
 *
 * EL STREAM SE ASIGNA SOLO SI CONECTO. Antes se asignaba antes de `connect()`,
 * asi que un fallo de red dejaba `soniox` apuntando a un objeto roto pero NO
 * nulo -- y `encenderMic()` solo rearmaba cuando era nulo. Resultado: todos los
 * dictados siguientes usaban ese stream muerto (ws:CLOSED, el contador de
 * chunks subiendo, nada mas), y la unica salida era cerrar la app.
 */
async function prepare(): Promise<void> {
  vozEstuvoLista = false
  const nuevo = new SonioxStream({
    onPartial: t => pintarVoz(t),
    onFinal: t => { draft = t; pintarVoz(t); if (screen === 'DICTATE') persist() },
    onError: m => { lastNote = m; pintarVoz(ultimoPintado || draft) },
    // El cierre ya no se anuncia solo: quien manda es onEstado, porque
    // reconectar es automatico y "socket cerrado (1006)" no le sirve a nadie.
    onClosed: () => {},
    onEstado: e => {
      if (e === 'listo') { vozEstuvoLista = true; lastNote = '' }
      else if (e === 'conectando') {
        lastNote = vozEstuvoLista ? 'sin red: reconectando...' : ''
      } else {
        lastNote = 'sin conexion. Suelta y vuelve a intentar.'
      }
      pintarVoz(ultimoPintado || draft)
    },
  })
  await nuevo.connect()
  soniox = nuevo          // recien aca: si connect() fallo, no queda basura
}

/** Enciende el microfono. Comun al dictado y a la busqueda. */
async function encenderMic(): Promise<void> {
  micOk = null; chunks = 0; bytes = 0; lastNote = ''; draft = ''; ultimoPintado = ''
  // No basta con que exista: un stream que se quedo cerrado no sirve, y
  // reusarlo es justo lo que dejaba la app muda hasta reiniciarla.
  if (!soniox || soniox.state === 'CLOSED') {
    try { await prepare() } catch { /* ya se mostro el error */ }
  }
  // audioControl devuelve boolean. Ignorarlo fue el bug: la pantalla decia
  // "Grabando" con el microfono apagado.
  try {
    micOk = await bridge.audioControl(true, AudioInputSource.Glasses)
  } catch (err) {
    micOk = false
    lastNote = `audioControl: ${String(err).slice(0, 60)}`
  }
}

/**
 * Apaga el microfono y devuelve lo que Soniox alcanzo a confirmar.
 *
 * Se ESPERA el cierre limpio: cerrar el socket de golpe tiraba todo lo que
 * estuviera en vuelo. Quien llama decide si le basta con eso o prefiere lo que
 * habia en pantalla.
 */
async function apagarMic(): Promise<string> {
  lastReleaseAt = Date.now()
  await bridge.audioControl(false)
  const confirmado = soniox ? await soniox.cerrar() : ''
  soniox = null
  return confirmado
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
/**
 * Un pendiente en un renglon: circulo, quien, y lo que dijo.
 *
 * El circulo ancla la linea. Sin el, seis renglones seguidos se leen como un
 * parrafo corrido y no como mensajes distintos -- probado en el simulador.
 */
const PANEL_CARS = 38   // medido en el simulador con el panel a 414 px

const lineaPendiente = (p: Pendiente): string => {
  const marca = p.kind === 'grupo' ? '\u25cf' : '\u25cb'
  const quien = p.quien.slice(0, 20)
  // El panel ENVUELVE el texto, no lo corta: un mensaje largo -- una URL, por
  // ejemplo -- se come el renglon del siguiente y la bandeja pierde entradas
  // sin avisar. Se recorta para que cada pendiente ocupe UNA linea.
  const hueco = PANEL_CARS - quien.length - 4
  const texto = p.text.length > hueco ? `${p.text.slice(0, hueco - 1)}\u2026` : p.text
  return `${marca} ${quien}  ${texto}`
}


/**
 * Pantalla de inicio: apps a la izquierda, bandeja a la derecha.
 *
 * La bandeja se trae SIN bloquear el dibujado: si la red tarda, la pantalla
 * aparece igual con las apps listas y el panel se llena despues. Esperarla
 * antes de pintar dejaria la app en blanco justo al abrirla.
 */
/**
 * Abre un pendiente: lo marca leido y entra a su conversacion.
 *
 * El marcado NO se espera: entrar al chat es lo que el usuario pidio, y
 * bloquearlo por una confirmacion de red haria que la app se sienta lenta por
 * algo que a el no le importa. Si falla, se reintenta la proxima vez.
 */
async function marcarLeidoYAbrir(p: Pendiente): Promise<void> {
  void marcarLeido(p.peer).catch(() => {})
  pendientes = pendientes.filter(x => x.peer !== p.peer)
  provider = providers.find(x => p.peer.startsWith(`${x.id}:`)) ?? null
  target = { id: p.peer, name: p.quien }
  await toRead()
}

/** Pantalla raiz: el foco arranca en la bandeja, que es lo que se mira. */
async function toInicio(): Promise<void> {
  stopPolling()
  screen = 'INICIO'
  target = null; provider = null; query = ''
  await apagarMic()
  await pintarInicio()
  void refrescarBandeja()
}

/** Misma pantalla, foco en las aplicaciones. */
async function toApps(): Promise<void> {
  stopPolling()
  screen = 'APPS'
  target = null; provider = null; query = ''
  await apagarMic()
  await pintarInicio()
}

/**
 * Las dos salidas van ESCRITAS, una en cada caja. Mover el foco es el unico
 * gesto que la pantalla no tiene ya asignado, y esconderlo detras de un doble
 * tap lo dejaria sin descubrir -- ademas de robarle al doble tap su unico
 * significado en la raiz, que es salir de la app (lo exige la revision).
 */
const IR_APPS = '\u2192 Aplicaciones'
const IR_BANDEJA = '\u2190 Volver'

const filasBandeja = (): string[] =>
  pendientes.length
    ? [...pendientes.map(lineaPendiente), IR_APPS]
    : ['Sin mensajes pendientes', IR_APPS]

const filasApps = (): string[] => [...providers.map(etiqueta), IR_BANDEJA]

async function pintarInicio(): Promise<void> {
  const n = pendientes.length
  const titulo = n === 0 ? 'VozGram'
    : n === 1 ? 'VozGram \u00b7 1 pendiente'
    : `VozGram \u00b7 ${n} pendientes`
  clockShown = hhmm()
  const foco = screen === 'APPS' ? 'apps' : 'bandeja'
  mirror(`${titulo}\n\n${filasBandeja().join('\n')}`)
  await bleCall(
    () => bridge.rebuildPageContainer(
      rebuildInicio(foco, filasApps(), filasBandeja(), titulo, clockShown)),
    'rebuild:inicio',
  )
}

async function refrescarBandeja(): Promise<void> {
  try {
    const { pendientes: nuevos } = await getUnread(6)
    // Si el usuario ya se movio de pantalla, pintar aqui seria pisarle lo que
    // esta viendo con una pantalla que ya dejo atras.
    if (screen !== 'INICIO' && screen !== 'APPS') { pendientes = nuevos; return }
    const antes = pendientes.map(p => p.peer + p.text).join('|')
    pendientes = nuevos
    if (antes !== nuevos.map(p => p.peer + p.text).join('|')) await pintarInicio()
  } catch (err) {
    note(`bandeja: ${String(err).slice(0, 60)}`)
  }
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
      await gotoText(`No se pudo cargar la lista.\n${String(err)}`, PISTA_VOLVER)
      return
    }
    if (screen !== 'PICK') return
  }

  await gotoList(
    contacts.length ? contacts.map(marcar) : ['(sin resultados)'],
    tituloLista(),
  )
}

async function toRead(): Promise<void> {
  screen = 'READ'
  draft = ''
  pages = ['cargando...']; page = 0
  await gotoText(readView(), PISTA_LEER)

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
  await setPista('')          // grabando, la pista estorba
  await setText(dictateView(''))
  await encenderMic()
  await setText(dictateView(''))
}

/** SOLTAR en DICTATE: se apaga el microfono y se pasa a confirmar. */
async function stopListening(): Promise<void> {
  if (screen !== 'DICTATE') return
  const confirmado = await apagarMic()
  // Tres candidatos: lo que Soniox confirmo al cerrar, lo ultimo que se vio en
  // pantalla, y lo que ya habia. Se toma el mas completo.
  draft = masCompleto(confirmado, ultimoPintado, draft)
  screen = 'CONFIRM'
  const cuerpo = draft.trim() || '(no se escuchó nada)'
  await gotoText(`Enviar a ${who()}:\n\n${cuerpo}`, PISTA_CONFIRMAR)
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
  const confirmado = await apagarMic()
  // Mismo problema que al dictar: soltar rapido dejaba la busqueda vacia y
  // parecia que el microfono no habia oido nada.
  draft = masCompleto(confirmado, ultimoPintado, draft)
  query = draft.trim()
  draft = ''
  await toPick()
}

async function doSend(): Promise<void> {
  if (busy || !target || !draft.trim()) return
  busy = true
  // La pista se BORRA mientras se envia: decia "• enviar", y un toque ahora
  // no hace nada. Una instruccion que no funciona es peor que ninguna.
  await setPista('')
  await setText(`Enviando a ${who()}...`)
  try {
    await sendMessage(target.id, draft.trim())
    await setText('Enviado ✓')
    draft = ''
    persist()
    // Volver AL CHAT, no al menu: acabas de escribir, quieres ver la respuesta.
    setTimeout(() => { toRead() }, 1200)
  } catch (err) {
    // Sin respuesta NO se dice "fallo": pudo haber salido, y reintentar a
    // ciegas lo mandaria dos veces. Volver al chat recarga el historial y ahi
    // se ve si esta.
    await setText(err instanceof SinRespuesta
      ? 'No se confirmó el envío.\n\nPuede que sí haya llegado: revisa el chat antes de reintentar.'
      : `FALLÓ el envío.\n${String(err)}`)
    await setPista(PISTA_REINTENTAR)
  } finally {
    busy = false
  }
}

// --- Arranque ---------------------------------------------------------------
clockShown = hhmm()
let ok = await bridge.createStartUpPageContainer(startUpWithText('VozGram\n\nCargando...', clockShown))
// 1 NO siempre es "contenedor invalido": tambien significa que la pagina YA
// EXISTE, cuando la WebView se recarga sobre la app ya arrancada. Rendirse
// ahi dejaria la app muerta por algo que se arregla reconstruyendo.
if (ok === 1 && await bridge.rebuildPageContainer(rebuildWithText('VozGram\n\nCargando...', clockShown))) ok = 0
if (ok !== 0) throw new Error(`createStartUpPageContainer fallo: ${ok}`)
lastRendered = 'VozGram\n\nCargando...'
mirror(lastRendered)

// --- Eventos: se escuchan DESDE AQUI ----------------------------------------
// En cuanto hay algo en los lentes, el doble toque tiene que poder salir. Antes
// el manejador se registraba al FINAL del arranque, despues de leer el
// borrador y de hablar con el backend: si cualquiera de las dos se colgaba, la
// pantalla decia "Cargando..." y el doble toque no hacia nada. Es causal de
// rechazo en la revision del portal.
//
// Hasta que el arranque termina solo se atiende el doble toque, y solo para
// salir: el resto de la app todavia no existe. `?? -1` y no `?? 0`: un sysEvent
// sin eventType es un TOQUE, y aqui el toque no hace nada.
let arrancado = false
const unsubscribe = bridge.onEvenHubEvent(event => {
  if (arrancado) { manejarEvento(event); return }
  if ((event.sysEvent?.eventType ?? -1) === OsEventTypeList.DOUBLE_CLICK_EVENT) {
    void bridge.shutDownPageContainer(1).catch(() => {})
  }
})

// Con tope: `getLocalStorage` puede no volver nunca en los lentes, y sin
// borrador guardado la app funciona igual.
draft = (await Promise.race([
  bridge.getLocalStorage(STORAGE_KEY),
  new Promise<string>(r => setTimeout(() => r(''), BLE_TIMEOUT_MS)),
])) || ''

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
    await toInicio()
  } else {
    // Un solo mensajero (o backend viejo): el menu de apps seria una lista de
    // un elemento, o sea un paso regalado. Vamos directo a los chats.
    provider = providers[0] ?? null
    await toPick()
  }
} catch (err) {
  await gotoText(`No se pudo hablar con el backend.\n${String(err)}`)
}
arrancado = true

// --- Eventos ----------------------------------------------------------------
// Una DECLARACION de funcion y no una constante: se iza, asi que el manejador
// registrado arriba, junto a la primera pantalla, ya la conoce. Solo se llama
// con `arrancado`, cuando todo lo que toca ya esta declarado.
// PROTOBUF: los ceros llegan como undefined. El `?? 0` NO es opcional.
function manejarEvento(event: EvenHubEvent): void {
  if (event.audioEvent?.audioPcm) {
    chunks++
    bytes += event.audioEvent.audioPcm.length
    soniox?.send(event.audioEvent.audioPcm)
    if ((screen === 'DICTATE' || screen === 'SEARCH') && chunks % 10 === 0) pintarVoz(draft)
    return
  }

  if (event.listEvent) {
    const i = event.listEvent.currentSelectItemIndex ?? 0
    if (screen === 'INICIO') {
      // La ultima fila NO es un mensaje: es el paso a las aplicaciones.
      const filas = filasBandeja()
      if (filas[i] === IR_APPS) { void toApps(); return }
      const p = pendientes[i]
      if (!p) return
      // Entrar a leerlo ES leerlo: se marca en el mensajero y sale de la
      // bandeja. Asomarse a la lista no marca nada.
      void marcarLeidoYAbrir(p)
      return
    }
    if (screen === 'APPS') {
      if (filasApps()[i] === IR_BANDEJA) { void toInicio(); return }
      const elegido = providers[i] ?? null
      if (!elegido) return
      // Un mensajero roto no se esconde de la lista: sigue ahi, con su motivo.
      // Desaparecerlo dejaria al usuario preguntandose si borro la app.
      if (!entrable(elegido)) {
        provider = elegido
        screen = 'INFO'
        void gotoText(explicar(elegido), PISTA_VOLVER)
        return
      }
      provider = elegido
      toPick()
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
    if (screen === 'INICIO') {
      // La RAIZ. Aqui el doble tap solo significa salir: la revision del
      // portal exige que abra el dialogo del sistema, y darle otro sentido
      // seria quitarle el unico que no se puede negociar.
      bridge.shutDownPageContainer(1)
    } else if (screen === 'APPS') {
      toInicio()
    } else if (screen === 'INFO') {
      toInicio()
    } else if (screen === 'PICK') {
      // Atras en dos tiempos: primero se suelta la busqueda, despues se sale.
      if (query) { query = ''; toPick() }
      else toInicio()
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
}

function cleanup(): void {
  clearInterval(clockTimer)
  stopPolling()
  bridge.audioControl(false)
  soniox?.close()
  unsubscribe()
}
window.addEventListener('beforeunload', cleanup)
