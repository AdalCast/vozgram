import { BACKEND_URL, APP_SECRET } from './config'

/** `kind` lo decide el adaptador: en los lentes no hay forma de deducirlo. */
export interface Contact { id: string; name: string; kind?: 'persona' | 'grupo' }
/**
 * `estado` es OPCIONAL: un backend viejo no lo manda y la app tiene que seguir
 * funcionando igual. Ausente = se asume listo.
 */
export type EstadoMensajero = 'listo' | 'conectando' | 'desvinculado' | 'caido'
export interface Provider { id: string; label: string; estado?: EstadoMensajero }
/** `sender` solo viene en GRUPOS: en un chat de a dos, `out` ya lo dice todo. */
export interface Msg { out: boolean; text: string; sender?: string }

/**
 * El backend no contesto a tiempo. NO es lo mismo que un fallo: en un envio,
 * el mensaje pudo haber salido y solo se perdio la respuesta. Quien lo muestra
 * tiene que decirlo asi, o el usuario reintenta y lo manda dos veces.
 */
export class SinRespuesta extends Error {}

/** Tope de cualquier llamada al backend: conectar, esperar y leer la respuesta. */
const TOPE_MS = 20_000

/**
 * ANTES NO HABIA NINGUN LIMITE. Con la red caida a medio camino -- el telefono
 * se durmio, se cambio de wifi a datos -- `fetch` no volvia nunca: la lista se
 * quedaba en "cargando..." y un envio en "Enviando a..." para siempre, con
 * `busy` bloqueando cualquier otro intento. Quien llama ya atrapa el error;
 * un cuelgue nunca llegaba a serlo. Con el tope, si.
 *
 * El reloj se apaga DESPUES de leer el cuerpo: la respuesta tambien puede
 * quedarse a medias.
 */
async function call<T>(path: string, init?: RequestInit): Promise<T> {
  const ctl = new AbortController()
  const reloj = setTimeout(() => ctl.abort(), TOPE_MS)
  try {
    const res = await fetch(`${BACKEND_URL}${path}`, {
      ...init,
      signal: ctl.signal,
      headers: {
        'x-app-secret': APP_SECRET,
        'Content-Type': 'application/json',
        ...(init?.headers ?? {}),
      },
    })
    if (!res.ok) throw new Error(`${path} -> HTTP ${res.status}`)
    return await (res.json() as Promise<T>)
  } catch (err) {
    if (ctl.signal.aborted) throw new SinRespuesta(`el servidor no respondio en ${TOPE_MS / 1000} s`)
    throw err
  } finally {
    clearTimeout(reloj)
  }
}

export const getSonioxKey = () =>
  call<{ api_key: string }>('/api/soniox-key', { method: 'POST' })

/** Un mensaje pendiente de leer, de cualquier mensajero. */
export interface Pendiente {
  peer: string
  quien: string
  text: string
  ts: number
  kind?: 'persona' | 'grupo'
}

export const getUnread = (limit = 8) =>
  call<{ pendientes: Pendiente[] }>(`/api/unread?limit=${limit}`)

export const marcarLeido = (peer: string) =>
  call<{ ok: true }>('/api/read', { method: 'POST', body: JSON.stringify({ peer }) })

export const getProviders = () =>
  call<{ providers: Provider[] }>('/api/providers')

/** Sin `provider` devuelve todo mezclado; con `q` busca en TODOS los chats. */
export const getContacts = (provider?: string, q?: string) => {
  const p = new URLSearchParams()
  if (provider) p.set('provider', provider)
  if (q) p.set('q', q)
  const qs = p.toString()
  return call<{ contacts: Contact[] }>(`/api/contacts${qs ? `?${qs}` : ''}`)
}

export const getMessages = (peer: string, limit = 10) =>
  call<{ messages: Msg[] }>(`/api/messages?peer=${encodeURIComponent(peer)}&limit=${limit}`)

export const sendMessage = (peer: string, text: string) =>
  call<{ ok: boolean }>('/api/send', {
    method: 'POST',
    body: JSON.stringify({ peer, text }),
  })
