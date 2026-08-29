# MOW PRO — Estación de Producción Musical Web

DAW web gratuito, estética oscura mate estilo Pro Tools, con login/registro
vía Firebase Authentication y guardado de proyectos en Firestore + Storage.

## Estructura de archivos

```
mow-pro/
├── index.html          Maquetado: pantalla de login + shell del DAW
├── style.css            Estilos: glassmorphism del login + interfaz Pro Tools
├── firebase-config.js   Inicialización de Auth, Firestore y Storage
├── auth.js              Login / registro / logout / transición de pantalla
├── audio-engine.js       Motor Web Audio API multipista
└── app.js                Controlador principal (UI + engine + Firestore)
```

## Puesta en marcha

1. Reemplaza `"TU_API_KEY"` en `firebase-config.js` con tu API Key real del
   proyecto `funnel-77b45` (Firebase Console → Configuración del proyecto).
2. En Firebase Console, habilita:
   - **Authentication → Sign-in method → Correo/contraseña**
   - **Firestore Database** (modo producción o pruebas)
   - **Storage**
3. Reglas de seguridad mínimas sugeridas (ajusta a tus necesidades):

   Firestore:
   ```
   match /users/{uid}/projects/{projectId} {
     allow read, write: if request.auth != null && request.auth.uid == uid;
   }
   ```

   Storage:
   ```
   match /users/{uid}/{allPaths=**} {
     allow read, write: if request.auth != null && request.auth.uid == uid;
   }
   ```
4. Sirve la carpeta con cualquier servidor estático (los ES Modules requieren
   HTTP, no `file://`). Por ejemplo:
   ```
   npx serve .
   ```
   o
   ```
   python3 -m http.server 8080
   ```
5. Abre el navegador, regístrate con correo/contraseña y empieza a producir.

## Funcionalidad incluida

- **Login/Registro** con glassmorphism, emblema "JP", transición de fade-out
  hacia la consola del DAW.
- **Transporte**: Play, Stop, Record Arm, Loop, Return to Zero, contadores
  Bars/Beats y Min:Seg:Ms, BPM, metrónomo audible, medidor de carga de CPU.
- **Vista Edit**: regla de tiempo interactiva (click = seek), tarjetas de
  pista con Solo/Mute/Arm/Volumen/Pan, carga de audio por archivo o
  drag&drop, waveform dibujada en Canvas a partir de picos precalculados.
- **Vista Mix**: channel strips con fader vertical largo, VU meter animado
  (RMS + peak) a 60 FPS, inserciones de EQ de 3 bandas (BiquadFilterNode) y
  Reverb (ConvolverNode con impulso sintético), pan, solo/mute, master bus.
- **Persistencia**: `Guardar` sube el audio nuevo a Cloud Storage y escribe
  el documento del proyecto (`projectName`, `bpm`, `tracks[]` con `volume`,
  `pan`, `clips`, `audioUrl`) en Firestore bajo `users/{uid}/projects/{id}`.
  `Abrir` recupera el proyecto más reciente y reconstruye pistas + waveforms.

## Notas de extensión

- El motor (`audio-engine.js`) está desacoplado de la UI: puedes añadir
  automatización, cuantización de grabación o edición de clips sin tocar
  Firebase.
- El backend Java opcional para procesamiento batch (normalización,
  render offline, conversión de formatos) puede integrarse como un
  servicio HTTP que reciba el audio desde Cloud Storage y devuelva el
  archivo procesado a una nueva ruta, sin cambiar el contrato de `tracks[]`.
