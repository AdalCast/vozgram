/**
 * A diferencia de la app privada, aqui NO hay BACKEND_URL ni APP_SECRET: no
 * existe servidor al que apuntar ni secreto compartido que embeber. Lo que el
 * usuario configura (api_id, api_hash, llave de Soniox) lo da de alta en la
 * pantalla del telefono y vive en SU almacenamiento, no en el paquete.
 *
 * Las medidas de pantalla son del hardware, no logica compartida: se declaran
 * aqui igual que en la app privada.
 */
export const SCREEN_W = 576
export const SCREEN_H = 288

export const SONIOX_WS_URL = 'wss://stt-rt.soniox.com/transcribe-websocket'
export const SONIOX_MODEL = 'stt-rt-v5'
