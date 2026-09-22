import {
  TextContainerProperty,
  ListContainerProperty,
  ListItemContainerProperty,
  RebuildPageContainer,
  CreateStartUpPageContainer,
} from '@evenrealities/even_hub_sdk'
import { SCREEN_W, SCREEN_H } from './config'

// Solo UN contenedor por pagina puede capturar eventos (isEventCapture: 1).
// Si hay dos, el SDK rechaza la pagina con error de validacion.
export const TEXT_ID = 1
export const TEXT_NAME = 'main'
export const LIST_ID = 2
export const LIST_NAME = 'contacts'
export const CLOCK_ID = 3
export const CLOCK_NAME = 'clock'
export const TITLE_ID = 4
export const TITLE_NAME = 'title'
/**
 * Alto de la barra superior: reloj a la derecha, titulo a la izquierda.
 * Verificado en el simulador: con 26 el primer contacto quedaba pegado al
 * titulo. 32 le da aire sin comerse un renglon de la lista.
 */
const BAR_H = 32

/**
 * Reloj: contenedor propio arriba a la derecha, presente en TODAS las pantallas.
 * isEventCapture en 0 porque solo UNO puede capturar eventos, y ese es el
 * contenedor principal. zOrderIndex mayor para que dibuje por encima.
 */
export function clockContainer(hhmm: string): TextContainerProperty {
  return new TextContainerProperty({
    // El texto va pegado a la IZQUIERDA de su contenedor, asi que la posicion
    // del contenedor ES la del reloj. Ajustado al ancho del texto para que no
    // quede flotando en medio de una caja vacia.
    // El indicador que dibuja el firmware va pegado al FINAL del contenedor,
    // no a una posicion fija: empujar el contenedor al borde los lleva a los
    // dos. Medido en el simulador.
    xPosition: SCREEN_W - 68,
    yPosition: 2,
    width: 64,
    height: 26,
    borderWidth: 0,
    borderColor: 5,
    paddingLength: 0,
    containerID: CLOCK_ID,
    containerName: CLOCK_NAME,
    content: hhmm,
    isEventCapture: 0,
    zOrderIndex: 2,
  })
}

/**
 * Titulo de la lista: en que app estas y, si hay busqueda, que buscaste.
 * Sin esto, dos listas identicas de nombres serian indistinguibles.
 */
export function titleContainer(text: string): TextContainerProperty {
  return new TextContainerProperty({
    xPosition: 4,
    yPosition: 2,
    width: SCREEN_W - 112,   // hasta donde empieza el reloj
    height: BAR_H,
    borderWidth: 0,
    borderColor: 5,
    paddingLength: 0,
    containerID: TITLE_ID,
    containerName: TITLE_NAME,
    content: text,
    isEventCapture: 0,
    // UNICO en la pagina: no alcanza con que todos declaren zOrderIndex, ademas
    // no se pueden repetir (DUPLICATE_Z_ORDER_INDEX). El reloj usa el 2.
    zOrderIndex: 3,
  })
}

export function textPage(content: string): TextContainerProperty {
  return new TextContainerProperty({
    xPosition: 0,
    yPosition: 0,
    width: SCREEN_W,
    height: SCREEN_H,
    borderWidth: 0,
    borderColor: 5,
    paddingLength: 4,
    containerID: TEXT_ID,
    containerName: TEXT_NAME,
    content,
    isEventCapture: 1,
    zOrderIndex: 1,
  })
}

export function listPage(names: string[]): ListContainerProperty {
  return new ListContainerProperty({
    xPosition: 0,
    // Baja lo que mide la barra: si arrancara en 0, el titulo taparia el
    // primer contacto de la lista.
    yPosition: BAR_H,
    width: SCREEN_W,
    height: SCREEN_H - BAR_H,
    borderWidth: 0,
    borderColor: 5,
    paddingLength: 4,
    containerID: LIST_ID,
    containerName: LIST_NAME,
    isEventCapture: 1,
    // Si UN contenedor de la pagina declara zOrderIndex, TODOS deben hacerlo.
    zOrderIndex: 1,
    // OJO: anidado en itemContainer, NO plano (verificado contra el .d.ts)
    itemContainer: new ListItemContainerProperty({
      itemCount: names.length,
      itemName: names,
      isItemSelectBorderEn: 1,
      // Sin esto el recuadro de seleccion se ajusta al LARGO DEL TEXTO, y se
      // lee como "esta palabra esta en una caja" en vez de "esta fila esta
      // seleccionada". A lo ancho del contenedor menos el padding de los dos
      // lados.
      itemWidth: SCREEN_W - 16,
    }),
  })
}

// Todas las paginas llevan el reloj, por eso containerTotalNum es 2.
export const startUpWithText = (content: string, hhmm: string) =>
  new CreateStartUpPageContainer({
    containerTotalNum: 2,
    textObject: [textPage(content), clockContainer(hhmm)],
  })

export const rebuildWithText = (content: string, hhmm: string) =>
  new RebuildPageContainer({
    containerTotalNum: 2,
    textObject: [textPage(content), clockContainer(hhmm)],
  })

// La lista lleva reloj Y titulo: tres contenedores.
export const rebuildWithList = (names: string[], hhmm: string, title: string) =>
  new RebuildPageContainer({
    containerTotalNum: 3,
    listObject: [listPage(names)],
    textObject: [clockContainer(hhmm), titleContainer(title)],
  })

// --- Pantalla de inicio: apps a la izquierda, bandeja a la derecha ---------
export const INBOX_ID = 7; export const INBOX_NAME = 'inbox'

const APPS_W = 140
const MARGEN = 6
const TOPE = BAR_H + 2
const PANEL_X = MARGEN + APPS_W + MARGEN
const PANEL_W = SCREEN_W - PANEL_X - MARGEN
const ALTO = SCREEN_H - TOPE - MARGEN

/**
 * La misma pantalla con el foco en un lado o en el otro.
 *
 * Un solo contenedor por pagina captura eventos, asi que "mover el foco" es
 * literalmente reconstruir la pagina cambiando cual de los dos es la LISTA y
 * cual es el TEXTO. No hay forma de tener los dos vivos a la vez.
 *
 * El foco arranca en la bandeja porque es lo que se mira al abrir; las apps
 * son el camino cuando ya sabes a quien buscas.
 */
export function rebuildInicio(
  foco: 'bandeja' | 'apps',
  apps: string[],
  pendientes: string[],
  titulo: string,
  hhmm: string,
) {
  const caja = (esLista: boolean, x: number, w: number, alto: number) => ({
    xPosition: x,
    yPosition: TOPE,
    width: w,
    height: alto,
    borderWidth: 1,
    borderColor: 5,
    borderRadius: 6,
    paddingLength: esLista ? 6 : 8,
  })

  // Alto de la caja de apps: ajustada al contenido para que quede ARRIBA y no
  // flotando a media caja. Un renglon mide ~42 px.
  const altoApps = 42 * Math.max(apps.length, 1) + 20

  if (foco === 'apps') {
    return new RebuildPageContainer({
      containerTotalNum: 4,
      listObject: [
        new ListContainerProperty({
          ...caja(true, MARGEN, APPS_W, altoApps),
          containerID: LIST_ID, containerName: LIST_NAME,
          isEventCapture: 1, zOrderIndex: 1,
          itemContainer: new ListItemContainerProperty({
            itemCount: apps.length, itemName: apps,
            isItemSelectBorderEn: 1, itemWidth: APPS_W - 16,
          }),
        }),
      ],
      textObject: [
        new TextContainerProperty({
          ...caja(false, PANEL_X, PANEL_W, ALTO),
          containerID: INBOX_ID, containerName: INBOX_NAME,
          content: pendientes.join('\n'), isEventCapture: 0, zOrderIndex: 4,
        }),
        clockContainer(hhmm),
        titleContainer(titulo),
      ],
    })
  }

  return new RebuildPageContainer({
    containerTotalNum: 4,
    listObject: [
      new ListContainerProperty({
        ...caja(true, PANEL_X, PANEL_W, ALTO),
        containerID: LIST_ID, containerName: LIST_NAME,
        isEventCapture: 1, zOrderIndex: 1,
        itemContainer: new ListItemContainerProperty({
          itemCount: pendientes.length, itemName: pendientes,
          isItemSelectBorderEn: 1, itemWidth: PANEL_W - 16,
        }),
      }),
    ],
    textObject: [
      new TextContainerProperty({
        ...caja(false, MARGEN, APPS_W, altoApps),
        containerID: INBOX_ID, containerName: INBOX_NAME,
        content: apps.join('\n'), isEventCapture: 0, zOrderIndex: 4,
      }),
      clockContainer(hhmm),
      titleContainer(titulo),
    ],
  })
}
