/**
 * Login de Telegram asistido, sin terminal interactiva.
 *
 * En vez de leer de stdin, publica lo que necesita en un archivo de estado
 * y espera la respuesta en otro archivo. Asi el asistente puede ir pasando
 * los datos uno por uno desde el chat.
 *
 * El session string NUNCA se imprime: se escribe directo al .env.
 */
import 'dotenv/config'
import { readFileSync, writeFileSync, existsSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import { TelegramClient } from 'telegram'
import { StringSession } from 'telegram/sessions'

const DIR = process.env.TGLOGIN_DIR
if (!DIR) throw new Error('falta TGLOGIN_DIR')

const STATUS = join(DIR, 'status')
const ANSWER = join(DIR, 'answer')
const ENV_PATH = join(__dirname, '..', '.env')

function setStatus(s: string): void {
  writeFileSync(STATUS, s, { mode: 0o600 })
  console.log(`[estado] ${s}`)
}

/** Publica que necesita un dato y espera a que aparezca el archivo answer. */
async function ask(label: string): Promise<string> {
  setStatus(`ESPERANDO:${label}`)
  for (;;) {
    if (existsSync(ANSWER)) {
      const v = readFileSync(ANSWER, 'utf8').trim()
      unlinkSync(ANSWER)
      if (v.length > 0) return v
    }
    await new Promise(r => setTimeout(r, 500))
  }
}

/** Reemplaza TG_SESSION dentro del .env sin tocar el resto. */
function guardarSesion(session: string): void {
  const env = readFileSync(ENV_PATH, 'utf8')
  const nuevo = env.includes('\nTG_SESSION=')
    ? env.replace(/^TG_SESSION=.*$/m, `TG_SESSION=${session}`)
    : `${env}\nTG_SESSION=${session}\n`
  writeFileSync(ENV_PATH, nuevo, { mode: 0o600 })
}

async function main() {
  const apiId = Number(process.env.TG_API_ID)
  const apiHash = process.env.TG_API_HASH ?? ''
  if (!apiId || !apiHash) throw new Error('faltan TG_API_ID / TG_API_HASH en .env')

  const client = new TelegramClient(new StringSession(''), apiId, apiHash, {
    connectionRetries: 5,
  })

  await client.start({
    phoneNumber: () => ask('telefono'),
    phoneCode: () => ask('codigo'),
    password: () => ask('password2fa'),
    onError: err => { setStatus(`ERROR:${String(err)}`) },
  })

  guardarSesion(String(client.session.save()))
  setStatus('LISTO')
  console.log('[ok] TG_SESSION guardado en .env — no se imprimio en pantalla')
  await client.disconnect()
  process.exit(0)
}

main().catch(err => { setStatus(`ERROR:${String(err)}`); process.exit(1) })
