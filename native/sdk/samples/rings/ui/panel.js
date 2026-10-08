// Rings panel (Premation SDK 1.1 sample). Runs in a sandboxed frame: no Node,
// no network. It talks to the editor only through postMessage (docs/PLUGIN_SDK.md
// "Plugin panels"): it reads `state`, and sends setParam / invokeButton /
// requestPreview. Every edit goes through the engine, so undo and redo work.
/* global window, document, atob */
'use strict';

const SET_PALETTE = 'p9'; // the hidden "Set Palette" button (rings.cpp kSetPalette)
const SPACING = 'p2';
const MAX_COLORS = 8;
const MAGIC = 0x52494e47; // 'RING'

let colors = [];
let nextId = 1;
const pending = new Map();
const $ = (id) => document.getElementById(id);

function send(msg) {
  window.parent.postMessage(Object.assign({ premation: 1 }, msg), '*');
}

function request(msg) {
  const id = nextId++;
  send(Object.assign({ id }, msg));
  return new Promise((resolve) => pending.set(id, resolve));
}

/** The flat sequence data (rings.cpp Palette): magic, format, seed, count, 8 × rgb float32, little-endian. */
function decodePalette(b64) {
  if (!b64) return null;
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  if (bytes.length < 16 + MAX_COLORS * 12) return null;
  const v = new DataView(bytes.buffer);
  if (v.getUint32(0, true) !== MAGIC) return null;
  const count = Math.min(MAX_COLORS, v.getUint32(12, true));
  const out = [];
  for (let i = 0; i < count; i++) {
    const c = [0, 1, 2].map((k) => Math.round(Math.max(0, Math.min(1, v.getFloat32(16 + i * 12 + k * 4, true))) * 255));
    out.push('#' + c.map((n) => n.toString(16).padStart(2, '0')).join(''));
  }
  return out;
}

function render() {
  const box = $('swatches');
  box.textContent = '';
  colors.forEach((hex, i) => {
    const input = document.createElement('input');
    input.type = 'color';
    input.value = hex;
    input.title = 'Colour ' + (i + 1);
    input.addEventListener('input', () => { colors[i] = input.value; });
    box.appendChild(input);
  });
  $('add').disabled = colors.length >= MAX_COLORS;
  $('remove').disabled = colors.length <= 1;
}

function status(text) { $('status').textContent = text; }

window.addEventListener('message', (e) => {
  if (e.source !== window.parent) return;
  const m = e.data;
  if (!m || m.premation !== 1) return;
  if (m.type === 'state') {
    const p = decodePalette(m.data && m.data.sequence);
    if (p) colors = p;
    const spacing = m.values && typeof m.values[SPACING] === 'number' ? m.values[SPACING] : null;
    if (spacing !== null) { $('spacing').value = String(spacing); $('spacingValue').textContent = String(spacing); }
    render();
  } else if (m.type === 'reply' && pending.has(m.id)) {
    pending.get(m.id)(m);
    pending.delete(m.id);
  }
});

$('add').addEventListener('click', () => { if (colors.length < MAX_COLORS) { colors.push('#ffffff'); render(); } });
$('remove').addEventListener('click', () => { if (colors.length > 1) { colors.pop(); render(); } });
$('apply').addEventListener('click', async () => {
  const r = await request({ type: 'invokeButton', key: SET_PALETTE, payload: colors.join(' ') });
  status(r.ok ? 'Palette applied.' : r.error);
});
$('spacing').addEventListener('change', async (e) => {
  const r = await request({ type: 'setParam', key: SPACING, value: Number(e.target.value) });
  if (!r.ok) status(r.error);
});
$('preview').addEventListener('click', async () => {
  const r = await request({ type: 'requestPreview', maxSize: 320 });
  if (r.ok && r.image) { $('frame').src = r.image; $('frame').hidden = false; } else status(r.error || 'No preview.');
});

send({ type: 'ready' });
