import { DatabaseSync } from 'node:sqlite'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import type { Contact, Msg, Pendiente } from './port'
import { normalizar, soloLegible } from './texto'

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
    -- Los DOS identificadores de una misma persona. WhatsApp esta migrando de
    -- "telefono@s.whatsapp.net" a "id@lid", que no expone el numero, y durante
    -- la transicion CONVIVEN los dos. Sin esta tabla el mismo contacto sale dos
    -- veces en la lista y con la conversacion partida por la mitad: abres una y
    -- ves lo viejo, abres la otra y ves lo de hoy.
    CREATE TABLE IF NOT EXISTS lid_map (
      lid TEXT PRIMARY KEY,
      pn  TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_lidmap_pn ON lid_map(pn);
    -- MIS nombres: como YO tengo guardada a la gente en mi agenda.
    --
    -- Va aparte de la tabla contacts porque esa la escribe WhatsApp en cada
    -- sincronizacion, y lo que WhatsApp manda NO es mi etiqueta: es el
    -- pushName, el nombre que cada quien se puso a si mismo. Guardar aqui mis
    -- etiquetas junto a las suyas las condenaba a borrarse solas -- que es
    -- exactamente lo que paso al revincular.
    CREATE TABLE IF NOT EXISTS mis_nombres (
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
  // Quien mando el mensaje DENTRO de un grupo. Hace falta para marcar leido:
  // la clave que pide WhatsApp lleva participant, y sin el los grupos no se
  // pueden marcar.
  if (!cols.some(c => c.name === 'participant')) {
    db.exec('ALTER TABLE messages ADD COLUMN participant TEXT')
  }
  const colsChats = db.prepare('PRAGMA table_info(chats)').all() as { name: string }[]
  if (!colsChats.some(c => c.name === 'unread')) {
    db.exec('ALTER TABLE chats ADD COLUMN unread INTEGER NOT NULL DEFAULT 0')
  }

  return db
}


export interface ChatGuardado {
  id: string
  name: string
  updatedAt: number
  /** Sin leer. `undefined` = el evento no lo traia; NO es lo mismo que cero. */
  unread?: number
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

/**
 * Quita el sufijo de dispositivo de un JID.
 *
 *   5216648093730:0@s.whatsapp.net  ->  5216648093730@s.whatsapp.net
 *
 * Baileys devuelve el telefono CON el dispositivo pegado, pero los chats se
 * guardan sin el. Comparar sin normalizar no encuentra nada -- y no falla:
 * simplemente no une nada, que es peor, porque no se nota.
 */
export function jidBase(jid: string): string {
  const i = jid.indexOf('@')
  if (i < 0) return jid
  const usuario = jid.slice(0, i)
  const dosPuntos = usuario.indexOf(':')
  return dosPuntos < 0 ? jid : `${usuario.slice(0, dosPuntos)}${jid.slice(i)}`
}

/**
 * Guarda MIS etiquetas. Ganan siempre sobre lo que mande WhatsApp: si me tome
 * el trabajo de llamarle "Esposa" a alguien, ver su pushName no me sirve.
 */
export function guardarMisNombres(filas: { id: string; name: string }[]): void {
  const utiles = filas.filter(f => f.id && f.name)
  if (utiles.length === 0) return
  const c = conn()
  const stmt = c.prepare(`
    INSERT INTO mis_nombres (id, name) VALUES (?, ?)
    ON CONFLICT(id) DO UPDATE SET name = excluded.name
  `)
  c.exec('BEGIN')
  try {
    for (const f of utiles) stmt.run(jidBase(f.id), f.name)
    c.exec('COMMIT')
  } catch (err) {
    c.exec('ROLLBACK')
    throw err
  }
}

/** Guarda equivalencias @lid <-> telefono, siempre en su forma base. */
export function guardarLidMap(pares: { lid: string; pn: string }[]): void {
  const utiles = pares.filter(p => p.lid && p.pn)
  if (utiles.length === 0) return
  const c = conn()
  const stmt = c.prepare(`
    INSERT INTO lid_map (lid, pn) VALUES (?, ?)
    ON CONFLICT(lid) DO UPDATE SET pn = excluded.pn
  `)
  c.exec('BEGIN')
  try {
    for (const x of utiles) stmt.run(jidBase(x.lid), jidBase(x.pn))
    c.exec('COMMIT')
  } catch (err) {
    c.exec('ROLLBACK')
    throw err
  }
}

/**
 * Todos los identificadores que apuntan a la misma persona, incluido el que se
 * pregunta. Un grupo (@g.us) no tiene doble identidad y vuelve solo.
 */
export function equivalentes(idCrudo: string): string[] {
  const c = conn()
  const id = jidBase(idCrudo)
  const out = new Set([idCrudo, id])
  if (id.endsWith('@lid')) {
    const f = c.prepare('SELECT pn FROM lid_map WHERE lid = ?').get(id) as
      | { pn: string } | undefined
    if (f?.pn) out.add(f.pn)
  } else if (id.endsWith('@s.whatsapp.net')) {
    const filas = c.prepare('SELECT lid FROM lid_map WHERE pn = ?').all(id) as
      { lid: string }[]
    for (const f of filas) out.add(f.lid)
  }
  return [...out]
}

/**
 * Chats @lid cuya equivalencia todavia no conocemos.
 *
 * Ojo con la diferencia respecto de chatsSinNombre(): aquel busca los que NO
 * tienen nombre, porque su trabajo es ponerles uno. Este busca los que faltan
 * de MAPEAR, tengan nombre o no -- y los duplicados que se ven en la lista son
 * justamente los que si tienen nombre.
 */
export function chatsLid(): string[] {
  const filas = conn()
    .prepare(`
      SELECT ch.id AS id
      FROM chats ch
      LEFT JOIN lid_map lm ON lm.lid = ch.id
      WHERE ch.id LIKE '%@lid' AND lm.lid IS NULL
    `)
    .all() as { id: string }[]
  return filas.map(f => f.id)
}

export interface MsgGuardado {
  id: string
  chatId: string
  out: boolean
  text: string
  ts: number
  /** Quien escribio. Solo se usa en grupos. */
  sender?: string
  /** Jid de quien escribio en un grupo. Necesario para marcar leido. */
  participant?: string
}

/**
 * Guarda chats. Si el chat ya existe conserva el nombre viejo cuando el nuevo
 * viene vacio: WhatsApp a veces manda actualizaciones parciales sin nombre.
 */
export function guardarChats(chats: ChatGuardado[]): void {
  if (chats.length === 0) return
  const c = conn()
  // El -1 significa "no vino en el evento". WhatsApp manda actualizaciones
  // PARCIALES: tomar un campo ausente como cero vaciaria la bandeja sola.
  const stmt = c.prepare(`
    INSERT INTO chats (id, name, updated_at, unread) VALUES (?, ?, ?, MAX(?, 0))
    ON CONFLICT(id) DO UPDATE SET
      name       = CASE WHEN excluded.name != '' THEN excluded.name ELSE chats.name END,
      updated_at = MAX(chats.updated_at, excluded.updated_at),
      unread     = CASE WHEN ? >= 0 THEN ? ELSE chats.unread END
  `)
  c.exec('BEGIN')
  try {
    for (const ch of chats) {
      const u = ch.unread ?? -1
      stmt.run(ch.id, ch.name, ch.updatedAt, u, u, u)
    }
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
    INSERT INTO messages (id, chat_id, out, text, ts, sender, participant)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO NOTHING
  `)
  c.exec('BEGIN')
  try {
    for (const m of msgs) {
      stmt.run(m.id, m.chatId, m.out ? 1 : 0, m.text, m.ts, m.sender ?? null, m.participant ?? null)
    }
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
  // Un @lid no lleva el telefono adentro: no hay numero que mostrar. Si no
  // tiene nombre todavia, se dice eso y no se inventa nada.
  if (jid.endsWith('@lid')) return 'Contacto sin nombre'
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
  // Se traen TODOS los chats, no solo `limit`. Al colapsar las dos identidades
  // de una persona en una sola fila, un LIMIT en SQL devolveria MENOS
  // elementos de los pedidos. Son unos cientos de filas: el costo es
  // irrelevante y el resultado, correcto.
  const filas = conn()
    .prepare(`
      SELECT ch.id AS id,
             -- Orden de preferencia, de mas mio a mas ajeno:
             --   1. mi etiqueta para ESTE identificador
             --   2. mi etiqueta para su telefono equivalente (si el chat es @lid)
             --   3. el nombre del chat  -> los grupos viven aqui
             --   4. lo que mando WhatsApp -> el pushName, como se llama el/ella
             --   5. el identificador crudo, que despues se vuelve legible
             COALESCE(NULLIF(mn.name, ''), NULLIF(mn2.name, ''),
                      NULLIF(ch.name, ''), NULLIF(co.name, ''), ch.id) AS name,
             ch.updated_at AS updatedAt,
             COALESCE(lm.pn, ch.id) AS grupo
      FROM chats ch
      LEFT JOIN contacts    co  ON co.id  = ch.id
      LEFT JOIN lid_map     lm  ON lm.lid = ch.id
      -- Dos veces: mi etiqueta puede estar guardada contra el @lid o contra el
      -- telefono, y el chat puede venir identificado de cualquiera de las dos
      -- formas. Sin el segundo join, renombrar por telefono no se ve en un
      -- chat @lid.
      LEFT JOIN mis_nombres mn  ON mn.id  = ch.id
      LEFT JOIN mis_nombres mn2 ON mn2.id = COALESCE(lm.pn, ch.id)
      ORDER BY ch.updated_at DESC
    `)
    .all() as { id: string; name: string; updatedAt: number; grupo: string }[]

  // Colapsa las identidades duplicadas. Vienen ordenadas de mas reciente a mas
  // vieja, asi que la PRIMERA de cada grupo es la conversacion viva: ese es el
  // id que se devuelve, para que abrirla lleve a los mensajes de hoy y no a los
  // del ano pasado.
  const porGrupo = new Map<string, { id: string; name: string; updatedAt: number; grupo: string }>()
  for (const f of filas) {
    const ya = porGrupo.get(f.grupo)
    if (!ya) {
      porGrupo.set(f.grupo, { id: f.id, name: f.name, updatedAt: f.updatedAt, grupo: f.grupo })
      continue
    }
    // El nombre puede estar en la identidad vieja y faltar en la nueva. Se toma
    // el mejor de las dos sin mover ni el id ni la fecha.
    if (ya.name === ya.id && f.name !== f.id) ya.name = f.name
  }

  let salida = [...porGrupo.values()].map(f => {
    // Si la cascada del SQL terminó cayendo en el id, lo volvemos legible.
    // Se usa el GRUPO, no el id: para un @lid cuyo telefono ya conocemos, el
    // grupo ES ese telefono. Un numero bien formateado se reconoce; "Contacto
    // sin nombre" repetido doce veces en la lista no distingue a nadie.
    const crudo = f.name === f.id ? numeroLegible(f.grupo) : f.name
    // Quitados los glifos que el firmware no dibuja, un nombre puede quedar
    // VACIO -- pasa con los que son puro emoji. Ahi se cae al telefono, que
    // aqui si lo tenemos.
    const limpio = soloLegible(crudo)
    return {
      id: f.id,
      name: limpio || numeroLegible(f.grupo),
      updatedAt: f.updatedAt,
      kind: f.id.endsWith('@g.us') ? ('grupo' as const) : ('persona' as const),
    }
  })

  if (q) {
    const aguja = normalizar(q)
    // Tambien se busca en el id: sirve para llegar por numero de telefono.
    salida = salida.filter(c => normalizar(c.name).includes(aguja) || c.id.includes(aguja))
  }
  return salida.slice(0, limit)
}

/**
 * Mensajes sin leer, uno por chat, mas reciente primero.
 *
 * UNO por chat y no todos: en una pantalla de seis renglones, tres mensajes
 * del mismo grupo tapan a las otras tres personas que tambien escribieron. El
 * dato que importa de un vistazo es QUIEN espera respuesta, no cuanto dijo.
 */
export function noLeidos(limite = 10): Pendiente[] {
  const filas = conn()
    .prepare(`
      SELECT ch.id AS id,
             COALESCE(NULLIF(mn.name,''), NULLIF(mn2.name,''),
                      NULLIF(ch.name,''), NULLIF(co.name,''), ch.id) AS nombre,
             COALESCE(lm.pn, ch.id) AS grupo,
             m.text AS text, m.ts AS ts, m.sender AS sender
      FROM chats ch
      LEFT JOIN contacts    co  ON co.id  = ch.id
      LEFT JOIN lid_map     lm  ON lm.lid = ch.id
      LEFT JOIN mis_nombres mn  ON mn.id  = ch.id
      LEFT JOIN mis_nombres mn2 ON mn2.id = COALESCE(lm.pn, ch.id)
      JOIN messages m ON m.id = (
        SELECT id FROM messages
        WHERE chat_id = ch.id AND out = 0 AND text <> ''
        ORDER BY ts DESC LIMIT 1
      )
      WHERE ch.unread > 0
      ORDER BY m.ts DESC
      LIMIT ?
    `)
    .all(limite) as {
      id: string; nombre: string; grupo: string
      text: string; ts: number; sender: string | null
    }[]

  return filas.map(f => {
    const esGrupo = f.id.endsWith('@g.us')
    // En un grupo interesa QUIEN hablo, no como se llama el grupo: el nombre
    // del grupo mas el de la persona no caben en un renglon de la pantalla.
    const crudo = esGrupo && f.sender ? f.sender : f.nombre
    const limpio = soloLegible(crudo)
    return {
      peer: f.id,
      quien: limpio || numeroLegible(f.grupo),
      text: soloLegible(f.text),
      ts: f.ts,
      kind: esGrupo ? ('grupo' as const) : ('persona' as const),
    }
  })
}

/** Claves de los mensajes sin leer de un chat, para marcarlos leidos. */
export function clavesNoLeidas(chatId: string, limite = 30): {
  id: string; participant: string | null
}[] {
  return conn()
    .prepare(`
      SELECT id, participant FROM messages
      WHERE chat_id = ? AND out = 0
      ORDER BY ts DESC LIMIT ?
    `)
    .all(chatId, limite) as { id: string; participant: string | null }[]
}

/** Suma uno al contador local cuando llega un mensaje nuevo. */
export function sumarNoLeido(chatId: string): void {
  conn().prepare('UPDATE chats SET unread = unread + 1 WHERE id = ?').run(chatId)
}

/** Pone en cero el contador local. Lo remoto lo marca el adaptador. */
export function limpiarNoLeidos(chatId: string): void {
  conn().prepare('UPDATE chats SET unread = 0 WHERE id = ?').run(chatId)
}

/** Chats de personas que siguen sin nombre. */
export function chatsSinNombre(): string[] {
  const filas = conn()
    .prepare(`
      SELECT ch.id AS id
      FROM chats ch
      LEFT JOIN contacts    co ON co.id = ch.id
      LEFT JOIN mis_nombres mn ON mn.id = ch.id
      WHERE (ch.id LIKE '%@s.whatsapp.net' OR ch.id LIKE '%@lid')
        AND (co.id IS NULL OR co.name = '')
        AND (mn.id IS NULL OR mn.name = '')
    `)
    .all() as { id: string }[]
  return filas.map(f => f.id)
}

/** Nombre guardado para un identificador cualquiera, si lo hay. */
export function nombreGuardado(id: string): string | null {
  const f = conn().prepare('SELECT name FROM contacts WHERE id = ?').get(id) as
    | { name: string }
    | undefined
  return f?.name || null
}

/**
 * Ultimos mensajes de un chat en orden cronologico (el mas viejo primero),
 * que es lo que pide el contrato. Se piden los N mas nuevos y se invierten.
 */
export function historial(chatId: string, limit = 10): Msg[] {
  // La conversacion puede estar PARTIDA entre las dos identidades de la misma
  // persona. Se leen todas juntas, o abrir un chat muestra solo la mitad -- que
  // es exactamente el sintoma que se reporto: una entrada con lo viejo y otra
  // con lo reciente.
  const ids = equivalentes(chatId)
  const marcas = ids.map(() => '?').join(', ')
  const filas = conn()
    .prepare(`SELECT out, text, sender FROM messages
              WHERE chat_id IN (${marcas}) ORDER BY ts DESC LIMIT ?`)
    .all(...ids, limit) as { out: number; text: string; sender: string | null }[]
  return filas
    .map(f => ({
      out: f.out === 1,
      text: f.text,
      ...(f.sender ? { sender: f.sender } : {}),
    }))
    .reverse()
}
