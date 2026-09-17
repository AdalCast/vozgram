/**
 * Le pone TU nombre a un contacto de WhatsApp.
 *
 *     npx tsx src/renombrar.ts 6631999919 "Esposa"
 *     npx tsx src/renombrar.ts 6631999919          <- consulta como se ve hoy
 *
 * Existe porque WhatsApp NO le entrega tu agenda a un dispositivo vinculado:
 * le manda el pushName, el nombre que cada quien se puso a si mismo. Para uno
 * o dos contactos nuevos, reexportar la agenda entera e importarla es un
 * martillo para un clavo.
 *
 * El nombre va a `mis_nombres`, que WhatsApp no toca: sobrevive a una
 * resincronizacion y a una revinculacion.
 */
import 'dotenv/config'
import { DatabaseSync } from 'node:sqlite'
import { guardarMisNombres } from './messaging/store'

const argumento = process.argv[2]
const nombre = process.argv[3]

if (!argumento) {
  console.error('Falta el numero.\n  npx tsx src/renombrar.ts 6631999919 "Esposa"')
  process.exit(1)
}

/** Ultimos 10 digitos: esquiva 52 / 521 / 044 / +, que varian por contacto. */
const clave = (s: string): string => s.replace(/[^0-9]/g, '').slice(-10)

const aguja = clave(argumento)
if (aguja.length < 10) {
  console.error(`"${argumento}" tiene menos de 10 digitos; no alcanza para identificar a nadie`)
  process.exit(1)
}

const db = new DatabaseSync(process.env.WA_DB_PATH ?? './data/whatsapp.db')

/**
 * Chats de persona con su telefono. Los @lid no llevan el numero adentro, asi
 * que el suyo sale de lid_map.
 */
const chats = db
  .prepare(`
    SELECT ch.id AS id,
           COALESCE(lm.pn, ch.id) AS telefono,
           COALESCE(NULLIF(mn.name,''), NULLIF(mn2.name,''),
                    NULLIF(ch.name,''), NULLIF(co.name,''), ch.id) AS visible
    FROM chats ch
    LEFT JOIN contacts    co  ON co.id  = ch.id
    LEFT JOIN lid_map     lm  ON lm.lid = ch.id
    LEFT JOIN mis_nombres mn  ON mn.id  = ch.id
    LEFT JOIN mis_nombres mn2 ON mn2.id = COALESCE(lm.pn, ch.id)
    WHERE ch.id LIKE '%@s.whatsapp.net' OR ch.id LIKE '%@lid'
  `)
  .all() as { id: string; telefono: string; visible: string }[]

const encontrados = chats.filter(c => clave(c.telefono) === aguja)

if (encontrados.length === 0) {
  console.error(`\nNo hay ningun chat con el numero ...${aguja}.`)
  console.error('Escribele una vez desde el telefono: hasta que no haya chat, no hay a que ponerle nombre.')
  process.exit(1)
}

console.log(`\nChats que coinciden con ...${aguja}:`)
for (const c of encontrados) {
  const tipo = c.id.endsWith('@lid') ? 'lid' : 'tel'
  console.log(`  (${tipo}) ${c.id.slice(0, 26).padEnd(28)} se ve como: ${c.visible}`)
}

if (!nombre) {
  console.log('\n(solo consulta. Agrega el nombre entre comillas para cambiarlo)')
  process.exit(0)
}

/**
 * Se escribe contra el TELEFONO, no contra el id del chat: la cascada busca
 * por las dos identidades, asi que una sola fila cubre al @lid y al numero.
 * Escribir contra el @lid solo arreglaria una de las dos.
 */
const porTelefono = encontrados
  .map(c => c.telefono)
  .filter(t => t.endsWith('@s.whatsapp.net'))

if (porTelefono.length === 0) {
  // Sin equivalencia conocida todavia, se marca el @lid directo. Funciona,
  // pero solo para ese identificador.
  guardarMisNombres(encontrados.map(c => ({ id: c.id, name: nombre })))
  console.log(`\nGuardado contra el identificador (aun no conocemos su telefono).`)
} else {
  guardarMisNombres([...new Set(porTelefono)].map(id => ({ id, name: nombre })))
}

console.log(`\nListo: ahora se ve como "${nombre}".`)
console.log('Gana sobre lo que mande WhatsApp y sobrevive a una revinculacion.')
console.log('Abre la app en los lentes; no hace falta reiniciar el servicio.')
