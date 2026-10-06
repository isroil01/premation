/**
 * Effect METADATA for the editor UI, read from the engine's catalog
 * (`@motion/engine-api` → packages/engine-api/src/generated/catalog.ts, the
 * same native/engine/catalog/*.json the C++ engine embeds) instead of the
 * TypeScript engine's `EFFECT_DEFS` (src/core/effects/effects.ts, which is
 * being deleted — docs/TS_ENGINE_REMOVAL.md).
 *
 * Thin functions in the shapes the panels were written against, so a call
 * site changes its import line and nothing else: `effectDefFor`, `paramsOf`,
 * `effectPropPath`, the colour-channel helpers … The names are the ones the
 * TS engine exported; `EffectDef` / `EffectParamDef` are aliases of the catalog
 * types.
 *
 * Pure: no engine instance, no store, no DOM. The `Effect` record here is the
 * document's effect instance as the mirror (src/core/mirror/effects.ts) and
 * the clipboard carry it — the TS engine's `Effect` is assignable to it.
 */

import {
  EFFECT_CATALOG,
  catalogEffect,
  type CatalogEffect,
  type CatalogEffectParam,
  type CatalogJson,
} from '@motion/engine-api';
import { pluginEffectDefFor } from './pluginEffectDefs';

// ── Types ────────────────────────────────────────────────────────────

/** An effect type id (`'gaussian-blur'`). The catalog is the list of known ones. */
export type EffectType = string;

/** Curve control points: `[inputX, outputY]` pairs in 0–255. */
export type CurvePoints = ReadonlyArray<readonly [number, number]>;
/**
 * `readonly number[]` is for params RESOLVED AT SNAPSHOT TIME rather than
 * authored (Audio Spectrum's band magnitudes). Not something a user types.
 */
export type EffectParamValue = number | string | boolean | CurvePoints | readonly number[];
export type EffectParams = Readonly<Record<string, EffectParamValue>>;

/** One effect parameter's definition — the catalog's entry. */
export type EffectParamDef = CatalogEffectParam;
/** One effect's definition — the catalog's entry (label, params, gpuOnly, newInstanceParams). */
export type EffectDef = CatalogEffect;

/** The document's effect instance, as the panels read it. */
export interface Effect {
  id: string;
  type: EffectType;
  /**
   * Every parameter, keyed by `EffectParamDef.key`. Optional because stored
   * data may predate it; read it through `paramsOf` / `effectParam`, which fill
   * in the declared defaults and migrate the legacy `amount`.
   */
  params?: EffectParams;
  /** When false the effect stays in the stack but contributes nothing. */
  enabled?: boolean;
  /**
   * AE Compositing Options → Effect Opacity, 0..100 percent. ABSENT means
   * "never touched" (100). Keyframeable under `effect.<id>.fx.opacity`.
   */
  opacity?: number;
  /** AE-style label colour on this instance (hex); absent = default chrome. */
  labelColor?: string;
  /** Scope this effect to one of the layer's mask paths. */
  maskId?: string;
  /** @deprecated The pre-multi-param single scalar; still read, never written. */
  amount?: number;
}

// ── The catalog ──────────────────────────────────────────────────────

/** Every built-in effect, in menu order. */
export const EFFECT_DEFS: ReadonlyArray<EffectDef> = EFFECT_CATALOG;

/**
 * The definition of an effect type: a built-in from the catalog, else a loaded
 * native plugin's (pluginEffectDefs.ts); undefined for an unknown one (a
 * missing plugin — the card then says so and the engine passes it through).
 */
export function effectDefFor(type: EffectType): EffectDef | undefined {
  return catalogEffect(type) ?? pluginEffectDefFor(type);
}

/** Effects that render only as a shader pass (no CSS-filter equivalent). */
export const GPU_ONLY_EFFECTS: ReadonlySet<EffectType> = new Set(
  EFFECT_CATALOG.filter((d) => d.gpuOnly).map((d) => d.type),
);

export function isGpuOnlyEffect(type: EffectType): boolean {
  return GPU_ONLY_EFFECTS.has(type);
}

/**
 * TEMPORAL effects: they change WHEN a layer is sampled, not what its pixels
 * look like (Echo, Posterize Time, Wide Time, Force Motion Blur). The catalog
 * does not mark these, so the list is explicit here — the same four the TS
 * engine's `isTemporalEffect` names.
 */
const TEMPORAL: ReadonlySet<string> = new Set(['echo', 'posterize-time', 'wide-time', 'force-motion-blur']);

export function isTemporalEffect(type: string): boolean {
  return TEMPORAL.has(type);
}

/**
 * TIME-DEPENDENT effects: their drawn output depends on the clock, received
 * through the named param. Not in the catalog either; explicit, matching the
 * TS engine's `TIME_DEPENDENT`.
 */
const TIME_DEPENDENT: ReadonlyMap<string, string> = new Map<string, string>([
  ['timecode', 'time'],
  ['strobe-light', 'time'],
  ['particle-systems', 'time'],
]);

export function isTimeDependentEffect(type: string): boolean {
  return TIME_DEPENDENT.has(type);
}

/** The param a time-dependent effect receives the clock through, if any. */
export function timeParamFor(type: string): string | undefined {
  return TIME_DEPENDENT.get(type);
}

// ── Params ───────────────────────────────────────────────────────────

/** A catalog default as a param value (the catalog stores numbers, strings, booleans and point arrays). */
function paramValueOf(v: CatalogJson | undefined): EffectParamValue | undefined {
  if (v === undefined || v === null) return undefined;
  if (typeof v === 'number' || typeof v === 'string' || typeof v === 'boolean') return v;
  if (Array.isArray(v)) return v as unknown as EffectParamValue;
  return undefined;
}

/** An effect's params filled in from its definition's defaults. */
export function defaultParams(def: EffectDef): EffectParams {
  const out: Record<string, EffectParamValue> = {};
  for (const p of def.params) {
    const v = paramValueOf(p.default);
    if (v !== undefined) out[p.key] = v;
  }
  return out;
}

/** The params a NEW instance is created with — defaults, then `newInstanceParams`. */
export function newInstanceParamsOf(def: EffectDef): EffectParams {
  const out: Record<string, EffectParamValue> = { ...defaultParams(def) };
  for (const [k, raw] of Object.entries(def.newInstanceParams ?? {})) {
    const v = paramValueOf(raw);
    if (v !== undefined) out[k] = v;
  }
  return out;
}

/** The parameter legacy `amount` and legacy keyframe tracks (`effect.<id>`) refer to. */
export function primaryParamKey(type: EffectType): string | undefined {
  return catalogEffect(type)?.params.find((p) => p.type === 'number')?.key;
}

/**
 * An effect's full parameter set: declared defaults ← legacy `amount` ← stored
 * params. Everything that reads params goes through here, so a legacy effect
 * resolves correctly wherever it entered.
 */
export function paramsOf(effect: Effect): EffectParams {
  const def = catalogEffect(effect.type);
  if (!def) return effect.params ?? {};
  const out: Record<string, EffectParamValue> = { ...defaultParams(def) };
  if (typeof effect.amount === 'number') {
    const key = def.params.find((p) => p.type === 'number')?.key;
    if (key) out[key] = effect.amount;
  }
  return { ...out, ...(effect.params ?? {}) };
}

/** Read one of an effect's parameters, falling back to its declared default. */
export function effectParam(effect: Effect, key: string): EffectParamValue {
  return paramsOf(effect)[key] ?? 0;
}

export function effectNumber(effect: Effect, key: string): number {
  const v = effectParam(effect, key);
  return typeof v === 'number' ? v : 0;
}

/**
 * The same effects with every LENGTH parameter (declared `unit: 'px'`)
 * multiplied by `k` — for a bake whose canvas is the layer's box × a raster
 * scale. A `resolved` px param is geometry and scales element-wise.
 */
export function scaleEffectLengths(
  effects: ReadonlyArray<Effect> | undefined,
  k: number,
): ReadonlyArray<Effect> | undefined {
  if (!effects || effects.length === 0 || k === 1 || !(k > 0)) return effects;
  return effects.map((e) => {
    const def = catalogEffect(e.type);
    if (!def) return e;
    const lengths = def.params.filter((p) => (p.type === 'number' || p.type === 'resolved') && p.unit === 'px');
    if (lengths.length === 0) return e;
    const params: Record<string, EffectParamValue> = { ...paramsOf(e) };
    for (const p of lengths) {
      const v = params[p.key];
      if (typeof v === 'number') params[p.key] = v * k;
      else if (p.type === 'resolved' && Array.isArray(v)) {
        params[p.key] = (v as readonly unknown[]).map((x) => (typeof x === 'number' ? x * k : x)) as number[];
      }
    }
    return { ...e, params };
  });
}

// ── Animation paths ──────────────────────────────────────────────────

/**
 * Animation prop-path for a keyframeable effect parameter (`effect.fx_3.radius`).
 * Omitting `paramKey` yields the LEGACY single-scalar path (`effect.fx_3`),
 * which drives the effect's primary parameter.
 */
export function effectPropPath(effectId: string, paramKey?: string): string {
  return paramKey === undefined ? `effect.${effectId}` : `effect.${effectId}.${paramKey}`;
}

/**
 * The reserved param key for AE's Compositing Options → Effect Opacity. It
 * carries a DOT on purpose: no declared param key can collide with it.
 */
export const EFFECT_OPACITY_KEY = 'fx.opacity';

/** The animation path for an effect's Compositing Options opacity. */
export function effectOpacityPath(effectId: string): string {
  return effectPropPath(effectId, EFFECT_OPACITY_KEY);
}

/** This effect's Compositing Options opacity as a 0..1 blend factor; absent reads as 1. */
export function effectOpacityOf(e: Effect): number {
  const pct = e.opacity;
  if (typeof pct !== 'number' || !Number.isFinite(pct)) return 1;
  return Math.max(0, Math.min(1, pct / 100));
}

/** Does this effect need the blend-against-input composite at all? PRESENCE of the field, not `< 100`. */
export function effectHasOpacity(e: Effect): boolean {
  return typeof e.opacity === 'number' && Number.isFinite(e.opacity);
}

// ── Names ────────────────────────────────────────────────────────────

/**
 * AE Effect Controls names: "Gaussian Blur", "Gaussian Blur 2" for the second
 * of a kind, numbered in stack order (the first keeps its plain name).
 */
export function effectDisplayNames(effects: ReadonlyArray<Effect>): Map<string, string> {
  const seen = new Map<string, number>();
  const out = new Map<string, string>();
  for (const e of effects) {
    const label = catalogEffect(e.type)?.label ?? e.type;
    const n = (seen.get(e.type) ?? 0) + 1;
    seen.set(e.type, n);
    out.set(e.id, n === 1 ? label : `${label} ${n}`);
  }
  return out;
}

// ── Colour channels ──────────────────────────────────────────────────

/**
 * Hex → [r, g, b, a], each 0..1 — the channel convention the `_r/_g/_b/_a`
 * keyframe tracks store (the same scale as `Color.fromHex`).
 */
export function parseColorChannels(hex: string): [number, number, number, number] {
  let h = hex.trim().replace(/^#/, '');
  if (h.length === 3) h = h.split('').map((c) => c + c).join('');
  if (h.length === 6) h += 'ff';
  if (h.length !== 8 || /[^0-9a-fA-F]/.test(h)) return [1, 1, 1, 1];
  const n = Number.parseInt(h, 16);
  return [((n >>> 24) & 0xff) / 255, ((n >>> 16) & 0xff) / 255, ((n >>> 8) & 0xff) / 255, (n & 0xff) / 255];
}

/** [r,g,b,a] each 0..1 → #rrggbb / #rrggbbaa. The exact inverse of {@link parseColorChannels}. */
export function channelsToColor(r: number, g: number, b: number, a: number): string {
  const c = (v: number): string =>
    Math.round(Math.max(0, Math.min(1, v)) * 255).toString(16).padStart(2, '0');
  const base = `#${c(r)}${c(g)}${c(b)}`;
  return a >= 1 ? base : `${base}${c(a)}`;
}

/**
 * Recompose a colour from its `_r/_g/_b/_a` channel tracks over the STORED
 * colour — a channel with no track keeps the authored channel, never a constant.
 */
export function resolveChannelColor(
  storedHex: string,
  sample: (suffix: '_r' | '_g' | '_b' | '_a') => number | undefined,
): string {
  const base = parseColorChannels(storedHex);
  return channelsToColor(
    sample('_r') ?? base[0],
    sample('_g') ?? base[1],
    sample('_b') ?? base[2],
    sample('_a') ?? base[3],
  );
}

/** `#rrggbb` + 0..1 alpha → `rgba(r,g,b,a)`; anything already functional passes through. */
export function withAlpha(hex: string, alpha: number): string {
  const a = Math.max(0, Math.min(1, alpha));
  const m = /^#([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return hex;
  const n = parseInt(m[1]!, 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
}

// ── CSS-filter previews ──────────────────────────────────────────────

const num = (p: EffectParams, k: string, fb = 0): number => {
  const v = p[k];
  return typeof v === 'number' && Number.isFinite(v) ? v : fb;
};
const str = (p: EffectParams, k: string, fb: string): string => {
  const v = p[k];
  return typeof v === 'string' ? v : fb;
};
const pct = (p: EffectParams, fb: number): number => num(p, 'amount', fb) / 100;

/**
 * The CSS `filter` grammar of the effects that have one — the small family a
 * Canvas2D `ctx.filter` can draw for a synchronous preview thumbnail. The
 * catalog carries no CSS builder (that was the TS engine's `EffectDef.css`),
 * so the ones that existed are kept here. Everything else is `''`: no cheap
 * preview, the panel shows the icon and category instead.
 */
const PREVIEW_FILTER: Readonly<Record<string, (p: EffectParams) => string>> = {
  blur: (p) => `blur(${num(p, 'amount', 6)}px)`,
  brightness: (p) => `brightness(${pct(p, 130)})`,
  contrast: (p) => `contrast(${pct(p, 130)})`,
  saturate: (p) => `saturate(${pct(p, 160)})`,
  grayscale: (p) => `grayscale(${pct(p, 100)})`,
  sepia: (p) => `sepia(${pct(p, 80)})`,
  'hue-rotate': (p) => `hue-rotate(${num(p, 'amount', 90)}deg)`,
  invert: (p) => `invert(${pct(p, 100)})`,
  glow: (p) => {
    // CSS cannot dilate; remap radius so Spread still hardens the halo.
    const s = Math.max(0, Math.min(100, num(p, 'spread', 0))) / 100;
    const r = Math.max(0, num(p, 'radius', 16) * (1 - s));
    return `drop-shadow(0 0 ${r}px ${withAlpha(str(p, 'color', '#78b4ff'), num(p, 'intensity', 90) / 100)})`;
  },
  'drop-shadow': (p) => {
    const d = num(p, 'distance', 6);
    const rad = (num(p, 'angle', 135) * Math.PI) / 180;
    const dx = (Math.cos(rad) * d).toFixed(1);
    const dy = (Math.sin(rad) * d).toFixed(1);
    const color = withAlpha(str(p, 'color', '#000000'), num(p, 'opacity', 55) / 100);
    // CSS drop-shadow has no Spread; harden by shrinking the blur radius.
    const s = Math.max(0, Math.min(100, num(p, 'spread', 0))) / 100;
    const soft = Math.max(0, num(p, 'softness', 12) * (1 - s));
    return `drop-shadow(${dx}px ${dy}px ${soft}px ${color})`;
  },
  'hue-saturation': (p) => {
    const parts: string[] = [];
    const hue = num(p, 'hue', 0);
    if (hue) parts.push(`hue-rotate(${hue}deg)`);
    // −100..+100 → CSS saturate 0..2 and brightness 0..2.
    parts.push(`saturate(${(100 + num(p, 'saturation', 0)) / 100})`);
    parts.push(`brightness(${(100 + num(p, 'lightness', 0)) / 100})`);
    return parts.join(' ');
  },
};

/** The CSS `filter` string previewing `type` at `params`, or `''` when the effect has no CSS form. */
export function effectPreviewFilter(type: EffectType, params: EffectParams): string {
  return PREVIEW_FILTER[type]?.(params) ?? '';
}
