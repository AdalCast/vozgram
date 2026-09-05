import { BACKEND_URL, APP_SECRET } from './config'

export interface Contact { id: string; name: string }
export interface Msg { out: boolean; text: string }

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

export const getContacts = () =>
  call<{ contacts: Contact[] }>('/api/contacts')

export const getMessages = (peer: string, limit = 10) =>
  call<{ messages: Msg[] }>(`/api/messages?peer=${encodeURIComponent(peer)}&limit=${limit}`)

export const sendMessage = (peer: string, text: string) =>
  call<{ ok: boolean }>('/api/send', {
    method: 'POST',
    body: JSON.stringify({ peer, text }),
  })
