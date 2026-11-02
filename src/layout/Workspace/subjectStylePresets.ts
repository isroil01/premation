/**
 * The subject style presets (the approved Subjects Pro design, board 2) and
 * what each is made of. Every preset is a stack of ORDINARY effects from the
 * engine's catalogue (native/engine/catalog/effects.json), each reading one
 * subject alone through Compositing Options ▸ subjectId — nothing here is a
 * new effect, so every part stays editable in Effect Controls.
 *
 * A preset is parameterised: an `intensity` (0…100, the tile's slider) and,
 * where a colour means something, a `color` (the tile's swatch). `parts`
 * turns the two into the effect settings; the stored defaults are the look
 * the preset was designed with, so the slider at its default reproduces it.
 *
 * Keyed presets (Draw-on Outline) also set keyframes on their effect: the
 * reveal starts at the playhead the style is applied at.
 *
 * A preset that shows a picture (Background Image) also takes a project image
 * and how it fits: it cannot be applied until one is chosen.
 */

import { secondsToFlicks, type Keyframe, type PropertyInit } from '@motion/engine-api';
import { values } from '@core/engine/propRefs';
import { t } from '@core/i18n';

export type StyleScope = 'subject' | 'background';

/** What the user set on the tile. */
export interface StyleParams {
  /** 0…100. */
  intensity: number;
  /** Hex colour (`#rrggbb`), used by presets that declare a `color`. */
  color: string;
  /** The project image (item id), used by presets that declare `image`. */
  image?: string;
  /** How that image fits the layer's box. */
  fit?: ImageFit;
}

export type ImageFit = 'fill' | 'fit' | 'stretch';

/** Image Fill's Fit choices (native/engine/catalog/effects.json), by the value a style stores. */
const IMAGE_FIT_CHOICE: Record<ImageFit, string> = { fill: 'Fill Frame', fit: 'Fit Inside', stretch: 'Stretch' };

export const IMAGE_FITS: ReadonlyArray<{ id: ImageFit; label: () => string }> = [
  { id: 'fill', label: () => t('subjects.style.fitFill', 'Fill frame') },
  { id: 'fit', label: () => t('subjects.style.fitInside', 'Fit inside') },
  { id: 'stretch', label: () => t('subjects.style.fitStretch', 'Stretch') },
];

export function isImageFit(v: unknown): v is ImageFit {
  return typeof v === 'string' && v in IMAGE_FIT_CHOICE;
}

/** Where and when a style is applied: frames at `fps`, the playhead at `time` (comp seconds). */
export interface StyleContext {
  fps: number;
  time: number;
}

/** Keys a part sets on one of its own properties (path relative to the effect). */
export interface StylePartKeys {
  path: string;
  keys: Keyframe[];
}

/** One effect of a style: its type, its settings, and whether it Applies To the subject or its background. */
export interface StylePart {
  effect: string;
  params: PropertyInit[];
  scope?: StyleScope;
  keys?: StylePartKeys[];
}

export type StyleKind = 'outline' | 'glow' | 'shadow' | 'background' | 'look' | 'motion';

export interface SubjectStylePreset {
  id: string;
  label: () => string;
  /** What it does, one line (the tile's tooltip). */
  hint: () => string;
  /** Which shelf it sits on. */
  kind: StyleKind;
  /** The slider's default; absent = the preset has no intensity. */
  intensity?: number;
  /** The swatch's default; absent = no colour to pick. */
  color?: string;
  /** Shows a project image: the tile picks one (and its fit), and nothing applies without it. */
  image?: boolean;
  parts: (p: StyleParams, ctx: StyleContext) => StylePart[];
}

/** The params a preset starts with. */
export function defaultParams(preset: SubjectStylePreset): StyleParams {
  return { intensity: preset.intensity ?? 50, color: preset.color ?? '#ffffff' };
}

export const hex = (h: string): ReturnType<typeof values.color> => {
  const n = Number.parseInt(h.replace('#', '').slice(0, 6).padEnd(6, '0'), 16);
  return values.color(((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255);
};

/** `color` mixed towards white by `amount` (0…1): the outer ring of a gradient outline. */
export function lighten(color: string, amount: number): string {
  const n = Number.parseInt(color.replace('#', '').slice(0, 6).padEnd(6, '0'), 16);
  const ch = (v: number): string => Math.round(v + (255 - v) * amount).toString(16).padStart(2, '0');
  return `#${ch((n >> 16) & 255)}${ch((n >> 8) & 255)}${ch(n & 255)}`;
}

const clamp = (v: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, v));
/** Intensity as a factor of the designed look: 50 → 1, 100 → 2, 0 → 0. */
const k = (p: StyleParams): number => p.intensity / 50;

const stroke = (color: string, width: number, more: PropertyInit[] = []): StylePart => ({
  effect: 'matte-stroke',
  params: [{ path: 'color', value: hex(color) }, { path: 'width', value: values.scalar(width) }, ...more],
});
const look = (params: PropertyInit[]): StylePart => ({ effect: 'selective-color-ai', params });
const outside = { path: 'applyTo', value: values.choice('Outside Matte') };
const inside = { path: 'applyTo', value: values.choice('Inside Matte') };

function key(time: number, value: number): Keyframe {
  return {
    id: '',
    time: secondsToFlicks(time),
    value: { kind: 'scalar', value },
    easing: 'linear',
    continuous: false,
    roving: false,
    spatialInterp: 'legacy',
    spatialIn: [],
    spatialOut: [],
    label: 0,
    dims: [],
  };
}

/** Draw-on Outline: how long the reveal takes, seconds. */
export const DRAW_ON_SECONDS = 2;
/** A dash long enough to cover any subject's perimeter at once; the gap equally long, so one dash draws on. */
const DRAW_ON_DASH = 6000;

export const SUBJECT_STYLES: readonly SubjectStylePreset[] = [
  { id: 'sticker', kind: 'outline', intensity: 50, color: '#ffffff',
    label: () => t('subjects.style.sticker', 'Sticker Pop'), hint: () => t('subjects.style.stickerHint', 'Thick white edge with a soft glow, the background dimmed'),
    parts: (p) => [
      stroke(p.color, 10 * k(p), [{ path: 'glowAmount', value: values.scalar(45 * k(p)) }, { path: 'glowRadius', value: values.scalar(22) }]),
      look([outside, { path: 'saturation', value: values.scalar(-35) }, { path: 'lightness', value: values.scalar(-30) }, { path: 'matteFeather', value: values.scalar(6) }]),
    ] },
  { id: 'neon', kind: 'glow', intensity: 50, color: '#39f5ff',
    label: () => t('subjects.style.neon', 'Neon Trace'), hint: () => t('subjects.style.neonHint', 'A thin glowing line round the subject on a darkened picture'),
    parts: (p) => [
      stroke(p.color, 4 * k(p), [{ path: 'softness', value: values.scalar(1) }, { path: 'glowAmount', value: values.scalar(90 * k(p)) }, { path: 'glowRadius', value: values.scalar(30) }]),
      look([outside, { path: 'lightness', value: values.scalar(-55) }, { path: 'matteFeather', value: values.scalar(4) }]),
    ] },
  { id: 'spotlight', kind: 'background', intensity: 60,
    label: () => t('subjects.style.spotlight', 'Spotlight'), hint: () => t('subjects.style.spotlightHint', 'Everything but the subject falls into shadow'),
    parts: (p) => [look([outside, { path: 'lightness', value: values.scalar(-clamp(p.intensity, 0, 100)) }, { path: 'matteFeather', value: values.scalar(24) }])] },
  { id: 'splash', kind: 'look', intensity: 100,
    label: () => t('subjects.style.splash', 'Colour Splash'), hint: () => t('subjects.style.splashHint', 'The subject keeps its colour, the rest turns grey'),
    parts: (p) => [look([outside, { path: 'saturation', value: values.scalar(-clamp(p.intensity, 0, 100)) }, { path: 'lightness', value: values.scalar(-15) }, { path: 'matteFeather', value: values.scalar(4) }])] },
  { id: 'duotone', kind: 'look', intensity: 50, color: '#ffcf3f',
    label: () => t('subjects.style.duotone', 'Duotone'), hint: () => t('subjects.style.duotoneHint', 'Subject in yellow, background in deep violet'),
    parts: (p) => [
      look([outside, { path: 'colorize', value: values.bool(true) }, { path: 'colorizeColor', value: hex('#3a2a8c') }, { path: 'colorizeAmount', value: values.scalar(100) }]),
      look([inside, { path: 'colorize', value: values.bool(true) }, { path: 'colorizeColor', value: hex(p.color) }, { path: 'colorizeAmount', value: values.scalar(clamp(70 * k(p), 0, 100)) }]),
    ] },
  { id: 'comic', kind: 'outline', intensity: 50, color: '#111111',
    label: () => t('subjects.style.comic', 'Comic Ink'), hint: () => t('subjects.style.comicHint', 'A heavy black ink line'),
    parts: (p) => [stroke(p.color, 8 * k(p))] },
  { id: 'halo', kind: 'glow', intensity: 50, color: '#bfe3ff',
    label: () => t('subjects.style.halo', 'Soft Halo'), hint: () => t('subjects.style.haloHint', 'A wide pale glow behind the subject'),
    parts: (p) => [stroke(p.color, 2, [{ path: 'softness', value: values.scalar(6) }, { path: 'glowAmount', value: values.scalar(80 * k(p)) }, { path: 'glowRadius', value: values.scalar(40 * k(p)) }])] },
  { id: 'dashes', kind: 'outline', intensity: 50, color: '#ffffff',
    label: () => t('subjects.style.dashes', 'Marching Dashes'), hint: () => t('subjects.style.dashesHint', 'A dashed white line, like a selection'),
    parts: (p) => [stroke(p.color, 4 * k(p), [{ path: 'dashed', value: values.bool(true) }])] },
  { id: 'portrait', kind: 'background', intensity: 50,
    label: () => t('subjects.style.portrait', 'Portrait Blur'), hint: () => t('subjects.style.portraitHint', 'The background blurred, the subject sharp'),
    parts: (p) => [{ effect: 'gaussian-blur', params: [{ path: 'blurriness', value: values.scalar(24 * k(p)) }], scope: 'background' }] },
  { id: 'warm', kind: 'look', intensity: 50, color: '#ff9a3c',
    label: () => t('subjects.style.warm', 'Warm Subject'), hint: () => t('subjects.style.warmHint', 'A warm tint on the subject only'),
    parts: (p) => [look([inside, { path: 'colorize', value: values.bool(true) }, { path: 'colorizeColor', value: hex(p.color) }, { path: 'colorizeAmount', value: values.scalar(clamp(35 * k(p), 0, 100)) }])] },

  // ── New in Subjects Pro ──────────────────────────────────────────────────
  { id: 'dropShadow', kind: 'shadow', intensity: 50, color: '#000000',
    label: () => t('subjects.style.dropShadow', 'Drop Shadow'), hint: () => t('subjects.style.dropShadowHint', 'A soft shadow cast by the subject onto the picture'),
    parts: (p) => [{ effect: 'drop-shadow', scope: 'subject', params: [
      { path: 'distance', value: values.scalar(4 + 0.24 * p.intensity) },
      { path: 'angle', value: values.scalar(135) },
      { path: 'softness', value: values.scalar(4 + 0.3 * p.intensity) },
      { path: 'color', value: hex(p.color) },
      { path: 'opacity', value: values.scalar(clamp(35 + 0.4 * p.intensity, 0, 100)) },
    ] }] },
  { id: 'longShadow', kind: 'shadow', intensity: 50, color: '#000000',
    label: () => t('subjects.style.longShadow', 'Long Shadow'), hint: () => t('subjects.style.longShadowHint', 'A flat shadow streaking away from the subject'),
    parts: (p) => [{ effect: 'long-shadow', scope: 'subject', params: [
      { path: 'angle', value: values.scalar(45) },
      { path: 'length', value: values.scalar(6 * p.intensity) },
      { path: 'color', value: hex(p.color) },
      { path: 'shadowOpacity', value: values.scalar(60) },
      { path: 'fade', value: values.scalar(100) },
    ] }] },
  { id: 'echo', kind: 'motion', intensity: 50,
    label: () => t('subjects.style.echo', 'Echo Trail'), hint: () => t('subjects.style.echoHint', 'Ghosts of the subject trail its movement'),
    parts: (p) => [{ effect: 'echo', scope: 'subject', params: [
      { path: 'echoTime', value: values.scalar(-0.05) },
      { path: 'numEchoes', value: values.scalar(clamp(Math.round(p.intensity / 8), 1, 64)) },
      { path: 'startIntensity', value: values.scalar(80) },
      { path: 'decay', value: values.scalar(70) },
      { path: 'echoOperator', value: values.choice('Composite In Back') },
    ] }] },
  { id: 'gradientOutline', kind: 'outline', intensity: 50, color: '#ff3fd4',
    label: () => t('subjects.style.gradientOutline', 'Gradient Outline'), hint: () => t('subjects.style.gradientOutlineHint', 'Two rings: the colour inside, fading to a paler band outside'),
    parts: (p) => [
      stroke(lighten(p.color, 0.6), 9 * k(p), [{ path: 'softness', value: values.scalar(3 * k(p)) }, { path: 'opacity', value: values.scalar(80) }]),
      stroke(p.color, 3 * k(p)),
    ] },
  { id: 'drawOn', kind: 'motion', intensity: 50, color: '#ffffff',
    label: () => t('subjects.style.drawOn', 'Draw-on Outline'), hint: () => t('subjects.style.drawOnHint', 'The outline draws itself round the subject over two seconds from the playhead'),
    parts: (p, ctx) => [{
      ...stroke(p.color, 4 * k(p), [
        { path: 'dashed', value: values.bool(true) },
        { path: 'dashLength', value: values.scalar(DRAW_ON_DASH) },
        { path: 'gapLength', value: values.scalar(DRAW_ON_DASH) },
        { path: 'dashOffset', value: values.scalar(DRAW_ON_DASH) },
      ]),
      keys: [{ path: 'dashOffset', keys: [key(ctx.time, DRAW_ON_DASH), key(ctx.time + DRAW_ON_SECONDS, 0)] }],
    }] },
  { id: 'rgbSplit', kind: 'look', intensity: 50,
    label: () => t('subjects.style.rgbSplit', 'RGB Split'), hint: () => t('subjects.style.rgbSplitHint', 'Red and blue pulled apart inside the subject only'),
    parts: (p) => [{ effect: 'chromatic-aberration', scope: 'subject', params: [
      { path: 'amount', value: values.scalar(clamp(0.24 * p.intensity, 0, 60)) },
      { path: 'aberrationMode', value: values.scalar(0) },
      { path: 'angle', value: values.scalar(0) },
      { path: 'falloff', value: values.scalar(0) },
    ] }] },
  { id: 'bgColor', kind: 'background', intensity: 100, color: '#101418',
    label: () => t('subjects.style.bgColor', 'Background Colour'), hint: () => t('subjects.style.bgColorHint', 'The picture behind the subject replaced by a flat colour'),
    parts: (p) => [{ effect: 'fill', scope: 'background', params: [{ path: 'color', value: hex(p.color) }, { path: 'opacity', value: values.scalar(clamp(p.intensity, 0, 100)) }] }] },
  { id: 'bgImage', kind: 'background', intensity: 100, image: true,
    label: () => t('subjects.style.bgImage', 'Background Image'), hint: () => t('subjects.style.bgImageHint', 'The picture behind the subject replaced by a project image'),
    parts: (p) => [{ effect: 'image-fill', scope: 'background', params: [
      { path: 'image', value: values.string(p.image ?? '') },
      { path: 'fit', value: values.choice(IMAGE_FIT_CHOICE[p.fit ?? 'fill']) },
      { path: 'opacity', value: values.scalar(clamp(p.intensity, 0, 100)) },
    ] }] },
  { id: 'paper', kind: 'outline', intensity: 50, color: '#ffffff',
    label: () => t('subjects.style.paper', 'Cut-out Paper'), hint: () => t('subjects.style.paperHint', 'A paper border with a small offset shadow, as if cut out and glued on'),
    parts: (p) => [
      { effect: 'drop-shadow', scope: 'subject', params: [
        { path: 'distance', value: values.scalar(10) }, { path: 'angle', value: values.scalar(135) }, { path: 'softness', value: values.scalar(6) },
        { path: 'color', value: hex('#000000') }, { path: 'opacity', value: values.scalar(45) },
      ] },
      stroke(p.color, 12 * k(p)),
    ] },
];

export function presetById(id: string): SubjectStylePreset | undefined {
  return SUBJECT_STYLES.find((p) => p.id === id);
}
