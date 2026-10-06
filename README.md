# Yumiko - Tube Downloader

Extensión para **Vivaldi** (y cualquier navegador Chromium) que descarga vídeos de
YouTube en distintas resoluciones **con audio incluido** y convierte el audio a
**MP3** por separado. Todo ocurre dentro del navegador: no hay servidor, ni
`yt-dlp`, ni `ffmpeg` que instalar.

> [!IMPORTANT]
> Descargar material de terceros puede incumplir los términos de YouTube o los
> derechos de autor. Úsalo con contenido propio o con permiso.

> [!NOTE]
> El icono (`assets/icon-source.png`) es una ilustración de un personaje de anime
> usada como imagen de marca. Si vas a distribuir el proyecto, comprueba que
> tienes derecho a usarla o sustituye ese archivo por una imagen propia y ejecuta
> `npm run icons` para regenerar los cuatro tamaños.

## Qué hace

- Lista las resoluciones reales del vídeo (1440p, 1080p60, 720p, 360p…),
  indicando fps, códec (H.264 / VP9 / AV1) y tamaño estimado.
- **Vídeo + audio en un solo archivo**: une el stream de vídeo y el de audio sin
  recodificar (copia los paquetes), así que no pierde calidad ni consume CPU.
- **Audio suelto**: MP3 (96–320 kbps, convertido dentro de la extensión) o el
  audio original en M4A/Opus sin tocar. Si un códec no se puede decodificar,
  prueba automáticamente con otra pista de audio. Si los streams de solo audio
  están rechazados por la CDN, extrae el sonido del archivo de vídeo completo
  (el único stream que YouTube sigue sirviendo) y lo convierte igual.
- **Carpeta independiente para vídeo, audio y miniaturas** (dentro de la carpeta de
  descargas, se pueden anidar varios niveles).
- **Nombre del archivo**: título, después códec y por último la extensión
  (`Mi vídeo - 1080p H.264.mp4`). El MP3 se llama solo con el título
  (`Mi canción.mp3`). Con la opción "Añadir el nombre del canal" se mete el
  canal entre el título y la calidad (`Mi vídeo - MiCanal - 1080p H.264.mp4`).
- **El título también va dentro del archivo**: los MP3 llevan etiqueta ID3 con
  el título y el canal, así que se ven en la pestaña de propiedades de Windows.
- **Miniaturas**: lista todas las variantes que YouTube expone de verdad para el
  vídeo (originales OAR, `maxres`, `hq`, `sd`, `mq`…) con su resolución exacta,
  y permite guardar cada una **tal cual** o **ampliarla con IA (x3)** o con
  Lanczos (x2/x4) y convertirla a JPG, WebP o PNG. La ampliación con IA usa
  onnxruntime (WebGPU si está disponible) y el modelo va incluido en el paquete.
- Descargas directas (sin procesar) para los formatos que ya vienen juntos.
- Progreso en vivo, cancelación y aviso de qué formato no ha podido usarse.

## Instalación en Vivaldi

Prepara los archivos una vez:

```bash
npm install
npm run build      # compila extension/lib/media.bundle.js
```

### Opción A: instalar el .crx (la más fácil)

```bash
npm run crx        # genera dist/yumiko-tube-downloader.crx
```

1. Abre `vivaldi://extensions`.
2. Arrastra el archivo `dist/yumiko-tube-downloader.crx` a la ventana de Vivaldi.
3. Confirma en el aviso de seguridad.

Esto evita el selector de carpetas por completo.

### Opción B: cargar la carpeta descomprimida

1. En `vivaldi://extensions`, activa el **Modo de desarrollador**.
2. Si ya hay una tarjeta de error de un intento anterior, bórrala primero (icono
   de papelera): Vivaldi conserva el error aunque el problema ya no exista.
3. Pulsa **Cargar descomprimida** y elige **exactamente** la carpeta
   `extension` del repositorio, que es la que contiene `manifest.json`
   (no la raíz del repositorio, que no lo tiene).

Para Chrome/Edge/Brave es igual, en `chrome://extensions` o `edge://extensions`.

También puedes generar un `.zip` para subirlo a una tienda o descomprimirlo en
una ruta sin espacios:

```bash
npm run zip        # dist/yumiko-tube-downloader.zip
```

> `extension/lib/media.bundle.js` es un archivo generado (~1,3 MB, incluye el
> codificador MP3). Está en `.gitignore`: hay que ejecutar `npm run build` antes
> de cargar la extensión.

## Uso

1. Abre un vídeo de YouTube y pulsa el icono de la extensión.
2. Elige la pestaña **Vídeo** o **Solo audio**, marca la resolución (o el bitrate
   del MP3) y pulsa **Descargar**.
3. En **Opciones** puedes cambiar por separado la carpeta de vídeo, la de audio y la
   de miniaturas (van dentro de tu carpeta de descargas, admitiendo subcarpetas
   anidadas como `Yumiko/Videos`), pedir dónde guardar cada vez, o quitar el
   nombre del canal.

> Chrome no deja escribir fuera de la carpeta de descargas, así que para guardar
> en otra unidad o carpeta usa "Preguntar dónde guardar cada vez", que abre el
> diálogo nativo con el que puedes elegir el sitio.

## Miniaturas

La pestaña **Miniaturas** del popup abre el **estudio**, un panel que se dibuja
encima de la propia página de YouTube (como en la extensión "Miniatura YouTube",
de la que está portado). También se abre con **Alt + M** o con el botón flotante
de la esquina.

El estudio tiene dos pestañas:

- **Este vídeo**: se sondean las 25 rutas que YouTube expone en `i.ytimg.com` y
  **solo aparecen las que existen de verdad**, con su resolución exacta,
  ordenadas de mayor a menor. Nada de tarjetas que dan error al hacer clic.
- **En esta página**: las miniaturas de todos los vídeos que haya en la página
  (búsqueda, lista de reproducción, canal…).

Y estos controles, que se guardan solos al cambiarlos:

- **Escalador**: Lanczos (1x, 1.5x, 2x, 3x, 4x) o IA (red neuronal). El factor
  puede ser "Auto", que usa el del modelo.
- **Modelo de IA**: el ligero x3 (incluido, 240 KB) o Real-ESRGAN x4 (67 MB, se
  descarga la primera vez y se cachea).
- **Formato**: PNG, JPG o WebP, con su calidad.
- **Ancho máximo**, **realce** y **gamma lineal**.
- **Quitar barras negras** y **recortar a 16:9**.
- **ZIP** cuando descargas varias de golpe.
- **Nombre de archivo** con plantilla (`{title}`, `{w}`, `{h}`, `{scale}`, …) y
  carpeta de destino (por defecto `Yumiko/Miniaturas`).

Puedes marcar varias miniaturas y descargarlas juntas, o usar "Descargar todas".
Al hacer clic en la imagen se abre a tamaño grande para verla.

Notas:

- El motor de IA (26 MB de WebAssembly de onnxruntime) **solo se carga** cuando
  eliges el modo IA. Usa **WebGPU** si el navegador lo expone y, si no, cae a
  WebAssembly (más lento) y te avisa.
- Procesar una miniatura con IA puede tardar unos segundos (la primera vez
  también carga el motor). Como el trabajo ocurre en la pestaña, **no la
  cambies ni la cierres** mientras procesa.
- Las dos extensiones pueden convivir: el estudio usa su propio espacio de
  nombres (`yumiko-thumbs`), sus propios ids de iframe y su propia clave de
  ajustes.

## Cómo funciona por dentro

| Pieza | Fichero | Función |
| --- | --- | --- |
| Extractor | `extension/src/inject.js` | Se inyecta en el mundo principal de la pestaña. Como el reproductor web de YouTube ya **no expone ningún formato**, consulta la API interna (`youtubei/v1/player`) con una cadena de clientes móviles (`ANDROID` → `IOS` → `ANDROID_VR` → `WEB`), que devuelven las URLs ya firmadas. **Antes de ofrecer cada URL la comprueba** con una petición de 2 bytes, porque YouTube devuelve URLs que luego rechaza con 403. |
| Base común | `extension/src/media-common.js` | Descarga por rangos, escritura en OPFS, errores en claro y cancelación. **No sabe nada de vídeo ni de audio.** |
| Módulo de vídeo | `extension/src/video.js` → `lib/processor.video.js` | Une el stream de vídeo con el de audio sin recodificar (H.264/AAC → MP4, VP9/Opus → WebM). 979 KB. |
| Módulo de audio | `extension/src/audio.js` → `lib/processor.audio.js` | Convierte a MP3 con lamejs o remuxa el audio sin tocar. 954 KB. |
| Runtime de página | `extension/src/page-runtime.js` | Instala en la pestaña las funciones que usa el service worker (procesar, leer bytes, cancelar). Compartido, pero cada processor se compila por separado. |
| Interfaz | `extension/popup.*` | Lista resoluciones, monta la petición y muestra el progreso. Las librerías de miniaturas se cargan **bajo demanda**. |
| Service worker | `extension/background.js` | Extrae los formatos, inyecta el módulo que corresponda, guarda el resultado con `chrome.downloads` y gestiona la cancelación. |
| Respaldo | `extension/offscreen.js` | Si el navegador no acepta guardar el blob de la página, la extensión copia los bytes en trozos y los reensambla aquí. |
| Estudio de miniaturas | `extension/thumbs/` | Panel completo embebido en la página de YouTube: rejilla con todas las miniaturas reales del vídeo, selección múltiple, ZIP, plantilla de nombres y escalado con IA (x3 incluido, x4 descargado bajo demanda) o Lanczos. Portado de "Miniatura YouTube". |
| Helpers | `extension/shared.js` | Nombres de archivo, tamaños, contenedores y ajustes. |

### Los tres bloques son independientes

Un fallo en uno **no puede** tumbar los otros dos:

- **Vídeo y audio son módulos separados** (`video.js` y `audio.js`), con bundles
  distintos. El de vídeo no lleva el codificador de MP3 y el de audio no lleva el
  de unir vídeo, y el build **falla** si alguna vez se mezclan. Cada uno se inyecta
  en la página solo cuando hace falta, así que descargar un vídeo no carga el
  motor de MP3.
- **Las miniaturas se cargan en diferido** desde el popup. Si sus librerías no
  arrancan, el popup sigue funcionando y lo dice en la pestaña de miniaturas;
  vídeo y audio no se ven afectados.
- Cada descarga va por su cuenta: si el módulo de audio no se puede inyectar, el
  error lo dice y el vídeo se sigue pudiendo descargar.

Detalles que importan:

- **Por qué el procesado ocurre en la pestaña**: la CDN de YouTube (`googlevideo.com`)
  devuelve **403 a las extensiones** porque su origen no es `youtube.com`, pero sí
  sirve las URLs a la propia página. Por eso la descarga y la conversión se ejecutan
  dentro de la pestaña y la extensión solo guarda el archivo. Por eso, mientras se
  procesa, **no cierres ni cambies de pestaña**: el trabajo vive en esa página.
- **Respaldo automático**: si el navegador no acepta guardar el blob de la página,
  la extensión copia los bytes en trozos de 3 MB y los reensambla ella misma.
- **Sin pérdida al unir**: se usa la copia directa de paquetes siempre que los
  códecs quepan en el contenedor (H.264/AAC → MP4, VP9/Opus → WebM). Si no,
  recodifica.
- **Memoria**: el archivo resultante se escribe en OPFS cuando está disponible
  (el sistema de archivos del navegador) en lugar de acumularse en RAM.
- **Velidad de la conversión a MP3**: ~30x el tiempo real en este equipo (60 s de
  audio en ~2 s). Un podcast de 10 min tarda del orden de 20-30 s.

## Pruebas

```bash
npm test           # todo lo que se puede probar sin navegador
npm run test:live  # prueba el extractor contra un vídeo real de YouTube
npm run probe      # a qué clientes de innertube responde YouTube hoy
```

- `scripts/test-extract.mjs`: el extractor en un contexto simulado (formatos, SABR,
  radio, directos, cadena de clientes, errores).
- `scripts/test-popup.mjs`: **el popup con un DOM real (jsdom)**: pestañas, lista de
  resoluciones, flujo de "Solo audio" (MP3, M4A, Opus), carpetas, "preguntar dónde
  guardar", errores y diagnóstico.
- `scripts/test-filename.mjs`: nombres de archivo (título, códec y extensión),
  carpetas y orden de las pistas de audio para convertir.
- `scripts/test-thumbnails.mjs`: catálogo de rutas, sondeo de las que existen de
  verdad y operaciones de imagen (Lanczos, realce, recorte de barras, mosaicos del
  modelo de IA).
- `scripts/test-media.mjs`: WAV → MP3 real (valida el archivo) y unión de vídeo +
  audio de un MP4 público.
- `scripts/test-page-processor.mjs`: el processor de la página converts WAV a MP3,
  comprueba la cabecera del resultado (128 kbps, 44,1 kHz, duración exacta) y
  verifica que los bytes se pueden releer por trozos para el respaldo.
- `scripts/test-live.mjs`: ejecuta el **código real de la extensión** contra YouTube
  de verdad. Ahora mismo da 17 formatos hasta 1080p en ~260 ms con el cliente ANDROID
  (`npm run test:live 9bZkp7q19f0`; con otros vídeos puede omitirse si esta red no
  llega a la CDN).

Lo que **no** cubren los tests automáticos: que la descarga de un stream real llegue
a completarse, que necesita un navegador con sesión y acceso a `googlevideo.com`.

## Diagnóstico

Si el popup no detecta un vídeo, abre **Diagnóstico** y pulsa **Copiar diagnóstico**: el texto dice qué vio la
extensión exactamente (URL, de dónde salió el id, cuántos formatos traía la página, si eran de audio o vídeo, si
estaba en modo SABR, qué cliente de innertube respondió y con qué resultado). Con eso cualquier fallo se localiza
sin adivinar.

## Límites conocidos

- Solo YouTube (no otras plataformas).
- Los vídeos protegidos con **DRM** no se pueden descargar; la extensión avisa en
  lugar de fallar en silencio.
- Cuando la página de YouTube solo ofrece los datos en modo **SABR** (sin URLs
  en la respuesta del reproductor), la extensión no se rinde: pregunta a la API
  interna con los clientes móviles, que sí devuelven las URLs. Si tampoco
  funcionan, el mensaje indica qué cliente se ha probado y con qué resultado.
- Algunos URLs de stream rechazan la descarga con **403** si el formato pertenece
  a una familia concreta (típico de AV1 y de los clientes Android). El mensaje
  sugiere usar "Original (sin tocar)" para esa calidad.
- La CDN rechaza con 403 los rangos abiertos y los que superan ~1 MB. La
  extensión los cierra a 1 MB (`media-common.js`), así que no debería aparecer
  un 403 por esto. Si lo hace, prueba con otro vídeo: puede que sea el CDN
  filtrando tu IP y no la extensión.
- Las URLs de los streams caducan (~6 h): si tarda demasiado, recarga la página.
- Los streams de YouTube además traen un **contador de uso**: tras unas pocas
  peticiones la CDN responde 403 aunque la URL pareciese buena. Por eso la
  extracción se reutiliza 30 min en vez de repetirse cada vez que se abre el
  popup, y cuando una descarga se come un 403 la extensión pide streams nuevos y
  reintenta una vez con las mismas pistas antes de rendirse.
- Los directos en marcha se descargan solo hasta el punto actual.
- Descargar vídeos de terceros puede incumplir los términos de YouTube o los
  derechos de autor. Úsalo con contenido propio o con permiso.

## Estructura

```
extension/          la extensión (esta es la carpeta que se carga en Vivaldi)
  manifest.json
  popup.html|css|js
  background.js       service worker
  offscreen.html|js   documento offscreen (reensamblado de bytes)
  shared.js           utilidades compartidas
  thumbs/             estudio de miniaturas (portado de "Miniatura YouTube")
    bridge.js           content script: monta el iframe y el botón flotante
    app/studio.html     el panel (rejilla, barra de ajustes, lightbox)
    app/studio.js       su lógica
    thumbnails.js       catálogo y sondeo de las rutas de i.ytimg.com
    pipeline.js         recorte -> escalado -> realce -> codificación
    ai-upscaler.js      super-resolución (canal Y y RGB)
    model-store.js      modelos incluidos y descarga en caché del x4
    zip.js  filename.js  nombres, carpetas y ZIP de las descargas múltiples
  src/inject.js       extractor de formatos (se inyecta en la página)
  src/media-common.js base común del procesado (sin vídeo ni audio)
  src/video.js        módulo de vídeo (unir streams)
  src/audio.js        módulo de audio (MP3 y remux)
  src/page-runtime.js runtime que se instala en la página
  src/processor.video.js  processor de página del módulo de vídeo
  src/processor.audio.js  processor de página del módulo de audio
  lib/                bundles generados de vídeo y audio
  models/             modelo de super-resolución incluido (240 KB)
  vendor/ort/         onnxruntime-web (26 MB, se carga solo en modo IA)
  icons/              iconos generados por scripts/make-icons.mjs
scripts/            build, iconos, crx, zip y tests
assets/             arte maestro de los iconos (no entra en el paquete)
  icon-source.png     arte a 256 px, del que salen icon48 e icon128
  icon-source-32.png  arte a 32 px, del que salen icon16 e icon32
```

## Desarrollo

```bash
npm run watch   # recompila lib/media.bundle.js al guardar
npm run icons   # regenera los iconos desde assets/
npm run crx     # regenera dist/yumiko-tube-downloader.crx (reutiliza la clave)
npm run zip     # regenera el .zip
```

Para cambiar el icono, sustituye `assets/icon-source.png` (o
`assets/icon-source-32.png` para los tamaños pequeños, que salen de su propio
arte porque a 16-32 px el dibujo grande se convierte en manchas) y ejecuta
`npm run icons`.

Dos guardas que se ejecutan en cada `npm run build`:

- `scripts/check-extension.mjs`: el manifiesto es JSON válido, sin BOM, y todos
  los ficheros que declara existen.
- `scripts/check-encoding.mjs`: ningún archivo tiene BOM ni caracteres rotos.

> No edites los archivos con `Set-Content -Encoding UTF8` de PowerShell: añade un
  BOM (y Chromium rechaza el manifiesto) y rompe los acentos. Usa un editor o
  `node` para escribir.

## Licencia

MIT. Descarga solo lo que tengas derecho a descargar.