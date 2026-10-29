/**
 * Subject styles — looks for ONE subject of a footage layer (the approved
 * Subjects Pro design, board 2). A style is a stack of ordinary effects, each
 * reading that subject alone (Compositing Options ▸ subjectId), so every part
 * of it stays editable in Effect Controls and toggles / deletes on its own.
 * Applying a preset is one undo entry.
 */

import type { Command, PropertyInit } from '@motion/engine-api';
import { edit } from '@core/engine/uiEdits';
import { values } from '@core/engine/propRefs';
import { t } from '@core/i18n';

type Scope = 'subject' | 'background';

/** One effect of a style: its type, its settings, and whether it Applies To the subject or its background. */
interface StylePart {
  effect: string;
  params: PropertyInit[];
  scope?: Scope;
}

export interface SubjectStylePreset {
  id: string;
  label: () => string;
  /** What it does, one line (the tile's tooltip). */
  hint: () => string;
  /** Which shelf it sits on. */
  kind: 'outline' | 'glow' | 'background' | 'look';
  parts: StylePart[];
}

const hex = (h: string): ReturnType<typeof values.color> => {
  const n = Number.parseInt(h.replace('#', ''), 16);
  return values.color(((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255);
};

const stroke = (color: string, width: number, more: PropertyInit[] = []): StylePart => ({
  effect: 'matte-stroke',
  params: [{ path: 'color', value: hex(color) }, { path: 'width', value: values.scalar(width) }, ...more],
});
const look = (params: PropertyInit[]): StylePart => ({ effect: 'selective-color-ai', params });

export const SUBJECT_STYLES: readonly SubjectStylePreset[] = [
  { id: 'sticker', kind: 'outline', label: () => t('subjects.style.sticker', 'Sticker Pop'), hint: () => t('subjects.style.stickerHint', 'Thick white edge with a soft glow, the background dimmed'),
    parts: [
      stroke('#ffffff', 10, [{ path: 'glowAmount', value: values.scalar(45) }, { path: 'glowRadius', value: values.scalar(22) }]),
      look([{ path: 'applyTo', value: values.choice('Outside Matte') }, { path: 'saturation', value: values.scalar(-35) }, { path: 'lightness', value: values.scalar(-30) }, { path: 'matteFeather', value: values.scalar(6) }]),
    ] },
  { id: 'neon', kind: 'glow', label: () => t('subjects.style.neon', 'Neon Trace'), hint: () => t('subjects.style.neonHint', 'A thin glowing line round the subject on a darkened picture'),
    parts: [
      stroke('#39f5ff', 4, [{ path: 'softness', value: values.scalar(1) }, { path: 'glowAmount', value: values.scalar(90) }, { path: 'glowRadius', value: values.scalar(30) }]),
      look([{ path: 'applyTo', value: values.choice('Outside Matte') }, { path: 'lightness', value: values.scalar(-55) }, { path: 'matteFeather', value: values.scalar(4) }]),
    ] },
  { id: 'spotlight', kind: 'background', label: () => t('subjects.style.spotlight', 'Spotlight'), hint: () => t('subjects.style.spotlightHint', 'Everything but the subject falls into shadow'),
    parts: [look([{ path: 'applyTo', value: values.choice('Outside Matte') }, { path: 'lightness', value: values.scalar(-60) }, { path: 'matteFeather', value: values.scalar(24) }])] },
  { id: 'splash', kind: 'look', label: () => t('subjects.style.splash', 'Colour Splash'), hint: () => t('subjects.style.splashHint', 'The subject keeps its colour, the rest turns grey'),
    parts: [look([{ path: 'applyTo', value: values.choice('Outside Matte') }, { path: 'saturation', value: values.scalar(-100) }, { path: 'lightness', value: values.scalar(-15) }, { path: 'matteFeather', value: values.scalar(4) }])] },
  { id: 'duotone', kind: 'look', label: () => t('subjects.style.duotone', 'Duotone'), hint: () => t('subjects.style.duotoneHint', 'Subject in yellow, background in deep violet'),
    parts: [
      look([{ path: 'applyTo', value: values.choice('Outside Matte') }, { path: 'colorize', value: values.bool(true) }, { path: 'colorizeColor', value: hex('#3a2a8c') }, { path: 'colorizeAmount', value: values.scalar(100) }]),
      look([{ path: 'applyTo', value: values.choice('Inside Matte') }, { path: 'colorize', value: values.bool(true) }, { path: 'colorizeColor', value: hex('#ffcf3f') }, { path: 'colorizeAmount', value: values.scalar(70) }]),
    ] },
  { id: 'comic', kind: 'outline', label: () => t('subjects.style.comic', 'Comic Ink'), hint: () => t('subjects.style.comicHint', 'A heavy black ink line'),
    parts: [stroke('#111111', 8)] },
  { id: 'halo', kind: 'glow', label: () => t('subjects.style.halo', 'Soft Halo'), hint: () => t('subjects.style.haloHint', 'A wide pale glow behind the subject'),
    parts: [stroke('#bfe3ff', 2, [{ path: 'softness', value: values.scalar(6) }, { path: 'glowAmount', value: values.scalar(80) }, { path: 'glowRadius', value: values.scalar(40) }])] },
  { id: 'dashes', kind: 'outline', label: () => t('subjects.style.dashes', 'Marching Dashes'), hint: () => t('subjects.style.dashesHint', 'A dashed white line, like a selection'),
    parts: [stroke('#ffffff', 4, [{ path: 'dashed', value: values.bool(true) }])] },
  { id: 'portrait', kind: 'background', label: () => t('subjects.style.portrait', 'Portrait Blur'), hint: () => t('subjects.style.portraitHint', 'The background blurred, the subject sharp'),
    parts: [{ effect: 'gaussian-blur', params: [{ path: 'blurriness', value: values.scalar(24) }], scope: 'background' }] },
  { id: 'warm', kind: 'look', label: () => t('subjects.style.warm', 'Warm Subject'), hint: () => t('subjects.style.warmHint', 'A warm tint on the subject only'),
    parts: [look([{ path: 'applyTo', value: values.choice('Inside Matte') }, { path: 'colorize', value: values.bool(true) }, { path: 'colorizeColor', value: hex('#ff9a3c') }, { path: 'colorizeAmount', value: values.scalar(35) }])] },
];

let seq = 0;

/** The commands that add `preset` for `subject` of `layer` (`subject` null: every subject of the layer). */
export function subjectStyleCommands(layer: string, subject: string | null, preset: SubjectStylePreset): Command[] {
  const out: Command[] = [];
  for (const part of preset.parts) {
    const id = `fx_style_${Date.now().toString(36)}_${(seq++).toString(36)}`;
    out.push({ type: 'addEffect', layers: [layer], effect: part.effect, params: part.params, id });
    if (part.scope) out.push({ type: 'setProperty', prop: { layer, path: `effects/${id}/compositing/subject` }, value: values.string(part.scope) });
    if (subject) out.push({ type: 'setProperty', prop: { layer, path: `effects/${id}/compositing/subjectId` }, value: values.string(subject) });
  }
  return out;
}

/** Add a style for one subject, one undo entry. */
export async function applySubjectStyle(layer: string, subject: string | null, preset: SubjectStylePreset): Promise<boolean> {
  return (await edit(t('subjects.style.apply', 'Style: {name}', { name: preset.label() }), subjectStyleCommands(layer, subject, preset))).ok;
}
