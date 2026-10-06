/**
 * Lo que se muestra de un mensaje que no es (solo) texto: `[imagen]`,
 * `[sticker]`, `[nota de voz] 0:14`...
 *
 * POR QUE EXISTE: un mensaje sin texto se DESCARTABA. En Telegram se perdia de
 * la vista; en WhatsApp se perdia y punto, porque ni llegaba a la base de datos
 * y WhatsApp no reenvia lo que no se recibio. Una foto de alguien quedaba como
 * si nunca la hubiera mandado, y la bandeja mostraba un mensaje viejo como si
 * fuera lo pendiente.
 *
 * Vive aparte y SIN NADA de las librerias -- ni GramJS ni Baileys -- para poder
 * probarlo con mensajes inventados. Lee los mensajes por su forma, no por su
 * clase.
 *
 * Los textos son los mismos que VozGram2 en español, a proposito: las dos apps
 * se ven igual en los lentes.
 */

export const MARCA = {
  imagen: '[imagen]',
  video: '[video]',
  videonota: '[videonota]',
  gif: '[GIF]',
  sticker: '[sticker]',
  notaDeVoz: '[nota de voz]',
  audio: '[audio]',
  ubicacion: '[ubicacion]',
  lugar: '[lugar]',
  contacto: '[contacto]',
  encuesta: '[encuesta]',
  evento: '[evento]',
  historia: '[historia]',
  dado: '[dado]',
  juego: '[juego]',
  adjunto: '[adjunto]',
  archivo: '[archivo]',
} as const

/** 14 -> "0:14", 95 -> "1:35". */
export const mmss = (s: number): string =>
  `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`

/**
 * Marca y texto juntos. Con pie de foto se ve "[imagen] mira esto", que dice lo
 * que hay Y lo que dijeron. Sin pie, solo la marca.
 */
export const conMarca = (marca: string, texto: string): string =>
  !marca ? texto : texto ? `${marca} ${texto}` : marca

/** Nombre de archivo recortado: comparte renglon con el resto. */
const nombreArchivo = (n: string): string => `[${n.slice(0, 24)}]`

// --- Telegram (GramJS) -------------------------------------------------------

/** La marca de un mensaje de GramJS, o '' si no trae nada que marcar. */
export function marcaTelegram(m: unknown): string {
  const media = (m as { media?: { className?: string } }).media
  if (!media) return ''

  switch (media.className) {
    case 'MessageMediaPhoto': return MARCA.imagen
    case 'MessageMediaGeo':
    case 'MessageMediaGeoLive': return MARCA.ubicacion
    case 'MessageMediaVenue': return MARCA.lugar
    case 'MessageMediaContact': return MARCA.contacto
    case 'MessageMediaPoll': return MARCA.encuesta
    case 'MessageMediaDice': return MARCA.dado
    case 'MessageMediaGame': return MARCA.juego
    case 'MessageMediaStory': return MARCA.historia
    // Una vista previa de enlace acompaña a un mensaje que SI trae texto: el
    // texto ya se muestra, y marcarlo ademas seria ruido. Y un medio VACIO no
    // es nada que marcar.
    case 'MessageMediaWebPage':
    case 'MessageMediaEmpty': return ''
    case 'MessageMediaDocument': break
    default: return MARCA.adjunto
  }

  // Un "documento" de Telegram es casi cualquier cosa: sticker, video, audio,
  // GIF o archivo. Lo que lo distingue son sus atributos, no su tipo.
  type Atributo = { className?: string; voice?: boolean; roundMessage?: boolean; fileName?: string; duration?: number }
  const attrs = (media as { document?: { attributes?: Atributo[] } }).document?.attributes ?? []
  const tiene = (c: string) => attrs.find(a => a.className === c)

  if (tiene('DocumentAttributeSticker')) return MARCA.sticker
  if (tiene('DocumentAttributeAnimated')) return MARCA.gif

  const audio = tiene('DocumentAttributeAudio')
  // La duracion al lado: saber si son seis segundos o dos minutos ya dice algo
  // del mensaje.
  if (audio) return audio.voice ? `${MARCA.notaDeVoz} ${mmss(audio.duration ?? 0)}` : MARCA.audio

  const video = tiene('DocumentAttributeVideo')
  if (video) return video.roundMessage ? MARCA.videonota : MARCA.video

  const archivo = tiene('DocumentAttributeFilename')
  if (archivo?.fileName) return nombreArchivo(archivo.fileName)
  return MARCA.archivo
}

/** Lo que se muestra de un mensaje de GramJS: su texto, su marca, o las dos. */
export function textoTelegram(m: unknown): string {
  const crudo = (m as { message?: unknown }).message
  return conMarca(marcaTelegram(m), typeof crudo === 'string' ? crudo : '')
}

// --- WhatsApp (Baileys) ------------------------------------------------------

type Contenido = Record<string, unknown> | null | undefined
type ConTexto = { caption?: string | null; name?: string | null; seconds?: number | null; ptt?: boolean | null; gifPlayback?: boolean | null; fileName?: string | null } | null | undefined

/**
 * Envolturas que traen el mensaje de verdad adentro: "ver una vez", mensajes
 * temporales, documento con pie. Sin abrirlas, una foto de "ver una vez" se
 * veria como nada.
 */
const ENVOLTURAS = [
  'ephemeralMessage', 'viewOnceMessage', 'viewOnceMessageV2', 'viewOnceMessageV2Extension',
  'documentWithCaptionMessage', 'groupMentionedMessage',
] as const

function desenvolver(c: Contenido): Contenido {
  // Con tope: una envoltura puede traer otra adentro (temporal + ver una vez).
  for (let i = 0; i < 4 && c; i++) {
    const k = ENVOLTURAS.find(e => (c?.[e] as { message?: unknown } | undefined)?.message)
    if (!k) break
    c = (c[k] as { message: Contenido }).message
  }
  return c
}

/**
 * Lo que se muestra de un mensaje de WhatsApp (`m.message` de Baileys), o ''
 * si no hay nada que mostrar.
 *
 * SOLO SE MARCAN TIPOS CONOCIDOS. WhatsApp manda por el mismo canal muchas
 * cosas que no son mensajes: reacciones, avisos de borrado y edicion, fijados,
 * claves de cifrado de grupo. Hasta ahora se descartaban por no tener texto;
 * con un "[adjunto]" por defecto llenarian la bandeja de mensajes falsos. Lo
 * desconocido devuelve '' y se sigue descartando, igual que antes.
 */
export function textoWhatsApp(contenido: unknown): string {
  const c = desenvolver(contenido as Contenido)
  if (!c) return ''
  const de = (k: string) => c[k] as ConTexto
  const pie = (k: string) => de(k)?.caption ?? ''

  const texto = (c.conversation as string | null | undefined)
    ?? (c.extendedTextMessage as { text?: string | null } | null | undefined)?.text
  if (texto) return texto

  if (de('imageMessage')) return conMarca(MARCA.imagen, pie('imageMessage'))
  if (de('videoMessage')) {
    return conMarca(de('videoMessage')?.gifPlayback ? MARCA.gif : MARCA.video, pie('videoMessage'))
  }
  if (de('ptvMessage')) return MARCA.videonota
  if (de('stickerMessage') || de('lottieStickerMessage')) return MARCA.sticker
  const audio = de('audioMessage')
  if (audio) return audio.ptt ? `${MARCA.notaDeVoz} ${mmss(audio.seconds ?? 0)}` : MARCA.audio
  const doc = de('documentMessage')
  if (doc) return conMarca(doc.fileName ? nombreArchivo(doc.fileName) : MARCA.archivo, doc.caption ?? '')
  if (de('locationMessage') || de('liveLocationMessage')) {
    // Con nombre es un LUGAR ("Cafe Tacuba"), sin nombre un punto en el mapa.
    const nombre = de('locationMessage')?.name ?? ''
    return nombre ? conMarca(MARCA.lugar, nombre) : MARCA.ubicacion
  }
  if (de('contactMessage') || de('contactsArrayMessage')) return MARCA.contacto
  for (const k of ['pollCreationMessage', 'pollCreationMessageV2', 'pollCreationMessageV3']) {
    // La pregunta de la encuesta SI se muestra: es lo que hay que contestar.
    if (de(k)) return conMarca(MARCA.encuesta, de(k)?.name ?? '')
  }
  if (de('eventMessage')) return conMarca(MARCA.evento, de('eventMessage')?.name ?? '')
  return ''
}
