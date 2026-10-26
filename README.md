# Ajedrez Online

Ajedrez 1 contra 1 por internet con salas privadas, sin registro. El servidor
valida todas las jugadas con el mismo motor que usa el cliente, así que no se
puede hacer trampas modificando el navegador.

Incluye además un **torneo familiar** con calendario, clasificación, cronómetro
de reflexión y partidas en directo para los que no están jugando.

## Características

- Sala privada con código de 6 caracteres y enlace de invitación (`/room/CODE`).
- El creador juega con blancas y el invitado con negras.
- Reglas completas: enroque, al paso, promoción, jaque, jaque mate y ahogado.
- Tablero táctil y con ratón (Pointer Events), adaptable a móvil.
- Capturas por jugador y ventaja material.
- Reconexión automática al recargar o recuperar la red.
- Rendición, revancha con intercambio de colores y limpieza de salas inactivas.
- Cronómetro de reflexión: cuenta el tiempo que piensa cada jugador, sin límite
  y sin que nadie pierda por tiempo. También guarda el tiempo de cada jugada.
- Modo espectador: cualquiera con el enlace puede mirar la partida sin ocupar
  asiento (`/room/CODE?ver=1`).
- Torneo familiar en `/torneo`: calendario automático, clasificación con
  desempates, botones para crear o unirse a la sala de cada partida, resultados
  guardados solos al terminar y descarga en PGN.
- Sin cuentas y sin cookies de seguimiento.

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

46 pruebas: motor (reglas, enroque, al paso, promoción, jaque mate, ahogado,
capturas), servidor (crear/unir sala, validación de jugadas, reconexión,
rendición y revancha), cronómetro y espectadores, y torneo (calendario,
clasificación, desempates, PGN y API).

## Arquitectura

```
online-chess/
├── shared/engine.js      Motor de ajedrez compartido (cliente y servidor)
├── server/server.js      Express + Socket.IO; sirve la UI y gestiona eventos
├── server/rooms.js       Salas, asientos, tokens, cronómetro y espectadores
├── server/tournament.js  Calendario, clasificación, desempates y PGN
├── server/db.js          PostgreSQL opcional (o memoria si no hay DATABASE_URL)
├── public/               HTML, CSS y JS del cliente (juego y torneo)
├── tests/                Pruebas del motor, del servidor y del torneo
└── render.yaml           Despliegue gratuito en Render
```

El flujo de una jugada es:

1. El cliente envía `game:move` con origen, destino y, si toca, la pieza de
   promoción.
2. El servidor comprueba que es el turno del jugador y valida la jugada con
   `shared/engine.js`.
3. Si es legal, actualiza el estado, responde al jugador y emite `room:update`
   a toda la sala. Si no, devuelve un error y el cliente no mueve la pieza.

Las salas viven en memoria. Si el servidor se reinicia, las partidas en curso se
pierden; solo los resultados del torneo se conservan si hay base de datos.

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
- Las salas y partidas en curso se pierden si el servicio se reinicia o se
  vuelve a desplegar. Los resultados del torneo se conservan si hay
  `DATABASE_URL` configurada.
- Render ofrece HTTPS y soporte de WebSocket; no hace falta configurar nada
  adicional.
- Si cambias el nombre del servicio, actualiza la URL que compartas. El enlace
  de invitación se genera con el origen actual de la página.
- Neon (PostgreSQL gratuito) no caduca por inactividad, así que los resultados
  sobreviven a los reinicios de Render.

### Variables de entorno

| Variable | Valor por defecto | Uso |
| --- | --- | --- |
| `PORT` | `3000` | Puerto HTTP (Render lo asigna automáticamente). |
| `NODE_VERSION` | `24` (en `render.yaml`) | Versión de Node en Render. |
| `DATABASE_URL` | vacío | Cadena de PostgreSQL donde se guardan resultados del torneo. Sin ella, se guardan en memoria y se pierden al reiniciar. |
| `TORNEO_CLAVE` | vacío | Clave del organizador para corregir resultados y cambiar jugadores. Sin ella, la administración del torneo queda desactivada. |
| `TORNEO_JUGADORES` | `Abuelo,Manuel,Fernan,Alejandro,Alvaro,Alberto` | Lista inicial de jugadores, separada por comas. |
| `PG_POOL_MAX` | `4` | Conexiones máximas a PostgreSQL. |

`DATABASE_URL` y `TORNEO_CLAVE` son secretos: márcalos como **Secret** en Render
y no los escribas en el repositorio.

## Torneo familiar

La página `/torneo` organiza una liguilla entre los jugadores configurados:

- **Calendario automático** con el sistema circular, siempre **ida y vuelta**:
  cada pareja juega dos partidas, una con cada color. Con 6 jugadores son 10
  rondas y 30 partidas (cada uno 5 con blancas y 5 con negras). Si el número es
  impar, cada ronda descansa uno y ese descanso vale 1 punto.
- **La revancha es la vuelta**: al aceptarla se cambian los colores y el segundo
  resultado se guarda en su propia casilla, sin pisar la ida.
- **Pausa de 20 minutos** en las salas del torneo si alguien se desconecta (las
  partidas sueltas 1v1 mantienen los 3 minutos).
- **Clasificación** con victoria 1, tablas ½ y derrota 0. Desempate: resultado
  directo entre los empatados y después número de victorias.
- **Resultados por pareja y colores**, no por ronda. Así se puede añadir o quitar
  jugadores sin perder lo ya jugado (no se puede quitar a quien ya tiene
  resultados).
- **Sala por partida**: quien tiene blancas pulsa «Crear sala» y el rival pulsa
  «Unirme» cuando aparece el código. Al terminar, el resultado, los tiempos y el
  PGN se guardan automáticamente.
- **Una sola partida a la vez**: mientras hay una sala de torneo en juego, el
  resto de botones «Crear sala» quedan desactivados y arriba aparece el aviso
  «Partida en curso» con el enlace para verla. El servidor también lo impide
  (`sala_ocupada`) aunque se pulse desde otro móvil.
- **Salas colgadas**: una sala sin jugadas y sin nadie dentro se borra a los 3
  minutos; una partida ya empezada aguanta 10 minutos por si vuelven. Además, el
  organizador puede cerrarla al instante con «Cerrar sala» (pide la clave); la
  partida se cancela y no se guarda resultado.
- **Espectadores**: el botón «Ver» abre la partida en modo espectador, con los
  dos cronómetros en directo. No ocupa asiento ni pide nombre.
- **Administración** (con `TORNEO_CLAVE`): corregir o anular un resultado a mano,
  descargar el PGN y editar la lista de jugadores.

### Base de datos gratuita (Neon)

1. Crea una cuenta en [Neon](https://neon.tech) y un proyecto gratuito en la
   región `aws-us-west-2` (Oregon), la misma que Render.
2. Copia la cadena de conexión **pooled** (la que lleva `-pooler` en el host).
3. Pásala como `DATABASE_URL` **sin la query string**: `pg` v8 falla con
   `?sslmode=require` y `?channel_binding=require`; el SSL ya lo activa
   `server/db.js` (`ssl: { rejectUnauthorized: false }` en hosts remotos).
   ```bash
   neon connection-string production --pooled   # quita lo que va tras «?»
   ```
4. En Render, añade `DATABASE_URL` como secreto. Se puede hacer por API:
   ```bash
   curl -X PUT -H "Authorization: Bearer $RENDER_API_KEY" \
     -H "Content-Type: application/json" \
     https://api.render.com/v1/services/<id>/env-vars \
     -d '[{"key":"DATABASE_URL","value":"postgresql://…"}]'
   ```
5. Abre `/torneo`: si abajo pone «Resultados guardados de forma permanente», ya
   está conectada. `/health` debe responder `"storage": "postgres"`.

Las tablas (`torneo_resultados`, `torneo_ajustes`) se crean solas al arrancar.

Sin `DATABASE_URL` la app funciona igual, pero avisa en `/torneo` de que los
resultados se guardan en memoria. Las tablas se crean solas la primera vez.

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
