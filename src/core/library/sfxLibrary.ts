/**
 * Sound FX library — REAL audio, procedurally synthesized.
 *
 * Every item renders a deterministic mono PCM buffer with pure DSP (seeded
 * noise, sine sweeps, one-pole filters — no WebAudio, no network), encodes it
 * as a standard 16-bit WAV, and inserts it through the exact same pipeline an
 * imported audio file uses: assetStore.addAsset(File) → insertAudio(asset).
 * The result is a normal audio layer with a waveform, level/trim controls and
 * transport-synced playback.
 *
 * The synth + WAV encoder are PURE and unit-tested; only `insertSfxItem`
 * touches stores/DOM.
 */

import { useAssetStore, type ImportedAsset } from '@stores/assetStore';
import { insertAudio } from '@core/scene/sceneInsert';
import { useSelectionStore } from '@stores/selectionStore';

export type SfxCategory = 'click' | 'whoosh' | 'impact' | 'ambient';

export interface SfxItem {
  id: string;
  name: string;
  cat: SfxCategory;
  /** Rendered length in seconds. */
  duration: number;
  color: string;
}

export const SFX_ITEMS: readonly SfxItem[] = [
  { id: 'sfx-click',    name: 'UI Click',       cat: 'click',   duration: 0.09, color: '#2988ff' },
  { id: 'sfx-pop',      name: 'Button Pop',     cat: 'click',   duration: 0.16, color: '#8b5cf6' },
  { id: 'sfx-toggle',   name: 'Toggle Switch',  cat: 'click',   duration: 0.07, color: '#10b981' },
  { id: 'sfx-whoosh',   name: 'Fast Whoosh',    cat: 'whoosh',  duration: 0.4,  color: '#f59e0b' },
  { id: 'sfx-whoosh-h', name: 'Heavy Whoosh',   cat: 'whoosh',  duration: 0.7,  color: '#ec4899' },
  { id: 'sfx-riser',    name: 'Riser',          cat: 'whoosh',  duration: 1.6,  color: '#6366f1' },
  { id: 'sfx-impact',   name: 'Hit Impact',     cat: 'impact',  duration: 0.5,  color: '#f97316' },
  { id: 'sfx-thud',     name: 'Thud',           cat: 'impact',  duration: 0.35, color: '#ef4444' },
  { id: 'sfx-boom',     name: 'Cinematic Boom', cat: 'impact',  duration: 1.5,  color: '#7c3aed' },
  { id: 'sfx-subdrop',  name: 'Sub Drop',       cat: 'impact',  duration: 1.2,  color: '#38bdf8' },
  { id: 'sfx-room',     name: 'Room Tone',      cat: 'ambient', duration: 4.0,  color: '#14b8a6' },
  { id: 'sfx-rain',     name: 'Rain Noise',     cat: 'ambient', duration: 4.0,  color: '#84cc16' },
  { id: 'sfx-tick',     name: 'Tick',           cat: 'click',   duration: 0.05, color: '#a3e635' },
  { id: 'sfx-chime',    name: 'Success Chime',  cat: 'click',   duration: 0.9,  color: '#22d3ee' },
  { id: 'sfx-swipe',    name: 'Soft Swipe',     cat: 'whoosh',  duration: 0.28, color: '#c084fc' },
  { id: 'sfx-reverse',  name: 'Reverse Suck',   cat: 'whoosh',  duration: 1.1,  color: '#fb923c' },
  { id: 'sfx-glass',    name: 'Glass Snap',     cat: 'impact',  duration: 0.4,  color: '#e2e8f0' },
  { id: 'sfx-drone',    name: 'Low Drone',      cat: 'ambient', duration: 4.0,  color: '#8b5cf6' },
] as const;

export function getSfxItem(id: string): SfxItem | null {
  return SFX_ITEMS.find((s) => s.id === id) ?? null;
}

// ── Pure DSP ───────────────────────────────────────────────────────

export const SFX_SAMPLE_RATE = 44100;

/** Deterministic PRNG (mulberry32) so the same item always renders the same audio. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a += 0x6d2b79f5;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const TAU = Math.PI * 2;

/** exp-decay envelope: 1 at t=0 → ~0 at t=dur. */
const decay = (t: number, dur: number, curve = 5): number => Math.exp((-curve * t) / dur);
/** attack-release envelope (linear attack, exp release). */
const ar = (t: number, dur: number, attack: number): number =>
  t < attack ? t / attack : decay(t - attack, dur - attack, 4);

/** Sine sweep from f0→f1 Hz over dur with exponential glide (phase-accurate). */
function sweepOsc(n: number, sr: number, f0: number, f1: number): Float32Array {
  const out = new Float32Array(n);
  let phase = 0;
  for (let i = 0; i < n; i++) {
    const p = i / n;
    const f = f0 * Math.pow(f1 / f0, p);
    phase += (TAU * f) / sr;
    out[i] = Math.sin(phase);
  }
  return out;
}

/** One-pole lowpass over a buffer (cutoff as 0..1 smoothing coefficient). */
function onePoleLp(buf: Float32Array, coeff: number): Float32Array {
  const out = new Float32Array(buf.length);
  let y = 0;
  for (let i = 0; i < buf.length; i++) {
    y += coeff * ((buf[i] ?? 0) - y);
    out[i] = y;
  }
  return out;
}

/** Simple resonant band emphasis: lowpassed noise minus a heavier lowpass. */
function bandNoise(n: number, rnd: () => number, loCoeff: number, hiCoeff: number): Float32Array {
  const white = new Float32Array(n);
  for (let i = 0; i < n; i++) white[i] = rnd() * 2 - 1;
  const lp1 = onePoleLp(white, loCoeff);
  const lp2 = onePoleLp(white, hiCoeff);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = (lp1[i] ?? 0) - (lp2[i] ?? 0);
  return out;
}

function normalize(buf: Float32Array, peakTarget = 0.89): Float32Array {
  let peak = 0;
  for (let i = 0; i < buf.length; i++) peak = Math.max(peak, Math.abs(buf[i] ?? 0));
  if (peak <= 0) return buf;
  const g = peakTarget / peak;
  for (let i = 0; i < buf.length; i++) buf[i] = (buf[i] ?? 0) * g;
  return buf;
}

/**
 * Peak envelope of an item's actual audio, downsampled to `buckets` bars — the
 * shape a card should draw.
 *
 * The cards drew a hardcoded `[4,7,5,9,6,8,5]` bar pattern, identical for every
 * item: a click, a whoosh and an ambient pad all looked like the same seven
 * bars, so the one glance that should say "short and sharp" vs "long and
 * swelling" said nothing at all. This is the real envelope, so a decay looks
 * like a decay.
 *
 * Values are 0..1 (peak absolute amplitude per bucket, normalised). Null for an
 * unknown id.
 */
export function sfxWaveform(id: string, buckets = 28): number[] | null {
  // The envelope is a SHAPE, not audio — rendering at full 44.1 kHz only to
  // throw almost all of it away would cost a card ~130k samples per item. An
  // eighth of the rate preserves every peak this drawing can resolve.
  const samples = renderSfxSamples(id, SFX_SAMPLE_RATE / 8);
  if (!samples) return null;
  const out: number[] = [];
  const per = samples.length / buckets;
  for (let b = 0; b < buckets; b++) {
    const start = Math.floor(b * per);
    const end = Math.max(start + 1, Math.floor((b + 1) * per));
    let peak = 0;
    for (let i = start; i < end && i < samples.length; i++) {
      const v = Math.abs(samples[i]!);
      if (v > peak) peak = v;
    }
    out.push(peak);
  }
  // Normalised so a quiet item still reads — the card shows shape, not level.
  const max = out.reduce((m, v) => Math.max(m, v), 0);
  return max > 0 ? out.map((v) => v / max) : out;
}

/**
 * Render an item's mono samples. Deterministic: same id → identical buffer.
 * Returns null for an unknown id.
 */
export function renderSfxSamples(id: string, sr: number = SFX_SAMPLE_RATE): Float32Array | null {
  const item = getSfxItem(id);
  if (!item) return null;
  const dur = item.duration;
  const n = Math.round(dur * sr);
  const rnd = mulberry32(0xc0ffee ^ id.split('').reduce((a, c) => a * 31 + c.charCodeAt(0), 7));
  const out = new Float32Array(n);
  const t = (i: number): number => i / sr;

  switch (id) {
    case 'sfx-click': {
      const osc = sweepOsc(n, sr, 2400, 900);
      for (let i = 0; i < n; i++) out[i] = (osc[i] ?? 0) * decay(t(i), dur, 10);
      break;
    }
    case 'sfx-pop': {
      const osc = sweepOsc(n, sr, 640, 130);
      for (let i = 0; i < n; i++) out[i] = (osc[i] ?? 0) * decay(t(i), dur, 6);
      break;
    }
    case 'sfx-toggle': {
      const noise = bandNoise(n, rnd, 0.55, 0.2);
      for (let i = 0; i < n; i++) out[i] = (noise[i] ?? 0) * decay(t(i), dur, 12);
      break;
    }
    case 'sfx-whoosh':
    case 'sfx-whoosh-h': {
      const heavy = id === 'sfx-whoosh-h';
      const noise = bandNoise(n, rnd, heavy ? 0.22 : 0.4, heavy ? 0.05 : 0.12);
      for (let i = 0; i < n; i++) {
        const p = t(i) / dur;
        // Swell in and out — the classic doppler-style pass-by envelope.
        const env = Math.sin(Math.PI * Math.min(1, p)) ** (heavy ? 1.6 : 1.2);
        out[i] = (noise[i] ?? 0) * env;
      }
      break;
    }
    case 'sfx-riser': {
      const osc = sweepOsc(n, sr, 90, 880);
      const noise = bandNoise(n, rnd, 0.35, 0.1);
      for (let i = 0; i < n; i++) {
        const p = t(i) / dur;
        out[i] = ((osc[i] ?? 0) * 0.55 + (noise[i] ?? 0) * 0.6) * p * p;
      }
      break;
    }
    case 'sfx-impact': {
      const thump = sweepOsc(n, sr, 160, 42);
      const noise = bandNoise(n, rnd, 0.5, 0.15);
      for (let i = 0; i < n; i++) {
        out[i] = (thump[i] ?? 0) * decay(t(i), dur, 6) + (noise[i] ?? 0) * decay(t(i), dur * 0.4, 8) * 0.5;
      }
      break;
    }
    case 'sfx-thud': {
      const thump = sweepOsc(n, sr, 110, 55);
      for (let i = 0; i < n; i++) out[i] = (thump[i] ?? 0) * decay(t(i), dur, 7);
      break;
    }
    case 'sfx-boom': {
      const sub = sweepOsc(n, sr, 70, 32);
      const noise = bandNoise(n, rnd, 0.2, 0.04);
      for (let i = 0; i < n; i++) {
        out[i] = (sub[i] ?? 0) * decay(t(i), dur, 3.2) + (noise[i] ?? 0) * decay(t(i), dur * 0.7, 4) * 0.35;
      }
      break;
    }
    case 'sfx-subdrop': {
      const sub = sweepOsc(n, sr, 220, 28);
      for (let i = 0; i < n; i++) out[i] = (sub[i] ?? 0) * ar(t(i), dur, 0.04);
      break;
    }
    case 'sfx-tick': {
      // Shorter and drier than the UI click — a keystroke, not a button.
      const noise = bandNoise(n, rnd, 0.85, 0.45);
      for (let i = 0; i < n; i++) out[i] = (noise[i] ?? 0) * decay(t(i), dur, 22);
      break;
    }
    case 'sfx-chime': {
      // A major third stacked over a root, each partial decaying at its own
      // rate — the higher the partial, the faster it dies, which is what makes
      // additive tones read as a struck bell rather than an organ chord.
      const partials: Array<[number, number, number]> = [[880, 1, 4], [1108, 0.6, 6], [1760, 0.32, 9]];
      for (const [freq, gain, rate] of partials) {
        let phase = 0;
        for (let i = 0; i < n; i++) {
          phase += (TAU * freq) / sr;
          out[i] = (out[i] ?? 0) + Math.sin(phase) * gain * decay(t(i), dur, rate);
        }
      }
      break;
    }
    case 'sfx-swipe': {
      const noise = bandNoise(n, rnd, 0.6, 0.2);
      for (let i = 0; i < n; i++) {
        const p = t(i) / dur;
        out[i] = (noise[i] ?? 0) * Math.sin(Math.PI * Math.min(1, p)) ** 1.1;
      }
      break;
    }
    case 'sfx-reverse': {
      // Built forwards then reversed: a decaying tail read backwards is the
      // swell that makes a reverse cymbal sound like one.
      const fwd = new Float32Array(n);
      const osc = sweepOsc(n, sr, 520, 180);
      const noise = bandNoise(n, rnd, 0.45, 0.12);
      for (let i = 0; i < n; i++) {
        fwd[i] = ((osc[i] ?? 0) * 0.4 + (noise[i] ?? 0) * 0.75) * decay(t(i), dur, 3);
      }
      for (let i = 0; i < n; i++) out[i] = fwd[n - 1 - i] ?? 0;
      break;
    }
    case 'sfx-glass': {
      // Inharmonic partials — deliberately NOT integer ratios, which is what
      // separates glass/metal from a pitched instrument.
      const partials: Array<[number, number]> = [[2100, 1], [3170, 0.55], [4630, 0.4], [6210, 0.22]];
      for (const [freq, gain] of partials) {
        let phase = 0;
        for (let i = 0; i < n; i++) {
          phase += (TAU * freq) / sr;
          out[i] = (out[i] ?? 0) + Math.sin(phase) * gain * decay(t(i), dur, 11);
        }
      }
      // A short noise transient for the strike itself.
      const strike = bandNoise(n, rnd, 0.9, 0.5);
      for (let i = 0; i < n; i++) out[i] = (out[i] ?? 0) + (strike[i] ?? 0) * decay(t(i), dur * 0.12, 20) * 0.6;
      break;
    }
    case 'sfx-drone': {
      // Two detuned low sines beating against each other, over a filtered bed.
      const bed = onePoleLp(bandNoise(n, rnd, 0.06, 0.008), 0.2);
      let p1 = 0, p2 = 0;
      for (let i = 0; i < n; i++) {
        p1 += (TAU * 55) / sr;
        p2 += (TAU * 55.7) / sr; // 0.7 Hz beat
        const p = t(i) / dur;
        const edge = Math.min(1, Math.min(p, 1 - p) * 20); // loopable edges
        out[i] = (Math.sin(p1) * 0.5 + Math.sin(p2) * 0.4 + (bed[i] ?? 0) * 0.5) * edge;
      }
      normalize(out, 0.42);
      return out;
    }
    case 'sfx-room': {
      // Quiet brown-ish noise bed; loopable (edges faded).
      const noise = onePoleLp(bandNoise(n, rnd, 0.08, 0.01), 0.3);
      for (let i = 0; i < n; i++) {
        const p = t(i) / dur;
        const edge = Math.min(1, Math.min(p, 1 - p) * 20);
        out[i] = (noise[i] ?? 0) * edge;
      }
      normalize(out, 0.28); // room tone should sit low
      return out;
    }
    case 'sfx-rain': {
      const hiss = bandNoise(n, rnd, 0.75, 0.3);
      // Sparse droplet ticks over the hiss bed.
      for (let i = 0; i < n; i++) out[i] = (hiss[i] ?? 0) * 0.5;
      const drops = Math.round(dur * 22);
      for (let dIdx = 0; dIdx < drops; dIdx++) {
        const at = Math.floor(rnd() * (n - 400));
        const amp = 0.25 + rnd() * 0.5;
        const f = 1400 + rnd() * 2200;
        for (let j = 0; j < 360; j++) {
          const i = at + j;
          if (i >= n) break;
          out[i] = (out[i] ?? 0) + Math.sin((TAU * f * j) / sr) * amp * Math.exp(-j / 70);
        }
      }
      break;
    }
    default:
      return null;
  }
  return normalize(out);
}

// ── WAV encoding (16-bit PCM mono) ─────────────────────────────────

/** Encode mono float samples as a canonical 44-byte-header 16-bit PCM WAV. */
export function encodeWavPcm16(samples: Float32Array, sampleRate: number = SFX_SAMPLE_RATE): ArrayBuffer {
  const dataLen = samples.length * 2;
  const buf = new ArrayBuffer(44 + dataLen);
  const v = new DataView(buf);
  const str = (off: number, s: string): void => { for (let i = 0; i < s.length; i++) v.setUint8(off + i, s.charCodeAt(i)); };
  str(0, 'RIFF');
  v.setUint32(4, 36 + dataLen, true);
  str(8, 'WAVE');
  str(12, 'fmt ');
  v.setUint32(16, 16, true);      // fmt chunk size
  v.setUint16(20, 1, true);       // PCM
  v.setUint16(22, 1, true);       // mono
  v.setUint32(24, sampleRate, true);
  v.setUint32(28, sampleRate * 2, true); // byte rate
  v.setUint16(32, 2, true);       // block align
  v.setUint16(34, 16, true);      // bits per sample
  str(36, 'data');
  v.setUint32(40, dataLen, true);
  let off = 44;
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i] ?? 0));
    v.setInt16(off, s < 0 ? s * 0x8000 : s * 0x7fff, true);
    off += 2;
  }
  return buf;
}

// ── Insert into the live composition ───────────────────────────────

/**
 * Insert a sound-effect item as a real audio layer. Synthesizes the WAV,
 * imports it through the normal asset pipeline (reusing the library asset if
 * this item was inserted before), and adds the audio layer. Returns the new
 * audio node id, or null on failure.
 */
export async function insertSfxItem(sfxId: string): Promise<string | null> {
  const item = getSfxItem(sfxId);
  if (!item) return null;
  const fileName = `${item.name}.wav`;

  // Re-use the previously imported asset for this item — same bytes anyway.
  const existing = useAssetStore.getState().assets.find((a) => a.type === 'audio' && a.name === fileName);
  let asset: ImportedAsset;
  if (existing) {
    asset = existing;
  } else {
    const samples = renderSfxSamples(sfxId);
    if (!samples) return null;
    const wav = encodeWavPcm16(samples);
    const file = new File([wav], fileName, { type: 'audio/wav' });
    asset = await useAssetStore.getState().addAsset(file);
  }
  // Some decode paths can miss duration metadata on blob WAVs — the synth
  // knows the exact length, so guarantee the layer gets a real out-point.
  if (!asset.metadata?.duration) {
    asset = { ...asset, metadata: { ...asset.metadata, duration: item.duration } };
  }
  insertAudio(asset);
  return useSelectionStore.getState().ids[0] ?? null;
}
