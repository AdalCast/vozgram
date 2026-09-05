/**
 * Vincula esta maquina como dispositivo de WhatsApp. Se corre UNA vez.
 *
 *     npm run login-whatsapp -- 5215512345678
 *
 * El numero va con codigo de pais y SIN el signo +.
 *
 * Usa codigo de emparejamiento, no QR: WhatsApp devuelve 8 caracteres que se
 * escriben en el telefono. Nada de escanear codigos en una terminal.
 *
 * Las credenciales quedan en WA_AUTH_DIR y NO deben salir del servidor: quien
 * las tenga puede leer y escribir por ti en WhatsApp.
 */
import 'dotenv/config'
import { mkdirSync } from 'node:fs'
import { AUTH_DIR, loggerMudo } from './messaging/whatsapp'

const numero = (process.argv[2] ?? '').replace(/[^0-9]/g, '')

if (!numero || numero.length < 10) {
  console.error('Falta el numero. Ejemplo:\n  npm run login-whatsapp -- 5215512345678')
  console.error('(codigo de pais incluido, sin + ni espacios)')
  process.exit(1)
}

async function main(): Promise<void> {
  // Dinamico por lo mismo que en el adaptador: Baileys es solo-ESM.
  const { default: makeWASocket, useMultiFileAuthState } = await import('baileys')

  mkdirSync(AUTH_DIR, { recursive: true, mode: 0o700 })
  const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR)

  if (state.creds.registered) {
    console.log('Este servidor YA esta vinculado a WhatsApp. No hace falta hacer nada.')
    console.log(`Para empezar de cero, borra la carpeta ${AUTH_DIR} y vuelve a correr esto.`)
    process.exit(0)
  }

  const sock = makeWASocket({
    auth: state,
    logger: loggerMudo,
    syncFullHistory: true,
    markOnlineOnConnect: false,
  })

  sock.ev.on('creds.update', saveCreds)

  let pedido = false
  sock.ev.on('connection.update', async ({ connection, lastDisconnect }) => {
    // El codigo se pide una vez que el socket arranco, no antes.
    if (!pedido && (connection === 'connecting' || connection === undefined)) {
      pedido = true
      try {
        const codigo = await sock.requestPairingCode(numero)
        console.log('\n===========================================')
        console.log('  CODIGO DE VINCULACION:', codigo)
        console.log('===========================================\n')
        console.log('En tu telefono:')
        console.log('  WhatsApp -> Ajustes -> Dispositivos vinculados')
        console.log('  -> Vincular dispositivo -> Vincular con numero de telefono')
        console.log('  -> escribe el codigo de arriba\n')
        console.log('El codigo caduca en pocos minutos. Si expira, vuelve a correr esto.')
      } catch (err) {
        console.error('No se pudo pedir el codigo:', err)
        process.exit(1)
      }
    }

    if (connection === 'open') {
      console.log('\nVINCULADO. Las credenciales quedaron en', AUTH_DIR)
      console.log('No copies esa carpeta fuera del servidor.')
      setTimeout(() => process.exit(0), 2000)
    }

    if (connection === 'close') {
      const codigo = (lastDisconnect?.error as { output?: { statusCode?: number } })
        ?.output?.statusCode
      console.error(`Conexion cerrada (codigo ${codigo ?? '?'}). Si no llegaste a escribir el codigo, vuelve a correr esto.`)
      process.exit(1)
    }
  })
}

main().catch(err => { console.error(err); process.exit(1) })
