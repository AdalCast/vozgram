# VozGram — necesidades detectadas usando la app

Se anota TODO lo que molesta al usarla, aunque no se implemente ya.
La trampa de construir para uno mismo es implementar lo ultimo que molesto,
no lo que mas molesta. Por eso se anota antes de decidir.

## Hecho

- [x] Push-to-talk: el mic solo graba mientras se mantiene presionado (v0.2.0)
- [x] `<end>` de Soniox filtrado del mensaje (v0.4.0)
- [x] Leer la conversacion: ultimos 10 mensajes con scroll (v0.5.0)
- [x] Textos en espanol mexicano, no rioplatense (v0.6.0)
- [x] Espejo de la pantalla del G2 en la WebView del telefono (v0.7.0)
- [x] Al enviar, quedarse en el chat en vez de volver al menu (v0.8.0)
- [x] Las respuestas del contacto aparecen solas, sin salir y entrar (v0.8.0)

## Para la version publica (no urgente)

El usuario decidio 2026-09-05: por ahora alcanza con que la use el.
Esto queda parkeado para cuando se quiera abrir a mas gente.

- [ ] Pantalla de configuracion en la WebView del telefono (URL del backend +
      secreto), guardada con `bridge.setLocalStorage`. Es HTML comun: FACIL.
- [ ] Pagina `/setup` servida por el propio backend de cada usuario: pegar clave
      de Soniox, hacer el login de Telegram desde el navegador (misma logica que
      `login-assisted.ts`, otra interfaz) y mostrar su APP_SECRET. MEDIO.
- [ ] Empaquetar el backend en Docker + Caddy (TLS automatico) para que instalar
      sea un solo comando. MEDIO.
- [ ] **BLOQUEANTE A VERIFICAR PRIMERO**: el `whitelist` de red en app.json se
      congela al empaquetar. Si el runtime NO acepta comodines (`https://*`),
      hace falta un .ehpk por persona y el modelo compartido se cae.
      El empaquetador acepta cualquier string (ni siquiera valida), asi que solo
      se sabe probando en hardware real: armar un build con whitelist
      `https://*.duckdns.org` SIN el dominio exacto y ver si sigue funcionando.

## Pendiente — ideas sin priorizar

- [ ] Traer mas de 10 mensajes / cargar mas al llegar al principio
- [ ] Buscar contacto (la lista crece y el orden cambia por actividad)
- [ ] Respuestas rapidas predefinidas (si/no/ahi voy) sin dictar
- [ ] Aviso de mensaje nuevo cuando NO estas dentro de ese chat
- [ ] Editar el texto antes de enviar (hoy es redictar todo)
- [ ] Reconexion de Soniox tras la migracion a WebView headless (background)

## Como priorizar

Para cada idea, anotar **cada cuanto te pega en el uso real**:
todos los dias / cada semana / me paso una vez.
Se implementa lo que mas pega, no lo ultimo que aparecio.
