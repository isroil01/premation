import { trackPoint } from './tracker';
import type { LumaPlane } from './patchMatch';

function plane(width: number, height: number, f: (x: number, y: number) => number): LumaPlane {
  const data = new Float32Array(width * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      data[y * width + x] = f(x, y);
    }
  }
  return { data, width, height };
}

const blobScene = (bx: number, by: number, amp = 0.6) => (x: number, y: number): number => {
  const blob = Math.exp(-((x - bx) ** 2 + (y - by) ** 2) / (2 * 2.5 ** 2));
  const texture = 0.05 * Math.sin(x * 1.3) * Math.cos(y * 0.7);
  return 0.3 + amp * blob + texture;
};

/** A clip whose feature follows `path(frame)`; occluded frames drop the blob. */
function clip(
  path: (frame: number) => { x: number; y: number },
  opts: { occluded?: Set<number> } = {},
): (frame: number) => Promise<LumaPlane> {
  return (frame: number) => {
    const { x, y } = path(frame);
    const amp = opts.occluded?.has(frame) ? 0 : 0.6;
    return Promise.resolve(plane(96, 96, blobScene(x, y, amp)));
  };
}

describe('trackPoint', () => {
  it('follows a linear drift across a clip, sub-pixel', async () => {
    const path = (f: number) => ({ x: 30 + 1.3 * f, y: 40 - 0.7 * f });
    const r = await trackPoint({
      frameAt: clip(path),
      fromFrame: 0,
      toFrame: 12,
      startX: 30,
      startY: 40,
      featureHalf: 6,
      searchHalf: 6,
    });
    expect(r.status).toBe('completed');
    expect(r.samples).toHaveLength(13);
    for (const s of r.samples) {
      const truth = path(s.frame);
      expect(Math.abs(s.x - truth.x)).toBeLessThan(0.35);
      expect(Math.abs(s.y - truth.y)).toBeLessThan(0.35);
      expect(s.coasted).toBe(false);
    }
  });

  it('follows ACCELERATING motion faster than the search window, via velocity prediction', async () => {
    // Speed reaches ~10 px/frame by the end — far beyond searchHalf 6 from a
    // standing start. Prediction centres the window on last velocity, so the
    // window only has to cover the per-frame CHANGE in velocity.
    const path = (f: number) => ({ x: 20 + 0.5 * f * f, y: 48 });
    const r = await trackPoint({
      frameAt: clip(path),
      fromFrame: 0,
      toFrame: 10,
      startX: 20,
      startY: 48,
      featureHalf: 6,
      searchHalf: 6,
    });
    expect(r.status).toBe('completed');
    const last = r.samples[r.samples.length - 1]!;
    expect(Math.abs(last.x - path(10).x)).toBeLessThan(0.5);
  });

  it('coasts through a short occlusion and reacquires on the far side', async () => {
    const path = (f: number) => ({ x: 30 + 2 * f, y: 40 });
    const r = await trackPoint({
      frameAt: clip(path, { occluded: new Set([4, 5, 6]) }),
      fromFrame: 0,
      toFrame: 10,
      startX: 30,
      startY: 40,
      featureHalf: 6,
      searchHalf: 6,
    });
    expect(r.status).toBe('completed');
    const occludedSamples = r.samples.filter((s) => [4, 5, 6].includes(s.frame));
    expect(occludedSamples.every((s) => s.coasted)).toBe(true);
    // Reacquired: the post-occlusion samples are confident matches again.
    const after = r.samples.filter((s) => s.frame > 6);
    expect(after.every((s) => !s.coasted)).toBe(true);
    const last = r.samples[r.samples.length - 1]!;
    expect(Math.abs(last.x - path(10).x)).toBeLessThan(0.5);
  });

  it('gives up as lost when the feature never comes back', async () => {
    const path = () => ({ x: 30, y: 40 });
    const occluded = new Set(Array.from({ length: 30 }, (_, i) => i + 3));
    const r = await trackPoint({
      frameAt: clip(path, { occluded }),
      fromFrame: 0,
      toFrame: 30,
      startX: 30,
      startY: 40,
      featureHalf: 6,
      searchHalf: 6,
      maxCoastFrames: 4,
    });
    expect(r.status).toBe('lost');
    expect(r.samples.length).toBeLessThan(31);
  });

  it('tracks backwards when toFrame < fromFrame', async () => {
    const path = (f: number) => ({ x: 30 + 1.5 * f, y: 40 + f });
    const r = await trackPoint({
      frameAt: clip(path),
      fromFrame: 10,
      toFrame: 0,
      startX: path(10).x,
      startY: path(10).y,
      featureHalf: 6,
      searchHalf: 6,
    });
    expect(r.status).toBe('completed');
    const last = r.samples[r.samples.length - 1]!;
    expect(last.frame).toBe(0);
    expect(Math.abs(last.x - 30)).toBeLessThan(0.4);
    expect(Math.abs(last.y - 40)).toBeLessThan(0.4);
  });

  it('reports lost immediately for an off-frame start point', async () => {
    const r = await trackPoint({
      frameAt: clip(() => ({ x: 30, y: 40 })),
      fromFrame: 0,
      toFrame: 5,
      startX: -20,
      startY: 40,
    });
    expect(r.status).toBe('lost');
    expect(r.samples).toHaveLength(1);
  });

  it('cancels via onProgress', async () => {
    const r = await trackPoint({
      frameAt: clip((f) => ({ x: 30 + f, y: 40 })),
      fromFrame: 0,
      toFrame: 20,
      startX: 30,
      startY: 40,
      featureHalf: 6,
      searchHalf: 6,
      onProgress: (done) => done < 5,
    });
    expect(r.status).toBe('cancelled');
    expect(r.samples.length).toBeLessThanOrEqual(6);
  });

  it('pulls frames strictly one at a time, in order', async () => {
    const seen: number[] = [];
    const inner = clip((f) => ({ x: 30 + f, y: 40 }));
    const r = await trackPoint({
      frameAt: (f) => {
        seen.push(f);
        return inner(f);
      },
      fromFrame: 0,
      toFrame: 6,
      startX: 30,
      startY: 40,
      featureHalf: 6,
      searchHalf: 6,
    });
    expect(r.status).toBe('completed');
    expect(seen).toEqual([0, 1, 2, 3, 4, 5, 6]);
  });
});
