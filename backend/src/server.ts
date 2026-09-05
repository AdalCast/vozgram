import 'dotenv/config'
import express from 'express'
import cors from 'cors'
import { listContacts, getHistory, sendMessage } from './telegram'

const app = express()
app.use(cors({ origin: process.env.CORS_ORIGIN ?? '*' }))
app.use(express.json())

// Log de una linea por request. Sirve para depurar desde los lentes, donde
// no hay consola: si el pedido llega aca, el problema esta despues.
app.use((req, _res, next) => {
  const ua = (req.header('user-agent') ?? '').slice(0, 60)
  const org = req.header('origin') ?? '-'
  console.log(`[req] ${req.method} ${req.path} origin=${org} ua=${ua}`)
  next()
})

/** Puerta unica: sin el secreto compartido, nadie toca nada. */
function auth(req: express.Request, res: express.Response, next: express.NextFunction) {
  const sent = req.header('x-app-secret')
  if (!process.env.APP_SECRET || sent !== process.env.APP_SECRET) {
    return res.status(401).json({ error: 'no autorizado' })
  }
  next()
}

app.get('/health', (_req, res) => res.json({ ok: true }))

/**
 * Acuña una clave TEMPORAL de Soniox y se la da al WebView.
 * La clave madre nunca sale de este proceso. La temporal expira y sirve una vez.
 */
app.post('/api/soniox-key', auth, async (_req, res) => {
  try {
    const r = await fetch('https://api.soniox.com/v1/auth/temporary-api-key', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${process.env.SONIOX_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        usage_type: 'transcribe_websocket',
        expires_in_seconds: 300,
      }),
    })
    if (!r.ok) return res.status(502).json({ error: `soniox ${r.status}` })
    const data = await r.json() as { api_key: string }
    res.json({ api_key: data.api_key })
  } catch (err) {
    res.status(500).json({ error: String(err) })
  }
})

app.get('/api/contacts', auth, async (_req, res) => {
  try {
    res.json({ contacts: await listContacts() })
  } catch (err) {
    res.status(500).json({ error: String(err) })
  }
})

/** Ultimos mensajes de un chat, para mostrar la conversacion en los lentes. */
app.get('/api/messages', auth, async (req, res) => {
  const peer = String(req.query.peer ?? '')
  const limit = Math.min(Number(req.query.limit ?? 10) || 10, 50)
  if (!peer) return res.status(400).json({ error: 'falta peer' })
  try {
    res.json({ messages: await getHistory(peer, limit) })
  } catch (err) {
    res.status(500).json({ error: String(err) })
  }
})

app.post('/api/send', auth, async (req, res) => {
  const { peer, text } = req.body ?? {}
  if (!peer || !text) return res.status(400).json({ error: 'faltan peer o text' })
  try {
    await sendMessage(String(peer), String(text))
    res.json({ ok: true })
  } catch (err) {
    res.status(500).json({ error: String(err) })
  }
})

const port = Number(process.env.PORT ?? 8787)
// Atado a loopback A PROPOSITO: el unico camino de entrada es nginx con TLS.
// No dependemos de que el firewall este bien configurado.
const host = process.env.BIND_HOST ?? '127.0.0.1'
app.listen(port, host, () => console.log(`vozgram backend escuchando en ${host}:${port}`))
