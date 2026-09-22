/**
 * Por que un chat se ve con un nombre en la lista y con otro en la bandeja.
 *
 * No cambia NADA: solo lee y reporta. La hipotesis que viene a comprobar es
 * que la persona existe bajo DOS identidades -su @lid y su telefono- y que
 * `mis_nombres` solo cubre una de las dos porque `lid_map` no las une.
 *
 *     npx tsx src/diag-nombres.ts            # revisa todo mis_nombres
 *     npx tsx src/diag-nombres.ts Esposa     # solo ese nombre
 */
import 'dotenv/config'
import { DatabaseSync } from 'node:sqlite'

const filtro = process.argv[2]
const db = new DatabaseSync(process.env.WA_DB_PATH ?? './data/whatsapp.db')

const ultimos = (s: string): string => s.replace(/[^0-9]/g, '').slice(-10)

const mios = db
  .prepare(`SELECT id, name FROM mis_nombres WHERE name <> ''` +
           (filtro ? ` AND name LIKE ?` : ''))
  .all(...(filtro ? [`%${filtro}%`] : [])) as { id: string; name: string }[]

if (mios.length === 0) {
  console.log('No hay nombres propios guardados' + (filtro ? ` que coincidan con "${filtro}"` : '.'))
  process.exit(0)
}

console.log(`\nRevisando ${mios.length} nombre(s) tuyo(s).\n`)

let problemas = 0

for (const mio of mios) {
  const tel = ultimos(mio.id)
  // Todos los chats de esa persona, por cualquiera de sus identidades.
  const chats = db
    .prepare(`
      SELECT ch.id AS id, ch.unread AS unread, ch.name AS pushname,
             (SELECT pn FROM lid_map WHERE lid = ch.id) AS pn,
             (SELECT name FROM mis_nombres WHERE id = ch.id) AS mio_directo,
             (SELECT name FROM mis_nombres
               WHERE id = COALESCE((SELECT pn FROM lid_map WHERE lid = ch.id), ch.id)
             ) AS mio_por_telefono
      FROM chats ch
      WHERE ch.id = ?
         OR ch.id IN (SELECT lid FROM lid_map WHERE pn = ?)
         OR (ch.id LIKE '%@s.whatsapp.net' AND replace(ch.id,'@s.whatsapp.net','') LIKE ?)
    `)
    .all(mio.id, mio.id, `%${tel}`) as {
      id: string; unread: number; pushname: string | null
      pn: string | null; mio_directo: string | null; mio_por_telefono: string | null
    }[]

  console.log(`== "${mio.name}"  (guardado contra ${mio.id})`)
  if (chats.length === 0) {
    console.log('   sin chats: hasta que no haya conversacion no hay a que ponerle nombre\n')
    continue
  }

  for (const c of chats) {
    // ESTA es la cascada real: lo que el usuario termina viendo.
    const seVe = c.mio_directo || c.mio_por_telefono || c.pushname || c.id
    const malo = seVe !== mio.name
    if (malo && c.unread > 0) problemas++
    console.log(
      `   ${malo ? 'MAL ' : ' ok '} ${c.id.slice(0, 30).padEnd(32)}` +
      ` sin leer:${String(c.unread).padStart(3)}  se ve: ${seVe}`,
    )
    if (malo) {
      console.log(`        pushname=${c.pushname ?? '-'}  lid_map.pn=${c.pn ?? 'NO LO CONOCE'}`)
    }
  }
  console.log()
}

/**
 * LA PARTE QUE DE VERDAD IMPORTA, y que este script NO tenia la primera vez.
 *
 * El bloque de arriba busca los chats de cada nombre tuyo partiendo de
 * `lid_map`. Eso tiene un punto ciego fatal: un @lid que NO esta en lid_map es
 * invisible para esa busqueda -- y es exactamente el caso que rompe los
 * nombres. La primera version reporto "todos correctos" con el problema
 * delante.
 *
 * Aqui se pregunta al reves: que identidades @lid siguen sin unir. Mientras no
 * lo esten, tu etiqueta (guardada contra el TELEFONO) no las alcanza y en
 * pantalla sale el pushName.
 */
const sueltos = db
  .prepare(`
    SELECT ch.id AS id, ch.unread AS unread,
           COALESCE(NULLIF(ch.name,''), NULLIF(co.name,''), ch.id) AS visible
    FROM chats ch
    LEFT JOIN contacts co ON co.id = ch.id
    WHERE ch.id LIKE '%@lid' AND ch.id NOT IN (SELECT lid FROM lid_map)
    ORDER BY ch.updated_at DESC
  `)
  .all() as { id: string; unread: number; visible: string }[]

console.log('== identidades @lid SIN unir a su telefono ==')
if (sueltos.length === 0) {
  console.log('   ninguna.\n')
} else {
  for (const f of sueltos) {
    console.log(`   ${f.visible.slice(0, 26).padEnd(28)} ${f.id.slice(0, 24)}  sin leer:${f.unread}`)
  }
  console.log(
    `\n   ${sueltos.length} sin unir. Si alguna es alguien que tienes guardado con\n`
    + '   otro nombre, va a salir con su pushName hasta que se una. Se une sola\n'
    + '   al llegarle un mensaje, o al reiniciar el servicio.\n',
  )
}

console.log(problemas > 0
  ? `${problemas} chat(s) CON PENDIENTES se ven con el nombre equivocado.\n`
    + 'Si dice "lid_map.pn=NO LO CONOCE", esa identidad @lid no esta unida a su\n'
    + 'telefono: por eso tu etiqueta no la alcanza. Lo arregla mapearLids() al\n'
    + 'reiniciar, o guardar el nombre tambien contra ese @lid.'
  : 'Todos los chats con nombre propio se ven correctos.')
