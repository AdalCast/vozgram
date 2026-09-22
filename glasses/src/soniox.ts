import { SONIOX_WS_URL, SONIOX_MODEL } from './config'
import { getSonioxKey } from './api'

export interface SonioxHandlers {
  onPartial: (text: string) => void  // texto provisional, puede cambiar
  onFinal: (text: string) => void    // texto confirmado, no cambia mas
  onError: (err: string) => void
  onClosed?: (code: number) => void  // Soniox cerro la sesion
  /**
   * Como esta la conexion AHORA. Existe porque en los lentes no hay consola:
   * si el socket se cae y no se dice, lo unico que ve el usuario es que dicta
   * y no pasa nada.
   */
  onEstado?: (e: 'conectando' | 'listo' | 'sin-conexion') => void
}

/** Reintentos antes de rendirse, y cuanto se espera entre cada uno. */
const MAX_REINTENTOS = 5
const espera = (n: number): number => Math.min(400 * 2 ** n, 5000)

/**
 * Cuanto audio se guarda mientras el socket esta caido, en bytes.
 *
 * A 16 kHz mono de 16 bits son 32000 bytes por segundo: esto son ~6 segundos.
 * Existe porque el microfono NO se apaga cuando se cae la red -- el usuario
 * sigue hablando. Sin esto, esos segundos se tiran y las palabras desaparecen
 * del mensaje sin que nada lo indique.
 *
 * Tiene tope porque un corte largo con el dedo apretado llenaria la memoria
 * de la WebView. Pasado el tope se descarta lo MAS VIEJO: si hay que perder
 * algo, que sea lo que ya quedo lejos y no lo que acaba de decir.
 */
const TOPE_BUFFER = 192_000

/**
 * Cliente de Soniox realtime.
 *
 * IMPORTANTE: la clave madre NUNCA llega al WebView. El backend acuña una
 * clave temporal que EXPIRA A LOS 300 s -- no es de un solo uso, como decia
 * antes este comentario. La diferencia importa: por eso se puede reutilizar
 * entre reconexiones en vez de pedir una nueva cada vez.
 *
 * OJO CON EL BACKGROUND: cuando el telefono se va a background el host
 * DESTRUYE esta WebView y crea una headless nueva. Este socket NO sobrevive.
 * El texto acumulado se persiste aparte con setBackgroundState (ver main.ts);
 * el socket se reabre llamando connect() de nuevo.
 */
export class SonioxStream {
  /** Lo arma `cerrar()` mientras espera la ultima confirmacion. */
  private alQuedarLimpio: (() => void) | null = null

  private ws: WebSocket | null = null
  private finalText = ''
  private handlers: SonioxHandlers

  /** true cuando el cierre lo pedimos nosotros: entonces NO se reconecta. */
  private cerradoAdrede = false
  private reintentos = 0
  /**
   * Una sola cadena de reintentos a la vez.
   *
   * MEDIDO: sin esto se rendia en 4 s cuando el respaldo debia durar 11. Un
   * `connect()` fallido deja un socket muerto que TAMBIEN dispara `onclose`,
   * asi que cada fallo lanzaba dos cadenas, y esas dos lanzaban cuatro. Los
   * cinco intentos se quemaban al doble de velocidad y la app se rendia con la
   * red a punto de volver.
   */
  private reconectando = false
  /** Audio que llego con el socket caido, a la espera de que vuelva. */
  private pendiente: Uint8Array[] = []
  private pendienteBytes = 0

  /**
   * La llave, guardada mientras siga viva.
   *
   * POR QUE: el backend la acuña con 300 s de vida y su endpoint tiene un
   * limitador de 60 peticiones cada 15 min. Sin esto, una racha de
   * reconexiones -justo lo que pasa en una red mala- pedia una llave por
   * intento y podia agotar ese cupo, convirtiendo un parpadeo de red en un 429
   * que se ve como "sin conexion".
   *
   * El margen de 60 s evita estrenar una llave que esta por vencer en mitad
   * del dictado.
   */
  private llave = ''
  private llaveHasta = 0

  constructor(handlers: SonioxHandlers) {
    this.handlers = handlers
  }

  async connect(): Promise<void> {
    this.cerradoAdrede = false
    this.handlers.onEstado?.('conectando')

    // 1. La clave temporal: se reusa si le queda vida (ver `llave`).
    if (!this.llave || Date.now() > this.llaveHasta) {
      const { api_key } = await getSonioxKey()
      this.llave = api_key
      this.llaveHasta = Date.now() + (300 - 60) * 1000
    }
    const api_key = this.llave

    // 2. Abrir el socket contra Soniox
    const ws = new WebSocket(SONIOX_WS_URL)
    ws.binaryType = 'arraybuffer'
    this.ws = ws

    await new Promise<void>((resolve, reject) => {
      ws.onopen = () => {
        // 3. Primer mensaje: configuracion. Formato identico al PCM del G2.
        ws.send(JSON.stringify({
          api_key,
          model: SONIOX_MODEL,
          audio_format: 'pcm_s16le',
          sample_rate: 16000,
          num_channels: 1,
          language_hints: ['es', 'en'],
          enable_endpoint_detection: true,
        }))
        this.reintentos = 0
        this.handlers.onEstado?.('listo')
        // Lo que se hablo mientras el socket estuvo caido se manda ahora, en
        // orden. Para Soniox es audio continuo: no nota el hueco.
        const cola = this.pendiente
        this.pendiente = []
        this.pendienteBytes = 0
        for (const chunk of cola) ws.send(chunk)
        resolve()
      }
      ws.onerror = () => reject(new Error('no se pudo conectar a Soniox'))
    })

    /**
     * Si el socket se cae SOLO -la red del usuario parpadeo, por ejemplo- hay
     * que volver a levantarlo. Antes esto solo lo anotaba: el microfono seguia
     * encendido mandando audio a un socket cerrado, el contador de chunks
     * subia, y no pasaba nada mas. La unica salida era cerrar la app.
     *
     * `finalText` vive en ESTA instancia, no en el socket, asi que lo ya
     * transcrito sobrevive a la reconexion.
     */
    ws.onclose = (ev) => {
      this.handlers.onClosed?.(ev.code)
      if (this.cerradoAdrede) return
      void this.reconectar()
    }

    ws.onmessage = (ev) => {
      const msg = JSON.parse(typeof ev.data === 'string' ? ev.data : '{}')
      if (msg.error_code) return this.handlers.onError(String(msg.error_message ?? msg.error_code))

      // `<end>` es un token de CONTROL de Soniox (endpoint detection), no texto.
      // Marca que el hablante termino una frase. Si no se filtra, aparece
      // literalmente dentro del mensaje.
      let partial = ''
      for (const t of msg.tokens ?? []) {
        const txt: string = t.text ?? ''
        if (txt === '<end>') {
          // Lo usamos como separador para que no se peguen las frases.
          if (this.finalText && !/\s$/.test(this.finalText)) this.finalText += ' '
          continue
        }
        if (t.is_final) this.finalText += txt
        else partial += txt
      }
      if (partial) {
        this.handlers.onPartial(this.finalText + partial)
      } else {
        this.handlers.onFinal(this.finalText)
        // Ya no queda nada en vuelo: si alguien espera el cierre limpio, este
        // es el momento en que Soniox termino de confirmar.
        this.alQuedarLimpio?.()
      }
    }
  }

  /**
   * Vuelve a levantar el socket, con esperas que crecen.
   *
   * Crecen porque en una red que parpadea, reintentar cada 100 ms no la
   * arregla y si gasta bateria. Y hay tope de intentos porque rendirse
   * DICIENDOLO es mejor que seguir en un ciclo que el usuario no ve.
   */
  private async reconectar(): Promise<void> {
    if (this.cerradoAdrede || this.reconectando) return
    this.reconectando = true
    try {
      while (!this.cerradoAdrede && this.reintentos < MAX_REINTENTOS) {
        const ms = espera(this.reintentos)
        this.reintentos++
        await new Promise(r => setTimeout(r, ms))
        if (this.cerradoAdrede) return
        try {
          await this.connect()
          return                      // `onopen` ya puso reintentos en 0
        } catch {
          // Siguiente vuelta del bucle. El onclose del socket muerto no abre
          // otra cadena: lo frena `reconectando`.
        }
      }
      if (!this.cerradoAdrede) {
        this.handlers.onEstado?.('sin-conexion')
        this.handlers.onError('sin conexion con el transcriptor')
      }
    } finally {
      this.reconectando = false
    }
  }

  /**
   * Empuja un chunk de PCM crudo tal cual sale de los lentes.
   *
   * Con el socket caido NO se tira: se guarda. El microfono no se apaga porque
   * la red falle, y el usuario sigue hablando -- descartar esos segundos hacia
   * desaparecer palabras del mensaje sin ninguna señal.
   */
  send(pcm: Uint8Array): void {
    if (this.ws?.readyState === WebSocket.OPEN) { this.ws.send(pcm); return }
    this.pendiente.push(pcm)
    this.pendienteBytes += pcm.length
    // Se descarta lo MAS VIEJO: si hay que perder algo, que sea lo que ya
    // quedo lejos y no lo que el usuario acaba de decir.
    while (this.pendienteBytes > TOPE_BUFFER && this.pendiente.length > 1) {
      const fuera = this.pendiente.shift()
      this.pendienteBytes -= fuera?.length ?? 0
    }
  }

  /** Cierre ABRUPTO. Para salir de la app; tira lo que este en vuelo. */
  close(): void {
    this.cerradoAdrede = true
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send('')
    this.ws?.close()
    this.ws = null
  }

  /**
   * Cierra ESPERANDO a que Soniox confirme lo que quedo en vuelo, y devuelve
   * el texto completo.
   *
   * POR QUE EXISTE: el string vacio le dice a Soniox "termine de hablar", pero
   * `close()` cerraba el socket en el MISMO instante, sin darle tiempo a
   * contestar. Todo lo que estuviera como parcial se perdia -- y los parciales
   * son justo lo que el usuario esta viendo escribirse en la pantalla. Soltar
   * el tap un segundo antes borraba el mensaje entero, no la ultima palabra.
   *
   * El tope existe porque esto pasa con el dedo levantado y la pantalla
   * esperando: mas de un segundo largo se siente como que la app se colgo.
   * Si vence, se devuelve lo confirmado hasta ese momento y quien llama decide
   * si prefiere lo que habia en pantalla.
   */
  async cerrar(topeMs = 1200): Promise<string> {
    this.cerradoAdrede = true          // a partir de aqui NO se reconecta
    const ws = this.ws
    if (!ws || ws.readyState !== WebSocket.OPEN) { this.ws = null; return this.finalText }

    ws.send('')
    await new Promise<void>(listo => {
      let hecho = false
      const terminar = (): void => {
        if (hecho) return
        hecho = true
        clearTimeout(reloj)
        this.alQuedarLimpio = null
        listo()
      }
      const reloj = setTimeout(terminar, topeMs)
      this.alQuedarLimpio = terminar
      // Si Soniox cierra por su cuenta tampoco hay nada mas que esperar.
      ws.addEventListener('close', terminar, { once: true })
    })

    ws.close()
    this.ws = null
    return this.finalText
  }

  /** Estado del socket, para diagnostico en pantalla. */
  get state(): string {
    if (!this.ws) return 'NULL'
    return ['CONNECTING','OPEN','CLOSING','CLOSED'][this.ws.readyState] ?? '?'
  }

  get transcript(): string { return this.finalText }
  set transcript(v: string) { this.finalText = v }
}
