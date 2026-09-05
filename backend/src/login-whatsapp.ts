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

const MAX_INTENTOS = 8
let intentos = 0
let codigoPedido = false

async function conectar(): Promise<void> {
  const { default: makeWASocket, useMultiFileAuthState, DisconnectReason } =
    await import('baileys')

  mkdirSync(AUTH_DIR, { recursive: true, mode: 0o700 })
  const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR)

  const sock = makeWASocket({
    auth: state,
    logger: loggerMudo,
    syncFullHistory: true,
    markOnlineOnConnect: false,
    // Baileys da 60 s al primer intento y 20 s a los siguientes, y al agotarlos
    // corta con 408. Son ~2 minutos: no alcanza para leer el codigo, ir al
    // telefono y teclearlo. Con esto cada intento dura 3 minutos.
    qrTimeout: 180_000,
  })

  sock.ev.on('creds.update', saveCreds)

  sock.ev.on('connection.update', async ({ connection, lastDisconnect, qr }) => {
    // El evento qr solo aparece cuando el servidor EXIGE emparejar. Si las
    // credenciales guardadas ya alcanzan, nunca llega y vamos directo a 'open'.
    if (qr && !codigoPedido && !state.creds.registered) {
      codigoPedido = true
      try {
        const codigo = await sock.requestPairingCode(numero)
        console.log('\n===========================================')
        console.log('  CODIGO DE VINCULACION:', codigo)
        console.log('===========================================\n')
        console.log('En tu telefono:')
        console.log('  WhatsApp -> Ajustes -> Dispositivos vinculados')
        console.log('  -> Vincular dispositivo -> Vincular con numero de telefono')
        console.log('  -> escribe el codigo de arriba\n')
        console.log('Esperando... (la ventana es de varios minutos)')
      } catch (err) {
        console.error('No se pudo pedir el codigo:', err)
      }
    }

    if (connection === 'open') {
      if (state.creds.registered) {
        console.log('\nVINCULADO Y REGISTRADO. Credenciales en', AUTH_DIR)
        console.log('No copies esa carpeta fuera del servidor.')
        setTimeout(() => process.exit(0), 3000)
      } else {
        console.log('[conectado, esperando que se confirme el registro...]')
      }
    }

    if (connection === 'close') {
      const codigo = (lastDisconnect?.error as { output?: { statusCode?: number } })
        ?.output?.statusCode

      if (codigo === DisconnectReason.loggedOut) {
        console.error('Sesion cerrada desde el telefono. Borra la carpeta y empieza de cero.')
        process.exit(1)
      }

      // ESTO ES LO QUE FALTABA. Tras emparejar, WhatsApp CIERRA la conexion a
      // proposito y espera que el cliente vuelva a conectarse; el registro se
      // completa recien en esa reconexion. Salirse aca deja la sesion a medias,
      // con identidad asignada pero registered = false.
      if (intentos < MAX_INTENTOS) {
        intentos++
        console.log(`[conexion cerrada (${codigo ?? '?'}); reconectando ${intentos}/${MAX_INTENTOS}...]`)
        setTimeout(() => { void conectar() }, 2000)
      } else {
        console.error('Demasiadas reconexiones. Vuelve a intentar desde cero.')
        process.exit(1)
      }
    }
  })
}

conectar().catch(err => { console.error(err); process.exit(1) })
