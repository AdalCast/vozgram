<!-- Copia versionada de lo que vive en /opt/vozgram/CLAUDE.md del servidor.
     Un agente que arranque ahi lo carga solo. Si lo cambias aqui, copialo:
       scp docs/CLAUDE-servidor.md root@<VPS>:/opt/vozgram/CLAUDE.md -->

# VozGram — servidor de producción

Backend de VozGram: dicta y envía mensajes de Telegram y WhatsApp desde unos
lentes Even Realities G2. Corre como `vozgram.service` detrás de nginx.

## LEE ESTO ANTES DE TOCAR NADA

**[RUNBOOK.md](RUNBOOK.md)** tiene el procedimiento para cada falla conocida,
con las trampas ya pagadas. La más frecuente es que WhatsApp se desvincule.

## Reglas

- **Nunca copies `data/wa-auth/` fuera de este servidor.** Quien la tenga
  controla el WhatsApp del dueño. Igual con `.env` (`TG_SESSION`,
  `SONIOX_API_KEY`, `APP_SECRET`).
- **Nunca corras un script de WhatsApp con el servicio arriba.** Dos procesos
  no comparten una sesión. `systemctl stop vozgram` primero, siempre.
- **Diagnostica antes de actuar.** Revincular una sesión sana la destruye.
  Lee el log primero: `journalctl -u vozgram --since "-24h" | grep whatsapp`.
- **Mueve, no borres.** Respalda con sufijo de fecha antes de tocar algo.
- **Mide el resultado.** Un cambio puede desplegarse limpio y no hacer nada.

## Estructura

```
src/server.ts             endpoints; NO conoce Telegram ni WhatsApp
src/messaging/port.ts     el contrato que cumplen los mensajeros
src/messaging/index.ts    enruta cada peer a su adaptador
src/messaging/telegram.ts MTProto — pregunta y recibe respuesta
src/messaging/whatsapp.ts Baileys — solo escucha lo que llega
src/messaging/store.ts    SQLite; existe porque a WhatsApp no se le puede
                          preguntar por el historial
data/wa-auth/             sesión de WhatsApp   (crítica)
data/whatsapp.db          chats y mensajes     (no se recupera si se pierde)
```

No es un repositorio git: el código se copia con `scp`. El código fuente vive
en https://github.com/AdalCast/vozgram

Corre con `npx tsx`, sin paso de compilación: el archivo copiado es el que se
ejecuta. Verifica con `npx tsc --noEmit` en desarrollo ANTES de copiar.
