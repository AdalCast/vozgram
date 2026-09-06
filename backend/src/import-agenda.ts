/**
 * Importa nombres desde una agenda exportada (.vcf) y se los pone a los chats
 * de WhatsApp.
 *
 *     npx tsx src/import-agenda.ts ruta/al/archivo.vcf [--aplicar]
 *
 * Sin --aplicar solo REPORTA lo que haria. Nada se escribe hasta que lo pidas.
 *
 * Existe porque WhatsApp NO le entrega la agenda telefonica a los dispositivos
 * vinculados: de 196 chats llegaron los 66 grupos y solo 2 personas. La agenda
 * la tiene el telefono del usuario, no WhatsApp.
 */
import 'dotenv/config'
import { readFileSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { guardarContactos } from './messaging/store'

const ruta = process.argv[2]
const aplicar = process.argv.includes('--aplicar')

if (!ruta) {
  console.error('Falta el archivo.\n  npx tsx src/import-agenda.ts agenda.vcf [--aplicar]')
  process.exit(1)
}

/**
 * vCard parte las lineas largas y continua en la siguiente con un espacio o
 * tabulador al inicio. Sin volver a pegarlas, un nombre largo llega cortado.
 */
function desdoblar(texto: string): string[] {
  const salida: string[] = []
  for (const cruda of texto.split(/\r\n|\r|\n/)) {
    if (/^[ \t]/.test(cruda) && salida.length > 0) {
      salida[salida.length - 1] += cruda.slice(1)
    } else {
      salida.push(cruda)
    }
  }
  return salida
}

/** vCard escapa comas, puntos y comas y saltos de linea. */
function desescapar(v: string): string {
  return v.replace(/\\n/gi, ' ').replace(/\\([,;\\])/g, '$1').trim()
}

/**
 * Los ultimos 10 digitos son la identidad real de un telefono mexicano.
 * Comparar asi esquiva el lio de 52 contra 521, del 044 viejo, del +, de los
 * espacios y de los guiones: todo eso es decoracion sobre los mismos 10 digitos.
 */
function clave(tel: string): string | null {
  const d = tel.replace(/[^0-9]/g, '')
  return d.length >= 10 ? d.slice(-10) : null
}

interface Entrada { nombre: string; claves: string[] }
interface Lectura { utiles: Entrada[]; total: number; sinTelefono: number; sinNombre: number }

function leerVCards(texto: string): Lectura {
  const utiles: Entrada[] = []
  let total = 0, sinTelefono = 0, sinNombre = 0
  let nombre = ''
  let claves: string[] = []

  for (const linea of desdoblar(texto)) {
    if (/^BEGIN:VCARD/i.test(linea)) { nombre = ''; claves = []; total++; continue }
    if (/^END:VCARD/i.test(linea)) {
      // Se cuenta cada descarte por su motivo: un contador que siempre da cero
      // no informa nada, y encima da falsa tranquilidad.
      if (!nombre) sinNombre++
      else if (!claves.length) sinTelefono++
      else utiles.push({ nombre, claves })
      continue
    }
    const i = linea.indexOf(':')
    if (i < 0) continue
    // El nombre de propiedad puede venir agrupado (item1.TEL) y con parametros
    // despues de ';'. Nos quedamos con la propiedad pelada.
    const prop = linea.slice(0, i).split(';')[0]!.split('.').pop()!.toUpperCase()
    const valor = linea.slice(i + 1)

    if (prop === 'FN' && !nombre) nombre = desescapar(valor)
    if (prop === 'TEL') {
      const k = clave(valor)
      if (k) claves.push(k)
    }
  }
  return { utiles, total, sinTelefono, sinNombre }
}

const lectura = leerVCards(readFileSync(ruta, 'utf8'))
const vcards = lectura.utiles

// Un mismo numero puede estar en dos tarjetas: gana la primera y se avisa.
const porClave = new Map<string, string>()
let choques = 0
for (const v of vcards) {
  for (const k of v.claves) {
    if (porClave.has(k) && porClave.get(k) !== v.nombre) choques++
    else porClave.set(k, v.nombre)
  }
}

console.log('=== agenda leida ===')
console.log('  tarjetas en el archivo         :', lectura.total)
console.log('  utilizables                    :', vcards.length)
console.log('  descartadas sin telefono largo :', lectura.sinTelefono, '(numeros de menos de 10 digitos)')
console.log('  descartadas sin nombre         :', lectura.sinNombre)
console.log('  telefonos utiles (>=10 digitos):', porClave.size)
if (choques) console.log('  numeros repetidos en 2 tarjetas:', choques, '(gana el primero)')

// --- cruce contra los chats reales ------------------------------------------
const db = new DatabaseSync(process.env.WA_DB_PATH ?? './data/whatsapp.db')
const existe = db
  .prepare("SELECT COUNT(*) n FROM sqlite_master WHERE type='table' AND name='chats'")
  .get() as { n: number }
if (existe.n === 0) {
  console.error('\nNo hay base de chats en', process.env.WA_DB_PATH ?? './data/whatsapp.db')
  console.error('Este script corre en el servidor, donde vive la base de WhatsApp.')
  process.exit(1)
}
const chats = db
  .prepare("SELECT id FROM chats WHERE id LIKE '%@s.whatsapp.net'")
  .all() as { id: string }[]

const aEscribir: { id: string; name: string }[] = []
for (const c of chats) {
  // 5216643637705:22@s.whatsapp.net -> 5216643637705 -> 6643637705
  const crudo = c.id.split('@')[0]!.split(':')[0]!
  const k = clave(crudo)
  if (!k) continue
  const nombre = porClave.get(k)
  if (nombre) aEscribir.push({ id: c.id, name: nombre })
}

console.log('\n=== cruce con tus chats ===')
console.log('  chats de personas      :', chats.length)
console.log('  quedarian con nombre   :', aEscribir.length)
console.log('  seguirian como numero  :', chats.length - aEscribir.length)

if (!aplicar) {
  console.log('\n(simulacion: no se escribio nada. Agrega --aplicar para guardar)')
  process.exit(0)
}

guardarContactos(aEscribir)
console.log('\nGUARDADOS', aEscribir.length, 'nombres.')
