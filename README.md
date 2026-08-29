# MOW PRO — DAW Web Gratuita (estilo Pro Tools)

Estación de trabajo de audio digital (DAW) para navegador, con estética y flujo de trabajo inspirados en Pro Tools. Frontend en HTML/CSS/JS puro (Web Audio API) y backend opcional en Java (JDK, sin dependencias externas) para persistencia de sesiones, biblioteca de audio y mezcla server-side.

## Estructura del proyecto

```
mowpro/
├── index.html              # Estructura de la interfaz (transporte, Edit, Mixer)
├── css/
│   └── style.css           # Tema oscuro estilo Pro Tools
├── js/
│   └── app.js               # Motor de audio (Web Audio API) + lógica de la UI
├── server/
│   └── MowProServer.java    # Backend HTTP ligero (JDK puro, sin frameworks)
├── projects/                 # Sesiones guardadas (.json) — se crea al guardar
├── audio-library/            # Audios subidos al servidor — se crea al subir
└── exports/                  # Mezclas renderizadas server-side (.wav)
```

## Cómo ejecutarlo

### Opción A — Solo frontend (sin instalar nada)
Abre `index.html` directamente en Chrome, Edge o Firefox. Todo el motor de audio, la carga de archivos (drag & drop) y la exportación de la mezcla (WAV) funcionan 100% en el navegador gracias a la Web Audio API. El botón **Guardar sesión** funcionará como descarga local de un `.json` si no detecta el backend Java.

### Opción B — Con backend Java (persistencia real de sesiones/audio)
Requiere JDK 11+ instalado.

```bash
cd mowpro
javac server/MowProServer.java -d out
java -cp out MowProServer
```

Luego abre **http://localhost:8080** en el navegador. El servidor:
- Sirve el frontend (`index.html`, `css/`, `js/`).
- `POST /api/save` guarda la sesión actual como JSON en `projects/`.
- `GET /api/list` lista las sesiones guardadas.
- `GET /api/load?name=archivo.json` recupera una sesión.
- `POST /api/upload` (header `X-Filename`) guarda un archivo de audio en `audio-library/`.
- `POST /api/export` mezcla (mixdown) archivos WAV de `audio-library/` en un único `.wav` dentro de `exports/`, sumando las pistas con la ganancia indicada (procesamiento de señal en Java puro con `javax.sound.sampled`).

## Funcionalidades incluidas

**Transporte:** Play, Pausa, Stop, Rewind, Grabar (usa el micrófono vía `MediaRecorder` sobre la pista armada), Loop, contador de tiempo conmutable (Min:Seg:Ms ↔ Compás|Tiempo|Tick), BPM y metrónomo con scheduler de "lookahead" para precisión rítmica, medidor de carga DSP.

**Vista Edit:** pistas con nombre editable, Solo/Mute/Record-Arm, fader y pan por pista, selectores de entrada/salida, línea de tiempo con regla (clic para mover el playhead), forma de onda dibujada a partir del `AudioBuffer` decodificado, y **drag & drop** de archivos WAV/MP3/OGG/M4A directamente sobre cada pista.

**Vista Mix:** consola con faders verticales largos, medidores de VU (verde/ámbar/rojo) actualizados en tiempo real vía `AnalyserNode`, dos slots de inserto por canal (EQ‑3 y Reverb) que abren un "Plugin Rack" flotante con controles reales, un send (bus auxiliar de reverb compartido) y strip de Master.

**Procesamiento de señal (Web Audio API):**
- **EQ de 3 bandas** por pista: `lowshelf` (320 Hz), `peaking` (1 kHz) y `highshelf` (3.2 kHz), con bypass.
- **Reverb** por convolución (`ConvolverNode`) con impulse response generado algorítmicamente (sin archivos de terceros), con control de mezcla wet/dry y tamaño de sala.
- **Ganancia y panorámica** independientes por pista, más fader/ganancia de Master.
- **Exportación**: renderizado offline (`OfflineAudioContext`) de toda la sesión a un único archivo **WAV PCM 16-bit** descargable, respetando mute/solo, EQ, pan y volumen.

## Notas técnicas
- No se usan frameworks de frontend (React, Vue, etc.) ni librerías externas: solo HTML5, CSS3 y JavaScript vanilla + Web Audio API.
- El backend Java usa únicamente el JDK estándar (`com.sun.net.httpserver`, `javax.sound.sampled`), sin Spring ni dependencias de Maven/Gradle, para simplificar la distribución gratuita del proyecto.
- El medidor "DSP/CPU" del header es una estimación visual (no hay una API estándar de navegador para leer el uso real de CPU del hilo de audio); sirve como indicador de carga relativa según pistas activas.
- Para producción real, se recomendaría añadir undo/redo, edición de clips (recortar/mover), automatización de parámetros y un formato de sesión versionado — la arquitectura actual (clases `Track`, bus de master, estado centralizado en `state`) está pensada para extenderse fácilmente.

## Prompt para el logo "JP / MOW PRO"

Para generar el isotipo en Midjourney, DALL·E 3 o Leonardo AI:

> Modern minimal logo design for a professional music production software called 'MOW PRO'. The logo features the stylized letters 'JP' integrated as a sleek emblem or icon. Dark fantasy and aesthetic vibe, dark charcoal grey and glowing electric blue accent colors. Clean geometry, sharp edges mixed with subtle audio waveform curves. Vector style, dark background, professional DAW software branding, highly detailed, 8k, minimalistic.
