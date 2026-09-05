import { SONIOX_WS_URL, SONIOX_MODEL } from './config'
import { getSonioxKey } from './api'

export interface SonioxHandlers {
  onPartial: (text: string) => void  // texto provisional, puede cambiar
  onFinal: (text: string) => void    // texto confirmado, no cambia mas
  onError: (err: string) => void
  onClosed?: (code: number) => void  // Soniox cerro la sesion
}

/**
 * Cliente de Soniox realtime.
 *
 * IMPORTANTE: la clave madre NUNCA llega al WebView. El backend acuña una
 * clave temporal single-use y solo esa viaja hasta aca.
 *
 * OJO CON EL BACKGROUND: cuando el telefono se va a background el host
 * DESTRUYE esta WebView y crea una headless nueva. Este socket NO sobrevive.
 * El texto acumulado se persiste aparte con setBackgroundState (ver main.ts);
 * el socket se reabre llamando connect() de nuevo.
 */
export class SonioxStream {
  private ws: WebSocket | null = null
  private finalText = ''
  private handlers: SonioxHandlers

  constructor(handlers: SonioxHandlers) {
    this.handlers = handlers
  }

  async connect(): Promise<void> {
    // 1. Pedirle al backend una clave temporal de un solo uso
    const { api_key } = await getSonioxKey()

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
        resolve()
      }
      ws.onerror = () => reject(new Error('no se pudo conectar a Soniox'))
    })

    // Si Soniox cierra, hay que enterarse: sin esto seguimos mandando al vacio.
    ws.onclose = (ev) => { this.handlers.onClosed?.(ev.code) }

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
      if (partial) this.handlers.onPartial(this.finalText + partial)
      else this.handlers.onFinal(this.finalText)
    }
  }

  /** Empuja un chunk de PCM crudo tal cual sale de los lentes. */
  send(pcm: Uint8Array): void {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(pcm)
  }

  /** Cierra el stream. El string vacio le dice a Soniox "termine de hablar". */
  close(): void {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send('')
    this.ws?.close()
    this.ws = null
  }

  /** Estado del socket, para diagnostico en pantalla. */
  get state(): string {
    if (!this.ws) return 'NULL'
    return ['CONNECTING','OPEN','CLOSING','CLOSED'][this.ws.readyState] ?? '?'
  }

  get transcript(): string { return this.finalText }
  set transcript(v: string) { this.finalText = v }
}
