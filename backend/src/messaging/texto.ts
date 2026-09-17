/**
 * Normaliza para comparar: sin acentos, sin mayusculas, sin puntuacion, sin
 * espacios sobrantes.
 *
 * Buscar "martin" TIENE que encontrar a "Martín". En espanol, un buscador que
 * distingue acentos es un buscador que no sirve. Vive aca y no dentro de un
 * adaptador porque la usan todos.
 *
 * La puntuacion se quita por una razon concreta: la busqueda de los lentes se
 * DICTA, y el transcriptor le pone puntos y comas a lo que oye. Al decir
 * "Gael" llegaba la cadena "Gael," y se buscaban chats que contuvieran esa
 * coma. Ninguno la tenia, asi que TODA busqueda por voz salia vacia -- sin
 * error y sin pista de por que.
 *
 * Se aplica igual al texto y a la aguja, asi que la comparacion sigue siendo
 * simetrica: quitarla de un solo lado si romperia.
 */
/**
 * Deja solo lo que la fuente del firmware sabe dibujar.
 *
 * Los emoji salen como una cajita vacia o directamente en blanco -- verificado
 * en el simulador: un grupo llamado "🏳‍🌈 Toxicos 👑" se veia "Toxicos []", y
 * un chat cuyo nombre entero era "💤💤" dejaba el renglon MUDO: ocupaba lugar
 * en la lista y no se podia saber de quien era.
 *
 * Devuelve cadena vacia si no queda nada legible. Quien llama decide con que
 * rellenar, porque solo el sabe si tiene un telefono a mano.
 */
export function soloLegible(t: string): string {
  return t
    .replace(/[^\p{Script=Latin}\p{N}\p{P}\p{Zs}+]/gu, '')
    .replace(/\s+/g, ' ')
    .trim()
}

export function normalizar(t: string): string {
  return t
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    // Fuera todo lo que no sea letra, numero o espacio. \p{L} y \p{N} cubren
    // la ñ y cualquier alfabeto; un [a-z0-9] pelado se comeria la ñ.
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}
