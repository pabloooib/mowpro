// ==========================================================================
// audio-engine.js
// Motor de audio multipista basado en Web Audio API.
// Maneja AudioContext, decodificación, ganancia/pan por pista, transporte,
// metrónomo y extracción de picos para el dibujo de waveforms en Canvas.
// ==========================================================================

const MASTER_FFT_SIZE = 1024;

class Track {
  constructor(engine, { id, name = "Audio Track" } = {}) {
    this.engine = engine;
    this.id = id;
    this.name = name;

    this.buffer = null;       // AudioBuffer decodificado
    this.peaks = null;        // Float32Array de picos precalculados (waveform)
    this.fileName = null;

    this.muted = false;
    this.solo = false;
    this.armed = false;
    this.volume = 0.8;        // 0..1 (lineal, mapeado a fader)
    this.pan = 0;             // -1..1

    // --- Nodos de audio ---
    const ctx = engine.ctx;
    this.gainNode = ctx.createGain();
    this.panNode = ctx.createStereoPanner();
    this.analyser = ctx.createAnalyser();
    this.analyser.fftSize = 512;
    this.analyser.smoothingTimeConstant = 0.6;

    this.gainNode.gain.value = this.volume;
    this.panNode.pan.value = this.pan;

    this.gainNode.connect(this.panNode);
    this.panNode.connect(this.analyser);
    this.analyser.connect(engine.masterGain);

    this._source = null;      // AudioBufferSourceNode activo (solo durante playback)
    this._meterBuf = new Uint8Array(this.analyser.frequencyBinCount);
  }

  async loadFile(file) {
    const arrayBuffer = await file.arrayBuffer();
    this.buffer = await this.engine.ctx.decodeAudioData(arrayBuffer.slice(0));
    this.fileName = file.name;
    this.peaks = computePeaks(this.buffer, 2000);
    return this.buffer;
  }

  loadDecodedBuffer(buffer, fileName) {
    this.buffer = buffer;
    this.fileName = fileName || this.fileName;
    this.peaks = computePeaks(buffer, 2000);
  }

  setVolume(v) {
    this.volume = Math.min(1, Math.max(0, v));
    this.gainNode.gain.setTargetAtTime(this.volume, this.engine.ctx.currentTime, 0.01);
  }

  setPan(p) {
    this.pan = Math.min(1, Math.max(-1, p));
    this.panNode.pan.setTargetAtTime(this.pan, this.engine.ctx.currentTime, 0.01);
  }

  setMute(m) {
    this.muted = m;
    this._applyAudibility();
  }

  setSolo(s) {
    this.solo = s;
    this.engine._recomputeSolo();
  }

  setArmed(a) {
    this.armed = a;
  }

  _applyAudibility() {
    const anySolo = this.engine.tracks.some((t) => t.solo);
    const audible = this.muted ? false : anySolo ? this.solo : true;
    const target = audible ? this.volume : 0;
    this.gainNode.gain.setTargetAtTime(target, this.engine.ctx.currentTime, 0.01);
  }

  getMeterLevel() {
    this.analyser.getByteTimeDomainData(this._meterBuf);
    let sumSquares = 0;
    let peak = 0;
    for (let i = 0; i < this._meterBuf.length; i++) {
      const v = (this._meterBuf[i] - 128) / 128;
      sumSquares += v * v;
      peak = Math.max(peak, Math.abs(v));
    }
    const rms = Math.sqrt(sumSquares / this._meterBuf.length);
    return { rms, peak };
  }

  // Arranca la reproducción de este track desde `offsetSeconds` en el
  // AudioContext-time `whenCtxTime`.
  _startPlayback(whenCtxTime, offsetSeconds) {
    if (!this.buffer) return;
    this._stopPlayback();
    const src = this.engine.ctx.createBufferSource();
    src.buffer = this.buffer;
    src.connect(this.gainNode);
    const clampedOffset = Math.max(0, Math.min(offsetSeconds, this.buffer.duration));
    src.start(whenCtxTime, clampedOffset);
    this._source = src;
  }

  _stopPlayback() {
    if (this._source) {
      try {
        this._source.stop();
      } catch (e) {
        /* ya detenido */
      }
      this._source.disconnect();
      this._source = null;
    }
  }
}

export class AudioEngine {
  constructor() {
    this.ctx = new (window.AudioContext || window.webkitAudioContext)();
    this.masterGain = this.ctx.createGain();
    this.masterAnalyser = this.ctx.createAnalyser();
    this.masterAnalyser.fftSize = MASTER_FFT_SIZE;

    this.masterGain.connect(this.masterAnalyser);
    this.masterAnalyser.connect(this.ctx.destination);

    this.tracks = [];
    this._trackIdCounter = 1;

    // --- Transporte ---
    this.bpm = 120;
    this.isPlaying = false;
    this.loopEnabled = false;
    this.metronomeEnabled = false;
    this.playStartCtxTime = 0;   // ctx.currentTime cuando arrancó el play
    this.playStartOffset = 0;    // posición (segundos) del playhead al arrancar
    this._metronomeTimer = null;
    this._rafId = null;
    this._onTick = null;         // callback(playheadSeconds)

    // --- Medición de carga de CPU/Audio (aproximada) ---
    this._loadSamples = [];
  }

  // ---------------- Gestión de pistas ----------------
  createTrack(name) {
    const track = new Track(this, { id: this._trackIdCounter++, name });
    this.tracks.push(track);
    return track;
  }

  removeTrack(id) {
    const idx = this.tracks.findIndex((t) => t.id === id);
    if (idx >= 0) {
      this.tracks[idx]._stopPlayback();
      this.tracks[idx].gainNode.disconnect();
      this.tracks.splice(idx, 1);
      this._recomputeSolo();
    }
  }

  _recomputeSolo() {
    this.tracks.forEach((t) => t._applyAudibility());
  }

  getPlayheadSeconds() {
    if (!this.isPlaying) return this.playStartOffset;
    return this.playStartOffset + (this.ctx.currentTime - this.playStartCtxTime);
  }

  // ---------------- Transporte ----------------
  async play() {
    if (this.ctx.state === "suspended") await this.ctx.resume();
    if (this.isPlaying) return;

    this.isPlaying = true;
    this.playStartCtxTime = this.ctx.currentTime;
    const offset = this.playStartOffset;

    this.tracks.forEach((t) => t._startPlayback(this.ctx.currentTime, offset));

    if (this.metronomeEnabled) this._startMetronome();
    this._loop();
  }

  stop() {
    if (!this.isPlaying) return;
    this.playStartOffset = this.getPlayheadSeconds();
    this.isPlaying = false;
    this.tracks.forEach((t) => t._stopPlayback());
    this._stopMetronome();
    if (this._rafId) cancelAnimationFrame(this._rafId);
  }

  returnToZero() {
    this.stop();
    this.playStartOffset = 0;
    if (this._onTick) this._onTick(0);
  }

  seekTo(seconds) {
    const wasPlaying = this.isPlaying;
    this.stop();
    this.playStartOffset = Math.max(0, seconds);
    if (this._onTick) this._onTick(this.playStartOffset);
    if (wasPlaying) this.play();
  }

  setBpm(bpm) {
    this.bpm = Math.min(300, Math.max(20, bpm));
    if (this.metronomeEnabled && this.isPlaying) {
      this._stopMetronome();
      this._startMetronome();
    }
  }

  toggleLoop(force) {
    this.loopEnabled = force !== undefined ? force : !this.loopEnabled;
  }

  toggleMetronome(force) {
    this.metronomeEnabled = force !== undefined ? force : !this.metronomeEnabled;
    if (this.isPlaying) {
      this._stopMetronome();
      if (this.metronomeEnabled) this._startMetronome();
    }
  }

  onTick(callback) {
    this._onTick = callback;
  }

  _loop() {
    if (!this.isPlaying) return;
    const t0 = performance.now();
    if (this._onTick) this._onTick(this.getPlayheadSeconds());

    // Estimación simple de carga de audio: tiempo de proceso vs. presupuesto de frame
    const dt = performance.now() - t0;
    this._loadSamples.push(dt);
    if (this._loadSamples.length > 30) this._loadSamples.shift();

    this._rafId = requestAnimationFrame(() => this._loop());
  }

  getCpuLoad() {
    // Heurística ligera basada en nº de pistas activas + tiempo de cómputo del loop.
    const base = Math.min(1, this.tracks.length * 0.04);
    const avg =
      this._loadSamples.reduce((a, b) => a + b, 0) / (this._loadSamples.length || 1);
    const runtime = Math.min(1, avg / 8);
    return Math.min(1, base + runtime);
  }

  _startMetronome() {
    const beatDuration = 60 / this.bpm;
    let nextBeatTime = this.ctx.currentTime;
    const scheduleAheadTime = 0.15;

    this._metronomeTimer = setInterval(() => {
      while (nextBeatTime < this.ctx.currentTime + scheduleAheadTime) {
        this._playClick(nextBeatTime);
        nextBeatTime += beatDuration;
      }
    }, 25);
  }

  _stopMetronome() {
    if (this._metronomeTimer) {
      clearInterval(this._metronomeTimer);
      this._metronomeTimer = null;
    }
  }

  _playClick(time) {
    const osc = this.ctx.createOscillator();
    const gain = this.ctx.createGain();
    osc.frequency.value = 1000;
    gain.gain.setValueAtTime(0.0001, time);
    gain.gain.exponentialRampToValueAtTime(0.35, time + 0.002);
    gain.gain.exponentialRampToValueAtTime(0.0001, time + 0.05);
    osc.connect(gain);
    gain.connect(this.masterGain);
    osc.start(time);
    osc.stop(time + 0.06);
  }

  getMasterMeter() {
    const buf = new Uint8Array(this.masterAnalyser.frequencyBinCount);
    this.masterAnalyser.getByteTimeDomainData(buf);
    let sumSquares = 0,
      peak = 0;
    for (let i = 0; i < buf.length; i++) {
      const v = (buf[i] - 128) / 128;
      sumSquares += v * v;
      peak = Math.max(peak, Math.abs(v));
    }
    return { rms: Math.sqrt(sumSquares / buf.length), peak };
  }
}

// --------------------------------------------------------------------------
// Utilidad: reduce un AudioBuffer a un arreglo compacto de picos (min/max)
// para poder dibujar la waveform eficientemente sin recorrer cada sample
// en cada frame de Canvas.
// --------------------------------------------------------------------------
export function computePeaks(audioBuffer, resolution = 1000) {
  const channelData = audioBuffer.getChannelData(0);
  const blockSize = Math.max(1, Math.floor(channelData.length / resolution));
  const peaks = new Float32Array(resolution * 2); // [min, max] por bloque

  for (let i = 0; i < resolution; i++) {
    const start = i * blockSize;
    let min = 1.0,
      max = -1.0;
    for (let j = 0; j < blockSize; j++) {
      const sample = channelData[start + j];
      if (sample === undefined) break;
      if (sample < min) min = sample;
      if (sample > max) max = sample;
    }
    peaks[i * 2] = min;
    peaks[i * 2 + 1] = max;
  }
  return peaks;
}
