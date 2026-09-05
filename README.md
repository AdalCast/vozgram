# VozGram

Dictar y enviar mensajes de **Telegram** desde unos lentes **Even Realities G2**,
sin sacar el teléfono del bolsillo.

Mantienes presionado el touchpad, hablas, sueltas, confirmas en el HUD y el
mensaje sale. También puedes leer los últimos mensajes del chat en los lentes.

> Proyecto personal, no afiliado ni respaldado por Even Realities ni por Telegram.
> Usa la API oficial de Telegram (MTProto) con tu propia cuenta.

## Cómo funciona

```
G2  --BLE-->  Teléfono (Even App, WebView)
                |  1. pide clave temporal  ------->  backend (tu VPS)
                |  2. audio PCM s16le 16k  ------->  wss://stt-rt.soniox.com  (directo)
                |  3. texto ya transcrito  ------->  backend
                v
          VPS con nginx + TLS
            `-- GramJS (MTProto) --> tu cuenta de Telegram
```

**El audio nunca pasa por el backend**: el teléfono habla directo con Soniox
usando una clave temporal de un solo uso que el backend acuña. Por el servidor
solo circula texto.

La clave madre de Soniox y el *session string* de Telegram viven **solo en el
VPS**. El paquete `.ehpk` es extraíble una vez publicado: nunca metas secretos
ahí. Lo único que viaja en el cliente es el `APP_SECRET` — un tradeoff conocido
y aceptado por tratarse de una app privada de un solo usuario.

## Interacción

| Pantalla | Tap | Mantener | Soltar | Doble tap |
|---|---|---|---|---|
| **PICK** (raíz) | elegir chat | — | — | salir (diálogo del sistema) |
| **READ** | — | responder | — | volver a PICK |
| **DICTATE** | — | — | terminar → CONFIRM | — |
| **CONFIRM** | **ENVIAR** | — | — | repetir |

En **READ** se ven los últimos 10 mensajes; el swipe pagina. La vista se
refresca sola cada 10 s respetando dónde va leyendo el usuario. El reloj está
siempre visible arriba a la derecha.

El micrófono se enciende **solo** mientras se mantiene presionado.

## Requisitos

- Unos Even Realities G2 y la Even App con una cuenta de desarrollador
- Un servidor con dominio y TLS (el backend no debe exponerse sin HTTPS)
- Una app de Telegram registrada en <https://my.telegram.org> (`api_id`, `api_hash`)
- Una cuenta de [Soniox](https://soniox.com) para la transcripción en tiempo real

## Puesta en marcha

### Backend

```bash
cd backend
cp .env.example .env
chmod 600 .env
npm install
npm run login    # UNA sola vez, interactivo: genera y guarda TG_SESSION
npm start
```

Variables de `backend/.env`:

| Variable | Qué es |
|---|---|
| `TG_API_ID`, `TG_API_HASH` | credenciales de tu app en my.telegram.org |
| `TG_SESSION` | sesión MTProto — **la genera `npm run login`, es crítica** |
| `SONIOX_API_KEY` | clave madre de Soniox (nunca sale del servidor) |
| `APP_SECRET` | secreto compartido con el cliente, 64 hex |
| `PORT`, `BIND_HOST` | por defecto `8787` y `127.0.0.1` |
| `CORS_ORIGIN` | el WebView de iOS usa un origin local impredecible |
| `MESSAGING_PROVIDER` | `telegram` (por defecto) o `whatsapp` |
| `WA_AUTH_DIR` | sesión de WhatsApp, por defecto `./data/wa-auth` — **crítica** |
| `WA_DB_PATH` | base de mensajes de WhatsApp, por defecto `./data/whatsapp.db` |

El backend escucha **solo en loopback**. La única puerta de entrada es nginx,
que hace proxy al puerto 8787 y termina el TLS.

### WhatsApp (opcional)

Se vincula **una sola vez**, con código de emparejamiento — no hay que escanear
ningún QR:

```bash
npm run login-whatsapp -- 5215512345678   # con código de país, sin el +
```

Imprime 8 caracteres que se escriben en el teléfono, en WhatsApp → Ajustes →
Dispositivos vinculados → Vincular con número de teléfono. Después:

```
MESSAGING_PROVIDER=whatsapp
```

**Advertencias que hay que leer antes:**

- Baileys **no es oficial**: usarlo va contra los términos de servicio de
  WhatsApp y existe riesgo real de que baneen el número.
- `data/wa-auth/` da control de tu WhatsApp a quien la tenga. Nunca sale del
  servidor, nunca entra a un backup sin cifrar. Está en el `.gitignore`.
- **WhatsApp no permite consultar historial.** Los mensajes llegan por eventos
  y este backend los guarda en SQLite (`node:sqlite`, incluido en Node 22+, sin
  dependencias). Verás la conversación desde que vinculaste hacia adelante, más
  lo que WhatsApp empuje al vincular. No es una limitación del código: es el
  protocolo.
- La versión publicada como `latest` de Baileys es un **release candidate**. La
  última "estable" es de hace más de un año y, en una biblioteca de ingeniería
  inversa, vieja significa rota. Por eso se fija la versión exacta.
- Baileys arrastra `whatsapp-rust-bridge`, que es **solo-ESM**. Este backend es
  CommonJS, así que Baileys se carga con `import()` dinámico: un import estático
  tumba el servidor al arrancar y se lleva puesto a Telegram.

### Cliente (lentes)

`glasses/.env` necesita dos variables:

```
VITE_BACKEND_URL=https://tu-backend.ejemplo.org
VITE_APP_SECRET=<el mismo APP_SECRET del backend>
```

**Cuidado**: todo lo que empiece con `VITE_` queda **incrustado en el bundle**
al compilar. No pongas ahí nada que no puedas permitirte publicar.

```bash
cd glasses
npm install
npm run dev                                   # http://localhost:5173
npx evenhub-simulator http://localhost:5173   # simulador de escritorio
npx evenhub qr --url http://<tu-ip>:5173      # sideload al G2 real
```

El dominio del backend también debe ir en el `whitelist` de `app.json`, o el
runtime bloquea la conexión en el hardware real.

### Entorno de pruebas completo

```bash
cd backend && set -a && . ./.env && set +a && npx tsx src/server.ts &
cd glasses && npx vite --port 5173 --strictPort &
DISPLAY=:1 npx evenhub-simulator http://localhost:5173 --automation-port 9898 &
```

`glasses/.env.development.local` apunta al backend local; `glasses/.env` guarda
la URL de producción. Para probar la configuración de producción sin compilar:

```bash
npx vite --mode production --port 5173 --force
```

## Empaquetado

```bash
cd glasses
npx vite build
npx evenhub pack app.json dist -o vozgram-0.9.0.ehpk
```

- `min_app_version` debe ser **2.2.9** (piso que impone el SDK 0.0.14). La
  plantilla del quickstart trae 2.0.0, desactualizado: el CLI lo pisa igual y
  deja el manifiesto inconsistente con lo estampado.
- El `.ehpk` **no es un zip**: es un formato binario propio con magic bytes `EHPK`.
- El permiso `network` **exige** un array `whitelist`. El simulador no lo aplica;
  el hardware sí. Es la causa clásica de "funciona en el simulador y falla en los
  lentes".

## Actualizar una versión en los lentes (flujo real, no documentado)

Descubierto a mano el 2026-09-05. La documentación oficial no lo explica; solo
deja una línea suelta: *"Old beta still has old copy until reinstalled"*.

Una beta **no se actualiza sola**, y reinstalar no es un botón: es una secuencia.

```
1. Subir el .ehpk nuevo al portal
2. REFRESCAR la página del portal
3. El GRUPO BETA SE BORRA -> hay que volver a crearlo
4. Volver a agregar el email del tester al grupo
5. Empujar el build al grupo
6. Llega un correo NUEVO de invitación -> hay que aceptarlo otra vez
7. Teléfono -> Me -> Beta tester -> Install
8. Revisar que la app siga habilitada en Perfil -> My plugins
```

La asignación al menú de los lentes **sí** sobrevive la reinstalación.

**Consecuencia práctica**: cada versión cuesta varios minutos de ceremonia más
una vuelta por correo. No conviene empaquetar un cambio a la vez. Regla de
trabajo: agrupar varios cambios de interfaz, exprimir el simulador (que sí
refleja el código al instante) y empaquetar solo cuando el lote está cerrado.

Truco para saber qué versión tienes puesta sin buscar el número: elegir un
cambio **visible** por versión y usarlo como señal.

- `0.2.0` → dice "MANTÉN APRETADO"
- `0.9.0` → hay reloj arriba a la derecha

## Restricciones del hardware que condicionan el diseño

Esto es lo que costó descubrir. Si vas a construir para los G2, léelo.

- Pantalla de **576x288, 4 bits en escala de grises**. Brillo de texto 0-4.
- **No hay bocina**: toda confirmación es visual.
- **Protobuf omite los valores cero**, así que cualquier campo en cero llega
  como `undefined`. El `?? 0` no es defensivo, es obligatorio: el índice 0 de
  una lista (el primer contacto) llega como `undefined`.
- **Nunca dos llamadas al bridge en paralelo**: comparten el enlace BLE.
  Hay que serializarlas en cadena y ponerles timeout — un salto flojo cuelga
  unos 30 segundos.
- **Un solo contenedor por página puede capturar eventos.** Lista y texto no
  conviven; se cambia de página con `rebuildPageContainer`.
- Si un contenedor declara `zOrderIndex`, **todos** los de esa página deben
  declararlo, o falla con `MISSING_Z_ORDER_INDEX`.
- Los **swipes** llegan por `textEvent`; los **taps**, por `sysEvent`. Un
  `if (!event.sysEvent) return` prematuro descarta todos los eventos de audio.
- `LONG_PRESS_EVENT = 9` y `LONG_PRESS_RELEASE_EVENT = 10` **sí existen** en el
  SDK 0.0.14, aunque documentación de terceros afirme lo contrario.
- El firmware puede colar un CLICK espurio justo después de soltar: se ignoran
  los clicks dentro de los 700 ms posteriores a un `LONG_PRESS_RELEASE`.
- La pantalla se llena por **renglones renderizados**, no por caracteres. Para
  paginar hay que contar `ceil(largo / ancho_de_línea)`.
- El glifo `⏺` **no existe** en la fuente del firmware (los emojis sí renderizan).
- `localStorage` del navegador **no persiste** (es un WebView de Flutter). Hay
  que usar `bridge.setLocalStorage` / `getLocalStorage`.
- Al pasar a segundo plano el host **destruye** la WebView y crea una headless
  que recarga la misma URL. El WebSocket a Soniox no sobrevive: hay que reabrirlo.
- El SDK 0.0.14 **no expone** `setBackgroundState` ni `onBackgroundRestore`,
  pese a estar documentados. Persistencia vía `bridge.setLocalStorage`.
- El doble tap en la página raíz **debe** abrir `shutDownPageContainer(1)`:
  no hacerlo es causal de rechazo en la revisión de la tienda.
- Soniox emite un token de control `<end>` que hay que filtrar del transcrito.

## Verificado

- Voz real en hardware físico, caminando en la calle con el teléfono guardado
- Envío a un contacto de terceros (el `access_hash` no fue problema: la app
  siempre llama a `getDialogs` antes de enviar, y eso deja caliente el caché de
  entidades de GramJS)
- Desde internet: `/health` responde, y todos los demás endpoints devuelven
  **401** sin la cabecera `x-app-secret`
- Flujo completo en el simulador vía su API de automatización
  (`--automation-port`): `GET /api/ping`, `GET /api/screenshot/glasses`,
  `GET /api/console`, `POST /api/input`

## Estructura

```
backend/
  src/server.ts          Endpoints HTTP. NO conoce a ningún mensajero por su nombre.
  src/messaging/port.ts  El contrato: qué debe saber hacer un mensajero.
  src/messaging/         Un archivo por mensajero, cada uno cumpliendo el contrato.
glasses/                 App web (Vite + TypeScript) que corre en el WebView y pinta el HUD.
BACKLOG.md               Lo que molesta al usar la app, anotado antes de decidir qué sigue.
```

### Puertos y adaptadores

Los endpoints hablan con `MessagingProvider`, nunca con un mensajero concreto:

```
server.ts ──▶ index.ts (enrutador) ──▶ port.ts (el contrato)
                                          ▲          ▲
                                          │          │
                                   telegram.ts   whatsapp.ts
```

Agregar otro mensajero es escribir un archivo que cumpla el contrato y
registrarlo en `messaging/index.ts`. `server.ts` no se toca.

### Los dos mensajeros a la vez

`/api/contacts` devuelve los chats de **todos** los mensajeros activos en una
sola lista ordenada por actividad real, con el origen marcado (`TG` / `WA`).
La marca solo aparece si hay más de una fuente: con una sola sería ruido en
una pantalla de 576 px.

Cada id viaja prefijado (`whatsapp:5215512345678@s.whatsapp.net`) y el
enrutador lo devuelve a su adaptador. **Los ids son opacos para los lentes**:
solo los reciben y los devuelven, así que sumar un mensajero **no exige
reconstruir el `.ehpk`**.

Un id sin prefijo se enruta a Telegram. Eso no es cortesía: es lo que evita
romper la app ya instalada en los lentes, que manda ids sin prefijar.

Si un mensajero falla, la lista sigue mostrando los demás (`Promise.allSettled`).
Un mensajero caído no puede dejar al usuario sin app.

`MESSAGING_PROVIDERS` (lista separada por comas) permite acotar cuáles se usan.
Por defecto se usan todos los registrados.

## Licencia

MIT — ver [LICENSE](LICENSE).
