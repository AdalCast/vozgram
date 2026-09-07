import { BACKEND_URL, APP_SECRET } from './config'

export interface Contact { id: string; name: string }
/**
 * `estado` es OPCIONAL: un backend viejo no lo manda y la app tiene que seguir
 * funcionando igual. Ausente = se asume listo.
 */
export type EstadoMensajero = 'listo' | 'conectando' | 'desvinculado' | 'caido'
export interface Provider { id: string; label: string; estado?: EstadoMensajero }
/** `sender` solo viene en GRUPOS: en un chat de a dos, `out` ya lo dice todo. */
export interface Msg { out: boolean; text: string; sender?: string }

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${BACKEND_URL}${path}`, {
    ...init,
    headers: {
      'x-app-secret': APP_SECRET,
      'Content-Type': 'application/json',
      ...(init?.headers ?? {}),
    },
  })
  if (!res.ok) throw new Error(`${path} -> HTTP ${res.status}`)
  return res.json() as Promise<T>
}

export const getSonioxKey = () =>
  call<{ api_key: string }>('/api/soniox-key', { method: 'POST' })

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
