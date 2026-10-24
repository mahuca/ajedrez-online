# Ajedrez Online

Ajedrez 1 contra 1 por internet con salas privadas, sin registro. El servidor
valida todas las jugadas con el mismo motor que usa el cliente, así que no se
puede hacer trampas modificando el navegador.

## Características

- Sala privada con código de 6 caracteres y enlace de invitación (`/room/CODE`).
- El creador juega con blancas y el invitado con negras.
- Reglas completas: enroque, al paso, promoción, jaque, jaque mate y ahogado.
- Tablero táctil y con ratón (Pointer Events), adaptable a móvil.
- Capturas por jugador y ventaja material.
- Reconexión automática al recargar o recuperar la red.
- Rendición, revancha con intercambio de colores y limpieza de salas inactivas.
- Sin cuentas, sin base de datos y sin cookies de seguimiento.

## Requisitos

- Node.js 20 o superior.
- Un navegador moderno con WebSocket.

## Ejecutar en local

```bash
cd online-chess
npm install
npm start
```

Abre <http://localhost:3000>. Para desarrollar con recarga automática:

```bash
npm run dev
```

El puerto se puede cambiar con la variable `PORT`:

```bash
PORT=3210 npm start
```

### Probar con dos jugadores en local

1. Abre `http://localhost:3000` en una pestaña y pulsa **Crear sala**.
2. Copia el enlace o el código de 6 caracteres.
3. Abre el enlace en otra pestaña, otro navegador o el móvil en la misma red
   (usa la IP local del equipo, por ejemplo `http://192.168.1.20:3000`).
4. Introduce un nombre y pulsa **Entrar**.

## Pruebas

```bash
npm test
```

Incluye pruebas del motor (reglas, enroque, al paso, promoción, jaque mate,
ahogado, capturas) y pruebas de integración del servidor (crear/unir sala,
validación de jugadas, reconexión, rendición y revancha).

## Arquitectura

```
online-chess/
├── shared/engine.js     Motor de ajedrez compartido (cliente y servidor)
├── server/server.js     Express + Socket.IO; sirve la UI y gestiona eventos
├── server/rooms.js      Salas, asientos, tokens, revancha y caducidad
├── public/              HTML, CSS y JS del cliente
├── tests/               Pruebas del motor y de integración
└── render.yaml          Despliegue gratuito en Render
```

El flujo de una jugada es:

1. El cliente envía `game:move` con origen, destino y, si toca, la pieza de
   promoción.
2. El servidor comprueba que es el turno del jugador y valida la jugada con
   `shared/engine.js`.
3. Si es legal, actualiza el estado, responde al jugador y emite `room:update`
   a toda la sala. Si no, devuelve un error y el cliente no mueve la pieza.

Las salas viven en memoria. Si el servidor se reinicia, las partidas en curso se
pierden; es el compromiso de una versión gratuita sin base de datos.

## Despliegue gratuito en Render

El repositorio incluye `render.yaml` para desplegar con un Blueprint.

1. Sube **el contenido de la carpeta `online-chess/`** a un repositorio de
   GitHub/GitLab, de forma que `package.json` y `render.yaml` queden en la raíz
   del repositorio.
2. En [Render](https://render.com), elige **New → Blueprint** y conecta el
   repositorio.
3. Render detecta `render.yaml`, crea el servicio `ajedrez-online` y ejecuta
   `npm install` y `npm start`.
4. Cuando termine, abre la URL `https://ajedrez-online.onrender.com` (el nombre
   puede variar) y comparte el enlace de la sala.

Si prefieres subir todo el proyecto (`chessboard.html`, `Ajedrez-Windows/` y
`online-chess/`) en un solo repositorio, indica a Render la ruta
`online-chess/render.yaml` como Blueprint y añade `rootDir: online-chess` al
servicio para que los comandos se ejecuten dentro de esa carpeta.

Notas del plan gratuito:

- El servicio se suspende tras un periodo sin tráfico. La primera visita puede
  tardar unos 30-60 segundos en despertar.
- Las salas y partidas se pierden si el servicio se reinicia o se vuelve a
  desplegar.
- Render ofrece HTTPS y soporte de WebSocket; no hace falta configurar nada
  adicional.
- Si cambias el nombre del servicio, actualiza la URL que compartas. El enlace
  de invitación se genera con el origen actual de la página.

### Variables de entorno

| Variable | Valor por defecto | Uso |
| --- | --- | --- |
| `PORT` | `3000` | Puerto HTTP (Render lo asigna automáticamente). |
| `NODE_VERSION` | `24` (en `render.yaml`) | Versión de Node en Render. |

No hay claves de API ni secretos.

## Seguridad y privacidad

- Servidor autoritativo: el cliente nunca decide el resultado de una jugada.
- Tokens de sesión aleatorios para reconectar; no se usan cuentas ni correos.
- Cabeceras CSP, `X-Content-Type-Options`, `X-Frame-Options` y
  `Referrer-Policy` activas.
- Los nombres se limpian y se limitan a 20 caracteres.
- Límite de intentos de creación/unión por socket y caducidad de salas.
- No se registran jugadas ni datos personales en disco.

## Paquete Windows sin conexión

La versión offline sigue disponible en `../Ajedrez-Windows/` y en
`../Ajedrez-Windows.zip`. Se abre con doble clic en `Ajedrez.bat` y no necesita
Node.js ni internet. Incluye IA con selector de bando, capturas y giro del
tablero.

## Solución de problemas

- **El enlace de invitación no abre la sala**: comprueba que el servidor esté
  arrancado y que el código tenga 6 caracteres. Los códigos no distinguen
  mayúsculas de minúsculas.
- **La primera carga tarda**: es normal en el plan gratuito de Render si el
  servicio estaba suspendido.
- **Se pierde la conexión**: la UI muestra «Reconectando…» y recupera la partida
  al volver la red. Si el rival se desconecta, aparece como desconectado y la
  partida puede cerrarse por abandono tras el tiempo límite.
- **No se puede mover una pieza**: solo puede mover el jugador del turno actual;
  el servidor rechaza cualquier intento del otro lado.
