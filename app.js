/* =========================================================
   MOW PRO — DAW Engine (Web Audio API)
   Autor: Claude (Senior Full-Stack / DAW dev)
   ---------------------------------------------------------
   Contenido:
   1. AudioContext / Master Bus
   2. Utilidades (impulse response, formateo de tiempo)
   3. Clase Track (gain, pan, EQ-3, Reverb, VU)
   4. Transporte (play/pause/stop/record/loop, scheduler)
   5. Metrónomo (lookahead scheduler)
   6. UI: render de pistas (Edit) y canales (Mixer)
   7. Drag & Drop de archivos de audio
   8. Plugin Rack (editor de EQ / Reverb)
   9. Persistencia de sesión (JSON) vía backend Java
   ========================================================= */

(() => {
  "use strict";

  /* ============ 1. AUDIO CONTEXT / MASTER BUS ============ */

  const AudioCtx = window.AudioContext || window.webkitAudioContext;
  const ctx = new AudioCtx();

  const masterGain = ctx.createGain();
  masterGain.gain.value = 1;

  const masterAnalyser = ctx.createAnalyser();
  masterAnalyser.fftSize = 1024;

  // Bus de reverb compartido (para los "Sends")
  const reverbBus = ctx.createGain();
  reverbBus.gain.value = 1;
  const reverbBusConvolver = ctx.createConvolver();
  reverbBusConvolver.buffer = createImpulseResponse(2.4, 3.2);
  reverbBus.connect(reverbBusConvolver);
  reverbBusConvolver.connect(masterGain);

  masterGain.connect(masterAnalyser);
  masterAnalyser.connect(ctx.destination);

  document.getElementById("sample-rate-text").textContent =
    `${ctx.sampleRate} Hz · ${navigator.platform || "Web"}`;

  /* ============ 2. UTILIDADES ============ */

  function createImpulseResponse(duration = 2, decay = 2) {
    const rate = ctx.sampleRate;
    const length = Math.max(1, Math.floor(rate * duration));
    const impulse = ctx.createBuffer(2, length, rate);
    for (let ch = 0; ch < 2; ch++) {
      const data = impulse.getChannelData(ch);
      for (let i = 0; i < length; i++) {
        data[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / length, decay);
      }
    }
    return impulse;
  }

  function formatTime(seconds, mode) {
    if (mode === "bars") {
      const bpm = state.bpm;
      const beatsPerBar = 4;
      const secPerBeat = 60 / bpm;
      const totalBeats = seconds / secPerBeat;
      const bar = Math.floor(totalBeats / beatsPerBar) + 1;
      const beat = Math.floor(totalBeats % beatsPerBar) + 1;
      const tick = Math.floor((totalBeats % 1) * 960);
      return `${pad(bar, 3)}|${beat}|${pad(tick, 3)}`;
    }
    const m = Math.floor(seconds / 60);
    const s = Math.floor(seconds % 60);
    const ms = Math.floor((seconds % 1) * 1000);
    return `${pad(m, 2)}:${pad(s, 2)}:${pad(ms, 3)}`;
  }
  function pad(n, len) { return String(Math.max(0, n)).padStart(len, "0"); }

  function dbToGain(db) { return Math.pow(10, db / 20); }
  function gainToDb(g) { return 20 * Math.log10(Math.max(g, 0.0001)); }

  const TRACK_COLORS = ["#2196f3", "#6fae2e", "#d8c13a", "#c76bd6", "#e5433d", "#3ad1c9", "#e08b3a"];

  /* ============ 3. ESTADO GLOBAL ============ */

  const state = {
    bpm: 120,
    isPlaying: false,
    isPaused: false,
    loopEnabled: false,
    metronomeOn: false,
    timeMode: "clock", // "clock" | "bars"
    playheadTime: 0,       // segundos, posición lógica del transporte
    playbackStartCtxTime: 0, // ctx.currentTime cuando arrancó el playback
    loopStart: 0,
    loopEnd: 8,
    tracks: [],
    selectedTrackId: null,
    activePluginTarget: null, // {trackId, type: 'eq'|'reverb'}
  };

  let trackIdCounter = 1;

  /* ============ 4. CLASE TRACK ============ */

  class Track {
    constructor(name) {
      this.id = trackIdCounter++;
      this.name = name || `Pista ${this.id}`;
      this.color = TRACK_COLORS[(this.id - 1) % TRACK_COLORS.length];
      this.buffer = null;       // AudioBuffer cargado
      this.sourceNode = null;   // AudioBufferSourceNode activo (durante playback)
      this.armed = false;
      this.muted = false;
      this.solo = false;
      this.gainValue = 0.85;
      this.panValue = 0;
      this.inputLabel = "Entrada 1";
      this.outputLabel = "Salida 1-2";

      // Cadena de audio por pista:
      // source -> inputGain -> EQ3 -> reverbSendGain -> (reverbBus)
      //                              -> dryGain -> panNode -> analyser -> masterGain
      this.inputGain = ctx.createGain();
      this.inputGain.gain.value = this.gainValue;

      // EQ de 3 bandas
      this.eqLow = ctx.createBiquadFilter();
      this.eqLow.type = "lowshelf";
      this.eqLow.frequency.value = 320;
      this.eqLow.gain.value = 0;

      this.eqMid = ctx.createBiquadFilter();
      this.eqMid.type = "peaking";
      this.eqMid.frequency.value = 1000;
      this.eqMid.Q.value = 0.9;
      this.eqMid.gain.value = 0;

      this.eqHigh = ctx.createBiquadFilter();
      this.eqHigh.type = "highshelf";
      this.eqHigh.frequency.value = 3200;
      this.eqHigh.gain.value = 0;

      this.eqBypassed = false;

      // Reverb (insert) — dry/wet local
      this.reverbConvolver = ctx.createConvolver();
      this.reverbConvolver.buffer = createImpulseResponse(1.8, 2.5);
      this.reverbWet = ctx.createGain();
      this.reverbWet.gain.value = 0.0; // 0 = insert de reverb apagado por defecto
      this.reverbDry = ctx.createGain();
      this.reverbDry.gain.value = 1.0;
      this.reverbBypassed = true;

      // Send a bus de reverb global
      this.sendAGain = ctx.createGain();
      this.sendAGain.gain.value = 0;

      this.panNode = ctx.createStereoPanner ? ctx.createStereoPanner() : null;

      this.analyser = ctx.createAnalyser();
      this.analyser.fftSize = 512;

      this.outputGain = ctx.createGain(); // fader post-inserts (para mixer)
      this.outputGain.gain.value = 1;

      // Conexión de cadena fija (source se conecta/desconecta dinámicamente)
      this.inputGain.connect(this.eqLow);
      this.eqLow.connect(this.eqMid);
      this.eqMid.connect(this.eqHigh);

      // EQ -> split dry/reverb-insert
      this.eqHigh.connect(this.reverbDry);
      this.eqHigh.connect(this.reverbConvolver);
      this.reverbConvolver.connect(this.reverbWet);

      const postFx = ctx.createGain();
      this.reverbDry.connect(postFx);
      this.reverbWet.connect(postFx);

      postFx.connect(this.sendAGain);
      this.sendAGain.connect(reverbBus);

      if (this.panNode) {
        postFx.connect(this.panNode);
        this.panNode.connect(this.outputGain);
      } else {
        postFx.connect(this.outputGain);
      }
      this.outputGain.connect(this.analyser);
      this.analyser.connect(masterGain);

      this.waveformPeaks = null; // Float32Array de picos para dibujar
    }

    loadBuffer(audioBuffer, fileName) {
      this.buffer = audioBuffer;
      this.fileName = fileName || "clip.wav";
      this.waveformPeaks = computeWaveformPeaks(audioBuffer, 1200);
    }

    setGain(value) {
      this.gainValue = value;
      this.inputGain.gain.setTargetAtTime(value, ctx.currentTime, 0.01);
    }

    setPan(value) {
      this.panValue = value;
      if (this.panNode) this.panNode.pan.setTargetAtTime(value, ctx.currentTime, 0.01);
    }

    setMuted(muted) {
      this.muted = muted;
      applySoloMuteLogic();
    }

    setSolo(solo) {
      this.solo = solo;
      applySoloMuteLogic();
    }

    /** Crea y arranca un nuevo AudioBufferSourceNode desde 'offset' segundos */
    startPlayback(offset, when) {
      if (!this.buffer) return;
      this.stopPlayback();
      const src = ctx.createBufferSource();
      src.buffer = this.buffer;
      src.connect(this.inputGain);
      const safeOffset = Math.max(0, Math.min(offset, this.buffer.duration));
      try {
        src.start(when, safeOffset);
      } catch (e) { /* offset fuera de rango: ignorar */ }
      this.sourceNode = src;
    }

    stopPlayback() {
      if (this.sourceNode) {
        try { this.sourceNode.stop(); } catch (e) { /* ya detenido */ }
        this.sourceNode.disconnect();
        this.sourceNode = null;
      }
    }
  }

  function applySoloMuteLogic() {
    const anySolo = state.tracks.some(t => t.solo);
    state.tracks.forEach(t => {
      const shouldMute = t.muted || (anySolo && !t.solo);
      t.outputGain.gain.setTargetAtTime(shouldMute ? 0 : 1, ctx.currentTime, 0.01);
      const row = document.querySelector(`.track-header-row[data-id="${t.id}"] .mini-btn--mute`);
      if (row) row.classList.toggle("is-active", t.muted);
    });
  }

  function computeWaveformPeaks(buffer, resolution) {
    const data = buffer.getChannelData(0);
    const blockSize = Math.max(1, Math.floor(data.length / resolution));
    const peaks = new Float32Array(resolution);
    for (let i = 0; i < resolution; i++) {
      let max = 0;
      const start = i * blockSize;
      const end = Math.min(start + blockSize, data.length);
      for (let j = start; j < end; j++) {
        const v = Math.abs(data[j]);
        if (v > max) max = v;
      }
      peaks[i] = max;
    }
    return peaks;
  }

  /* ============ 5. TRANSPORTE ============ */

  const els = {
    play: document.getElementById("btn-play"),
    pause: document.getElementById("btn-pause"),
    stop: document.getElementById("btn-stop"),
    rewind: document.getElementById("btn-rewind"),
    record: document.getElementById("btn-record"),
    loop: document.getElementById("btn-loop"),
    metronome: document.getElementById("btn-metronome"),
    bpm: document.getElementById("bpm-input"),
    timeDisplay: document.getElementById("time-display"),
    timePrimary: document.getElementById("time-primary"),
    timeModeLabel: document.getElementById("time-mode-label"),
    cpuFill: document.getElementById("cpu-bar-fill"),
    cpuPct: document.getElementById("cpu-pct"),
    playheadEdit: document.getElementById("playhead-edit"),
    status: document.getElementById("status-text"),
  };

  function getProjectDuration() {
    let max = 30; // mínimo 30s de timeline visible
    state.tracks.forEach(t => {
      if (t.buffer) max = Math.max(max, t.buffer.duration);
    });
    return max;
  }

  function playAll() {
    if (state.isPlaying) return;
    ctx.resume();
    const when = ctx.currentTime + 0.05;
    state.tracks.forEach(t => t.startPlayback(state.playheadTime, when));
    state.playbackStartCtxTime = when - state.playheadTime;
    state.isPlaying = true;
    state.isPaused = false;
    els.play.classList.add("is-active");
    setStatus("Reproduciendo…");
    requestAnimationFrame(playbackLoop);
  }

  function pauseAll() {
    if (!state.isPlaying) return;
    state.playheadTime = ctx.currentTime - state.playbackStartCtxTime;
    state.tracks.forEach(t => t.stopPlayback());
    state.isPlaying = false;
    state.isPaused = true;
    els.play.classList.remove("is-active");
    setStatus("Pausado.");
  }

  function stopAll() {
    state.tracks.forEach(t => t.stopPlayback());
    state.isPlaying = false;
    state.isPaused = false;
    state.playheadTime = 0;
    els.play.classList.remove("is-active");
    updateTimeDisplay();
    updatePlayheadPosition();
    setStatus("Detenido.");
  }

  function rewind() {
    state.playheadTime = 0;
    if (state.isPlaying) {
      const when = ctx.currentTime + 0.05;
      state.tracks.forEach(t => t.startPlayback(0, when));
      state.playbackStartCtxTime = when;
    }
    updateTimeDisplay();
    updatePlayheadPosition();
  }

  function playbackLoop() {
    if (!state.isPlaying) return;
    state.playheadTime = ctx.currentTime - state.playbackStartCtxTime;

    if (state.loopEnabled && state.playheadTime >= state.loopEnd) {
      state.playheadTime = state.loopStart;
      const when = ctx.currentTime + 0.02;
      state.tracks.forEach(t => t.startPlayback(state.loopStart, when));
      state.playbackStartCtxTime = when - state.loopStart;
    } else {
      const dur = getProjectDuration();
      if (state.playheadTime >= dur && !state.loopEnabled) {
        stopAll();
        return;
      }
    }

    updateTimeDisplay();
    updatePlayheadPosition();
    updateMeters();
    updateCpuMeter();
    requestAnimationFrame(playbackLoop);
  }

  function updateTimeDisplay() {
    els.timePrimary.textContent = formatTime(state.playheadTime, state.timeMode === "bars" ? "bars" : "clock");
  }

  function updatePlayheadPosition() {
    const pxPerSec = 100;
    const x = state.playheadTime * pxPerSec;
    els.playheadEdit.style.transform = `translateX(${x}px)`;
  }

  els.play.addEventListener("click", playAll);
  els.pause.addEventListener("click", pauseAll);
  els.stop.addEventListener("click", stopAll);
  els.rewind.addEventListener("click", rewind);

  els.loop.addEventListener("click", () => {
    state.loopEnabled = !state.loopEnabled;
    els.loop.classList.toggle("is-active", state.loopEnabled);
    setStatus(state.loopEnabled ? `Loop activado (${state.loopStart}s–${state.loopEnd}s)` : "Loop desactivado.");
  });

  els.timeDisplay.addEventListener("click", () => {
    state.timeMode = state.timeMode === "clock" ? "bars" : "clock";
    els.timeModeLabel.textContent = state.timeMode === "clock" ? "MIN:SEG:MS" : "COMP|TIEMPO|TICK";
    updateTimeDisplay();
  });

  els.bpm.addEventListener("change", () => {
    state.bpm = Math.max(20, Math.min(300, parseInt(els.bpm.value, 10) || 120));
    els.bpm.value = state.bpm;
  });

  /* ---- Grabación (mic -> pista armada) ---- */
  let mediaRecorder = null;
  let recordedChunks = [];
  let recordingTrack = null;

  els.record.addEventListener("click", async () => {
    if (mediaRecorder && mediaRecorder.state === "recording") {
      mediaRecorder.stop();
      return;
    }
    const armedTrack = state.tracks.find(t => t.armed);
    if (!armedTrack) {
      setStatus("⚠ Arma una pista (R) antes de grabar.");
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      recordingTrack = armedTrack;
      recordedChunks = [];
      mediaRecorder = new MediaRecorder(stream);
      mediaRecorder.ondataavailable = e => recordedChunks.push(e.data);
      mediaRecorder.onstop = async () => {
        const blob = new Blob(recordedChunks, { type: "audio/webm" });
        const arrayBuffer = await blob.arrayBuffer();
        const audioBuffer = await ctx.decodeAudioData(arrayBuffer);
        recordingTrack.loadBuffer(audioBuffer, `grabación_${recordingTrack.name}.webm`);
        renderTrackLane(recordingTrack);
        els.record.classList.remove("is-armed");
        setStatus(`Grabación finalizada en “${recordingTrack.name}”.`);
        stream.getTracks().forEach(tr => tr.stop());
      };
      mediaRecorder.start();
      els.record.classList.add("is-armed");
      if (!state.isPlaying) playAll();
      setStatus(`● Grabando en “${armedTrack.name}”…`);
    } catch (err) {
      setStatus("⚠ No se pudo acceder al micrófono: " + err.message);
    }
  });

  function setStatus(msg) { els.status.textContent = msg; }

  /* ============ 6. METRÓNOMO (lookahead scheduler) ============ */

  let metronomeTimer = null;
  let nextClickTime = 0;
  let clickBeatCounter = 0;
  const SCHEDULE_AHEAD = 0.1;
  const LOOKAHEAD_MS = 25;

  function scheduleClick(time, accent) {
    const osc = ctx.createOscillator();
    const g = ctx.createGain();
    osc.frequency.value = accent ? 1500 : 1000;
    g.gain.setValueAtTime(0.001, time);
    g.gain.exponentialRampToValueAtTime(0.4, time + 0.005);
    g.gain.exponentialRampToValueAtTime(0.001, time + 0.06);
    osc.connect(g);
    g.connect(masterGain);
    osc.start(time);
    osc.stop(time + 0.07);
  }

  function metronomeScheduler() {
    while (nextClickTime < ctx.currentTime + SCHEDULE_AHEAD) {
      scheduleClick(nextClickTime, clickBeatCounter % 4 === 0);
      clickBeatCounter++;
      nextClickTime += 60 / state.bpm;
    }
  }

  els.metronome.addEventListener("click", () => {
    state.metronomeOn = !state.metronomeOn;
    els.metronome.classList.toggle("is-active", state.metronomeOn);
    if (state.metronomeOn) {
      clickBeatCounter = 0;
      nextClickTime = ctx.currentTime + 0.1;
      metronomeTimer = setInterval(metronomeScheduler, LOOKAHEAD_MS);
    } else {
      clearInterval(metronomeTimer);
    }
  });

  /* ============ 7. MEDIDORES (VU / CPU) ============ */

  function computeRms(analyser) {
    const buf = new Float32Array(analyser.fftSize);
    analyser.getFloatTimeDomainData(buf);
    let sum = 0;
    for (let i = 0; i < buf.length; i++) sum += buf[i] * buf[i];
    return Math.sqrt(sum / buf.length);
  }

  function updateMeters() {
    // Master
    const rmsMaster = computeRms(masterAnalyser);
    const pctMaster = Math.min(100, rmsMaster * 260);
    const l = document.getElementById("master-vu-l");
    const r = document.getElementById("master-vu-r");
    if (l) l.style.height = pctMaster + "%";
    if (r) r.style.height = Math.max(0, pctMaster - Math.random() * 4) + "%";

    // Por pista (mixer)
    state.tracks.forEach(t => {
      const rms = computeRms(t.analyser);
      const pct = Math.min(100, rms * 260);
      const elL = document.getElementById(`vu-${t.id}-l`);
      const elR = document.getElementById(`vu-${t.id}-r`);
      if (elL) elL.style.height = pct + "%";
      if (elR) elR.style.height = Math.max(0, pct - Math.random() * 4) + "%";
    });
  }

  function updateCpuMeter() {
    // Estimación simulada de carga DSP en función de nº de pistas activas y nodos.
    const activeSources = state.tracks.filter(t => t.sourceNode).length;
    const base = 4 + activeSources * 6 + state.tracks.length * 1.5;
    const jitter = Math.random() * 4;
    const pct = Math.min(96, Math.round(base + jitter));
    els.cpuFill.style.width = pct + "%";
    els.cpuPct.textContent = pct + "%";
    els.cpuFill.style.background = pct > 75
      ? "linear-gradient(90deg, var(--vu-yellow), var(--vu-red))"
      : "linear-gradient(90deg, var(--vu-green), var(--vu-yellow))";
  }
  setInterval(() => { if (!state.isPlaying) updateCpuMeter(); }, 800);

  /* ============ 8. GESTIÓN DE PISTAS Y RENDER UI ============ */

  const trackHeaders = document.getElementById("track-headers");
  const trackLanes = document.getElementById("track-lanes");
  const mixerConsole = document.getElementById("mixer-console");
  const masterStrip = document.getElementById("master-strip");
  const emptyHint = document.getElementById("empty-hint");

  function addTrack(name) {
    const track = new Track(name);
    state.tracks.push(track);
    renderTrackHeader(track);
    renderTrackLane(track);
    renderChannelStrip(track);
    emptyHint.style.display = "none";
    setStatus(`Pista “${track.name}” añadida.`);
    return track;
  }

  function removeTrack(id) {
    const idx = state.tracks.findIndex(t => t.id === id);
    if (idx === -1) return;
    const t = state.tracks[idx];
    t.stopPlayback();
    document.querySelector(`.track-header-row[data-id="${id}"]`)?.remove();
    document.querySelector(`.track-lane[data-id="${id}"]`)?.remove();
    document.querySelector(`.channel-strip[data-id="${id}"]`)?.remove();
    state.tracks.splice(idx, 1);
  }

  function renderTrackHeader(track) {
    const row = document.createElement("div");
    row.className = "track-header-row";
    row.dataset.id = track.id;
    row.innerHTML = `
      <div class="track-header-row__top">
        <span class="track-color-dot" style="background:${track.color}"></span>
        <input class="track-name-input" value="${track.name}" spellcheck="false">
        <div class="track-btn-group">
          <button class="mini-btn mini-btn--solo" title="Solo">S</button>
          <button class="mini-btn mini-btn--mute" title="Mute">M</button>
          <button class="mini-btn mini-btn--rec" title="Record Arm">R</button>
          <button class="mini-btn mini-btn--del" title="Eliminar pista">✕</button>
        </div>
      </div>
      <div class="track-header-row__io">
        <select class="io-select io-in">
          <option>Entrada 1</option><option>Entrada 2</option><option>Micrófono</option><option>Sin entrada</option>
        </select>
        <select class="io-select io-out">
          <option>Salida 1-2</option><option>Bus A</option><option>Bus B</option>
        </select>
      </div>
      <div class="track-header-row__fader">
        <label>VOL</label>
        <input type="range" class="mini-fader" min="0" max="1.3" step="0.01" value="${track.gainValue}">
        <label>PAN</label>
        <input type="range" class="mini-pan" min="-1" max="1" step="0.01" value="0">
      </div>
    `;
    trackHeaders.appendChild(row);

    row.querySelector(".track-name-input").addEventListener("input", e => {
      track.name = e.target.value;
      syncStripName(track);
    });
    row.querySelector(".mini-btn--solo").addEventListener("click", e => {
      track.setSolo(!track.solo);
      e.target.classList.toggle("is-active", track.solo);
    });
    row.querySelector(".mini-btn--mute").addEventListener("click", e => {
      track.setMuted(!track.muted);
      e.target.classList.toggle("is-active", track.muted);
    });
    row.querySelector(".mini-btn--rec").addEventListener("click", e => {
      track.armed = !track.armed;
      e.target.classList.toggle("is-active", track.armed);
    });
    row.querySelector(".mini-btn--del").addEventListener("click", () => removeTrack(track.id));
    row.querySelector(".mini-fader").addEventListener("input", e => {
      track.setGain(parseFloat(e.target.value));
      syncStripFader(track);
    });
    row.querySelector(".mini-pan").addEventListener("input", e => {
      track.setPan(parseFloat(e.target.value));
      syncStripPan(track);
    });
    row.addEventListener("click", () => selectTrack(track.id));
  }

  function renderTrackLane(track) {
    let lane = document.querySelector(`.track-lane[data-id="${track.id}"]`);
    if (!lane) {
      lane = document.createElement("div");
      lane.className = "track-lane";
      lane.dataset.id = track.id;
      lane.innerHTML = `<canvas></canvas><span class="clip-label"></span>`;
      trackLanes.appendChild(lane);
      setupDragAndDrop(lane, track);
    }
    const canvas = lane.querySelector("canvas");
    const label = lane.querySelector(".clip-label");
    const emptyMsg = lane.querySelector(".lane-empty-msg");
    if (emptyMsg) emptyMsg.remove();

    if (!track.buffer) {
      const msg = document.createElement("div");
      msg.className = "lane-empty-msg";
      msg.textContent = "Suelta un audio aquí…";
      lane.appendChild(msg);
      label.textContent = "";
      return;
    }
    label.textContent = track.fileName;
    drawWaveform(canvas, track);
  }

  function drawWaveform(canvas, track) {
    const dpr = window.devicePixelRatio || 1;
    const widthPx = Math.max(200, track.buffer.duration * 100);
    canvas.style.width = widthPx + "px";
    canvas.width = widthPx * dpr;
    canvas.height = 96 * dpr;
    const g = canvas.getContext("2d");
    g.scale(dpr, dpr);
    g.clearRect(0, 0, widthPx, 96);
    g.fillStyle = "#232323";
    g.fillRect(0, 0, widthPx, 96);

    const peaks = track.waveformPeaks;
    const mid = 48;
    g.strokeStyle = track.color;
    g.fillStyle = track.color + "55";
    g.beginPath();
    g.moveTo(0, mid);
    for (let i = 0; i < peaks.length; i++) {
      const x = (i / peaks.length) * widthPx;
      const h = peaks[i] * 42;
      g.lineTo(x, mid - h);
    }
    for (let i = peaks.length - 1; i >= 0; i--) {
      const x = (i / peaks.length) * widthPx;
      const h = peaks[i] * 42;
      g.lineTo(x, mid + h);
    }
    g.closePath();
    g.fill();
    g.lineWidth = 1;
    g.stroke();
  }

  function selectTrack(id) {
    state.selectedTrackId = id;
    document.querySelectorAll(".track-header-row").forEach(r => {
      r.classList.toggle("is-selected", parseInt(r.dataset.id, 10) === id);
    });
  }

  /* ---- Mixer channel strip ---- */

  function renderChannelStrip(track) {
    const strip = document.createElement("div");
    strip.className = "channel-strip";
    strip.dataset.id = track.id;
    strip.style.setProperty("--track-color", track.color);
    strip.innerHTML = `
      <div class="strip-io">${track.inputLabel}</div>
      <div class="strip-inserts">
        <div class="insert-slot insert-eq" data-type="eq">EQ-3</div>
        <div class="insert-slot insert-reverb" data-type="reverb">Reverb</div>
      </div>
      <div class="strip-sends">
        <div class="send-slot"><span>A</span><input type="range" class="send-a" min="0" max="1" step="0.01" value="0"></div>
      </div>
      <div class="strip-pan">
        <label>PAN</label>
        <input type="range" class="strip-pan-input" min="-1" max="1" step="0.01" value="0">
      </div>
      <div class="strip-btn-row">
        <button class="mini-btn mini-btn--solo" title="Solo">S</button>
        <button class="mini-btn mini-btn--mute" title="Mute">M</button>
        <button class="mini-btn mini-btn--rec" title="Record Arm">R</button>
      </div>
      <div class="strip-meter-fader">
        <div class="vu-meter">
          <div class="vu-fill" id="vu-${track.id}-l"></div>
          <div class="vu-fill" id="vu-${track.id}-r"></div>
        </div>
        <input type="range" class="fader fader--vertical strip-fader" min="0" max="1.3" step="0.01" value="${track.gainValue}" orient="vertical">
      </div>
      <div class="strip-name">${track.name}</div>
    `;
    mixerConsole.insertBefore(strip, masterStrip);

    strip.querySelector(".insert-eq").addEventListener("click", () => openPluginRack(track, "eq"));
    strip.querySelector(".insert-reverb").addEventListener("click", () => openPluginRack(track, "reverb"));
    strip.querySelector(".send-a").addEventListener("input", e => {
      track.sendAGain.gain.setTargetAtTime(parseFloat(e.target.value), ctx.currentTime, 0.01);
    });
    strip.querySelector(".strip-pan-input").addEventListener("input", e => {
      track.setPan(parseFloat(e.target.value));
      syncHeaderPan(track);
    });
    strip.querySelector(".mini-btn--solo").addEventListener("click", e => {
      track.setSolo(!track.solo);
      e.target.classList.toggle("is-active", track.solo);
      syncHeaderToggle(track, "solo");
    });
    strip.querySelector(".mini-btn--mute").addEventListener("click", e => {
      track.setMuted(!track.muted);
      e.target.classList.toggle("is-active", track.muted);
      syncHeaderToggle(track, "mute");
    });
    strip.querySelector(".mini-btn--rec").addEventListener("click", e => {
      track.armed = !track.armed;
      e.target.classList.toggle("is-active", track.armed);
      syncHeaderToggle(track, "rec");
    });
    strip.querySelector(".strip-fader").addEventListener("input", e => {
      track.setGain(parseFloat(e.target.value));
      syncHeaderFader(track);
    });
  }

  function syncStripName(track) {
    const el = document.querySelector(`.channel-strip[data-id="${track.id}"] .strip-name`);
    if (el) el.textContent = track.name;
  }
  function syncStripFader(track) {
    const el = document.querySelector(`.channel-strip[data-id="${track.id}"] .strip-fader`);
    if (el) el.value = track.gainValue;
  }
  function syncStripPan(track) {
    const el = document.querySelector(`.channel-strip[data-id="${track.id}"] .strip-pan-input`);
    if (el) el.value = track.panValue;
  }
  function syncHeaderFader(track) {
    const el = document.querySelector(`.track-header-row[data-id="${track.id}"] .mini-fader`);
    if (el) el.value = track.gainValue;
  }
  function syncHeaderPan(track) {
    const el = document.querySelector(`.track-header-row[data-id="${track.id}"] .mini-pan`);
    if (el) el.value = track.panValue;
  }
  function syncHeaderToggle(track, kind) {
    const map = { solo: ".mini-btn--solo", mute: ".mini-btn--mute", rec: ".mini-btn--rec" };
    const el = document.querySelector(`.track-header-row[data-id="${track.id}"] ${map[kind]}`);
    if (el) {
      const val = kind === "solo" ? track.solo : kind === "mute" ? track.muted : track.armed;
      el.classList.toggle("is-active", val);
    }
  }

  document.getElementById("btn-add-track").addEventListener("click", () => addTrack());

  /* ============ 9. DRAG & DROP DE AUDIO ============ */

  function setupDragAndDrop(lane, track) {
    ["dragenter", "dragover"].forEach(evt =>
      lane.addEventListener(evt, e => { e.preventDefault(); lane.classList.add("drag-over"); })
    );
    ["dragleave", "drop"].forEach(evt =>
      lane.addEventListener(evt, e => { e.preventDefault(); lane.classList.remove("drag-over"); })
    );
    lane.addEventListener("drop", async e => {
      const file = e.dataTransfer.files[0];
      if (!file) return;
      if (!/\.(wav|mp3|ogg|m4a)$/i.test(file.name)) {
        setStatus("⚠ Formato no soportado. Usa WAV, MP3, OGG o M4A.");
        return;
      }
      setStatus(`Cargando “${file.name}”…`);
      try {
        const arrayBuffer = await file.arrayBuffer();
        const audioBuffer = await ctx.decodeAudioData(arrayBuffer);
        track.loadBuffer(audioBuffer, file.name);
        renderTrackLane(track);
        setStatus(`“${file.name}” cargado en “${track.name}”.`);
      } catch (err) {
        setStatus("⚠ Error al decodificar el audio: " + err.message);
      }
    });
  }

  /* ============ 10. PLUGIN RACK (EQ-3 / Reverb) ============ */

  const pluginRack = document.getElementById("plugin-rack");
  const pluginRackTitle = document.getElementById("plugin-rack-title");
  const pluginRackBody = document.getElementById("plugin-rack-body");
  document.getElementById("plugin-rack-close").addEventListener("click", () => pluginRack.hidden = true);

  function openPluginRack(track, type) {
    pluginRack.hidden = false;
    if (type === "eq") {
      pluginRackTitle.textContent = `EQ-3 — ${track.name}`;
      pluginRackBody.innerHTML = buildEqControls(track);
      bindEqControls(track);
    } else {
      pluginRackTitle.textContent = `Reverb — ${track.name}`;
      pluginRackBody.innerHTML = buildReverbControls(track);
      bindReverbControls(track);
    }
  }

  function buildEqControls(track) {
    return `
      <label class="plugin-bypass"><input type="checkbox" id="eq-bypass" ${track.eqBypassed ? "checked" : ""}> Bypass</label>
      <div class="plugin-row"><label>Graves (Hz 320)</label><input type="range" id="eq-low" min="-15" max="15" step="0.5" value="${track.eqLow.gain.value}"><span class="val" id="eq-low-val">${track.eqLow.gain.value} dB</span></div>
      <div class="plugin-row"><label>Medios (1kHz)</label><input type="range" id="eq-mid" min="-15" max="15" step="0.5" value="${track.eqMid.gain.value}"><span class="val" id="eq-mid-val">${track.eqMid.gain.value} dB</span></div>
      <div class="plugin-row"><label>Agudos (3.2kHz)</label><input type="range" id="eq-high" min="-15" max="15" step="0.5" value="${track.eqHigh.gain.value}"><span class="val" id="eq-high-val">${track.eqHigh.gain.value} dB</span></div>
    `;
  }
  function bindEqControls(track) {
    const low = document.getElementById("eq-low");
    const mid = document.getElementById("eq-mid");
    const high = document.getElementById("eq-high");
    const bypass = document.getElementById("eq-bypass");
    low.addEventListener("input", () => {
      track.eqLow.gain.setTargetAtTime(parseFloat(low.value), ctx.currentTime, 0.01);
      document.getElementById("eq-low-val").textContent = low.value + " dB";
    });
    mid.addEventListener("input", () => {
      track.eqMid.gain.setTargetAtTime(parseFloat(mid.value), ctx.currentTime, 0.01);
      document.getElementById("eq-mid-val").textContent = mid.value + " dB";
    });
    high.addEventListener("input", () => {
      track.eqHigh.gain.setTargetAtTime(parseFloat(high.value), ctx.currentTime, 0.01);
      document.getElementById("eq-high-val").textContent = high.value + " dB";
    });
    bypass.addEventListener("change", () => {
      track.eqBypassed = bypass.checked;
      const targetLow = bypass.checked ? 0 : parseFloat(low.value);
      const targetMid = bypass.checked ? 0 : parseFloat(mid.value);
      const targetHigh = bypass.checked ? 0 : parseFloat(high.value);
      track.eqLow.gain.setTargetAtTime(targetLow, ctx.currentTime, 0.01);
      track.eqMid.gain.setTargetAtTime(targetMid, ctx.currentTime, 0.01);
      track.eqHigh.gain.setTargetAtTime(targetHigh, ctx.currentTime, 0.01);
      updateInsertSlotUI(track, "eq", !bypass.checked);
    });
    updateInsertSlotUI(track, "eq", !track.eqBypassed && (track.eqLow.gain.value || track.eqMid.gain.value || track.eqHigh.gain.value));
  }

  function buildReverbControls(track) {
    const wetPct = Math.round(track.reverbWet.gain.value * 100);
    return `
      <label class="plugin-bypass"><input type="checkbox" id="rv-bypass" ${track.reverbBypassed ? "checked" : ""}> Bypass</label>
      <div class="plugin-row"><label>Mezcla (Wet)</label><input type="range" id="rv-wet" min="0" max="100" step="1" value="${wetPct}"><span class="val" id="rv-wet-val">${wetPct}%</span></div>
      <div class="plugin-row"><label>Tamaño sala</label><input type="range" id="rv-size" min="0.5" max="4" step="0.1" value="1.8"><span class="val" id="rv-size-val">1.8s</span></div>
    `;
  }
  function bindReverbControls(track) {
    const wet = document.getElementById("rv-wet");
    const size = document.getElementById("rv-size");
    const bypass = document.getElementById("rv-bypass");
    wet.addEventListener("input", () => {
      const v = track.reverbBypassed ? 0 : parseFloat(wet.value) / 100;
      track.reverbWet.gain.setTargetAtTime(v, ctx.currentTime, 0.01);
      document.getElementById("rv-wet-val").textContent = wet.value + "%";
      updateInsertSlotUI(track, "reverb", !track.reverbBypassed && parseFloat(wet.value) > 0);
    });
    size.addEventListener("change", () => {
      track.reverbConvolver.buffer = createImpulseResponse(parseFloat(size.value), 2.5);
      document.getElementById("rv-size-val").textContent = size.value + "s";
    });
    bypass.addEventListener("change", () => {
      track.reverbBypassed = bypass.checked;
      const v = bypass.checked ? 0 : parseFloat(wet.value) / 100;
      track.reverbWet.gain.setTargetAtTime(v, ctx.currentTime, 0.01);
      updateInsertSlotUI(track, "reverb", !bypass.checked && parseFloat(wet.value) > 0);
    });
  }

  function updateInsertSlotUI(track, type, active) {
    const slot = document.querySelector(`.channel-strip[data-id="${track.id}"] .insert-${type}`);
    if (!slot) return;
    slot.classList.toggle("insert-slot--filled", !!active);
  }

  /* ============ 11. VIEW SWITCH (Edit / Mix) ============ */

  document.querySelectorAll(".view-tab").forEach(tab => {
    tab.addEventListener("click", () => {
      document.querySelectorAll(".view-tab").forEach(t => t.classList.remove("active"));
      document.querySelectorAll(".view").forEach(v => v.classList.remove("active"));
      tab.classList.add("active");
      document.getElementById(tab.dataset.view).classList.add("active");
    });
  });

  /* ============ 12. MASTER FADER ============ */

  document.getElementById("master-fader").addEventListener("input", e => {
    masterGain.gain.setTargetAtTime(parseFloat(e.target.value), ctx.currentTime, 0.01);
  });

  /* ============ 13. PERSISTENCIA DE SESIÓN (backend Java) ============ */

  const API_BASE = ""; // mismo origen que sirve el HTML (ver MowProServer.java)

  function serializeSession() {
    return {
      name: "Sesión MOW PRO",
      bpm: state.bpm,
      createdAt: new Date().toISOString(),
      tracks: state.tracks.map(t => ({
        id: t.id,
        name: t.name,
        color: t.color,
        gain: t.gainValue,
        pan: t.panValue,
        muted: t.muted,
        solo: t.solo,
        fileName: t.fileName || null,
        eq: { low: t.eqLow.gain.value, mid: t.eqMid.gain.value, high: t.eqHigh.gain.value, bypass: t.eqBypassed },
        reverb: { wet: t.reverbWet.gain.value, bypass: t.reverbBypassed },
      })),
    };
  }

  document.getElementById("btn-save-session").addEventListener("click", async () => {
    const session = serializeSession();
    try {
      const res = await fetch(`${API_BASE}/api/save`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(session),
      });
      if (!res.ok) throw new Error("HTTP " + res.status);
      setStatus("Sesión guardada en el servidor (carpeta /projects).");
    } catch (err) {
      // Fallback: descarga local si no hay backend Java corriendo
      const blob = new Blob([JSON.stringify(session, null, 2)], { type: "application/json" });
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = "sesion-mowpro.json";
      a.click();
      setStatus("Backend no disponible: sesión descargada localmente.");
    }
  });

  document.getElementById("btn-load-session").addEventListener("click", () => {
    document.getElementById("session-file-input").click();
  });
  document.getElementById("session-file-input").addEventListener("change", async e => {
    const file = e.target.files[0];
    if (!file) return;
    const text = await file.text();
    try {
      const session = JSON.parse(text);
      applySession(session);
      setStatus(`Sesión “${session.name || file.name}” cargada.`);
    } catch (err) {
      setStatus("⚠ Archivo de sesión inválido.");
    }
  });

  function applySession(session) {
    // Limpia pistas actuales
    [...state.tracks].forEach(t => removeTrack(t.id));
    state.bpm = session.bpm || 120;
    els.bpm.value = state.bpm;
    (session.tracks || []).forEach(td => {
      const t = addTrack(td.name);
      t.setGain(td.gain ?? 0.85);
      t.setPan(td.pan ?? 0);
      if (td.muted) { t.setMuted(true); syncHeaderToggle(t, "mute"); document.querySelector(`.channel-strip[data-id="${t.id}"] .mini-btn--mute`)?.classList.add("is-active"); }
      if (td.solo) { t.setSolo(true); syncHeaderToggle(t, "solo"); }
      if (td.eq) {
        t.eqLow.gain.value = td.eq.low || 0;
        t.eqMid.gain.value = td.eq.mid || 0;
        t.eqHigh.gain.value = td.eq.high || 0;
        t.eqBypassed = !!td.eq.bypass;
      }
      if (td.reverb) {
        t.reverbWet.gain.value = td.reverb.wet || 0;
        t.reverbBypassed = !!td.reverb.bypass;
      }
      syncStripFader(t);
      syncStripPan(t);
    });
  }

  /* ---- Exportar mezcla (render en el navegador con OfflineAudioContext) ---- */

  document.getElementById("btn-export").addEventListener("click", exportMix);

  async function exportMix() {
    if (state.tracks.length === 0) {
      setStatus("⚠ No hay pistas para exportar.");
      return;
    }
    setStatus("Renderizando mezcla…");
    const duration = getProjectDuration();
    const offlineCtx = new OfflineAudioContext(2, Math.ceil(duration * ctx.sampleRate), ctx.sampleRate);
    const offlineMaster = offlineCtx.createGain();
    offlineMaster.gain.value = masterGain.gain.value;
    offlineMaster.connect(offlineCtx.destination);

    state.tracks.forEach(t => {
      if (!t.buffer || t.muted) return;
      const src = offlineCtx.createBufferSource();
      src.buffer = t.buffer;
      const g = offlineCtx.createGain();
      g.gain.value = t.gainValue;
      let pan = null;
      if (offlineCtx.createStereoPanner) {
        pan = offlineCtx.createStereoPanner();
        pan.pan.value = t.panValue;
      }
      const low = offlineCtx.createBiquadFilter();
      low.type = "lowshelf"; low.frequency.value = 320; low.gain.value = t.eqBypassed ? 0 : t.eqLow.gain.value;
      const mid = offlineCtx.createBiquadFilter();
      mid.type = "peaking"; mid.frequency.value = 1000; mid.Q.value = 0.9; mid.gain.value = t.eqBypassed ? 0 : t.eqMid.gain.value;
      const high = offlineCtx.createBiquadFilter();
      high.type = "highshelf"; high.frequency.value = 3200; high.gain.value = t.eqBypassed ? 0 : t.eqHigh.gain.value;

      src.connect(g);
      g.connect(low); low.connect(mid); mid.connect(high);
      if (pan) { high.connect(pan); pan.connect(offlineMaster); }
      else { high.connect(offlineMaster); }
      src.start(0);
    });

    try {
      const rendered = await offlineCtx.startRendering();
      const wavBlob = audioBufferToWav(rendered);
      const a = document.createElement("a");
      a.href = URL.createObjectURL(wavBlob);
      a.download = "mowpro-mixdown.wav";
      a.click();
      setStatus("Mezcla exportada como WAV.");

      // Además, se ofrece al backend Java para un render/copia server-side (opcional).
      try {
        await fetch(`${API_BASE}/api/export`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ note: "Render realizado en cliente vía OfflineAudioContext." }),
        });
      } catch (_) { /* backend opcional */ }
    } catch (err) {
      setStatus("⚠ Error al exportar: " + err.message);
    }
  }

  /** Convierte un AudioBuffer a un Blob WAV (PCM 16-bit) */
  function audioBufferToWav(buffer) {
    const numChannels = buffer.numberOfChannels;
    const sampleRate = buffer.sampleRate;
    const format = 1; // PCM
    const bitDepth = 16;

    let interleaved;
    if (numChannels === 2) {
      interleaved = interleave(buffer.getChannelData(0), buffer.getChannelData(1));
    } else {
      interleaved = buffer.getChannelData(0);
    }

    const dataLength = interleaved.length * (bitDepth / 8);
    const bufferArr = new ArrayBuffer(44 + dataLength);
    const view = new DataView(bufferArr);

    writeString(view, 0, "RIFF");
    view.setUint32(4, 36 + dataLength, true);
    writeString(view, 8, "WAVE");
    writeString(view, 12, "fmt ");
    view.setUint32(16, 16, true);
    view.setUint16(20, format, true);
    view.setUint16(22, numChannels, true);
    view.setUint32(24, sampleRate, true);
    view.setUint32(28, sampleRate * numChannels * (bitDepth / 8), true);
    view.setUint16(32, numChannels * (bitDepth / 8), true);
    view.setUint16(34, bitDepth, true);
    writeString(view, 36, "data");
    view.setUint32(40, dataLength, true);

    floatTo16BitPCM(view, 44, interleaved);
    return new Blob([view], { type: "audio/wav" });
  }
  function interleave(left, right) {
    const length = left.length + right.length;
    const result = new Float32Array(length);
    let index = 0, inputIndex = 0;
    while (index < length) {
      result[index++] = left[inputIndex];
      result[index++] = right[inputIndex];
      inputIndex++;
    }
    return result;
  }
  function floatTo16BitPCM(view, offset, input) {
    for (let i = 0; i < input.length; i++, offset += 2) {
      const s = Math.max(-1, Math.min(1, input[i]));
      view.setInt16(offset, s < 0 ? s * 0x8000 : s * 0x7fff, true);
    }
  }
  function writeString(view, offset, str) {
    for (let i = 0; i < str.length; i++) view.setUint8(offset + i, str.charCodeAt(i));
  }

  /* ============ 14. RULER (click para mover playhead) ============ */

  document.getElementById("ruler").addEventListener("click", e => {
    const rect = e.currentTarget.getBoundingClientRect();
    const x = e.clientX - rect.left + e.currentTarget.parentElement.scrollLeft;
    const seconds = x / 100;
    state.playheadTime = Math.max(0, seconds);
    updateTimeDisplay();
    updatePlayheadPosition();
    if (state.isPlaying) {
      const when = ctx.currentTime + 0.05;
      state.tracks.forEach(t => t.startPlayback(state.playheadTime, when));
      state.playbackStartCtxTime = when - state.playheadTime;
    }
  });

  /* ============ 15. INICIALIZACIÓN ============ */

  function init() {
    addTrack("Voz Principal");
    addTrack("Guitarra");
    addTrack("Batería");
    updateTimeDisplay();
    updateCpuMeter();
    setStatus("MOW PRO listo. Haz clic en cualquier control para activar el audio del navegador.");
  }

  // Los navegadores requieren un gesto de usuario para arrancar el AudioContext.
  document.body.addEventListener("click", () => { if (ctx.state === "suspended") ctx.resume(); }, { once: true });

  init();
})();
