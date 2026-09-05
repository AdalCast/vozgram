/**
 * Normaliza para comparar: sin acentos, sin mayusculas, sin espacios sobrantes.
 *
 * Buscar "martin" TIENE que encontrar a "Martín". En espanol, un buscador que
 * distingue acentos es un buscador que no sirve. Vive aca y no dentro de un
 * adaptador porque la usan todos.
 */
export function normalizar(t: string): string {
  return t.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim()
}
