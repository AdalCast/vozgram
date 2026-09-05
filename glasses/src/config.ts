// OJO: todo lo que empiece con VITE_ TERMINA DENTRO DEL BUNDLE.
// Para una app privada (estado Test) es aceptable. Si algun dia se publica
// a Released, este secreto es extraible del .ehpk y hay que rediseñar
// la autenticacion (token por dispositivo, OAuth, etc).
export const BACKEND_URL = import.meta.env.VITE_BACKEND_URL ?? ''
export const APP_SECRET = import.meta.env.VITE_APP_SECRET ?? ''

export const SONIOX_WS_URL = 'wss://stt-rt.soniox.com/transcribe-websocket'
export const SONIOX_MODEL = 'stt-rt-v5'

export const SCREEN_W = 576
export const SCREEN_H = 288
