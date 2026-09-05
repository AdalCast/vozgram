import 'dotenv/config'
import express from 'express'
import cors from 'cors'
import rateLimit from 'express-rate-limit'
import { listarTodo, resolver } from './messaging'

const app = express()

// No anunciamos con que esta hecho el servidor. Es informacion gratis para
// quien escanea buscando versiones con agujeros conocidos.
app.disable('x-powered-by')

// CRITICO para el rate limit: detras de nginx el socket SIEMPRE viene de
// 127.0.0.1, asi que sin esto req.ip seria loopback para TODO el mundo y el
// limitador meteria a internet entera en un solo balde -- un atacante nos
// dejaria afuera de nuestra propia app.
// El 1 es literal: confiamos en UN salto (nuestro nginx), no en cualquiera
// que mande un X-Forwarded-For inventado.
app.set('trust proxy', 1)
app.use(cors({ origin: process.env.CORS_ORIGIN ?? '*' }))
app.use(express.json())

// Log de una linea por request. Sirve para depurar desde los lentes, donde
// no hay consola: si el pedido llega aca, el problema esta despues.
app.use((req, _res, next) => {
  const ua = (req.header('user-agent') ?? '').slice(0, 60)
  const org = req.header('origin') ?? '-'
  console.log(`[req] ${req.method} ${req.path} ip=${req.ip} origin=${org} ua=${ua}`)
  next()
})

/**
 * Tope general de la API. El uso legitimo pico ronda las 8 req/min (el poll de
 * mensajes cada 10 s mientras se lee un chat). 600 en 15 minutos deja mas de
 * 4x de margen y aun asi corta en seco a quien quiera martillar el endpoint.
 * Va ANTES de auth: asi el que ni siquiera tiene el secreto se topa con el
 * limite en vez de generarnos 401s gratis para siempre.
 */
const limiteApi = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 600,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'demasiadas peticiones' },
})

/**
 * Acuñar claves de Soniox CUESTA DINERO, asi que lleva tope propio y estricto.
 * 60 en 15 minutos es un dictado cada 15 segundos sostenido: muy por encima de
 * lo que hace una persona, muy por debajo de lo que haria un abuso.
 */
const limiteSoniox = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 60,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'demasiadas peticiones' },
})

app.use('/api', limiteApi)

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
app.post('/api/soniox-key', limiteSoniox, auth, async (_req, res) => {
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
    res.json({ contacts: await listarTodo() })
  } catch (err) {
    res.status(500).json({ error: String(err) })
  }
})

/** Ultimos mensajes de un chat, para mostrar la conversacion en los lentes. */
app.get('/api/messages', auth, async (req, res) => {
  const peerCrudo = String(req.query.peer ?? '')
  const limit = Math.min(Number(req.query.limit ?? 10) || 10, 50)
  if (!peerCrudo) return res.status(400).json({ error: 'falta peer' })
  try {
    const { proveedor, peer } = resolver(peerCrudo)
    res.json({ messages: await proveedor.getHistory(peer, limit) })
  } catch (err) {
    res.status(500).json({ error: String(err) })
  }
})

app.post('/api/send', auth, async (req, res) => {
  const { peer: peerCrudo, text } = req.body ?? {}
  if (!peerCrudo || !text) return res.status(400).json({ error: 'faltan peer o text' })
  try {
    const { proveedor, peer } = resolver(String(peerCrudo))
    await proveedor.sendMessage(peer, String(text))
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
