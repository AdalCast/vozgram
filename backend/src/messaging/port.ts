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
}

export interface MessagingProvider {
  /** Identificador corto y estable. Sirve para elegir adaptador y para los logs. */
  readonly id: string

  /** Chats recientes, para armar el menu de destinatarios en los lentes. */
  listContacts(limit?: number): Promise<Contact[]>

  /** Ultimos mensajes de un chat, en orden cronologico (el mas viejo primero). */
  getHistory(peer: string, limit?: number): Promise<Msg[]>

  sendMessage(peer: string, text: string): Promise<void>
}
