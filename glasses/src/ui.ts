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
    xPosition: SCREEN_W - 104,
    yPosition: 2,
    width: 100,
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
