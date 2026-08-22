/**
 * The contract every effect ported from Canvas2D to the GPU must satisfy.
 *
 * ── Why a contract and not a test per effect ────────────────────────────────
 *
 * 112 effects are queued to move onto the GPU. A port is four coordinated edits
 * in four files, and three of the four failure modes are SILENT — the effect
 * still renders, just wrongly, on some layers and not others. Writing that
 * knowledge down once, as an assertion applied to every ported effect, is the
 * difference between a repeatable procedure and 112 chances to get it subtly
 * wrong.
 *
 * The four properties, and what breaking each one looks like:
 *
 *   1. It no longer FORCES a bake (`isGpuUnbakeableEffect` false). Miss this
 *      and the port buys nothing: every layer carrying the effect still drags
 *      the whole chain through a CPU rasterization, which was the entire
 *      reason to port it.
 *
 *   2. It KEEPS its Canvas2D implementation (`hasCanvas2dImplementation`). A
 *      layer baked for some other reason — fill opacity, a mask-scoped effect,
 *      any CPU-only effect beside it — runs its whole chain through the bake.
 *      Drop the CPU pass and the effect vanishes on exactly those layers, which
 *      is the hardest kind of bug to attribute because the effect works fine
 *      everywhere else.
 *
 *   3. It is emitted to the GPU on an UNBAKED layer. Otherwise the port is
 *      inert and the effect silently does nothing — the shape
 *      `pluginEffectsCanRender` and the extrusion scrub both had.
 *
 *   4. It is NOT emitted on a BAKED layer. The bake has already drawn it; hand
 *      it to the GPU as well and it applies TWICE. This is the one that reads
 *      as "the effect is too strong on some layers" rather than as a bug, and
 *      it is why `extractSpatialEffects(layer, true)` carries only `gpuOnly`
 *      effects — a ported effect must not be marked `gpuOnly`.
 */

import { isGpuUnbakeableEffect } from './effectBake';
import { hasCanvas2dImplementation } from './canvas2dEffects';
import { effectDefFor } from './effects';
import { extractSpatialEffects } from '@core/rendering/snapshotToFrameScene';
import type { Effect } from './effects';
import type { RenderLayer } from '@core/rendering/RenderBackend';

/**
 * Effects that have BOTH a GPU shader and a retained Canvas2D pass.
 *
 * Grows by one line per port. `apply-color-lut` and the Fill/Stroke/Sharpen/
 * Noise group are the precedents this contract was read off; `beam` is the
 * first of the 112-effect CPU population to follow them.
 */
const PORTED: ReadonlyArray<{ type: string; params: Record<string, unknown> }> = [
  { type: 'fill', params: { color: '#ff0000', opacity: 100 } },
  { type: 'stroke', params: { color: '#ff0000', width: 3 } },
  { type: 'sharpen', params: { amount: 50 } },
  { type: 'noise', params: { amount: 20, evolution: 0, monochrome: false } },
  {
    type: 'beam',
    params: { length: 100, startX: 10, startY: 50, endX: 90, endY: 50, thickness: 8, softness: 30, color: '#8fd0ff' },
  },
  {
    type: 'light-sweep',
    params: { position: 50, sweepWidth: 120, angle: 35, color: '#ffffff', intensity: 70, softness: 60, composite: 4 },
  },
  {
    type: 'lens-flare',
    params: { centerX: 48, centerY: -28, brightness: 70, scale: 1, color: '#ffd9a0' },
  },
  {
    type: 'light-rays',
    params: {
      centerX: 0, centerY: 0, rayCount: 48, rayLength: 180, spread: 100, rotation: 15,
      color: '#fff3c4', opacity: 70, falloff: 40, seed: 1, composite: 1,
    },
  },
  // ── Round six: the per-pixel colour ports ──
  {
    type: 'vignette',
    params: { amount: 55, size: 55, feather: 60, roundness: 0, centerX: 0, centerY: 0 },
  },
  {
    type: 'black-and-white',
    params: { reds: 40, yellows: 60, greens: 40, cyans: 60, blues: 20, magentas: 80, tint: false, tintColor: '#d8b48a' },
  },
  {
    type: 'tritone',
    params: { highlights: '#ffffff', midtones: '#808080', shadows: '#000000', blend: 0 },
  },
  {
    type: 'photo-filter',
    params: { color: '#ec8a00', density: 25, preserveLuminosity: true },
  },
  { type: 'threshold', params: { level: 128 } },
  { type: "mirror", params: {"centerX":0,"centerY":0,"angle":45} },
  { type: "offset", params: {"shiftX":30,"shiftY":10,"blend":0} },
  { type: "bulge", params: {"centerX":0,"centerY":0,"radius":80,"height":50} },
  { type: "twirl", params: {"centerX":0,"centerY":0,"radius":80,"angle":90} },
  { type: "spherize", params: {"centerX":0,"centerY":0,"radius":80,"amount":60} },
  { type: "kaleidoscope", params: {"segments":6,"centerX":0,"centerY":0,"rotation":0,"sourceAngle":0,"zoom":100} },
  { type: "ripple", params: {"centerX":0,"centerY":0,"radius":100,"amplitude":10,"frequency":3,"phase":0,"decay":1} },
  { type: "chromatic-aberration", params: {"amount":6,"aberrationMode":0,"angle":0,"falloff":50,"centerX":0,"centerY":0} },
  { type: "magnify", params: {"centerX":0,"centerY":0,"magnification":150,"radius":80,"shape":0,"feather":10} },
  { type: "mosaic", params: {"horizontalBlocks":20,"verticalBlocks":15,"sharpColors":false} },
  { type: "find-edges", params: {"invert":true,"blendWithOriginal":0} },
  { type: "emboss", params: {"angle":45,"relief":2,"contrast":100,"blend":0} },
  { type: "color-emboss", params: {"direction":45,"relief":2,"contrast":100,"blendWithOriginal":0} },
  { type: "halftone", params: {"cellSize":8,"screenAngle":45,"contrast":100,"inkColor":"#000000","paperColor":"#ffffff","colorize":false,"blendWithOriginal":0} },
  { type: 'vibrance', params: { vibrance: 30, saturation: 0 } },
];

const layerWith = (effects: Effect[]): RenderLayer =>
  ({ id: 'L', kind: 'shape', x: 0, y: 0, width: 100, height: 100, opacity: 1, effects } as unknown as RenderLayer);

describe('ported effects: GPU shader + retained Canvas2D reference', () => {
  it.each(PORTED)('$type is registered', ({ type }) => {
    expect(effectDefFor(type)).toBeDefined();
  });

  it.each(PORTED)('$type no longer forces a CPU bake', ({ type }) => {
    expect(isGpuUnbakeableEffect(type)).toBe(false);
  });

  it.each(PORTED)('$type keeps a Canvas2D pass, for layers baked anyway', ({ type }) => {
    expect(hasCanvas2dImplementation(type)).toBe(true);
  });

  it.each(PORTED)('$type reaches the GPU on an unbaked layer', ({ type, params }) => {
    const out = extractSpatialEffects(layerWith([{ id: 'fx', type, params } as unknown as Effect]));
    expect(out?.map((e) => e.type)).toContain(type);
  });

  it.each(PORTED)('$type does NOT reach the GPU on a baked layer (no double-apply)', ({ type, params }) => {
    // `true` = the baked-layer call: only gpuOnly effects survive it, because
    // the bake has already drawn everything else into the texture.
    const out = extractSpatialEffects(layerWith([{ id: 'fx', type, params } as unknown as Effect]), true);
    expect(out?.map((e) => e.type) ?? []).not.toContain(type);
  });

  it.each(PORTED)('$type is not marked gpuOnly, which is what the no-double-apply rule rests on', ({ type }) => {
    // A `gpuOnly` effect is passed through the baked-layer filter by design
    // (Displace/Motion Tile have no CPU form at all). Marking a PORTED effect
    // gpuOnly would therefore reintroduce the double-apply the test above
    // rules out — and it would still satisfy every other assertion here, which
    // is why this is asserted separately rather than trusted to follow.
    expect(effectDefFor(type)?.gpuOnly ?? false).toBe(false);
  });
});
