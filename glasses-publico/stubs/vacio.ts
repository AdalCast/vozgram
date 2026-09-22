/**
 * Modulos de Node que GramJS importa pero NO usa por el camino de navegador
 * (fs, net, stream, assert, constants). Resolverlos a `{}` y no a `undefined`
 * es la diferencia entre que el bundle cargue o que estalle al evaluarse.
 */
export default {}
