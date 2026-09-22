# Por qué el whitelist dice lo que dice

Los cinco `wss://*.web.telegram.org` son los **centros de datos de Telegram**.
GramJS elige uno segun donde se registro la cuenta y puede **migrar a otro** en
cualquier momento (`PHONE_MIGRATE_X`, `USER_MIGRATE_X`), asi que van los cinco
o la app se cuelga para quien caiga en el que falta.

Y se cuelga literal: en el hardware una peticion fuera del whitelist **no
falla, se queda esperando para siempre**. El simulador no aplica el whitelist,
asi que este error solo aparece en los lentes, despues de una vuelta entera por
el portal.

## Lo que NO va

- **Las variantes `-1`** (`venus-1.web.telegram.org`) son para **descargar
  medios**. Esta app solo manda y lee texto; si algun dia se agregan fotos o
  notas de voz, hay que agregar las cinco.
- **Ningun dominio propio.** Eso es el punto entero de esta version: no hay
  backend. Si aparece un dominio aqui, algo se hizo mal.

## Antes de empaquetar

```bash
~/.claude/skills/even-realities-g2/scripts/revisar-paquete.sh app.json dist
```
