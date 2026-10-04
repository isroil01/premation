/**
 * Pan.
 *
 * Two claims, and the second is the one that could silently break an export.
 *
 * 1. A centred layer builds NO panner. Pan is new; every project that predates
 *    it must keep exactly the audio graph it had, and "exactly" means no extra
 *    node in the chain, not "a node set to 0".
 * 2. The live engine and the offline mixdown ask the SAME question about
 *    whether a panner exists. A voice that pans in the preview and renders
 *    centred would pass every visual check and only surface on headphones,
 *    which is the failure `voicePanner` is shared to prevent.
 */

import {
  voicePanner, panToNorm,   MIN_PAN, MAX_PAN,
} from './audioParams';

/** A context stub that records how many panners were asked for. */
function fakeCtx(): BaseAudioContext & { made: number } {
  const ctx = {
    made: 0,
    createStereoPanner(): StereoPannerNode {
      ctx.made += 1;
      return { pan: { value: 0 } } as unknown as StereoPannerNode;
    },
  };
  return ctx as unknown as BaseAudioContext & { made: number };
}

describe('voicePanner — the graph only grows when it has to', () => {
  it('builds nothing for a centred, unanimated voice', () => {
    const ctx = fakeCtx();
    expect(voicePanner(ctx, {})).toBeNull();
    expect(voicePanner(ctx, { pan: 0 })).toBeNull();
    expect(ctx.made).toBe(0);
  });

  it('builds one as soon as the voice is off centre', () => {
    const ctx = fakeCtx();
    const p = voicePanner(ctx, { pan: -40 });
    expect(p).not.toBeNull();
    expect(p!.pan.value).toBeCloseTo(-0.4, 5);
    expect(ctx.made).toBe(1);
  });

  /** An animated pan can pass through 0 — the panner has to exist anyway, or
   *  the ramp would have nothing to be scheduled on. */
  it('builds one for an animated pan even when it currently reads centre', () => {
    const ctx = fakeCtx();
    expect(voicePanner(ctx, { pan: 0, panAnimated: true })).not.toBeNull();
  });

  /** Older engines have no StereoPannerNode. A missing panner is better than a
   *  thrown constructor taking the whole voice — and its layer — down. */
  it('degrades to no panner rather than throwing when the context lacks one', () => {
    const bare = {} as unknown as BaseAudioContext;
    expect(() => voicePanner(bare, { pan: 80 })).not.toThrow();
    expect(voicePanner(bare, { pan: 80 })).toBeNull();
  });
});

describe('panToNorm', () => {
  it('maps the document percent onto the node’s −1…1', () => {
    expect(panToNorm(0)).toBe(0);
    expect(panToNorm(MIN_PAN)).toBe(-1);
    expect(panToNorm(MAX_PAN)).toBe(1);
    expect(panToNorm(50)).toBeCloseTo(0.5, 6);
  });

  it('clamps rather than letting a bad document drive the node out of range', () => {
    expect(panToNorm(500)).toBe(1);
    expect(panToNorm(-500)).toBe(-1);
    expect(panToNorm(Number.NaN)).toBe(0);
  });
});
