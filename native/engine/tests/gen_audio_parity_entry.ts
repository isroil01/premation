/**
 * The TypeScript side of the E2 audio parity gate — bundled by
 * gen_audio_parity.mjs and RUN in Electron's renderer (Chromium's
 * OfflineAudioContext, the engine the editor's export uses).
 *
 * Every scene goes through the REAL `mixdownBuffer` (src/core/audio/
 * audioMixdown.ts) — its `connectAudioEffects`, `buildParamRamp`,
 * `voicePanner`, `audibleWindow`, `reverseBuffer` — with only its two inputs
 * stubbed: the scene reader (`readAudioLayers`, which would read the scene
 * graph) returns the scene's voices, and the decode cache (`audioEngine`)
 * returns the scene's generated buffers. Keyframes go into the real
 * `defaultAnimation`.
 *
 * Sources are generated from Math.sin and an integer xorshift, so the C++
 * test (test_audio_parity.cpp) rebuilds them bit for bit (motion_jsmath's
 * V8 sin) instead of reading them from the file.
 */

import { mixdownBuffer } from '@core/audio/audioMixdown';
import { distortionCurve } from '@core/audio/audioEffects';
import { defaultAnimation } from '@motion/animation';

const SR = 48000;
const SRC_FRAMES = 24000;
const SCENE_FRAMES = 7680; // 0.16 s: 8 ramp steps of 20 ms, 60 render quanta

type Planes = Float32Array[];

function tone(): Planes {
  const l = new Float32Array(SRC_FRAMES);
  const r = new Float32Array(SRC_FRAMES);
  for (let i = 0; i < SRC_FRAMES; i++) {
    l[i] = 0.5 * Math.sin(2 * Math.PI * 440 * i / SR);
    r[i] = 0.4 * Math.sin(2 * Math.PI * 660 * i / SR) + 0.1 * Math.sin(2 * Math.PI * 3000 * i / SR);
  }
  return [l, r];
}

function mono(): Planes {
  const m = new Float32Array(SRC_FRAMES);
  for (let i = 0; i < SRC_FRAMES; i++) {
    m[i] = 0.6 * Math.sin(2 * Math.PI * 220 * i / SR) * (0.5 + 0.5 * Math.sin(2 * Math.PI * 3 * i / SR));
  }
  return [m];
}

function noise(seed: number, amp: number): Planes {
  const l = new Float32Array(SRC_FRAMES);
  const r = new Float32Array(SRC_FRAMES);
  let x = seed >>> 0;
  const next = (): number => {
    x ^= x << 13; x >>>= 0;
    x ^= x >>> 17;
    x ^= x << 5; x >>>= 0;
    return (x / 4294967296) * 2 * amp - amp;
  };
  for (let i = 0; i < SRC_FRAMES; i++) {
    l[i] = next();
    r[i] = next();
  }
  return [l, r];
}

const SOURCES: Record<string, () => Planes> = {
  tone,
  mono,
  noise: () => noise(0x9e3779b9, 0.4),
  loud: () => noise(0x1234567, 0.9),
};

interface Kf { t: number; v: number }
interface FxDef {
  id: string;
  type: string;
  params?: Record<string, number>;
  mode?: 'lowpass' | 'highpass';
  wave?: string;
  curve?: string;
  flags?: string[];
  kf?: Record<string, Kf[]>;
}
interface VoiceDef {
  id: string;
  src: string;
  start?: number;
  in?: number;
  out?: number;
  rate?: number;
  reverse?: boolean;
  level?: number;
  pan?: number;
  levelKf?: Kf[];
  panKf?: Kf[];
  fx?: FxDef[];
}
interface SceneDef { name: string; start?: number; voices: VoiceDef[] }

const fxScene = (name: string, src: string, fx: FxDef[]): SceneDef => ({
  name, voices: [{ id: 'v', src, out: 0.5, fx }],
});

const SCENES: SceneDef[] = [
  { name: 'gain_static', voices: [{ id: 'v', src: 'tone', out: 0.5, level: -6 }] },
  { name: 'mono_upmix', voices: [{ id: 'v', src: 'mono', out: 0.5 }] },
  { name: 'pan_static_stereo', voices: [{ id: 'v', src: 'tone', out: 0.5, pan: -40 }] },
  { name: 'pan_static_mono', voices: [{ id: 'v', src: 'mono', out: 0.5, pan: 70 }] },
  { name: 'level_kf', voices: [{ id: 'v', src: 'tone', out: 0.5, levelKf: [{ t: 0, v: 0 }, { t: 0.06, v: -3 }, { t: 0.16, v: -20 }] }] },
  { name: 'pan_kf', voices: [{ id: 'v', src: 'mono', out: 0.5, panKf: [{ t: 0, v: -100 }, { t: 0.16, v: 100 }] }] },
  {
    name: 'trims_overlap',
    voices: [
      { id: 'a', src: 'tone', start: 0.02, in: 0.1, out: 0.22 },
      { id: 'b', src: 'noise', start: 0, in: 0.05, out: 0.15, level: -3 },
    ],
  },
  { name: 'rate_half', voices: [{ id: 'v', src: 'tone', out: 0.5, rate: 0.5 }] },
  { name: 'rate_1_5', voices: [{ id: 'v', src: 'mono', out: 0.5, rate: 1.5 }] },
  { name: 'reverse', voices: [{ id: 'v', src: 'tone', in: 0.1, out: 0.26, reverse: true }] },
  { name: 'export_offset', start: 0.08, voices: [{ id: 'v', src: 'tone', start: 0.02, in: 0.05, out: 0.4, level: -3 }] },
  // The bar ends inside the render: mixdownBuffer reverses the window CLIPPED
  // to the export range (backwardsOffset of win.duration), so a reversed bar
  // that outlasts the range renders a different span than the preview plays —
  // a TS divergence the C++ does not copy (it plays the bar's window, as
  // AudioEngine.startVoice does). Kept inside the range, both agree.
  { name: 'backwards_swap', voices: [{ id: 'v', src: 'tone', out: 0.16, fx: [{ id: 'bk', type: 'backwards', flags: ['swapChannels'] }] }] },
  fxScene('eq', 'noise', [{ id: 'eq', type: 'parametric-eq', params: { frequency: 1000, gain: 12, q: 2, frequency2: 5000, gain2: -10, q2: 1 } }]),
  fxScene('bass_treble', 'noise', [{ id: 'bt', type: 'bass-treble', params: { bass: 8, treble: -6 } }]),
  fxScene('lowpass', 'noise', [{ id: 'lp', type: 'high-low-pass', mode: 'lowpass', params: { cutoff: 800, q: 6 } }]),
  fxScene('highpass', 'noise', [{ id: 'hp', type: 'high-low-pass', mode: 'highpass', params: { cutoff: 2000, q: 0.707 } }]),
  fxScene('delay', 'mono', [{ id: 'dl', type: 'delay', params: { time: 0.03, feedback: 50, mix: 40 } }]),
  fxScene('reverb', 'mono', [{ id: 'rv', type: 'reverb', params: { decay: 0.1, preDelay: 10, mix: 50 } }]),
  fxScene('reverb_long', 'tone', [{ id: 'rv2', type: 'reverb', params: { decay: 1, preDelay: 0, mix: 60, diffusion: 30, brightness: 80 } }]),
  fxScene('flange', 'noise', [{ id: 'fl', type: 'flange-chorus', params: { separation: 3, depth: 50, rate: 0.4, feedback: 40, mix: 50 } }]),
  fxScene('chorus', 'tone', [{ id: 'ch', type: 'flange-chorus', params: { separation: 20, voices: 3, phase: 120, mix: 60 }, flags: ['stereoVoices'] }]),
  fxScene('tone_sine', 'mono', [{ id: 'tn', type: 'tone', params: { frequency: 440, frequency2: 660, level: -12 } }]),
  fxScene('tone_square', 'mono', [{ id: 'tq', type: 'tone', wave: 'square', params: { frequency: 300, level: -18 } }]),
  fxScene('tone_noise', 'mono', [{ id: 'tw', type: 'tone', wave: 'white-noise', params: { level: -20 } }]),
  fxScene('modulator_am', 'tone', [{ id: 'md', type: 'modulator', params: { rate: 30, depth: 50 } }]),
  fxScene('modulator_fm', 'tone', [{ id: 'mf', type: 'modulator', params: { rate: 5, depth: 0, fmDepth: 60 } }]),
  fxScene('stereo_mixer', 'tone', [{ id: 'sm', type: 'stereo-mixer', params: { leftLevel: 150, rightLevel: 50, leftPan: -20, rightPan: 60 }, flags: ['invertPhase'] }]),
  fxScene('compressor', 'loud', [{ id: 'cp', type: 'compressor', params: { threshold: -30, ratio: 6, knee: 10, attack: 5, release: 100, makeupGain: 6 } }]),
  fxScene('compressor_limit', 'loud', [{ id: 'cl', type: 'compressor', params: { threshold: -20, ratio: 3, outputLimit: -6 } }]),
  fxScene('distortion_soft', 'tone', [{ id: 'ds', type: 'distortion', params: { drive: 40 } }]),
  fxScene('distortion_tube_crush', 'tone', [{ id: 'dt', type: 'distortion', curve: 'tube', params: { drive: 60, resolution: 8 } }]),
  fxScene('distortion_fuzz_mix', 'tone', [{ id: 'dz', type: 'distortion', curve: 'fuzz', params: { drive: 30, mix: 50 } }]),
  fxScene('de_esser', 'noise', [{ id: 'de', type: 'de-esser', params: { threshold: -30, frequency: 6000, bandwidth: 3000 } }]),
  fxScene('fx_automation', 'noise', [
    { id: 'ea', type: 'parametric-eq', params: { gain: 12, q: 3 }, kf: { frequency: [{ t: 0, v: 200 }, { t: 0.16, v: 4000 }] } },
    { id: 'da', type: 'delay', params: { time: 0.02, feedback: 30 }, kf: { mix: [{ t: 0, v: 0 }, { t: 0.16, v: 100 }] } },
  ]),
  fxScene('chain_order', 'tone', [
    { id: 'c1', type: 'parametric-eq', params: { frequency: 3000, gain: 10, q: 1 } },
    { id: 'c2', type: 'compressor', params: { threshold: -24, ratio: 4 } },
    { id: 'c3', type: 'reverb', params: { decay: 0.2, mix: 30 } },
  ]),
  // A mono voice made stereo by the compressor, then panned with the STEREO law.
  { name: 'mono_chain_pan', voices: [{ id: 'v', src: 'mono', out: 0.5, pan: -60, fx: [{ id: 'mc', type: 'compressor', params: { threshold: -12 } }] }] },
];

// ── Output: sections of [u32 nameLen][name][u32 kind][payload] ─────────────

const parts: Uint8Array[] = [];
function u32(v: number): Uint8Array {
  const b = new Uint8Array(4);
  new DataView(b.buffer).setUint32(0, v, true);
  return b;
}
function section(name: string, kind: number, payload: Uint8Array): void {
  const n = new TextEncoder().encode(name);
  parts.push(u32(n.length), n, u32(kind), u32(payload.length), payload);
}
function planesPayload(planes: Float32Array[], frames: number): Uint8Array {
  const out = new Uint8Array(8 + planes.length * frames * 4);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, planes.length, true);
  dv.setUint32(4, frames, true);
  let o = 8;
  for (const p of planes) {
    for (let i = 0; i < frames; i++) { dv.setFloat32(o, p[i] ?? 0, true); o += 4; }
  }
  return out;
}

function sceneText(s: SceneDef): string {
  const lines: string[] = [`scene ${s.name} start=${s.start ?? 0} frames=${SCENE_FRAMES}`];
  const kfs = (k?: Kf[]): string => (k ?? []).map((x) => `${x.t},${x.v}`).join(';');
  for (const v of s.voices) {
    lines.push(`voice id=${v.id} src=${v.src} start=${v.start ?? 0} in=${v.in ?? 0} out=${v.out ?? 0} rate=${v.rate ?? 1}`
      + ` reverse=${v.reverse ? 1 : 0} level=${v.level ?? 0} pan=${v.pan ?? 0}`
      + ` levelkf=${kfs(v.levelKf)} pankf=${kfs(v.panKf)}`);
    for (const f of v.fx ?? []) {
      const params = Object.entries(f.params ?? {}).map(([k, x]) => `${k}:${x}`).join(',');
      const fkf = Object.entries(f.kf ?? {}).map(([k, x]) => `${k}@${kfs(x)}`).join('|');
      lines.push(`fx id=${f.id} type=${f.type} mode=${f.mode ?? '-'} wave=${f.wave ?? '-'} curve=${f.curve ?? '-'}`
        + ` flags=${(f.flags ?? []).join('|') || '-'} params=${params || '-'} kf=${fkf || '-'}`);
    }
  }
  lines.push('end');
  return lines.join('\n');
}

function b64(u: Uint8Array): string {
  let s = '';
  for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode(...u.subarray(i, i + 0x8000));
  return btoa(s);
}

export async function run(): Promise<string> {
  const g = globalThis as unknown as { __parityLayers: unknown[]; __parityBuffers: Record<string, AudioBuffer> };
  g.__parityBuffers = {};
  for (const [name, make] of Object.entries(SOURCES)) {
    const planes = make();
    const buf = new AudioBuffer({ numberOfChannels: planes.length, length: SRC_FRAMES, sampleRate: SR });
    planes.forEach((p, c) => buf.copyToChannel(p, c));
    g.__parityBuffers[name] = buf;
  }
  section('scenes', 1, new TextEncoder().encode(SCENES.map(sceneText).join('\n')));
  for (const s of SCENES) {
    const nodePrefix = `${s.name}:`;
    g.__parityLayers = s.voices.map((v) => {
      const nodeId = nodePrefix + v.id;
      for (const k of v.levelKf ?? []) defaultAnimation.setKeyframe(nodeId, 'audioLevelDb', k.t, k.v, 'linear');
      for (const k of v.panKf ?? []) defaultAnimation.setKeyframe(nodeId, 'audioPan', k.t, k.v, 'linear');
      for (const f of v.fx ?? []) {
        for (const [key, list] of Object.entries(f.kf ?? {})) {
          for (const k of list) defaultAnimation.setKeyframe(nodeId, `audiofx.${f.id}.${key}`, k.t, k.v, 'linear');
        }
      }
      return {
        id: nodeId,
        nodeId,
        assetId: v.src,
        src: v.src,
        levelDb: v.level ?? 0,
        levelAnimated: (v.levelKf ?? []).length > 0,
        ...(v.pan ? { pan: v.pan } : {}),
        ...((v.panKf ?? []).length > 0 ? { panAnimated: true } : {}),
        effects: v.fx?.map((f) => ({
          id: f.id, type: f.type, params: f.params ?? {},
          ...(f.mode ? { mode: f.mode } : {}), ...(f.wave ? { wave: f.wave } : {}),
          ...(f.curve ? { curve: f.curve } : {}), ...(f.flags ? { flags: f.flags } : {}),
        })),
        startSec: v.start ?? 0,
        inSec: v.in ?? 0,
        outSec: v.out ?? 0,
        playbackRate: v.rate ?? 1,
        retimeReverse: v.reverse === true,
        muted: false,
      };
    });
    const start = s.start ?? 0;
    const rendered = await mixdownBuffer(start, start + SCENE_FRAMES / SR);
    if (!rendered) throw new Error(`scene ${s.name} rendered nothing`);
    const planes = [rendered.getChannelData(0), rendered.getChannelData(1)];
    section(`out:${s.name}`, 2, planesPayload(planes, SCENE_FRAMES));
  }
  // Bit-exact ports: distortion curves (every shape, crushed and not).
  for (const c of ['soft-clip', 'hard-clip', 'saturation-1', 'saturation-2', 'tube', 'fuzz']) {
    section(`curve:${c}:60:16`, 2, planesPayload([distortionCurve(c as never, 60, 16)], 2048));
    section(`curve:${c}:35:5`, 2, planesPayload([distortionCurve(c as never, 35, 5)], 2048));
  }
  let total = 0;
  for (const p of parts) total += p.length;
  const all = new Uint8Array(4 + total);
  all.set(new TextEncoder().encode('PAP1'), 0);
  let o = 4;
  for (const p of parts) { all.set(p, o); o += p.length; }
  return b64(all);
}
