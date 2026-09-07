/**
 * EL CONTRATO.
 *
 * Aca no hay implementacion: solo se declara QUE tiene que saber hacer un
 * mensajero para que VozGram pueda usarlo. Los endpoints hablan con esta
 * interfaz y NUNCA con Telegram, WhatsApp o quien sea directamente.
 *
 * La analogia es el enchufe de la pared: la pared define la FORMA del enchufe,
 * no que aparato vas a conectar. Agregar un mensajero nuevo pasa a ser escribir
 * un archivo que cumpla este contrato, sin tocar nada mas.
 */

export interface Contact {
  id: string
  name: string
  /**
   * Ultima actividad, en segundos epoch. Existe para poder MEZCLAR chats de
   * mensajeros distintos en un solo orden: sin esto, cada adaptador devuelve
   * su lista bien ordenada pero no hay forma de intercalarlas con sentido.
   */
  updatedAt?: number
}

export interface Msg {
  /** true = lo mandaste tu; false = te lo mandaron */
  out: boolean
  text: string
  /**
   * Quien lo escribio. Solo tiene sentido en GRUPOS: en un chat de a dos, `out`
   * ya lo dice todo. Sin esto, en un grupo todos los mensajes se ven iguales y
   * no se sabe quien dijo que.
   */
  sender?: string
}

/**
 * Estado de la conexion de un mensajero.
 *
 * Existe porque un mensajero puede estar roto de maneras DISTINTAS, y la
 * diferencia le importa a quien trae los lentes puestos:
 *   - 'desvinculado' solo lo arregla una persona, en el servidor. Esperar no
 *     sirve de nada, asi que hay que decirlo.
 *   - 'caido' se puede arreglar solo en la proxima reconexion. Conviene
 *     esperar y no mandar a nadie a tocar el servidor de madrugada.
 * Sin esta distincion las dos se ven igual: un error sin explicacion.
 */
export type EstadoMensajero = 'listo' | 'conectando' | 'desvinculado' | 'caido'

export interface MessagingProvider {
  /** Identificador corto y estable. Sirve para elegir adaptador y para los logs. */
  readonly id: string

  /** Nombre para mostrarle a una persona, en el menu de mensajeros. */
  readonly label: string

  /**
   * Chats recientes, para armar el menu de destinatarios en los lentes.
   * Con `q`, filtra por nombre en TODOS los chats, no solo en los recientes:
   * buscar sirve justamente para llegar a quien no esta arriba.
   */
  listContacts(limit?: number, q?: string): Promise<Contact[]>

  /** Ultimos mensajes de un chat, en orden cronologico (el mas viejo primero). */
  getHistory(peer: string, limit?: number): Promise<Msg[]>

  sendMessage(peer: string, text: string): Promise<void>

  /**
   * Estado de la conexion, SIN abrirla ni tocar la red.
   *
   * OPCIONAL a proposito: un mensajero que se conecta por pedido -- como
   * Telegram -- no tiene un estado que reportar entre una llamada y la
   * siguiente. Obligarlo a inventar uno seria peor que no preguntar, asi que
   * quien no lo implemente se asume listo.
   */
  estado?(): EstadoMensajero
}
