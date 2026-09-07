# Anuncio para Discord

Texto listo para publicar en comunidades. Cada versión cabe en **un solo
mensaje** de Discord (el límite son 2000 caracteres).

Las capturas van como **archivos adjuntos**, no como enlaces: están en
[`docs/capturas/`](capturas/) y pesan entre 5 y 8 KB cada una. Adjuntarlas
directo hace que Discord las hospede en su CDN — un enlace a un servidor propio
publicaría su dominio y le mandaría el tráfico de cada persona que abra el
mensaje.

---

## Español

> **VozGram — dictar y enviar mensajes de Telegram y WhatsApp desde los G2**
>
> Mantienes presionado el touchpad, hablas, sueltas, confirmas en el HUD y el mensaje sale. También lees la conversación en los lentes y buscas contactos dictando el nombre.
>
> *(adjuntar aquí las capturas)*
>
> **Cómo está armado**
> - Los lentes son pantalla y micrófonos. La app corre en el teléfono, en el WebView del Even Hub SDK.
> - El audio va del teléfono directo al servicio de transcripción. **Nunca pasa por mi servidor.**
> - Un backend propio habla con Telegram por MTProto (la API oficial) y con WhatsApp por Baileys.
>
> **Es un proyecto personal, no un servicio.** Y quiero ser claro con eso, porque es la parte importante:
>
> **1. No hay versión hospedada, y no la va a haber.** Cada quien levanta su propio servidor. La app funciona con la sesión de *tu* cuenta personal: hospedarlo para otros significaría que yo guardo las sesiones de mensajería de otras personas. Esa responsabilidad no la quiero ni la debo asumir.
>
> **2. Tus credenciales se quedan en tu máquina.** La sesión de Telegram, la de WhatsApp y la clave de transcripción viven solo en tu servidor. Yo no las veo nunca.
>
> **3. WhatsApp va por Baileys, que NO es oficial.** Va contra los términos de servicio de WhatsApp y hay riesgo real de que baneen el número. Yo lo uso con mi número personal y acepto ese riesgo. Si lo instalas, que sea una decisión informada.
>
> **4. No hay soporte ni garantías.** Lo hice para mí y lo uso a diario. Lo comparto por si a alguien le sirve o quiere aprender de cómo está hecho. Si se rompe, se rompe.
>
> Código, arquitectura y diagramas de flujo — incluidas las trampas del SDK que me costaron horas encontrar: https://github.com/AdalCast/vozgram

---

## English

> **VozGram — dictate and send Telegram and WhatsApp messages from the G2**
>
> Hold the touchpad, speak, release, confirm on the HUD, and the message goes out. You also read the conversation on the glasses and find contacts by dictating a name.
>
> *(attach screenshots here)*
>
> **How it's built**
> - The glasses are a display and microphones. The app runs on the phone, inside the Even Hub SDK WebView.
> - Audio goes straight from the phone to the transcription service. **It never touches my server.**
> - A self-hosted backend talks to Telegram over MTProto (the official API) and to WhatsApp over Baileys.
>
> **This is a personal project, not a service.** I want to be upfront about that, because it's the part that matters:
>
> **1. There is no hosted version, and there won't be one.** Everyone runs their own server. The app works with the session of *your* personal account — hosting it for other people would mean I hold other people's messaging sessions. That's a responsibility I don't want and shouldn't take on.
>
> **2. Your credentials stay on your machine.** The Telegram session, the WhatsApp session and the transcription key live only on your own server. I never see them.
>
> **3. WhatsApp goes through Baileys, which is NOT official.** It violates WhatsApp's terms of service and there's a real risk the number gets banned. I use it with my personal number and I accept that risk. If you install it, make it an informed decision.
>
> **4. No support, no guarantees.** I built it for myself and I use it daily. I'm sharing it in case it's useful to someone, or in case someone wants to learn from how it's put together. If it breaks, it breaks.
>
> Code, architecture and flow diagrams — including the SDK traps that cost me hours: https://github.com/AdalCast/vozgram

---

## Por qué está escrito así

El orden de los cuatro puntos no es casual. **La razón número uno no es legal,
es humana**: «no quiero guardar las sesiones de mensajería de otras personas».
Es a la vez la verdad técnica —la app funciona con la sesión de una cuenta
personal— y la razón por la que no debe existir una versión hospedada.

Puesto así, nadie pide una versión hospedada después de leerlo. Si el primer
punto fuera un descargo de responsabilidad, la mitad de la gente preguntaría
igual.
