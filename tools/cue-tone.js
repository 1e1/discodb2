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
const serialize = () => JSON.stringify({ during: toExport(presets.during), after: toExport(presets.after) }, null, 2);

function refresh() {
  draw(presets[mode], mode);
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
    writeForm(presets[mode]);
    refresh();
    flash('imported ✓');
  } catch (_) {
    flash('invalid JSON');
  }
});

writeForm(presets[mode]);
refresh();
