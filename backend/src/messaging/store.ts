import { DatabaseSync } from 'node:sqlite'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import type { Contact, Msg } from './port'

/**
 * Almacen para mensajeros que NO permiten consultar historial.
 *
 * Telegram no necesita esto: le preguntas y te responde. WhatsApp no: los
 * mensajes llegan solos por eventos y, si no los guardas, se pierden. Por eso
 * el adaptador de WhatsApp escribe aca todo lo que ve pasar.
 *
 * Usa node:sqlite, incluido en Node 22+. CERO dependencias nuevas.
 */

const RUTA = process.env.WA_DB_PATH ?? './data/whatsapp.db'

let db: DatabaseSync | null = null

function conn(): DatabaseSync {
  if (db) return db
  mkdirSync(dirname(RUTA), { recursive: true })
  db = new DatabaseSync(RUTA)
  // WAL: permite leer mientras se escribe. El adaptador escribe eventos
  // continuamente mientras la API lee para responder a los lentes.
  db.exec('PRAGMA journal_mode = WAL')
  db.exec(`
    CREATE TABLE IF NOT EXISTS chats (
      id         TEXT PRIMARY KEY,
      name       TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS messages (
      id      TEXT PRIMARY KEY,
      chat_id TEXT NOT NULL,
      out     INTEGER NOT NULL,
      text    TEXT NOT NULL,
      ts      INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_msg_chat ON messages(chat_id, ts);
  `)
  return db
}

export interface ChatGuardado {
  id: string
  name: string
  updatedAt: number
}

export interface MsgGuardado {
  id: string
  chatId: string
  out: boolean
  text: string
  ts: number
}

/**
 * Guarda chats. Si el chat ya existe conserva el nombre viejo cuando el nuevo
 * viene vacio: WhatsApp a veces manda actualizaciones parciales sin nombre.
 */
export function guardarChats(chats: ChatGuardado[]): void {
  if (chats.length === 0) return
  const c = conn()
  const stmt = c.prepare(`
    INSERT INTO chats (id, name, updated_at) VALUES (?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      name       = CASE WHEN excluded.name != '' THEN excluded.name ELSE chats.name END,
      updated_at = MAX(chats.updated_at, excluded.updated_at)
  `)
  c.exec('BEGIN')
  try {
    for (const ch of chats) stmt.run(ch.id, ch.name, ch.updatedAt)
    c.exec('COMMIT')
  } catch (err) {
    c.exec('ROLLBACK')
    throw err
  }
}

/** Guarda mensajes. El id de WhatsApp es unico, asi que reinsertar no duplica. */
export function guardarMensajes(msgs: MsgGuardado[]): void {
  if (msgs.length === 0) return
  const c = conn()
  const stmt = c.prepare(`
    INSERT INTO messages (id, chat_id, out, text, ts) VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(id) DO NOTHING
  `)
  c.exec('BEGIN')
  try {
    for (const m of msgs) stmt.run(m.id, m.chatId, m.out ? 1 : 0, m.text, m.ts)
    c.exec('COMMIT')
  } catch (err) {
    c.exec('ROLLBACK')
    throw err
  }
}

/** Chats mas recientes primero, igual que el menu de Telegram. */
export function listarChats(limit = 20): Contact[] {
  const filas = conn()
    .prepare('SELECT id, name FROM chats ORDER BY updated_at DESC LIMIT ?')
    .all(limit) as { id: string; name: string }[]
  return filas.map(f => ({ id: f.id, name: f.name || f.id }))
}

/**
 * Ultimos mensajes de un chat en orden cronologico (el mas viejo primero),
 * que es lo que pide el contrato. Se piden los N mas nuevos y se invierten.
 */
export function historial(chatId: string, limit = 10): Msg[] {
  const filas = conn()
    .prepare('SELECT out, text FROM messages WHERE chat_id = ? ORDER BY ts DESC LIMIT ?')
    .all(chatId, limit) as { out: number; text: string }[]
  return filas.map(f => ({ out: f.out === 1, text: f.text })).reverse()
}
