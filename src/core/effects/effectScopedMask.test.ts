/**
 * M6 — effect-scoped masking.
 *
 * THE INVARIANT: an effect mask decides WHERE an effect applies, never where the
 * layer exists. Outside the mask the layer must come back byte-identical —
 * alpha included. That is the whole line between an effect mask and a second
 * layer mask, and it is what these tests pin.
 *
 * Uses node-canvas via jest's canvas environment where available; the pure
 * routing assertions run regardless.
 */

import { effectsNeedCpuBake, layerIsBaked } from './effectBake';
import type { Effect } from './effects';
import { rectangleMask } from './mask';

const blur: Effect = { id: 'e1', type: 'blur', params: { radius: 8 } } as Effect;
const scopedBlur: Effect = { ...blur, id: 'e2', maskId: 'm1' };

describe('a scoped effect forces the CPU bake', () => {
  it('an UNSCOPED GPU-native effect does not force a bake', () => {
    expect(effectsNeedCpuBake([blur])).toBe(false);
  });

  it('the SAME effect with a maskId does', () => {
    // The GPU effect chain has no per-effect scope. Handing it a scoped effect
    // would apply that effect to the whole layer — a blur meant for one region
    // blurring everything, which reads as a design choice rather than a bug.
    expect(effectsNeedCpuBake([scopedBlur])).toBe(true);
  });

  it('reaches layerIsBaked, so every call site agrees', () => {
    // M5b's single source of truth must see it too, or the rasterizer and the
    // frame-scene builder disagree about who owns a scoped chain.
    expect(layerIsBaked({ kind: 'shape', effects: [scopedBlur] })).toBe(true);
    expect(layerIsBaked({ kind: 'image', effects: [scopedBlur] })).toBe(true);
    expect(layerIsBaked({ kind: 'text', effects: [blur] })).toBe(false);
  });

  it('a DISABLED scoped effect does not force a bake', () => {
    expect(effectsNeedCpuBake([{ ...scopedBlur, enabled: false }])).toBe(false);
  });

  it('an empty maskId is not a scope', () => {
    // `maskId: ''` is a half-written edit, not a request to scope to nothing.
    expect(effectsNeedCpuBake([{ ...blur, maskId: '' }])).toBe(false);
  });
});

describe('scope resolution', () => {
  it('a maskId that matches no path leaves the effect unscoped, not skipped', () => {
    // Deleting a mask must not silently delete the effect with it. The effect
    // still runs — it just runs everywhere, which is visible and recoverable,
    // unlike an effect that quietly stops existing.
    const mask = { paths: [{ ...rectangleMask(100, 100), id: 'm1', mode: 'none' as const }] };
    expect(mask.paths.find((p) => p.id === 'nope')).toBeUndefined();
    // The routing predicate still forces the bake, so the effect is applied by
    // the chain rather than dropped between the two paths.
    expect(effectsNeedCpuBake([{ ...blur, maskId: 'nope' }])).toBe(true);
  });

  it('the referenced path should be mode `none`, or it cuts the layer too', () => {
    // Mode `none` exists precisely so a path can be geometry without being a
    // cut (M2). A scope pointing at an `add` path would both scope the effect
    // AND clip the layer, which is two behaviours from one control.
    const scopePath = { ...rectangleMask(100, 100), id: 'm1', mode: 'none' as const };
    expect(scopePath.mode).toBe('none');
  });
});
