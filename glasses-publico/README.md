# VozGram Telegram — versión publicable

Esta carpeta es **hermana** de `glasses/`, no su reemplazo. Las dos construyen
una app para los mismos lentes, pero son productos distintos:

| | `glasses/` | `glasses-publico/` |
|---|---|---|
| Mensajeros | Telegram **y WhatsApp** | solo Telegram |
| Dónde vive la sesión | en el VPS del dueño | **en el teléfono de cada quien** |
| Backend | `backend/` en un VPS | **ninguno** |
| Para quién | uso personal | publicable en Even Hub |

## Por qué existe

Publicar la app de `glasses/` significaría que el dueño del servidor custodia
las sesiones de Telegram y WhatsApp de desconocidos. Una sesión de MTProto es
acceso TOTAL a esa cuenta. Eso no se hace.

Aquí la librería de Telegram corre **dentro de la WebView del teléfono**: el
usuario da de alta su propia cuenta en la pantalla del celular y sus mensajes
nunca tocan una máquina ajena. Sin servidor no hay custodia, y sin custodia no
hay responsabilidad que asumir.

WhatsApp **no puede** venirse: Baileys declara `engines: node >= 20` y no tiene
build de navegador. Por eso la versión publicable es Telegram y punto.

## Qué se comparte con `glasses/` y qué no

**Se comparte `ui.ts`** —las 237 líneas que dibujan la pantalla— por un alias
de Vite. Ese archivo es dibujo puro: no sabe que existen proveedores, ni un
backend, ni WhatsApp. Tenerlo en dos copias garantizaría que una de las dos se
pudra al primer ajuste de diseño.

**Todo lo demás es propio.** `glasses/` no se toca nunca desde aquí.

> Un cambio en `ui.ts` afecta a las dos apps, pero **no llega a ningunos lentes
> hasta que alguien corre `pack.sh`**. El `.ehpk` instalado está congelado. Al
> empaquetar cualquiera de las dos, verificar las dos en el simulador.

## Estado

En construcción. El arnés de compilación está verificado: GramJS completa el
apretón de manos de MTProto dentro de la WebView en 3.1 s.

Falta el adaptador `tg-directo.ts` y el formulario de alta.
