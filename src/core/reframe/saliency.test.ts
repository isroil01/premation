/**
 * Does it look where a person would look?
 *
 * Tested against synthetic frames rather than footage, because the claims are
 * simple enough to state exactly: a moving thing beats a static thing, a
 * detailed thing beats a flat thing, a bright corner does not beat the middle,
 * and a frame with nothing in it says so instead of inventing a subject.
 */

import { analyseFrame, attentionCentre, lumaFromRgba, saliencyMap } from './saliency';

const W = 32;
const H = 32;

/** A frame of `fill`, with an optional bright rectangle painted into it. */
function frame(fill: number, rect?: { x: number; y: number; w: number; h: number; value: number }): Uint8ClampedArray {
  const px = new Uint8ClampedArray(W * H * 4);
  for (let i = 0; i < W * H; i++) {
    px[i * 4] = fill;
    px[i * 4 + 1] = fill;
    px[i * 4 + 2] = fill;
    px[i * 4 + 3] = 255;
  }
  if (rect) {
    for (let y = rect.y; y < rect.y + rect.h; y++) {
      for (let x = rect.x; x < rect.x + rect.w; x++) {
        const i = (y * W + x) * 4;
        px[i] = rect.value;
        px[i + 1] = rect.value;
        px[i + 2] = rect.value;
      }
    }
  }
  return px;
}

describe('lumaFromRgba', () => {
  it('is Rec.601, matching the tracker', () => {
    const px = new Uint8ClampedArray([255, 0, 0, 255]);
    expect(lumaFromRgba(px, 1, 1)[0]).toBeCloseTo(0.299 * 255, 4);
  });
});

describe('attentionCentre', () => {
  it('finds the middle of a single bright blob', () => {
    const map = new Float32Array(W * H);
    for (let y = 14; y < 18; y++) for (let x = 22; x < 26; x++) map[y * W + x] = 1;
    const point = attentionCentre(map, W, H);
    expect(point.x).toBeCloseTo(23.5 / 31, 2);
    expect(point.y).toBeCloseTo(15.5 / 31, 2);
  });

  it('reports no confidence for an empty map, and sits centre', () => {
    const point = attentionCentre(new Float32Array(W * H), W, H);
    expect(point).toEqual({ x: 0.5, y: 0.5, confidence: 0 });
  });

  it('reports low confidence for a uniform map — nothing to look at', () => {
    const point = attentionCentre(new Float32Array(W * H).fill(1), W, H);
    expect(point.confidence).toBeLessThan(0.05);
  });

  it('reports high confidence for a concentrated one', () => {
    const map = new Float32Array(W * H);
    for (let y = 14; y < 18; y++) for (let x = 14; x < 18; x++) map[y * W + x] = 1;
    expect(attentionCentre(map, W, H).confidence).toBeGreaterThan(0.9);
  });
});

describe('saliencyMap', () => {
  it('finds what MOVED between two frames', () => {
    // The subject is the thing that moves; the background is the thing that
    // does not. This is the cue that carries almost every real shot.
    const previous = lumaFromRgba(frame(60), W, H);
    const current = lumaFromRgba(frame(60, { x: 22, y: 14, w: 6, h: 6, value: 220 }), W, H);
    const point = attentionCentre(saliencyMap(current, previous, W, H), W, H);
    expect(point.x).toBeGreaterThan(0.6);
  });

  it('still finds the subject in a locked-off shot, from detail alone', () => {
    const still = lumaFromRgba(frame(60, { x: 4, y: 14, w: 6, h: 6, value: 220 }), W, H);
    const point = attentionCentre(saliencyMap(still, still, W, H), W, H);
    expect(point.x).toBeLessThan(0.45);
  });

  it('does not let a corner win over the middle', () => {
    // A bright edge in the corner of an otherwise empty frame must not drag the
    // reframe out there — the boring case has to stay boring.
    const previous = lumaFromRgba(frame(60), W, H);
    const current = lumaFromRgba(frame(60, { x: 0, y: 0, w: 3, h: 3, value: 255 }), W, H);
    const point = attentionCentre(saliencyMap(current, previous, W, H), W, H);
    expect(point.x).toBeGreaterThan(0.15);
    expect(point.y).toBeGreaterThan(0.15);
  });

  it('has nothing to say about a flat frame', () => {
    const flat = lumaFromRgba(frame(128), W, H);
    expect(attentionCentre(saliencyMap(flat, flat, W, H), W, H).confidence).toBeLessThan(0.2);
  });

  it('uses detail only when there is no previous frame', () => {
    // The first frame of a shot has no motion to measure, and inventing one
    // would put a cut's first frame somewhere arbitrary.
    const first = lumaFromRgba(frame(60, { x: 22, y: 14, w: 6, h: 6, value: 220 }), W, H);
    const point = attentionCentre(saliencyMap(first, null, W, H), W, H);
    expect(point.x).toBeGreaterThan(0.55);
  });
});

describe('analyseFrame', () => {
  it('returns the point and the luma to carry into the next frame', () => {
    const result = analyseFrame(frame(60, { x: 22, y: 14, w: 6, h: 6, value: 220 }), null, W, H);
    expect(result.luma).toHaveLength(W * H);
    expect(result.point.x).toBeGreaterThan(0.5);
  });
});
