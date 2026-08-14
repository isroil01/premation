/**
 * Built-in effect presets — production starter looks that apply like a paste.
 *
 * These live in memory (not localStorage) so every install gets the same
 * starter set. User-saved presets still append via `listEffectPresets`.
 */

import type { CopiedEffect, EffectPreset } from './effectClipboard';
import type { Effect, EffectType } from './effects';

let seq = 0;
function fx(type: EffectType, params: Record<string, number | string | boolean>): Effect {
  return { id: `builtin_${type}_${(seq += 1)}`, type, enabled: true, params };
}

function stack(...effects: Effect[]): CopiedEffect[] {
  return effects.map((effect) => ({ effect, tracks: {} }));
}

/** Twenty AE-style starter looks. Names are stable — do not rename lightly. */
export const BUILTIN_EFFECT_PRESETS: ReadonlyArray<EffectPreset> = [
  { name: 'Soft Glow', items: stack(fx('glow', { radius: 24, color: '#ffffff', intensity: 55 })) },
  { name: 'Neon Edge', items: stack(fx('glow', { radius: 12, color: '#39ff14', intensity: 90 }), fx('find-edges', { invert: true, blendWithOriginal: 35 })) },
  { name: 'Cinematic Grade', items: stack(fx('lumetri', { exposure: -0.15, contrast: 12, vibrance: 8 }), fx('vignette', { amount: 35 })) },
  { name: 'Warm Sunset', items: stack(fx('photo-filter', { density: 40, color: '#ec8a00' }), fx('tint', { amount: 20, mapWhite: '#ffe0b0' })) },
  { name: 'Cold Steel', items: stack(fx('hue-saturation', { hue: -12, saturation: -15 }), fx('contrast', { amount: 115 })) },
  { name: 'Noir', items: stack(fx('black-and-white', { reds: 40, yellows: 60, greens: 40 }), fx('contrast', { amount: 125 }), fx('add-grain', { intensity: 12 })) },
  { name: 'Film Grain', items: stack(fx('add-grain', { intensity: 28 }), fx('vignette', { amount: 20 })) },
  { name: 'Dream Soft', items: stack(fx('gaussian-blur', { blurriness: 6 }), fx('glow', { radius: 30, color: '#ffe8c8', intensity: 40 })) },
  { name: 'Pop Poster', items: stack(fx('posterize', { levels: 6 }), fx('saturate', { amount: 140 })) },
  { name: 'Ink Outline', items: stack(fx('find-edges', { invert: true, blendWithOriginal: 0 }), fx('threshold', { level: 45 })) },
  { name: 'Drop Card', items: stack(fx('drop-shadow', { distance: 10, angle: 135, softness: 18, color: '#000000', opacity: 55 })) },
  { name: 'Beveled Badge', items: stack(fx('bevel', { depth: 40, size: 4 }), fx('inner-shadow', { distance: 3, softness: 4, opacity: 40 })) },
  { name: 'Motion Streak', items: stack(fx('directional-blur', { length: 24, direction: 0 })) },
  { name: 'Zoom Burst', items: stack(fx('radial-blur', { amount: 35, blurType: 1 })) },
  { name: 'RGB Split', items: stack(fx('shift-channels', { takeRedFrom: 1, takeGreenFrom: 2, takeBlueFrom: 3, takeAlphaFrom: 0 })) },
  { name: 'Matte Cleanup', items: stack(fx('simple-choker', { chokeAmount: 1.5 }), fx('minimax', { radius: 1, operation: 0, channel: 0 })) },
  { name: 'Wipe In', items: stack(fx('linear-wipe', { completion: 50, wipeAngle: 0 })) },
  { name: 'Venetian Reveal', items: stack(fx('venetian-blinds', { completion: 40, direction: 0, width: 28 })) },
  { name: 'Light Sweep', items: stack(fx('light-sweep', { sweepWidth: 200, intensity: 70, angle: 35, position: 50 })) },
  { name: 'Unsharp Punch', items: stack(fx('unsharp-mask', { amount: 80, radius: 1.5, threshold: 2 })) },
];

export function listBuiltinEffectPresets(): EffectPreset[] {
  return BUILTIN_EFFECT_PRESETS.map((p) => ({
    name: p.name,
    items: p.items.map((item) => ({
      effect: { ...item.effect, id: `fx_preset_${item.effect.type}_${(seq += 1)}` },
      tracks: {},
    })),
  }));
}
