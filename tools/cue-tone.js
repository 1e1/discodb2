'use strict';
// Cue-tone editor for the discodb2 Wizard. Pure Web Audio, no dependencies.
// Holds TWO presets ("during" / "after"); the combined JSON is the shared
// Wizard cue config (the active preset is chosen by the experiment's mode).

const $ = (id) => document.getElementById(id);
const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
const midiToHz = (m) => 440 * Math.pow(2, (m - 69) / 12);
const midiName = (m) => NOTE_NAMES[((m % 12) + 12) % 12] + (Math.floor(m / 12) - 1);
const midiFromHz = (hz) => Math.max(48, Math.min(96, Math.round(69 + 12 * Math.log2((Number(hz) || 440) / 440))));
const clampInt = (v, lo, hi) => Math.max(lo, Math.min(hi, Math.round(Number(v) || 0)));

function fillNotes(sel, lo, hi, def) {
  for (let m = lo; m <= hi; m++) {
    const o = document.createElement('option');
    o.value = String(m);
    o.textContent = `${midiName(m)} — ${midiToHz(m).toFixed(0)} Hz`;
    if (m === def) o.selected = true;
    sel.appendChild(o);
  }
}
fillNotes($('highNote'), 48, 96, 88); // E6 (~1319 Hz)
fillNotes($('lowNote'), 48, 96, 57);  // A3 (~220 Hz)

// Defaults: "during" needs a long low tone (reaction window); "after" can be short.
const presets = {
  during: { waveform: 'square', count: 3, highMidi: 88, highMs: 90, lowMidi: 57, lowMs: 700, gapMs: 110 },
  after: { waveform: 'square', count: 3, highMidi: 88, highMs: 90, lowMidi: 57, lowMs: 160, gapMs: 110 },
};
let mode = $('mode').value;

// ── Device sounds (connect / disconnect) — a separate 2-note family ──────────
// One param set drives BOTH: connect = low(short)→high(long); disconnect =
// high(short)→low(long). Both end on the LONGER note (the Windows-USB chirp
// feel). Consumed by the cockpit's playStartBeep / playStopBeep.
// `inputMidi` = the "on input" cue: two IDENTICAL-pitch notes on the SAME
// short→long rhythm as connect/disconnect. Default E5 (the third that completes
// the C-E-G triad with the connect/disconnect C5/G5).
const device = { waveform: 'sine', lowMidi: 72, highMidi: 79, inputMidi: 76, shortMs: 70, longMs: 140, gapMs: 8 };
fillNotes($('dLow'), 48, 96, 72); // C5 (~523 Hz)
fillNotes($('dHigh'), 48, 96, 79); // G5 (~784 Hz)
fillNotes($('dInput'), 48, 96, 76); // E5 (~659 Hz)

function readForm() {
  return {
    waveform: $('wave').value,
    count: clampInt($('count').value, 1, 8),
    highMidi: +$('highNote').value,
    highMs: clampInt($('highMs').value, 10, 2000),
    lowMidi: +$('lowNote').value,
    lowMs: clampInt($('lowMs').value, 10, 4000),
    gapMs: clampInt($('gap').value, 0, 2000),
  };
}
function writeForm(p) {
  $('wave').value = p.waveform;
  $('count').value = p.count;
  $('highNote').value = String(p.highMidi);
  $('highMs').value = p.highMs;
  $('lowNote').value = String(p.lowMidi);
  $('lowMs').value = p.lowMs;
  $('gap').value = p.gapMs;
}

function sequence(p, m) {
  const beeps = [];
  let t = 0;
  for (let i = 0; i < p.count; i++) {
    beeps.push({ hz: midiToHz(p.highMidi), durMs: p.highMs, t, kind: 'hi' });
    t += p.highMs + p.gapMs;
  }
  beeps.push({ hz: midiToHz(p.lowMidi), durMs: p.lowMs, t, kind: 'lo' });
  const lowStart = t;
  const lowEnd = t + p.lowMs;
  return { beeps, totalMs: lowEnd, actionAt: m === 'during' ? (lowStart + lowEnd) / 2 : lowEnd };
}

let ctx = null;
function audio() {
  if (!ctx) ctx = new (window.AudioContext || window.webkitAudioContext)();
  if (ctx.state === 'suspended') ctx.resume();
  return ctx;
}
function play(p) {
  const c = audio();
  const t0 = c.currentTime + 0.06;
  for (const b of sequence(p, mode).beeps) {
    const at = t0 + b.t / 1000;
    const dur = b.durMs / 1000;
    const osc = c.createOscillator();
    const g = c.createGain();
    osc.type = p.waveform;
    osc.frequency.value = b.hz;
    const atk = 0.004;
    const rel = 0.012;
    g.gain.setValueAtTime(0.0001, at);
    g.gain.exponentialRampToValueAtTime(0.85, at + atk);
    g.gain.setValueAtTime(0.85, at + Math.max(atk, dur - rel));
    g.gain.exponentialRampToValueAtTime(0.0006, at + dur);
    osc.connect(g).connect(c.destination);
    osc.start(at);
    osc.stop(at + dur + 0.03);
  }
}

function draw(p, m) {
  const cv = $('tl');
  const x = cv.getContext('2d');
  const W = cv.width;
  const H = cv.height;
  x.clearRect(0, 0, W, H);
  const seq = sequence(p, m);
  const pad = 32;
  const scale = (W - 2 * pad) / Math.max(seq.totalMs, 1);
  const ms2x = (ms) => pad + ms * scale;
  x.strokeStyle = '#2a2f3a';
  x.lineWidth = 1;
  x.beginPath();
  x.moveTo(pad, H - 26);
  x.lineTo(W - pad, H - 26);
  x.stroke();
  for (const b of seq.beeps) {
    const bx = ms2x(b.t);
    const bw = Math.max(2, b.durMs * scale);
    const h = b.kind === 'hi' ? 70 : 112;
    x.fillStyle = b.kind === 'hi' ? '#38bdf8' : '#f59e0b';
    x.fillRect(bx, H - 26 - h, bw, h);
    x.fillStyle = '#9aa0aa';
    x.font = '12px system-ui';
    x.fillText(`${b.hz.toFixed(0)}Hz`, bx, H - 26 - h - 5);
  }
  const ax = ms2x(seq.actionAt);
  x.strokeStyle = '#22c55e';
  x.setLineDash([5, 4]);
  x.lineWidth = 2;
  x.beginPath();
  x.moveTo(ax, 6);
  x.lineTo(ax, H - 14);
  x.stroke();
  x.setLineDash([]);
  x.fillStyle = '#22c55e';
  x.font = 'bold 12px system-ui';
  x.fillText('ACTION', ax + 5, 18);
  x.fillStyle = '#9aa0aa';
  x.font = '12px system-ui';
  x.fillText(`${Math.round(seq.totalMs)} ms`, W - pad - 54, H - 8);
}

function toExport(p) {
  return {
    waveform: p.waveform,
    high: { note: midiName(p.highMidi), hz: +midiToHz(p.highMidi).toFixed(1), durationMs: p.highMs, count: p.count },
    low: { note: midiName(p.lowMidi), hz: +midiToHz(p.lowMidi).toFixed(1), durationMs: p.lowMs },
    gapMs: p.gapMs,
    totalMs: Math.round(sequence(p, 'after').totalMs),
  };
}
function fromExport(o) {
  const hi = o.high || {};
  const lo = o.low || {};
  const waves = ['square', 'sine', 'triangle', 'sawtooth'];
  return {
    waveform: waves.includes(o.waveform) ? o.waveform : 'square',
    count: clampInt(hi.count ?? 3, 1, 8),
    highMidi: midiFromHz(hi.hz ?? midiToHz(88)),
    highMs: clampInt(hi.durationMs ?? 90, 10, 2000),
    lowMidi: midiFromHz(lo.hz ?? midiToHz(57)),
    lowMs: clampInt(lo.durationMs ?? 300, 10, 4000),
    gapMs: clampInt(o.gapMs ?? 110, 0, 2000),
  };
}
const serialize = () => JSON.stringify({ during: toExport(presets.during), after: toExport(presets.after), device: deviceToExport(device), sonification: sonif }, null, 2);

// ── device sounds: read/write, sequence, play, draw, export ──────────────────
function readDevice() {
  return {
    waveform: $('dWave').value,
    lowMidi: +$('dLow').value,
    highMidi: +$('dHigh').value,
    inputMidi: +$('dInput').value,
    shortMs: clampInt($('dShort').value, 10, 1000),
    longMs: clampInt($('dLong').value, 10, 2000),
    gapMs: clampInt($('dGap').value, 0, 500),
  };
}
function writeDevice(d) {
  $('dWave').value = d.waveform;
  $('dLow').value = String(d.lowMidi);
  $('dHigh').value = String(d.highMidi);
  $('dInput').value = String(d.inputMidi);
  $('dShort').value = d.shortMs;
  $('dLong').value = d.longMs;
  $('dGap').value = d.gapMs;
}
// dir = 'connect' (low→high) | 'disconnect' (high→low) | 'input' (same note ×2).
// The 2nd note is always the long one (the short→long rhythm is shared).
function deviceSeq(d, dir) {
  const lo = midiToHz(d.lowMidi);
  const hi = midiToHz(d.highMidi);
  const inp = midiToHz(d.inputMidi);
  const first = dir === 'connect' ? lo : dir === 'disconnect' ? hi : inp;
  const second = dir === 'connect' ? hi : dir === 'disconnect' ? lo : inp;
  return [
    { hz: first, durMs: d.shortMs, t: 0 },
    { hz: second, durMs: d.longMs, t: d.shortMs + d.gapMs },
  ];
}
const deviceTotalMs = (d) => d.shortMs + d.gapMs + d.longMs;

// Play an explicit note sequence (reuses the cue envelope; own waveform).
function playNotes(seq, waveform) {
  const c = audio();
  const t0 = c.currentTime + 0.04;
  for (const b of seq) {
    const at = t0 + b.t / 1000;
    const dur = b.durMs / 1000;
    const osc = c.createOscillator();
    const g = c.createGain();
    osc.type = waveform;
    osc.frequency.value = b.hz;
    g.gain.setValueAtTime(0.0001, at);
    g.gain.exponentialRampToValueAtTime(0.85, at + 0.004);
    g.gain.setValueAtTime(0.85, at + Math.max(0.004, dur - 0.012));
    g.gain.exponentialRampToValueAtTime(0.0006, at + dur);
    osc.connect(g).connect(c.destination);
    osc.start(at);
    osc.stop(at + dur + 0.03);
  }
}
function drawDevice(d) {
  const cv = $('dtl');
  const x = cv.getContext('2d');
  const W = cv.width;
  const H = cv.height;
  x.clearRect(0, 0, W, H);
  const total = deviceTotalMs(d);
  const pad = 32;
  const scale = (W - 2 * pad) / Math.max(total, 1);
  const hi = midiToHz(d.highMidi);
  x.strokeStyle = '#2a2f3a';
  x.lineWidth = 1;
  x.beginPath();
  x.moveTo(pad, H - 22);
  x.lineTo(W - pad, H - 22);
  x.stroke();
  // The CONNECT shape (low→high); disconnect is its pitch-mirror.
  for (const b of deviceSeq(d, 'connect')) {
    const bx = pad + b.t * scale;
    const bw = Math.max(2, b.durMs * scale);
    const h = b.hz === hi ? 80 : 48; // higher note → taller bar
    x.fillStyle = b.hz === hi ? '#38bdf8' : '#22c55e';
    x.fillRect(bx, H - 22 - h, bw, h);
    x.fillStyle = '#9aa0aa';
    x.font = '12px system-ui';
    x.fillText(`${b.hz.toFixed(0)}Hz · ${b.durMs}ms`, bx, H - 22 - h - 5);
  }
  x.fillStyle = '#9aa0aa';
  x.font = '12px system-ui';
  x.fillText(`connect ${Math.round(total)} ms · disconnect = pitch-mirror`, W - pad - 250, H - 6);
}
function deviceToExport(d) {
  const note = (hz) => midiName(midiFromHz(hz));
  return {
    waveform: d.waveform,
    connect: deviceSeq(d, 'connect').map((b) => ({ note: note(b.hz), hz: +b.hz.toFixed(1), durationMs: b.durMs })),
    disconnect: deviceSeq(d, 'disconnect').map((b) => ({ note: note(b.hz), hz: +b.hz.toFixed(1), durationMs: b.durMs })),
    input: deviceSeq(d, 'input').map((b) => ({ note: note(b.hz), hz: +b.hz.toFixed(1), durationMs: b.durMs })),
    gapMs: d.gapMs,
    totalMs: Math.round(deviceTotalMs(d)),
  };
}
function deviceFromExport(o) {
  const waves = ['square', 'sine', 'triangle', 'sawtooth'];
  const c = o.connect || [];
  const inp = o.input || [];
  return {
    waveform: waves.includes(o.waveform) ? o.waveform : 'sine',
    lowMidi: midiFromHz(c[0] && c[0].hz ? c[0].hz : 523),
    highMidi: midiFromHz(c[1] && c[1].hz ? c[1].hz : 784),
    inputMidi: midiFromHz(inp[0] && inp[0].hz ? inp[0].hz : 659),
    shortMs: clampInt(c[0] && c[0].durationMs ? c[0].durationMs : 70, 10, 1000),
    longMs: clampInt(c[1] && c[1].durationMs ? c[1].durationMs : 140, 10, 2000),
    gapMs: clampInt(o.gapMs != null ? o.gapMs : 8, 0, 500),
  };
}

function refresh() {
  draw(presets[mode], mode);
  drawDevice(device);
  $('modeHint').textContent = mode === 'during'
    ? 'act DURING the low tone → keep it long enough (reaction time)'
    : 'act AFTER the low tone → it can be short';
  if (document.activeElement !== $('io')) $('io').value = serialize();
}

let flashTimer = null;
function flash(msg) {
  $('status').textContent = msg;
  if (flashTimer) clearTimeout(flashTimer);
  flashTimer = setTimeout(() => { $('status').textContent = ''; }, 1600);
}

let loopTimer = null;
const stopLoop = () => { if (loopTimer) { clearTimeout(loopTimer); loopTimer = null; } };
function startLoop() {
  stopLoop();
  const tick = () => {
    const p = presets[mode];
    play(p);
    loopTimer = setTimeout(tick, sequence(p, mode).totalMs + 700);
  };
  tick();
}

['wave', 'count', 'highNote', 'highMs', 'lowNote', 'lowMs', 'gap'].forEach((id) => {
  $(id).addEventListener('input', () => { presets[mode] = readForm(); refresh(); });
});
['dWave', 'dLow', 'dHigh', 'dInput', 'dShort', 'dLong', 'dGap'].forEach((id) => {
  $(id).addEventListener('input', () => { Object.assign(device, readDevice()); refresh(); });
});
function flashDevice(msg) {
  $('dStatus').textContent = msg;
  setTimeout(() => { if ($('dStatus').textContent === msg) $('dStatus').textContent = ''; }, 1200);
}
$('playConnect').addEventListener('click', () => {
  Object.assign(device, readDevice());
  playNotes(deviceSeq(device, 'connect'), device.waveform);
  flashDevice('♪ connect — low→high');
});
$('playDisconnect').addEventListener('click', () => {
  Object.assign(device, readDevice());
  playNotes(deviceSeq(device, 'disconnect'), device.waveform);
  flashDevice('♪ disconnect — high→low');
});
$('playInput').addEventListener('click', () => {
  Object.assign(device, readDevice());
  playNotes(deviceSeq(device, 'input'), device.waveform);
  flashDevice('♪ input — same note ×2');
});
$('mode').addEventListener('change', () => {
  presets[mode] = readForm();
  mode = $('mode').value;
  writeForm(presets[mode]);
  refresh();
});
$('loop').addEventListener('change', () => ($('loop').checked ? startLoop() : stopLoop()));
$('play').addEventListener('click', () => { presets[mode] = readForm(); play(presets[mode]); });
$('copy').addEventListener('click', async () => {
  try { await navigator.clipboard.writeText($('io').value); flash('copied ✓'); }
  catch (_) { flash('copy failed (select the text)'); }
});
$('import').addEventListener('click', () => {
  try {
    const obj = JSON.parse($('io').value);
    if (obj.during) presets.during = fromExport(obj.during);
    if (obj.after) presets.after = fromExport(obj.after);
    if (obj.device) { Object.assign(device, deviceFromExport(obj.device)); writeDevice(device); }
    if (obj.sonification) { for (const k of Object.keys(sonif)) if (obj.sonification[k]) Object.assign(sonif[k], obj.sonification[k]); svWriteForm(); svApply(); }
    writeForm(presets[mode]);
    refresh();
    flash('imported ✓');
  } catch (_) {
    flash('invalid JSON');
  }
});

// ── frame-melody sonification, PER STEP TYPE ─────────────────────────────────
// A looping pseudo-melody stands in for the CAN-frame sonification. Each "voice"
// (step type) shapes it through one BiquadFilter + one shared LFO (tremolo or
// vibrato) + optional detune / soft-drive — all native, cheap nodes. The point:
// each phase sounds distinct, so the operator hears which phase they're in.
const FX_NOTES = [196, 220, 247, 262, 294, 330, 392, 440];
// Defaults: a distinct fingerprint per phase (tune to taste; exported in the JSON).
const SONIF = {
  noise:    { wave: 'triangle', filter: 'bandpass', cutoff: 600,  fx: 'none',    intervalMs: 190 },
  stimulus: { wave: 'square',   filter: 'highpass', cutoff: 700,  fx: 'vibrato', intervalMs: 150 },
  observe:  { wave: 'sine',     filter: 'lowpass',  cutoff: 1400, fx: 'tremolo', intervalMs: 280 },
  awaiting: { wave: 'sine',     filter: 'lowpass',  cutoff: 420,  fx: 'tremolo', intervalMs: 230 },
};
const sonif = JSON.parse(JSON.stringify(SONIF));
let svVoice = 'noise';
let svTimer = null, svFilter = null, svMaster = null, svTremGain = null, svVibGain = null, svShaper = null;

/** Soft-clip curve for the "drive" effect (cheap waveshaper). */
function driveCurve(k) {
  const n = 256, curve = new Float32Array(n);
  for (let i = 0; i < n; i++) { const x = (i * 2) / n - 1; curve[i] = ((1 + k) * x) / (1 + k * Math.abs(x)); }
  return curve;
}
function svChain() {
  const c = audio();
  if (!svMaster) {
    svMaster = c.createGain(); svMaster.gain.value = 0.85;
    svFilter = c.createBiquadFilter(); svFilter.type = 'lowpass'; svFilter.frequency.value = 12000;
    svShaper = c.createWaveShaper(); svShaper.curve = null;
    svFilter.connect(svShaper); svShaper.connect(svMaster); svMaster.connect(c.destination);
    // shared tremolo LFO → master gain; shared vibrato LFO → (per-note) detune.
    svTremGain = c.createGain(); svTremGain.gain.value = 0;
    const trem = c.createOscillator(); trem.frequency.value = 6; trem.connect(svTremGain); svTremGain.connect(svMaster.gain); trem.start();
    svVibGain = c.createGain(); svVibGain.gain.value = 0;
    const vib = c.createOscillator(); vib.frequency.value = 5.5; vib.connect(svVibGain); vib.start();
  }
  return c;
}
/** Push the current voice's filter + effect settings onto the chain. */
function svApply() {
  if (!svFilter) return;
  const v = sonif[svVoice], t = audio().currentTime;
  svFilter.type = v.filter === 'none' ? 'allpass' : v.filter;
  if (v.filter !== 'none') svFilter.frequency.setTargetAtTime(v.cutoff, t, 0.05);
  svFilter.Q.value = (v.filter === 'bandpass' || v.filter === 'notch') ? 4 : 0.7;
  svTremGain.gain.setTargetAtTime(v.fx === 'tremolo' ? 0.5 : 0, t, 0.05);
  svVibGain.gain.setTargetAtTime(v.fx === 'vibrato' ? 14 : 0, t, 0.05); // detune cents
  svShaper.curve = v.fx === 'drive' ? driveCurve(8) : null;
}
function svNote() {
  const c = audio(), v = sonif[svVoice];
  const base = FX_NOTES[(Math.random() * FX_NOTES.length) | 0];
  const freq = base * (v.fx === 'detune' ? 0.84 : 1);
  const o = c.createOscillator(), g = c.createGain();
  o.type = v.wave; o.frequency.value = freq;
  if (v.fx === 'vibrato') svVibGain.connect(o.detune);
  const at = c.currentTime + 0.01, dur = Math.min(0.16, (v.intervalMs / 1000) * 0.7);
  g.gain.setValueAtTime(0.0001, at); g.gain.exponentialRampToValueAtTime(0.16, at + 0.012);
  g.gain.exponentialRampToValueAtTime(0.0001, at + dur);
  o.connect(g); g.connect(svFilter); o.start(at); o.stop(at + dur + 0.03);
}
function svReadForm() {
  const v = sonif[svVoice];
  v.wave = $('svWave').value; v.filter = $('svFilter').value;
  v.cutoff = clampInt($('svCut').value, 80, 12000); v.fx = $('svFx').value;
  v.intervalMs = clampInt($('svInt').value, 60, 900);
}
function svWriteForm() {
  const v = sonif[svVoice];
  $('svWave').value = v.wave; $('svFilter').value = v.filter; $('svCut').value = v.cutoff;
  $('svFx').value = v.fx; $('svInt').value = v.intervalMs;
}
function svRestartIfPlaying() { if (svTimer) { clearInterval(svTimer); svTimer = setInterval(svNote, sonif[svVoice].intervalMs); } }
$('svVoice').addEventListener('change', () => { svVoice = $('svVoice').value; svWriteForm(); svApply(); svRestartIfPlaying(); });
['svWave', 'svFilter', 'svCut', 'svFx', 'svInt'].forEach((id) => {
  $(id).addEventListener('input', () => { svReadForm(); svApply(); if (id === 'svInt') svRestartIfPlaying(); });
});
$('svPlay').addEventListener('click', () => { svChain(); svApply(); if (svTimer) clearInterval(svTimer); svTimer = setInterval(svNote, sonif[svVoice].intervalMs); $('svStatus').textContent = 'playing · ' + svVoice; });
$('svStop').addEventListener('click', () => { if (svTimer) { clearInterval(svTimer); svTimer = null; } $('svStatus').textContent = ''; });
svWriteForm();

writeForm(presets[mode]);
writeDevice(device);
refresh();
