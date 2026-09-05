/**
 * Login interactivo de Telegram. Se corre UNA VEZ, a mano, en la terminal.
 * Imprime el session string que va en TG_SESSION del .env
 *
 *   npm run login
 */
import 'dotenv/config'
import { createInterface } from 'node:readline/promises'
import { TelegramClient } from 'telegram'
import { StringSession } from 'telegram/sessions'

const rl = createInterface({ input: process.stdin, output: process.stdout })
const ask = (q: string) => rl.question(q)

async function main() {
  const apiId = Number(process.env.TG_API_ID)
  const apiHash = process.env.TG_API_HASH ?? ''
  if (!apiId || !apiHash) throw new Error('poné TG_API_ID y TG_API_HASH en .env primero')

  const client = new TelegramClient(new StringSession(''), apiId, apiHash, {
    connectionRetries: 5,
  })

  await client.start({
    phoneNumber: () => ask('Telefono (con codigo de pais, ej +52...): '),
    phoneCode: () => ask('Codigo que te llego por Telegram: '),
    password: () => ask('Contraseña 2FA (enter si no tenes): '),
    onError: err => console.error(err),
  })

  console.log('\n=== TG_SESSION ===\n')
  console.log(client.session.save())
  console.log('\nCopialo al .env. Es tu cuenta entera: chmod 600 y nunca a git.\n')
  await client.disconnect()
  rl.close()
}

main().catch(err => { console.error(err); process.exit(1) })
