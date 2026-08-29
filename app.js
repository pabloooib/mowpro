// ==========================================================================
// app.js
// Controlador principal: vincula la interfaz (Edit/Mix), el motor de audio
// (audio-engine.js), la autenticación (auth.js) y la persistencia en
// Firestore/Storage (firebase-config.js).
// ==========================================================================

import { auth, db, storage } from "./firebase-config.js";
import { setAuthCallbacks } from "./auth.js";
import { AudioEngine, computePeaks } from "./audio-engine.js";
import {
  doc,
  setDoc,
  getDoc,
  collection,
  getDocs,
} from "https://www.gstatic.com/firebasejs/10.8.0/firebase-firestore.js";
import {
  ref,
  uploadBytes,
  getDownloadURL,
} from "https://www.gstatic.com/firebasejs/10.8.0/firebase-storage.js";

// --------------------------------------------------------------------------
// Estado global de la app
// --------------------------------------------------------------------------
const engine = new AudioEngine();
let currentUser = null;
let currentProjectId = null;
const PIXELS_PER_SECOND = 90;
const TRACK_ROW_HEIGHT = 96;

// --------------------------------------------------------------------------
// Referencias DOM
// --------------------------------------------------------------------------
const $ = (id) => document.getElementById(id);

const tracksContainer = $("tracks-container");
const mixConsole = $("mix-console");
const rulerCanvas = $("ruler-canvas");
const playheadEl = $("playhead");
const tracksScrollArea = $("tracks-scroll-area");
const fileInputHidden = $("file-input-hidden");

const btnPlay = $("btn-play");
const btnStop = $("btn-stop");
const btnRecord = $("btn-record");
const btnLoop = $("btn-loop");
const btnReturnZero = $("btn-return-zero");
const btnMetronome = $("btn-metronome");
const bpmInput = $("bpm-input");
const cpuBarFill = $("cpu-bar-fill");
const counterBars = $("counter-bars");
const counterTime = $("counter-time");

const btnViewEdit = $("btn-view-edit");
const btnViewMix = $("btn-view-mix");
const viewEdit = $("view-edit");
const viewMix = $("view-mix");

const btnAddTrack = $("btn-add-track");
const btnSaveProject = $("btn-save-project");
const btnLoadProject = $("btn-load-project");
const projectNameInput = $("project-name");

const masterFader = $("master-fader");
const masterVuFill = $("master-vu-fill");
const masterVuPeak = $("master-vu-peak");

// Guarda referencias UI por track: { id -> { row, canvas, ctx, ... } }
const trackViews = new Map();
let pendingLoadTrackId = null; // id de la pista esperando selección de archivo

// ==========================================================================
// AUTENTICACIÓN -> arranque de la app
// ==========================================================================
setAuthCallbacks({
  onReady: (user) => {
    currentUser = user;
    if (engine.tracks.length === 0) {
      createTrackUI(engine.createTrack("Pista 1"));
      createTrackUI(engine.createTrack("Pista 2"));
    }
  },
  onGone: () => {
    currentUser = null;
    engine.stop();
  },
});

// ==========================================================================
// TRANSPORTE
// ==========================================================================
btnPlay.addEventListener("click", async () => {
  await engine.play();
  btnPlay.classList.add("active");
});

btnStop.addEventListener("click", () => {
  engine.stop();
  btnPlay.classList.remove("active");
  btnRecord.classList.remove("active");
});

btnRecord.addEventListener("click", () => {
  btnRecord.classList.toggle("active");
});

btnLoop.addEventListener("click", () => {
  engine.toggleLoop();
  btnLoop.classList.toggle("active", engine.loopEnabled);
});

btnReturnZero.addEventListener("click", () => {
  engine.returnToZero();
  btnPlay.classList.remove("active");
});

btnMetronome.addEventListener("click", () => {
  engine.toggleMetronome();
  btnMetronome.classList.toggle("active", engine.metronomeEnabled);
});

bpmInput.addEventListener("change", () => {
  engine.setBpm(parseInt(bpmInput.value, 10) || 120);
});

engine.onTick((seconds) => {
  updateCounters(seconds);
  updatePlayheadPosition(seconds);
});

function updateCounters(seconds) {
  // Minutos:Segundos:Milisegundos
  const mins = Math.floor(seconds / 60);
  const secs = Math.floor(seconds % 60);
  const ms = Math.floor((seconds * 1000) % 1000);
  counterTime.textContent =
    `${pad(mins, 2)}:${pad(secs, 2)}:${pad(ms, 3)}`;

  // Bars|Beats|Ticks a partir del BPM (4/4 asumido, 960 ticks por beat)
  const beatsPerSecond = engine.bpm / 60;
  const totalBeats = seconds * beatsPerSecond;
  const bar = Math.floor(totalBeats / 4) + 1;
  const beat = (Math.floor(totalBeats) % 4) + 1;
  const tick = Math.floor((totalBeats % 1) * 960);
  counterBars.textContent = `${pad(bar, 3)}|${pad(beat, 2)}|${pad(tick, 3)}`;
}

function pad(n, len) {
  return String(Math.max(0, n)).padStart(len, "0");
}

function updatePlayheadPosition(seconds) {
  const x = seconds * PIXELS_PER_SECOND;
  playheadEl.style.transform = `translateX(${x}px)`;
}

// Click en la regla de tiempo para desplazar el playhead (seek)
rulerCanvas.addEventListener("click", (e) => {
  const rect = rulerCanvas.getBoundingClientRect();
  const x = e.clientX - rect.left;
  const seconds = Math.max(0, x / PIXELS_PER_SECOND);
  engine.seekTo(seconds);
});

// ==========================================================================
// ALTERNANCIA DE VISTAS: EDIT / MIX
// ==========================================================================
btnViewEdit.addEventListener("click", () => switchView("edit"));
btnViewMix.addEventListener("click", () => switchView("mix"));

function switchView(which) {
  const isEdit = which === "edit";
  btnViewEdit.classList.toggle("active", isEdit);
  btnViewMix.classList.toggle("active", !isEdit);
  viewEdit.classList.toggle("hidden", !isEdit);
  viewMix.classList.toggle("hidden", isEdit);
}

// ==========================================================================
// GESTIÓN DE PISTAS — VISTA DE EDICIÓN
// ==========================================================================
btnAddTrack.addEventListener("click", () => {
  const track = engine.createTrack(`Pista ${engine.tracks.length + 1}`);
  createTrackUI(track);
  createChannelStrip(track);
  resizeRuler();
});

function createTrackUI(track) {
  const row = document.createElement("div");
  row.className = "track-row";
  row.dataset.trackId = track.id;

  row.innerHTML = `
    <div class="track-control-card">
      <div class="track-name-row">
        <input class="track-name-input" type="text" value="${escapeHtml(track.name)}" />
        <button class="track-remove-btn" title="Eliminar pista">✕</button>
      </div>
      <div class="track-buttons-row">
        <button class="track-mini-btn solo" title="Solo">S</button>
        <button class="track-mini-btn mute" title="Mute">M</button>
        <button class="track-mini-btn arm" title="Armar grabación">●</button>
      </div>
      <div class="track-fader-row">
        <span style="font-size:9px; color:var(--text-dim);">VOL</span>
        <input type="range" class="track-volume" min="0" max="100" value="${Math.round(track.volume * 100)}" />
      </div>
      <div class="track-fader-row">
        <span style="font-size:9px; color:var(--text-dim);">PAN</span>
        <input type="range" class="track-pan" min="-100" max="100" value="0" />
      </div>
      <div class="track-load-row">
        <button class="track-load-btn">📁 Cargar archivo de audio</button>
      </div>
      <span class="track-file-label">Sin archivo</span>
    </div>
    <div class="track-lane">
      <canvas class="waveform-canvas"></canvas>
    </div>
  `;

  tracksContainer.appendChild(row);

  const canvas = row.querySelector(".waveform-canvas");
  const view = {
    row,
    canvas,
    ctx: canvas.getContext("2d"),
    fileLabel: row.querySelector(".track-file-label"),
  };
  trackViews.set(track.id, view);

  // --- Eventos de la tarjeta de control ---
  row.querySelector(".track-name-input").addEventListener("input", (e) => {
    track.name = e.target.value;
    const strip = mixConsole.querySelector(`[data-track-id="${track.id}"] .strip-title`);
    if (strip) strip.textContent = track.name;
  });

  row.querySelector(".track-remove-btn").addEventListener("click", () => {
    engine.removeTrack(track.id);
    row.remove();
    trackViews.delete(track.id);
    const strip = mixConsole.querySelector(`[data-track-id="${track.id}"]`);
    if (strip) strip.remove();
  });

  const soloBtn = row.querySelector(".track-mini-btn.solo");
  soloBtn.addEventListener("click", () => {
    track.setSolo(!track.solo);
    soloBtn.classList.toggle("active", track.solo);
    syncMixButtons(track);
  });

  const muteBtn = row.querySelector(".track-mini-btn.mute");
  muteBtn.addEventListener("click", () => {
    track.setMute(!track.muted);
    muteBtn.classList.toggle("active", track.muted);
    syncMixButtons(track);
  });

  const armBtn = row.querySelector(".track-mini-btn.arm");
  armBtn.addEventListener("click", () => {
    track.setArmed(!track.armed);
    armBtn.classList.toggle("active", track.armed);
  });

  row.querySelector(".track-volume").addEventListener("input", (e) => {
    track.setVolume(e.target.value / 100);
    syncMixFader(track);
  });

  row.querySelector(".track-pan").addEventListener("input", (e) => {
    track.setPan(e.target.value / 100);
  });

  row.querySelector(".track-load-btn").addEventListener("click", () => {
    pendingLoadTrackId = track.id;
    fileInputHidden.value = "";
    fileInputHidden.click();
  });

  // Drag & drop de audio directamente sobre la lane de la pista
  const lane = row.querySelector(".track-lane");
  lane.addEventListener("dragover", (e) => e.preventDefault());
  lane.addEventListener("drop", async (e) => {
    e.preventDefault();
    const file = e.dataTransfer.files[0];
    if (file) await handleFileForTrack(track, file);
  });

  resizeTrackCanvas(track, view);
}

fileInputHidden.addEventListener("change", async (e) => {
  const file = e.target.files[0];
  if (file && pendingLoadTrackId != null) {
    const track = engine.tracks.find((t) => t.id === pendingLoadTrackId);
    if (track) await handleFileForTrack(track, file);
  }
  pendingLoadTrackId = null;
});

async function handleFileForTrack(track, file) {
  const view = trackViews.get(track.id);
  view.fileLabel.textContent = "Decodificando…";
  try {
    await track.loadFile(file);
    track._pendingFile = file; // se subirá a Cloud Storage en el próximo guardado
    view.fileLabel.textContent = file.name;
    resizeTrackCanvas(track, view);
    drawWaveform(track, view);
    resizeRuler();
  } catch (err) {
    console.error(err);
    view.fileLabel.textContent = "Error al decodificar el archivo";
  }
}

function resizeTrackCanvas(track, view) {
  const rect = view.row.querySelector(".track-lane").getBoundingClientRect();
  view.canvas.width = Math.max(rect.width, minCanvasWidth());
  view.canvas.height = rect.height;
  drawWaveform(track, view);
}

function minCanvasWidth() {
  const longest = engine.tracks.reduce(
    (max, t) => Math.max(max, t.buffer ? t.buffer.duration : 0),
    30
  );
  return longest * PIXELS_PER_SECOND;
}

// --- Dibujo de waveform en Canvas (usa los picos precalculados) ---
function drawWaveform(track, view) {
  const { ctx, canvas } = view;
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  if (!track.peaks) return;

  const midY = canvas.height / 2;
  const peaks = track.peaks;
  const numPeaks = peaks.length / 2;
  const durationPx = track.buffer.duration * PIXELS_PER_SECOND;
  const step = durationPx / numPeaks;

  ctx.beginPath();
  ctx.strokeStyle = "rgba(0,136,255,0.9)";
  ctx.fillStyle = "rgba(0,136,255,0.35)";
  ctx.lineWidth = 1;

  for (let i = 0; i < numPeaks; i++) {
    const x = i * step;
    const min = peaks[i * 2];
    const max = peaks[i * 2 + 1];
    const yMin = midY + min * midY * 0.92;
    const yMax = midY + max * midY * 0.92;
    ctx.moveTo(x, yMin);
    ctx.lineTo(x, yMax);
  }
  ctx.stroke();
}

function syncMixButtons(track) {
  const strip = mixConsole.querySelector(`[data-track-id="${track.id}"]`);
  if (!strip) return;
  strip.querySelector(".strip-mute").classList.toggle("active", track.muted);
  strip.querySelector(".strip-solo").classList.toggle("active", track.solo);
}

function syncMixFader(track) {
  const strip = mixConsole.querySelector(`[data-track-id="${track.id}"]`);
  if (!strip) return;
  strip.querySelector(".fader").value = Math.round(track.volume * 100);
}

// ==========================================================================
// REGLA DE TIEMPO (Canvas)
// ==========================================================================
function resizeRuler() {
  const wrapper = rulerCanvas.parentElement;
  rulerCanvas.width = Math.max(minCanvasWidth(), wrapper.clientWidth);
  rulerCanvas.height = wrapper.clientHeight;
  drawRuler();
}

function drawRuler() {
  const ctx = rulerCanvas.getContext("2d");
  const w = rulerCanvas.width;
  const h = rulerCanvas.height;
  ctx.clearRect(0, 0, w, h);
  ctx.fillStyle = "#101216";
  ctx.fillRect(0, 0, w, h);

  ctx.strokeStyle = "rgba(255,255,255,0.15)";
  ctx.fillStyle = "#9aa2ad";
  ctx.font = "10px SFMono-Regular, Consolas, monospace";

  const totalSeconds = w / PIXELS_PER_SECOND;
  for (let s = 0; s <= totalSeconds; s++) {
    const x = s * PIXELS_PER_SECOND;
    const isBar = s % 4 === 0;
    ctx.beginPath();
    ctx.moveTo(x, isBar ? 4 : h - 10);
    ctx.lineTo(x, h);
    ctx.stroke();
    if (isBar) {
      ctx.fillText(formatSecondsLabel(s), x + 3, 12);
    }
  }
}

function formatSecondsLabel(s) {
  const m = Math.floor(s / 60);
  const sec = s % 60;
  return `${m}:${String(sec).padStart(2, "0")}`;
}

window.addEventListener("resize", () => {
  resizeRuler();
  trackViews.forEach((view, id) => {
    const track = engine.tracks.find((t) => t.id === id);
    if (track) resizeTrackCanvas(track, view);
  });
});

// ==========================================================================
// VISTA DE MEZCLA — Channel strips
// ==========================================================================
function createChannelStrip(track) {
  const strip = document.createElement("div");
  strip.className = "channel-strip";
  strip.dataset.trackId = track.id;

  strip.innerHTML = `
    <div class="strip-title">${escapeHtml(track.name)}</div>

    <div class="insert-slot eq-toggle">EQ 3 Bandas</div>
    <div class="eq-mini hidden">
      <div class="eq-band"><span>LOW</span><input type="range" min="-12" max="12" value="0" class="eq-low" /></div>
      <div class="eq-band"><span>MID</span><input type="range" min="-12" max="12" value="0" class="eq-mid" /></div>
      <div class="eq-band"><span>HIGH</span><input type="range" min="-12" max="12" value="0" class="eq-high" /></div>
    </div>

    <div class="insert-slot reverb-toggle">Reverb</div>
    <div class="eq-mini hidden">
      <div class="eq-band"><span>MIX</span><input type="range" min="0" max="100" value="20" class="reverb-mix" /></div>
    </div>

    <div class="pan-knob-row">
      <span>PAN</span>
      <input type="range" class="strip-pan" min="-100" max="100" value="0" />
    </div>

    <div class="strip-buttons">
      <button class="track-mini-btn solo strip-solo">S</button>
      <button class="track-mini-btn mute strip-mute">M</button>
    </div>

    <div class="fader-section">
      <div class="vu-meter"><div class="vu-fill"></div><div class="vu-peak"></div></div>
      <input type="range" class="fader" min="0" max="100" value="${Math.round(track.volume * 100)}" orient="vertical" />
    </div>
    <div class="strip-fader-value">${track.volume.toFixed(2)}</div>
  `;

  mixConsole.appendChild(strip);

  // --- EQ (implementado vía BiquadFilterNode, opcional / visual + funcional simple) ---
  const eqNodes = createEqChain(track);

  strip.querySelector(".eq-toggle").addEventListener("click", (e) => {
    e.currentTarget.classList.toggle("active");
    e.currentTarget.nextElementSibling.classList.toggle("hidden");
  });
  strip.querySelector(".reverb-toggle").addEventListener("click", (e) => {
    e.currentTarget.classList.toggle("active");
    e.currentTarget.nextElementSibling.classList.toggle("hidden");
  });

  strip.querySelector(".eq-low").addEventListener("input", (e) => {
    eqNodes.low.gain.setTargetAtTime(parseFloat(e.target.value), engine.ctx.currentTime, 0.02);
  });
  strip.querySelector(".eq-mid").addEventListener("input", (e) => {
    eqNodes.mid.gain.setTargetAtTime(parseFloat(e.target.value), engine.ctx.currentTime, 0.02);
  });
  strip.querySelector(".eq-high").addEventListener("input", (e) => {
    eqNodes.high.gain.setTargetAtTime(parseFloat(e.target.value), engine.ctx.currentTime, 0.02);
  });
  strip.querySelector(".reverb-mix").addEventListener("input", (e) => {
    eqNodes.setReverbMix(e.target.value / 100);
  });

  strip.querySelector(".strip-pan").addEventListener("input", (e) => {
    track.setPan(e.target.value / 100);
    const editPan = trackViews.get(track.id)?.row.querySelector(".track-pan");
    if (editPan) editPan.value = e.target.value;
  });

  strip.querySelector(".strip-solo").addEventListener("click", (e) => {
    track.setSolo(!track.solo);
    e.currentTarget.classList.toggle("active", track.solo);
    const editSolo = trackViews.get(track.id)?.row.querySelector(".track-mini-btn.solo");
    if (editSolo) editSolo.classList.toggle("active", track.solo);
  });
  strip.querySelector(".strip-mute").addEventListener("click", (e) => {
    track.setMute(!track.muted);
    e.currentTarget.classList.toggle("active", track.muted);
    const editMute = trackViews.get(track.id)?.row.querySelector(".track-mini-btn.mute");
    if (editMute) editMute.classList.toggle("active", track.muted);
  });

  const faderEl = strip.querySelector(".fader");
  const faderValueEl = strip.querySelector(".strip-fader-value");
  faderEl.addEventListener("input", (e) => {
    track.setVolume(e.target.value / 100);
    faderValueEl.textContent = (e.target.value / 100).toFixed(2);
    const editVol = trackViews.get(track.id)?.row.querySelector(".track-volume");
    if (editVol) editVol.value = e.target.value;
  });

  track._vuFillEl = strip.querySelector(".vu-fill");
  track._vuPeakEl = strip.querySelector(".vu-peak");
}

// Cadena simple de EQ 3 bandas + retorno de reverb (ConvolverNode con IR sintética)
function createEqChain(track) {
  const ctx = engine.ctx;
  const low = ctx.createBiquadFilter();
  low.type = "lowshelf";
  low.frequency.value = 200;

  const mid = ctx.createBiquadFilter();
  mid.type = "peaking";
  mid.frequency.value = 1000;
  mid.Q.value = 0.8;

  const high = ctx.createBiquadFilter();
  high.type = "highshelf";
  high.frequency.value = 4000;

  // Reconectar: gainNode -> low -> mid -> high -> panNode -> analyser -> master
  track.gainNode.disconnect();
  track.gainNode.connect(low);
  low.connect(mid);
  mid.connect(high);
  high.connect(track.panNode);

  // Reverb sencillo (convolver con ruido decadente generado en el momento)
  const convolver = ctx.createConvolver();
  convolver.buffer = createSyntheticImpulseResponse(ctx, 2.0, 2.5);
  const reverbGain = ctx.createGain();
  reverbGain.gain.value = 0;
  high.connect(convolver);
  convolver.connect(reverbGain);
  reverbGain.connect(track.panNode);

  return {
    low,
    mid,
    high,
    setReverbMix(amount) {
      reverbGain.gain.setTargetAtTime(amount, ctx.currentTime, 0.02);
    },
  };
}

function createSyntheticImpulseResponse(ctx, duration, decay) {
  const rate = ctx.sampleRate;
  const length = rate * duration;
  const impulse = ctx.createBuffer(2, length, rate);
  for (let ch = 0; ch < 2; ch++) {
    const data = impulse.getChannelData(ch);
    for (let i = 0; i < length; i++) {
      data[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / length, decay);
    }
  }
  return impulse;
}

masterFader.addEventListener("input", (e) => {
  engine.masterGain.gain.setTargetAtTime(e.target.value / 100, engine.ctx.currentTime, 0.01);
});

// ==========================================================================
// ANIMACIÓN 60 FPS — VU meters, CPU load, playhead scroll
// ==========================================================================
function animationLoop() {
  // VU meters por pista
  engine.tracks.forEach((track) => {
    if (!track._vuFillEl) return;
    const { rms, peak } = track.getMeterLevel();
    track._vuFillEl.style.height = `${Math.min(100, rms * 140)}%`;
    track._vuPeakEl.style.bottom = `${Math.min(100, peak * 140)}%`;
  });

  // VU meter master
  const master = engine.getMasterMeter();
  masterVuFill.style.height = `${Math.min(100, master.rms * 140)}%`;
  masterVuPeak.style.bottom = `${Math.min(100, master.peak * 140)}%`;

  // Carga de CPU
  const load = engine.getCpuLoad();
  cpuBarFill.style.width = `${Math.round(load * 100)}%`;

  requestAnimationFrame(animationLoop);
}
requestAnimationFrame(animationLoop);

// ==========================================================================
// PERSISTENCIA — Guardar / Cargar proyecto (.mow) en Firestore + Storage
// ==========================================================================
btnSaveProject.addEventListener("click", async () => {
  if (!currentUser) return alert("Debes iniciar sesión para guardar tu proyecto.");
  btnSaveProject.disabled = true;
  btnSaveProject.textContent = "💾 Guardando…";
  try {
    await saveProject();
    btnSaveProject.textContent = "✅ Guardado";
  } catch (err) {
    console.error(err);
    btnSaveProject.textContent = "⚠️ Error";
  } finally {
    setTimeout(() => {
      btnSaveProject.disabled = false;
      btnSaveProject.textContent = "💾 Guardar";
    }, 1800);
  }
});

async function saveProject() {
  const projectId = currentProjectId || crypto.randomUUID();
  currentProjectId = projectId;

  // Subir cualquier audio nuevo a Cloud Storage y recolectar metadatos
  const tracksData = [];
  for (const track of engine.tracks) {
    let audioUrl = track.remoteUrl || null;

    if (track.buffer && track._pendingFile) {
      const path = `users/${currentUser.uid}/projects/${projectId}/${track.id}-${track._pendingFile.name}`;
      const storageRef = ref(storage, path);
      await uploadBytes(storageRef, track._pendingFile);
      audioUrl = await getDownloadURL(storageRef);
      track.remoteUrl = audioUrl;
      track._pendingFile = null;
    }

    tracksData.push({
      id: track.id,
      name: track.name,
      volume: track.volume,
      pan: track.pan,
      muted: track.muted,
      solo: track.solo,
      audioUrl,
      fileName: track.fileName || null,
      clips: [{ start: 0, duration: track.buffer ? track.buffer.duration : 0 }],
    });
  }

  const projectData = {
    projectName: projectNameInput.value || "Proyecto sin título",
    bpm: engine.bpm,
    ownerUid: currentUser.uid,
    updatedAt: Date.now(),
    tracks: tracksData,
  };

  await setDoc(doc(db, "users", currentUser.uid, "projects", projectId), projectData);
}

btnLoadProject.addEventListener("click", async () => {
  if (!currentUser) return alert("Debes iniciar sesión para cargar proyectos.");
  try {
    const snap = await getDocs(collection(db, "users", currentUser.uid, "projects"));
    if (snap.empty) return alert("No tienes proyectos guardados todavía.");

    // Selección simple del proyecto más reciente (se puede ampliar a un selector visual)
    let latestDoc = null;
    snap.forEach((d) => {
      if (!latestDoc || d.data().updatedAt > latestDoc.data().updatedAt) latestDoc = d;
    });

    await loadProjectData(latestDoc.id, latestDoc.data());
  } catch (err) {
    console.error(err);
    alert("Ocurrió un error al cargar el proyecto.");
  }
});

async function loadProjectData(projectId, data) {
  currentProjectId = projectId;
  projectNameInput.value = data.projectName || "Proyecto sin título";
  engine.setBpm(data.bpm || 120);
  bpmInput.value = engine.bpm;

  // Limpiar pistas actuales
  [...engine.tracks].forEach((t) => engine.removeTrack(t.id));
  tracksContainer.innerHTML = "";
  mixConsole.innerHTML = "";
  trackViews.clear();

  for (const t of data.tracks || []) {
    const track = engine.createTrack(t.name);
    track.setVolume(t.volume ?? 0.8);
    track.setPan(t.pan ?? 0);
    track.setMute(!!t.muted);
    track.setSolo(!!t.solo);
    track.remoteUrl = t.audioUrl || null;
    track.fileName = t.fileName || null;

    createTrackUI(track);
    createChannelStrip(track);

    if (t.audioUrl) {
      try {
        const resp = await fetch(t.audioUrl);
        const arrayBuffer = await resp.arrayBuffer();
        const buffer = await engine.ctx.decodeAudioData(arrayBuffer);
        track.loadDecodedBuffer(buffer, t.fileName);
        const view = trackViews.get(track.id);
        view.fileLabel.textContent = t.fileName || "Audio remoto";
        resizeTrackCanvas(track, view);
      } catch (err) {
        console.warn("No se pudo recargar el audio de la pista", t.name, err);
      }
    }
  }
  resizeRuler();
}

// --------------------------------------------------------------------------
// Utilidades
// --------------------------------------------------------------------------
function escapeHtml(str) {
  const div = document.createElement("div");
  div.textContent = str;
  return div.innerHTML;
}

// Redimensionar la regla al iniciar
resizeRuler();
