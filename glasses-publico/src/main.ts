/**
 * ARNES DE VERIFICACION -- todavia no es la app.
 *
 * Comprueba las tres cosas que tienen que ser ciertas para que esta version
 * exista, y las comprueba EN ESTE ORDEN porque cada una depende de la anterior:
 *
 *   1. el codigo compartido con la app privada resuelve (`@ui`)
 *   2. GramJS carga dentro de la WebView
 *   3. MTProto completa su apreton de manos SIN backend
 *
 * Se reemplaza por la app real en cuanto exista `tg-directo.ts`.
 */
import './polyfill'
import { TelegramClient } from 'telegram'
import { StringSession } from 'telegram/sessions/index.js'
import { rebuildInicio, INBOX_NAME } from '@ui'
import { SCREEN_W, SCREEN_H } from './config'

const $screen = document.getElementById('screen')
const lineas: string[] = []
const decir = (s: string): void => {
  lineas.push(s)
  console.log('[vozgram]', s)
  if ($screen) $screen.textContent = lineas.join('\n')
}

async function verificar(): Promise<void> {
  decir(`pantalla: ${SCREEN_W}x${SCREEN_H}`)
  // Importar una funcion REAL del modulo compartido: si el alias estuviera
  // mal, esto seria undefined y el arnes lo dice en vez de fallar callado.
  decir(`ui compartida: ${typeof rebuildInicio === 'function' ? `ok (${INBOX_NAME})` : 'NO RESUELVE'}`)
  decir(`GramJS: ${typeof TelegramClient === 'function' ? 'cargado' : 'NO CARGO'}`)

  // api_id/api_hash de relleno a proposito: el apreton de manos de MTProto
  // -Diffie-Hellman, RSA, AES-IGE, SHA- NO los usa. Si connect() termina, toda
  // la criptografia corrio dentro de la WebView. Recien los metodos con sesion
  // exigen credenciales de verdad, y esas las pone el usuario en su alta.
  const cliente = new TelegramClient(
    new StringSession(''),
    123456,
    '0123456789abcdef0123456789abcdef',
    { connectionRetries: 1, useWSS: true },
  )

  const t0 = performance.now()
  await cliente.connect()
  decir(`MTProto conectado en ${Math.round(performance.now() - t0)} ms`)
  decir(`clave de autorizacion: ${cliente.session.getAuthKey() ? 'creada' : 'NO'}`)
  await cliente.disconnect()
  decir('--- arnes OK, sin backend ---')
}

verificar().catch((e: unknown) => {
  // En los lentes no hay consola: si esto no se dibuja, no hay diagnostico.
  decir(`FALLO: ${e instanceof Error ? e.message : String(e)}`)
})
