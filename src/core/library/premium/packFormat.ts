/**
 * Premium library pack format, v1 — the contract between the private content
 * repo that authors premium items, the backend that stores and gates them, and
 * the editor that inserts them.
 *
 * Premium payloads are DATA, never code: the editor is open source, so a
 * premium item cannot ship as a builder function in this repo. Every payload
 * kind is interpreted by a generic, open-source path that also exists for free
 * content (a fragment paste, a Lottie import, an audio import, a keyframe
 * recipe), so a premium item behaves exactly like the built-in ones once it
 * lands.
 *
 * Pure: no React, no stores, no engine. Validators return a reason string
 * rather than throwing, so a malformed item from the server is skipped with a
 * warning instead of taking the panel down.
 */

import type { FragmentLayer } from '@/engine-client/fragmentBuilder';
import type { TemplateField } from '@core/template/templateTypes';
import type { LottieJson } from '@core/lottie/lottieImport';

export const PACK_FORMAT_VERSION = 1;

export type PremiumKind = 'template' | 'lottie' | 'sfx' | 'transition';
export type PremiumTier = 'free' | 'cloud';

/** What every viewer may see about an item — the catalog row. */
export interface PremiumMeta {
  /** `pro.<kind>.<slug>`; free server items use `free.<kind>.<slug>`. */
  id: string;
  kind: PremiumKind;
  name: string;
  category: string;
  tags: string[];
  tier: PremiumTier;
  /** Monotonic per id; the payload cache is keyed by it. */
  version: number;
  durationSec: number;
  /** Templates and Lottie: `'16:9'`, `'9:16'`, `'1:1'`, … */
  aspect?: string;
  width?: number;
  height?: number;
  /** Templates: how many fields the buyer can edit. */
  fieldCount?: number;
  /** Templates: those fields' labels, for the preview sheet ("Title, Subtitle, Accent color"). */
  fieldLabels?: string[];
  /** Templates: a whole scene in a new composition, or an element dropped into the current one. */
  mode?: TemplateMode;
  /** Sound FX: 64 normalised max-abs buckets of the sound, for the card's waveform. */
  peaks?: number[];
  description: string;
}

/** A catalog row as the backend serves it: meta plus public preview media (relative URLs). */
export interface PremiumCatalogItem extends PremiumMeta {
  poster?: string;
  preview?: string;
  audio?: string;
}

// ── Payloads ──────────────────────────────────────────────────────

export type TemplateMode = 'scene' | 'element';

/** A file the template brings with it (soundtrack, texture). Imported in the apply gesture. */
export interface TemplateAsset {
  /**
   * Placeholder the layers carry in `assetId` / `__assetId` (and `src` /
   * `__src`). Replaced by the imported item's real asset id and url before the
   * paste, because asset ids are minted by the engine on import and cannot be
   * known when the pack is authored.
   */
  ref: string;
  name: string;
  mime: string;
  /** Base64 bytes. Packs keep assets small; the backend caps the whole payload. */
  data: string;
}

export interface TemplatePayload {
  v: 1;
  mode: TemplateMode;
  settings: { width: number; height: number; fps: number; durationSeconds: number; background: string };
  /** `FragmentBuilder.build().layers` — plain JSON; the client re-encodes it. */
  layers: FragmentLayer[];
  /** Field targets name scratch row ids from `layers`; remapped to minted ids on paste. */
  fields: TemplateField[];
  assets: TemplateAsset[];
}

export interface LottiePayload {
  v: 1;
  doc: LottieJson;
}

/** The transform props a layer transition may drive. */
export type SpecProp = 'x' | 'y' | 'scaleX' | 'scaleY' | 'rotation' | 'opacity';

/**
 * A value relative to the layer it lands on, so one authored move fits any
 * layer anywhere in any comp:
 *   `pose`  — the layer's own resting value for this prop (opacity: 100)
 *   `offL/offR/offU/offD` — the displacement that puts the layer fully off
 *             that edge of the frame (x for L/R, y for U/D)
 *   `const` — an absolute value
 * Result = base × mul + add (mul defaults to 1, add to 0).
 */
export interface SpecValue {
  base: 'pose' | 'offL' | 'offR' | 'offU' | 'offD' | 'const';
  mul?: number;
  add?: number;
}

export type SpecEase = 'linear' | 'easeIn' | 'easeOut' | 'easeInOut' | 'hold' | [number, number, number, number];

export interface SpecKf<P extends string = SpecProp> {
  prop: P;
  /** Fraction of the transition's duration, 0..1. */
  t: number;
  value: SpecValue;
  /** Ease of the segment that STARTS at this key. */
  ease?: SpecEase;
}

/** An effect parameter animated alongside the move (directional blur, chromatic split…). */
export interface SpecFxTrack {
  /** Registry effect type (`EFFECT_DEFS`). Reused when the layer already has one. */
  type: string;
  param: string;
  /** Extra params set when the effect is added (angle, quality…). */
  init?: Record<string, number | string | boolean>;
  enter: Array<{ t: number; value: number; ease?: SpecEase }>;
  exit: Array<{ t: number; value: number; ease?: SpecEase }>;
}

export interface TransitionPayload {
  v: 1;
  duration: number;
  motionBlur: boolean;
  /** Entrance keys. Every prop must end on `pose` (opacity on 100). */
  enter: SpecKf[];
  /** Exit keys. Opacity must end on 0; other props end where they like (the interpreter restores them invisibly). */
  exit: SpecKf[];
  fx: SpecFxTrack[];
}

export type PremiumPayload =
  | { kind: 'template'; payload: TemplatePayload }
  | { kind: 'lottie'; payload: LottiePayload }
  | { kind: 'sfx'; payload: Uint8Array }
  | { kind: 'transition'; payload: TransitionPayload };

// ── Validation (server data is untrusted) ─────────────────────────

const ID_RE = /^(pro|free)\.(template|lottie|sfx|transition)\.[a-z0-9][a-z0-9-]*$/;
const KINDS: ReadonlySet<string> = new Set(['template', 'lottie', 'sfx', 'transition']);
const SPEC_PROPS: ReadonlySet<string> = new Set(['x', 'y', 'scaleX', 'scaleY', 'rotation', 'opacity']);
const SPEC_BASES: ReadonlySet<string> = new Set(['pose', 'offL', 'offR', 'offU', 'offD', 'const']);
const NAMED_EASES: ReadonlySet<string> = new Set(['linear', 'easeIn', 'easeOut', 'easeInOut', 'hold']);

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const str = (v: unknown, max = 200): v is string => typeof v === 'string' && v.length > 0 && v.length <= max;

/** Null when `v` is a usable catalog row, else why not. */
export function catalogItemProblem(v: unknown): string | null {
  if (!isObj(v)) return 'not an object';
  if (!str(v.id) || !ID_RE.test(v.id)) return `bad id ${String(v.id)}`;
  if (!str(v.kind) || !KINDS.has(v.kind)) return `bad kind ${String(v.kind)}`;
  if (v.id.split('.')[1] !== v.kind) return `id ${v.id} does not match kind ${v.kind}`;
  if (!str(v.name, 80)) return 'missing name';
  if (!str(v.category, 40)) return 'missing category';
  if (v.tier !== 'free' && v.tier !== 'cloud') return 'bad tier';
  if (!finite(v.version) || v.version < 1) return 'bad version';
  if (!finite(v.durationSec) || v.durationSec <= 0 || v.durationSec > 600) return 'bad duration';
  if (!Array.isArray(v.tags) || !v.tags.every((t) => typeof t === 'string')) return 'bad tags';
  if (v.peaks !== undefined && (!Array.isArray(v.peaks) || !v.peaks.every((p) => finite(p) && p >= 0 && p <= 1))) return 'bad peaks';
  if (v.mode !== undefined && v.mode !== 'scene' && v.mode !== 'element') return 'bad mode';
  if (v.fieldLabels !== undefined && (!Array.isArray(v.fieldLabels) || !v.fieldLabels.every((l) => str(l, 60)))) return 'bad fieldLabels';
  // Absent media may come as null (motion-back did that until the Library launch).
  for (const k of ['poster', 'preview', 'audio'] as const) {
    if (v[k] !== undefined && v[k] !== null && !str(v[k], 400)) return `bad ${k}`;
  }
  return null;
}

function easeProblem(e: unknown): string | null {
  if (e === undefined) return null;
  if (typeof e === 'string') return NAMED_EASES.has(e) ? null : `bad ease ${e}`;
  if (Array.isArray(e) && e.length === 4 && e.every(finite)) {
    const [x1, , x2] = e as number[];
    if (x1! >= 0 && x1! <= 1 && x2! >= 0 && x2! <= 1) return null;
  }
  return 'bad bezier ease';
}

function keysProblem(keys: unknown, label: string): string | null {
  if (!Array.isArray(keys)) return `${label} is not a list`;
  for (const k of keys) {
    if (!isObj(k)) return `${label}: key is not an object`;
    if (!finite(k.t) || k.t < 0 || k.t > 1) return `${label}: key time ${String(k.t)} outside 0..1`;
    const e = easeProblem(k.ease);
    if (e) return `${label}: ${e}`;
  }
  return null;
}

/** Null when `v` is a transition payload the interpreter can run, else why not. */
export function transitionPayloadProblem(v: unknown): string | null {
  if (!isObj(v) || v.v !== 1) return 'not a v1 transition';
  if (!finite(v.duration) || v.duration <= 0 || v.duration > 10) return 'bad duration';
  if (typeof v.motionBlur !== 'boolean') return 'bad motionBlur';
  for (const side of ['enter', 'exit'] as const) {
    const keys = v[side];
    const p = keysProblem(keys, side);
    if (p) return p;
    for (const k of keys as Array<Record<string, unknown>>) {
      if (!str(k.prop) || !SPEC_PROPS.has(k.prop)) return `${side}: bad prop ${String(k.prop)}`;
      const val = k.value;
      if (!isObj(val) || !str(val.base) || !SPEC_BASES.has(val.base)) return `${side}: bad value`;
      if (val.mul !== undefined && !finite(val.mul)) return `${side}: bad mul`;
      if (val.add !== undefined && !finite(val.add)) return `${side}: bad add`;
    }
  }
  if (!Array.isArray(v.fx)) return 'fx is not a list';
  for (const fx of v.fx) {
    if (!isObj(fx) || !str(fx.type, 60) || !str(fx.param, 60)) return 'bad fx track';
    for (const side of ['enter', 'exit'] as const) {
      const p = keysProblem(fx[side], `fx ${fx.type}.${side}`);
      if (p) return p;
      if (!(fx[side] as Array<Record<string, unknown>>).every((k) => finite(k.value))) return `fx ${fx.type}.${side}: bad value`;
    }
  }
  return null;
}

/** Null when `v` is a template payload the apply path can paste, else why not. */
export function templatePayloadProblem(v: unknown): string | null {
  if (!isObj(v) || v.v !== 1) return 'not a v1 template';
  if (v.mode !== 'scene' && v.mode !== 'element') return 'bad mode';
  const s = v.settings;
  if (!isObj(s) || !finite(s.width) || !finite(s.height) || !finite(s.fps) || !finite(s.durationSeconds) || typeof s.background !== 'string') return 'bad settings';
  if (s.width < 16 || s.height < 16 || s.width > 8192 || s.height > 8192) return 'bad size';
  if (!Array.isArray(v.layers) || v.layers.length === 0) return 'no layers';
  for (const l of v.layers) {
    if (!isObj(l) || !isObj(l.row) || !str(l.row.id)) return 'bad layer row';
  }
  const ids = new Set((v.layers as Array<{ row: { id: string } }>).map((l) => l.row.id));
  if (!Array.isArray(v.fields)) return 'fields is not a list';
  for (const f of v.fields) {
    if (!isObj(f) || !str(f.id) || !isObj(f.target) || !str(f.target.nodeId)) return 'bad field';
    if (!ids.has(f.target.nodeId)) return `field ${f.id} targets missing layer ${f.target.nodeId}`;
    if (f.alsoTargets !== undefined) {
      if (!Array.isArray(f.alsoTargets)) return `field ${f.id}: bad alsoTargets`;
      for (const tg of f.alsoTargets) {
        if (!isObj(tg) || !str(tg.nodeId) || !ids.has(tg.nodeId)) return `field ${f.id}: alsoTargets names a missing layer`;
      }
    }
  }
  if (!Array.isArray(v.assets)) return 'assets is not a list';
  for (const a of v.assets) {
    if (!isObj(a) || !str(a.ref) || !str(a.name) || !str(a.mime) || typeof a.data !== 'string') return 'bad asset';
  }
  return null;
}

/** Null when `v` is a Lottie payload, else why not. Deep checks are the importer's job. */
export function lottiePayloadProblem(v: unknown): string | null {
  if (!isObj(v) || v.v !== 1) return 'not a v1 lottie payload';
  const d = v.doc;
  if (!isObj(d) || !Array.isArray(d.layers) || !finite(d.w) || !finite(d.h) || !finite(d.fr)) return 'bad lottie doc';
  return null;
}

/** Null when `bytes` start like a RIFF/WAVE file. */
export function wavProblem(bytes: Uint8Array): string | null {
  if (bytes.length < 44) return 'too short for a WAV';
  const tag = (o: number): string => String.fromCharCode(bytes[o]!, bytes[o + 1]!, bytes[o + 2]!, bytes[o + 3]!);
  return tag(0) === 'RIFF' && tag(8) === 'WAVE' ? null : 'not a RIFF/WAVE file';
}

/** Parse downloaded payload bytes for `kind`; throws with a readable reason on bad data. */
export function parsePayload(kind: PremiumKind, bytes: Uint8Array): PremiumPayload {
  if (kind === 'sfx') {
    const p = wavProblem(bytes);
    if (p) throw new Error(p);
    return { kind, payload: bytes };
  }
  let json: unknown;
  try {
    json = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw new Error('payload is not JSON');
  }
  const problem =
    kind === 'template' ? templatePayloadProblem(json)
      : kind === 'lottie' ? lottiePayloadProblem(json)
        : transitionPayloadProblem(json);
  if (problem) throw new Error(problem);
  return { kind, payload: json } as PremiumPayload;
}
