import { DatabaseSync } from 'node:sqlite'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import type { Contact, Msg } from './port'
import { normalizar } from './texto'

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
    -- Los nombres de las PERSONAS no vienen en el chat: llegan aparte, en el
    -- arreglo contacts. Sin esta tabla la lista muestra numeros crudos.
    CREATE TABLE IF NOT EXISTS contacts (
      id   TEXT PRIMARY KEY,
      name TEXT NOT NULL
    );
  `)

  // MIGRACION. `CREATE TABLE IF NOT EXISTS` no toca una tabla que ya existe,
  // asi que una columna nueva hay que agregarla a mano o los datos viejos se
  // quedan sin ella. Se consulta el esquema real antes de tocar nada.
  const cols = db.prepare('PRAGMA table_info(messages)').all() as { name: string }[]
  if (!cols.some(c => c.name === 'sender')) {
    db.exec('ALTER TABLE messages ADD COLUMN sender TEXT')
  }

  return db
}


export interface ChatGuardado {
  id: string
  name: string
  updatedAt: number
}

export interface ContactoGuardado {
  id: string
  name: string
}

/** Nombre para mostrar de una persona. Nunca pisa un nombre con uno vacio. */
export function guardarContactos(cs: ContactoGuardado[]): void {
  const utiles = cs.filter(c => c.id && c.name)
  if (utiles.length === 0) return
  const c = conn()
  const stmt = c.prepare(`
    INSERT INTO contacts (id, name) VALUES (?, ?)
    ON CONFLICT(id) DO UPDATE SET
      name = CASE WHEN excluded.name != '' THEN excluded.name ELSE contacts.name END
  `)
  c.exec('BEGIN')
  try {
    for (const x of utiles) stmt.run(x.id, x.name)
    c.exec('COMMIT')
  } catch (err) {
    c.exec('ROLLBACK')
    throw err
  }
}

export interface MsgGuardado {
  id: string
  chatId: string
  out: boolean
  text: string
  ts: number
  /** Quien escribio. Solo se usa en grupos. */
  sender?: string
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
    INSERT INTO messages (id, chat_id, out, text, ts, sender) VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO NOTHING
  `)
  c.exec('BEGIN')
  try {
    for (const m of msgs) stmt.run(m.id, m.chatId, m.out ? 1 : 0, m.text, m.ts, m.sender ?? null)
    c.exec('COMMIT')
  } catch (err) {
    c.exec('ROLLBACK')
    throw err
  }
}

/**
 * Convierte un JID en algo legible cuando no hay nombre.
 * WhatsApp NO le entrega la agenda telefonica a los dispositivos vinculados:
 * solo llegan los nombres de grupos y de quien te escribe (via pushName). Para
 * el resto, un numero bien formateado se reconoce; un JID crudo no.
 *
 *   5216643637705@s.whatsapp.net  ->  +52 664 363 7705
 */
export function numeroLegible(jid: string): string {
  // SOLO personas. El id de un grupo es un numero largo que no es telefono de
  // nadie: formatearlo inventaria un contacto que no existe.
  if (!jid.endsWith('@s.whatsapp.net')) return 'Grupo'
  const crudo = jid.split('@')[0]?.split(':')[0] ?? jid
  if (!/^[0-9]+$/.test(crudo)) return jid
  // Mexico: el 1 despues del 52 es herencia del prefijo viejo de celular y no
  // se marca desde 2019. Estorba al leer, asi que fuera.
  const n = crudo.startsWith('521') && crudo.length === 13 ? `52${crudo.slice(3)}` : crudo
  if (n.startsWith('52') && n.length === 12) {
    const d = n.slice(2)
    return `+52 ${d.slice(0, 3)} ${d.slice(3, 6)} ${d.slice(6)}`
  }
  if (n.length > 10) return `+${n.slice(0, n.length - 10)} ${n.slice(-10, -7)} ${n.slice(-7, -4)} ${n.slice(-4)}`
  return `+${n}`
}

/**
 * Chats mas recientes primero, igual que el menu de Telegram.
 * El nombre se resuelve en cascada: el del chat (grupos), si no el del
 * contacto (personas), y como ultimo recurso el numero pelado.
 */
export function listarChats(limit = 20, q?: string): Contact[] {
  // Al buscar se traen TODOS los chats y se filtra en JS: son un par de cientos
  // de filas, y SQLite no sabe comparar sin acentos. Hacerlo aca es correcto y
  // mas barato que ensuciar el esquema con una columna normalizada.
  const tope = q ? 5000 : limit
  const filas = conn()
    .prepare(`
      SELECT ch.id AS id,
             COALESCE(NULLIF(ch.name, ''), NULLIF(co.name, ''), ch.id) AS name,
             ch.updated_at AS updatedAt
      FROM chats ch
      LEFT JOIN contacts co ON co.id = ch.id
      ORDER BY ch.updated_at DESC
      LIMIT ?
    `)
    .all(tope) as { id: string; name: string; updatedAt: number }[]

  let salida = filas.map(f => ({
    id: f.id,
    // Si la cascada del SQL terminó cayendo en el id, lo volvemos legible.
    name: f.name === f.id ? numeroLegible(f.id) : f.name,
    updatedAt: f.updatedAt,
  }))

  if (q) {
    const aguja = normalizar(q)
    // Tambien se busca en el id: sirve para llegar por numero de telefono.
    salida = salida
      .filter(c => normalizar(c.name).includes(aguja) || c.id.includes(aguja))
      .slice(0, limit)
  }
  return salida
}

/**
 * Ultimos mensajes de un chat en orden cronologico (el mas viejo primero),
 * que es lo que pide el contrato. Se piden los N mas nuevos y se invierten.
 */
export function historial(chatId: string, limit = 10): Msg[] {
  const filas = conn()
    .prepare('SELECT out, text, sender FROM messages WHERE chat_id = ? ORDER BY ts DESC LIMIT ?')
    .all(chatId, limit) as { out: number; text: string; sender: string | null }[]
  return filas
    .map(f => ({
      out: f.out === 1,
      text: f.text,
      ...(f.sender ? { sender: f.sender } : {}),
    }))
    .reverse()
}
