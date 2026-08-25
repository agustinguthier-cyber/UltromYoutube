# ULTRON

Renderizado de video vertical faceless (1080x1920 @ 30fps) con Remotion, a
partir de un `guion.json` con timestamps, textos, fondo y la ruta del audio
locutado.

## Instalar

```bash
cd ultron
npm install
```

## Previsualizar (Studio)

```bash
npm start
```

Abre Remotion Studio con datos de ejemplo (`src/Root.tsx` → `sampleProps`):
audio de silencio (`public/audio/ejemplo.mp3`) y un fondo de video de prueba
(`public/backgrounds/sample-bg.mp4`).

## Contrato de `guion.json`

No tiene que vivir en `public/` -- puede ser cualquier ruta (ver
`jobs/demo-broll.json` como ejemplo). Lo que sí debe estar dentro de
`public/` son los **assets que referencia** (`audio`, `background.src`),
porque Remotion los sirve como estáticos durante el render.

```json
{
  "title": "Título fijo que aparece arriba",
  "audio": "audio/locucion.mp3",
  "durationInSeconds": 45.2,
  "background": { "type": "video", "src": "backgrounds/clip.mp4" },
  "captions": [
    {
      "start": 0.0,
      "end": 1.1,
      "text": "ESTO ES UN EJEMPLO",
      "words": [
        { "start": 0.0, "end": 0.3, "text": "ESTO" },
        { "start": 0.3, "end": 0.55, "text": "ES" },
        { "start": 0.55, "end": 0.8, "text": "UN" },
        { "start": 0.8, "end": 1.1, "text": "EJEMPLO" }
      ]
    }
  ]
}
```

- `audio`: ruta relativa a `public/` (el archivo de locución debe copiarse ahí).
- `captions`: líneas de subtítulo (hasta 4 palabras juntas en pantalla) con
  tiempo en segundos. `words` es opcional: si viene, `Captions.tsx` resalta
  en amarillo la palabra puntual que se está pronunciando (con un pequeño
  "pop" de escala) mientras el resto queda en blanco -- estilo TikTok/
  MrBeast. Sin `words` (captions viejos, o alineación por whisper.cpp sin
  desglose por palabra) cae a texto plano sin resaltado, no rompe nada.
- `durationInSeconds`: opcional. Si falta, la duración del video se calcula
  automáticamente como el `end` del último caption.
- `background`: opcional en el schema, pero **recomendado escribirlo siempre
  explícito** (ver gotcha abajo). Si falta, fondo negro sólido. Tres formas:
  - Color sólido: `{ "type": "color", "value": "#0b1220" }`
  - Video local (B-roll), recortado a pantalla completa (`object-fit: cover`),
    silenciado por defecto: `{ "type": "video", "src": "backgrounds/clip.mp4" }`
    (agregar `"muted": false` para conservar su audio original). Si el clip es
    más corto que el video final, hace **loop automático** (sin cortes, sin
    congelarse) -- `calculateMetadata.ts` mide su duración real (vía
    `mediabunny`) y `Background.tsx` lo envuelve en `<Loop>`. No hace falta
    declarar la duración a mano.
  - Por escena/segmento del guion (generadas por IA, ver paso 4 abajo): cada
    entrada de `scenes` es o una **imagen fija** con **Ken Burns** (zoom
    suave 1.0→1.12) o un **clip de video real** (ej. de Wan2GP), a pantalla
    completa -- se pueden mezclar libremente en el mismo video:
    ```json
    {
      "type": "scenes",
      "scenes": [
        { "start": 0.0, "end": 4.0, "video": "assets/brolls/scene-1.mp4" },
        { "start": 4.0, "end": 8.05, "image": "scenes/scene-2.jpg" }
      ]
    }
    ```
    Cada escena es una `<Sequence>` de Remotion -- el Ken Burns (para
    imágenes) es siempre relativo al inicio de SU PROPIA ventana (frame
    local de la Sequence, no el frame global), así que se reinicia limpio en
    cada corte. Un hueco entre escenas (o ninguna escena) muestra negro
    sólido, no rompe el render.

`guion.json`/Remotion **no** saben nada de música de fondo ni SFX -- solo
producen visuales + narración horneada. Eso se mezcla después con FFmpeg
(ver paso 5, más abajo).

> **Gotcha de Remotion (real, no obvio):** `remotion render --props=<archivo>`
> no *reemplaza* los `defaultProps` de la composición (`src/Root.tsx` →
> `sampleProps`) -- los mezcla por encima, clave por clave. Un `guion.json`
> que omite `"background"` hereda en silencio el video de demo de
> `sampleProps` en vez de cualquier default que uno espere. Por eso
> `scripts/lib/buildGuion.js` escribe esa clave **siempre** -- con el
> default `{"type":"color","value":"#000000"}` si no hay fondo -- nunca la
> omite. Si escribís un `guion.json` a mano, hacé lo mismo.

## Renderizar

```bash
npm run render -- [ruta/a/guion.json] [ruta/de/salida.mp4]
```

Sin argumentos, renderiza `public/guion.json` a `out/guion.mp4`. Para un
guion de producción arbitrario:

```bash
npm run render -- jobs/demo-broll.json out/demo-broll.mp4
```

El script (`scripts/render.js`) resuelve las rutas y ejecuta el CLI de
Remotion (`remotion render VerticalVideo <salida> --props=<guion>`) -- la
validación del contenido contra el schema la hace el propio CLI, no hay
lógica de validación duplicada acá.

## Generar un video desde un tema (pipeline completo)

```bash
npm run generate -- --prompt "3 datos curiosos sobre el espacio"
```

Orquesta las 5 etapas (llama a `scripts/render.js` en la mitad, para el
render de Remotion):

1. **Guion** (`scripts/lib/generateScript.js`): le pide al LLM un JSON con
   `title` + `segments[]`, cada uno con `text` (español, listo para
   locución), `keywords` (inglés, sin usar por ahora) e `image_prompt`
   (inglés, descripción visual de UNA escena para generar con IA -- paso 4).
   Reusa `/api/generate-script` del servidor de UltromYoutube (proyecto
   padre) -- necesita `node server.js` corriendo en `--server` (default
   `http://localhost:3000`).
2. **Locución** (`scripts/lib/generateNarration.js`): reusa el flujo async
   `/api/generate-audio/start|status|result` del mismo servidor (Voicebox por
   default -- necesita la app abierta). Guarda el audio en `public/audio/`.
3. **Timestamps** (`scripts/lib/alignTimestamps.js`): agrupa el texto en
   bloques de 1-3 palabras y les asigna tiempo. Dos modos:
   - **Fallback proporcional** (default, siempre funciona): reparte el tiempo
     según la longitud de cada bloque a lo largo de la duración real del
     audio (medida con ffprobe). Es una aproximación, no alineación forzada
     real -- mismo enfoque que ya usa `render.js` del proyecto padre para sus
     subtítulos .ass (ver su `CLAUDE.md`).
   - **whisper.cpp real** (opcional): si seteás `ULTRON_WHISPER_MODEL` con la
     ruta a un modelo `.bin` de
     [whisper.cpp](https://github.com/ggml-org/whisper.cpp/blob/master/models/README.md),
     usa el filtro nativo `whisper` de ffmpeg (este build lo trae compilado)
     para transcribir el audio real y sacar cortes de segmento genuinos
     (silencios detectados por VAD), en vez de repartir a ciegas. **No
     verificado en este entorno** (no hay un modelo descargado) -- si falla o
     el modelo no está, cae solo al fallback proporcional sin romper nada.
4. **Fondo + export** (`scripts/lib/selectBackground.js` +
   `scripts/lib/generateBrolls.js` + `scripts/lib/generateImage.js` +
   `scripts/lib/buildGuion.js`): resuelve un fondo por segmento (a partir de
   su `image_prompt`) y arma el `guion.json` final
   (`background.type = "scenes"`) en `jobs/`, después dispara el render.
   **Habilitado por defecto, sin configurar nada.** Desde 2026-08-21,
   `generateBrolls.js` y `generateImage.js` (no `selectBackground.js`, que es
   específico del layout de `public/` de este proyecto) también se reusan
   tal cual desde el proyecto padre (`server.js`, ruta
   `/api/generate-scene-media`, paso 7 de la app web) -- misma config de
   `ultron/.env` para ambos consumidores.
   - **Wan2GP (opcional, B-roll de video real)**: con `WAN2GP_ROOT`
     configurado (`ultron/.env`), cada escena intenta PRIMERO un clip de
     video real -- ver `scripts/wan2gp_bridge.py`. **No verificado
     end-to-end** (2026-08-21): no hubo una instalación real de Wan2GP
     disponible para probar. Wan2GP no tiene API REST -- solo un SDK de
     Python in-process, así que el puente es un subproceso Python que
     importa ese SDK directo (necesita Python + las dependencias de Wan2GP
     resolubles). Si falla o no está configurado, esa escena puntual cae
     sola a imagen IA (siguiente punto), sin romper el pipeline.
   - **Imagen IA** (`IMAGE_PROVIDER`, opcional, `ultron/.env`) -- se usa si
     Wan2GP no está configurado o falla para esa escena:
   - `pollinations` (**default**): [Pollinations.ai](https://pollinations.ai),
     gratis, sin API key, HTTP GET directo. Elegido en vivo (2026-08-21)
     después de evaluar alternativas: NVIDIA flux no respondía (ver abajo) y
     las opciones de mejor calidad (Fal.ai, etc.) piden una API key que
     todavía no tenemos -- Pollinations es la única 100% automatizable ya
     mismo, sin bloquear el pipeline esperando credenciales. Es un servicio
     comunitario gratuito sin SLA garantizado; si más adelante hace falta más
     consistencia, Fal.ai es el upgrade natural (mismo shape de función en
     `generateImage.js`).
   - `nvidia`: NVIDIA NIM, `black-forest-labs/flux.1-schnell`. Contrato
     verificado contra la documentación oficial de NVIDIA, pero **no probado
     con éxito en este entorno** (2026-08-20): la conexión TCP se establece
     pero el servidor nunca responde (0 bytes, dos intentos de 90s). Es un
     producto NVCF separado de los NIM de chat/texto -- antes de asumir que
     es un bug, confirmar en build.nvidia.com que la cuenta tenga ese
     entitlement habilitado.
   - `skyreels`: servidor local propio (`SKYREELS_URL`), sin contrato
     público documentado -- mismo enfoque best-effort que el resto de
     proveedores locales/propios de este proyecto. Ajustar
     `generateImageSkyReels()` en `scripts/lib/generateImage.js` si tu
     servidor real espera otro formato.
   - `none` / `off` / `disabled`: vuelve al comportamiento anterior (fondo
     negro sólido, cero llamadas de red).
   - **Cero fondos negros** (2026-08-21): la cadena completa por escena es
     Wan2GP → imagen IA (con un reintento) → reutilizar el fondo (video o
     imagen) de la escena exitosa más cercana (primero la anterior, si no
     hay ninguna la siguiente) -- sigue siendo su propia `<Sequence>`, así
     que si es imagen el Ken Burns arranca de nuevo, no es un frame
     congelado. El negro sólido queda como último recurso solo si TODAS las
     escenas del video fallan en todos los pasos.
5. **BGM + SFX + carpeta final** (`scripts/lib/mixAudio.js` +
   `scripts/lib/buildSfxCues.js` + `scripts/lib/generateThumbnail.js` +
   `scripts/lib/buildMetadataTxt.js`): 100% local, sin subir nada a ningún
   servicio externo.
   - **BGM**: elige al azar una pista de `public/assets/audio/bgm/` (si hay
     alguna) y la mezcla por debajo de la narración con **ducking real**
     (`sidechaincompress` de FFmpeg, no un volumen fijo) -- baja sola cuando
     hay voz y sube en los huecos. Medido en una prueba real: ~5.8dB de
     atenuación promedio con narración presente vs. sin ella. Carpeta vacía
     o inexistente = video sin BGM, no rompe nada.
   - **SFX**: un efecto al azar de `public/assets/audio/sfx/` en cada corte
     de escena (el inicio de cada segmento del guion, salvo el primero).
     Carpeta vacía = sin SFX.
   - El repo trae placeholders sintetizados con ffmpeg (cero riesgo de
     derechos): `bgm/ambient-pad.mp3`, `sfx/pop.mp3`, `sfx/whoosh.mp3` --
     pisalos con tus propios archivos.
   - Sin BGM ni SFX, se usa el render de Remotion tal cual (no se
     recodifica de más). Con cualquiera de los dos, FFmpeg mezcla el audio
     y remuxea copiando el video sin recodificar (`-c:v copy`, rápido).
   - Resultado en `out/YYYY-MM-DD_<título>/`: `video.mp4`, `portada.png`
     (frame real extraído al 15% de la duración -- no hay generación de
     portada dedicada todavía) y `metadata.txt` (título, descripción y
     hashtags armados de las `keywords` de cada segmento + el canal, si
     hay). `--out <ruta.mp4>` pisa toda esta carpeta y deja solo el .mp4 en
     esa ruta -- pensado para integraciones externas que no necesitan
     portada/metadata.

## Canales (`--channel`)

```bash
npm run generate -- --channel "Enigmas Ocultos"
npm run generate -- --channel "Enigmas Ocultos" --prompt "Tema puntual"
```

Lee `channels_data.json` (raíz del proyecto padre) por nombre
(`scripts/lib/loadChannel.js`, insensible a acentos/mayúsculas, match
parcial si no hay exacto):
- Sin `--prompt`, elige un tema al azar de `ideasSEO.muestra` del canal.
- El tono (`tono`) y la guía de estilo visual (`styleBase`) del canal se
  inyectan en el prompt del guion (`scripts/lib/generateScript.js`), así
  `text` e `image_prompt` de cada segmento salen on-brand sin escribir nada
  a mano.
- La voz de Voicebox se auto-resuelve por palabras en común entre el
  nombre del canal y los perfiles reales (`scripts/lib/resolveVoiceProfile.js`)
  -- el nombre del canal en `channels_data.json` no siempre es idéntico al
  nombre del perfil en Voicebox (ej. canal "Enigmas Ocultos" → perfil real
  "Enigmas"; probado en vivo, un match por igualdad exacta falla con HTTP
  404). `--voice` sigue pisando esto si se pasa explícito.

Otros flags: `--voice <perfil>` (perfil de voz de Voicebox), `--out
<ruta.mp4>`, `--skip-render` (arma el `guion.json` y para ahí, sin renderizar).
