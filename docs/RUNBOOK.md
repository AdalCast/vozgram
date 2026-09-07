# Runbook de operación — VozGram

Qué hacer cuando algo se rompe en el servidor. Escrito para que lo siga
cualquiera —persona o agente— sin haber estado presente cuando pasó.

**Servidor**: VPS, `/opt/vozgram`. Servicio `vozgram.service`.
**NO es un repositorio git**: el código se copia a mano con `scp`.
El código fuente vive en https://github.com/AdalCast/vozgram

Copia viva en el servidor: `/opt/vozgram/RUNBOOK.md`.

---

## Reglas que no se negocian

1. **Nunca copies `data/wa-auth/` fuera del servidor.** Quien tenga esa carpeta
   tiene control total del WhatsApp del dueño. Lo mismo para `TG_SESSION` y
   `SONIOX_API_KEY` en `.env`.
2. **Nunca corras un script de WhatsApp con el servicio arriba.** Dos procesos
   no pueden compartir una sesión: el segundo recibe `Connection Closed` y
   puede dejar la sesión inservible. Siempre `systemctl stop vozgram` primero.
3. **Mueve, no borres.** Antes de tocar credenciales o código, respalda con
   sufijo de fecha. Si el arreglo sale mal, hay de dónde volver.
4. **Mide el resultado, no confíes en que el deploy salió bien.** Un cambio
   puede desplegarse limpio y no hacer nada. Ver «Verificar» en cada sección.

---

## Qué es esto y cómo está armado

Backend de VozGram: dicta y envía mensajes de Telegram y WhatsApp desde unos
lentes Even Realities G2. Corre detrás de nginx.

```
src/server.ts             endpoints; NO conoce Telegram ni WhatsApp
src/messaging/port.ts     el contrato que cumplen los mensajeros
src/messaging/index.ts    enruta cada peer a su adaptador
src/messaging/telegram.ts MTProto — pregunta y recibe respuesta
src/messaging/whatsapp.ts Baileys — solo escucha lo que llega
src/messaging/store.ts    SQLite; existe porque a WhatsApp NO se le puede
                          preguntar por el historial
data/wa-auth/             sesión de WhatsApp   (crítica)
data/whatsapp.db          chats y mensajes     (no se recupera si se pierde)
```

Corre con `npx tsx`: **no hay paso de compilación**, el archivo copiado es el
que se ejecuta.

---

## Síntoma: HTTP 500 al abrir chats de WhatsApp

Telegram sigue funcionando (los adaptadores están aislados con
`Promise.allSettled`). Solo WhatsApp falla.

### 1. Confirmar el diagnóstico ANTES de tocar nada

```bash
journalctl -u vozgram --since "-24h" --no-pager | grep -i whatsapp | tail -20
```

| Lo que dice el log | Qué significa | Qué hacer |
|---|---|---|
| `sesion cerrada desde el telefono` | Sesión revocada | **Revincular** (abajo) |
| `caida (515); reconectando` | Normal, el protocolo | Nada, se arregla solo |
| `el socket murio sin avisar` | El vigilante lo detectó | Nada, reconecta solo |
| `N reconexiones fallidas seguidas` | Se rindió | `systemctl restart vozgram` |
| `mensajes descartados` | Ruido normal | Nada |

Solo el primero necesita revincular. **Revincular sin haber leído el log es
tirar una sesión sana.**

### 2. Revincular WhatsApp

Necesitas el teléfono en la mano: el código dura unos 3 minutos.

```bash
systemctl stop vozgram                       # OBLIGATORIO: ver regla 2

cd /opt/vozgram
mv data/wa-auth data/wa-auth.muerta-$(date +%Y%m%d-%H%M)   # mover, no borrar

rm -f /tmp/wa-login.log
nohup npx tsx src/login-whatsapp.ts <NUMERO_CON_LADA> > /tmp/wa-login.log 2>&1 &

sleep 15 && cat /tmp/wa-login.log            # aquí sale el código de 8 letras
```

En el teléfono: **WhatsApp → Ajustes → Dispositivos vinculados → Vincular
dispositivo → Vincular con número de teléfono**, y escribir el código.

Después de emparejar, el log dirá:

```
[conexion cerrada (515); reconectando 1/8...]
VINCULADO Y REGISTRADO.
```

**El 515 NO es un error.** WhatsApp cierra la conexión a propósito y el
emparejamiento se completa en la reconexión. Matar el proceso al verlo es el
error clásico: costó tres intentos fallidos la primera vez.

### 3. Levantar y verificar

```bash
pgrep -af "login-whatsap[p]" || echo "sin procesos de login (correcto)"
systemctl start vozgram
sleep 20 && journalctl -u vozgram --since "-1min" --no-pager | tail -10
```

Se espera ver `[whatsapp] conectado`. Cuarenta y cinco segundos después:
`N chats nombrados via @lid` y `N identidades @lid unificadas`.

Conectado no es suficiente: hay que confirmar que **recibió**.

```bash
cd /opt/vozgram && node -e '
const {DatabaseSync}=require("node:sqlite");
const db=new DatabaseSync("data/whatsapp.db");
for (const t of ["chats","messages","contacts","lid_map"])
  console.log(t.padEnd(10), db.prepare("SELECT COUNT(*) n FROM "+t).get().n);
'
```

**No cuentes `chats.name` para saber cuántos tienen nombre.** El nombre sale de
una cascada con `contacts`; contar la columna sola da un número bajo y falso.
La consulta correcta:

```sql
SELECT COUNT(*) FROM chats ch LEFT JOIN contacts co ON co.id = ch.id
WHERE COALESCE(NULLIF(ch.name,''), NULLIF(co.name,'')) IS NOT NULL
```

### 4. Limpiar, días después

```bash
rm -rf /opt/vozgram/data/wa-auth.muerta-*
```

---

## Por qué se desvincula

Vincular un dispositivo nuevo **no** desvincula los demás. Lo que sí revoca la
sesión del servidor:

- **Cerrar todas las sesiones** desde el teléfono. Es la causa habitual.
- **Llenar el cupo de dispositivos vinculados**: entra el nuevo y sale el más
  viejo. El del servidor es el candidato natural porque nadie lo toca.

Después de vincular cualquier dispositivo nuevo, conviene revisar la lista de
vinculados y confirmar que el servidor sigue ahí.

---

## Desplegar un cambio del backend

`/opt/vozgram` **no es un repositorio git**. Desde la máquina de desarrollo:

```bash
cd ~/Documentos/even-telegram/backend/src/messaging

# 1. respaldar lo que hay en el servidor
ssh root@<VPS> 'cd /opt/vozgram/src/messaging && M=$(date +%Y%m%d-%H%M) &&
  for f in port.ts index.ts store.ts whatsapp.ts; do cp "$f" "$f.bak-$M"; done'

# 2. copiar
scp port.ts index.ts store.ts whatsapp.ts root@<VPS>:/opt/vozgram/src/messaging/

# 3. CONFIRMAR que llegó lo mismo, no asumirlo
md5sum port.ts index.ts store.ts whatsapp.ts
ssh root@<VPS> 'md5sum /opt/vozgram/src/messaging/{port,index,store,whatsapp}.ts'

# 4. reiniciar
ssh root@<VPS> 'systemctl restart vozgram && sleep 8 && systemctl is-active vozgram'
```

El servicio corre con `npx tsx`, así que **no hay paso de compilación**: el
archivo copiado es el que se ejecuta. Pasa `npx tsc --noEmit` en local antes de
copiar, o el error aparece en producción.

---

## Lo que vive dónde

| Cosa | Ruta | Si se pierde |
|---|---|---|
| Sesión de WhatsApp | `data/wa-auth/` | Revincular (arriba) |
| Mensajes y chats | `data/whatsapp.db` | **No se recupera.** WhatsApp no reenvía lo viejo |
| Sesión de Telegram | `TG_SESSION` en `.env` | Correr `npm run login` |
| Clave de Soniox | `.env` | Sacar otra del panel de Soniox |

`data/wa-auth/` y `data/whatsapp.db` son **archivos distintos**: perder las
credenciales no toca los mensajes. Al revincular, WhatsApp manda una
sincronización inicial y el historial se repuebla.

---

## Trampas ya pagadas

- **`pkill -f "login-whatsapp"` por SSH mata la propia sesión remota**: el
  comando remoto contiene el patrón. Usar `pgrep -af "login-whatsap[p]"`.
- **Baileys devuelve los teléfonos con sufijo de dispositivo**
  (`521...:0@s.whatsapp.net`) y los chats se guardan sin él. Comparar sin
  normalizar con `jidBase()` no encuentra nada **y no falla**.
- **Chats que se ven repetidos**: WhatsApp está migrando a `@lid` y una persona
  puede existir bajo dos identidades. `mapearLids()` las une. Pero si dos chats
  solo comparten el NOMBRE, son personas distintas: **unir por nombre mandaría
  mensajes a quien no es.**
