/**
 * How far the disk tier may promote, given how much room RAM has.
 *
 * The reported symptom this is the fix for: the FIRST playback pass is smooth
 * and the second and third are worse. That direction is the whole clue — a
 * cache should make pass two faster, so something is doing work that only
 * exists once the cache has content in it.
 *
 * On pass one the disk index is empty, so `prefetch` finds nothing and does
 * nothing. From pass two on it finds everything: for each of 12 frames ahead it
 * fires an IndexedDB read, a PNG decode and a full-resolution canvas draw. That
 * pays only if the promoted frame is still resident when the playhead arrives —
 * and at 31.6 MiB a frame (a 1920x1080 viewport at dpr 2) the 512 MiB budget
 * holds 16, so promoting 12 into it while the render loop also inserts means
 * they evict each other first.
 *
 * Same defect as `STREAM_AHEAD` had one tier down, so the same invariant fixes
 * it: `ahead * 2 <= capacity`.
 */

import { FrameCache, diskLookAhead } from './frameCache';
import { LOOK_AHEAD } from './frameDiskCache';

const MiB = 1024 * 1024;

/** A frame of a given pixel size, which is all the budget arithmetic reads. */
function frameOf(w: number, h: number): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  return c;
}

describe('diskLookAhead', () => {
  it('leaves the small-frame case exactly where it was tuned', () => {
    // 1600x900 at dpr 1 is 5.5 MiB a frame → 93 frames of budget. Promoting 12
    // into 93 was never the problem and must not become slower.
    expect(diskLookAhead(93)).toBe(LOOK_AHEAD);
    expect(diskLookAhead(145)).toBe(LOOK_AHEAD);
  });

  it('holds back when the cache cannot hold what it promotes', () => {
    // 1920x1080 at dpr 2 → 16 frames. Promoting 12 into 16, while the render
    // loop is also inserting, is how a promotion evicts its own neighbours.
    expect(diskLookAhead(16)).toBe(8);
    expect(diskLookAhead(8)).toBe(4);
  });

  it('never asks for more than half the capacity', () => {
    for (let cap = 4; cap <= 400; cap++) {
      expect(diskLookAhead(cap) * 2).toBeLessThanOrEqual(cap);
    }
  });

  it('stops entirely when there is no room to receive', () => {
    // A promoted frame evicted before it is read cost a read, a decode and a
    // full-res draw and bought nothing. Not promoting is strictly better.
    for (const cap of [0, 1, 2, 3]) expect(diskLookAhead(cap)).toBe(0);
  });

  it('treats an UNKNOWN capacity as unthrottled, not as zero', () => {
    // An empty cache has stored nothing and so has no frame size to reason
    // from. Reading that as "small" would disable the tier exactly when it is
    // coldest — which is the bug this line was written wrong as, first time.
    expect(diskLookAhead(Infinity)).toBe(LOOK_AHEAD);
    expect(diskLookAhead(NaN)).toBe(LOOK_AHEAD);
  });
});

describe('the capacity the cache reports', () => {
  it('is unknown while empty', () => {
    expect(new FrameCache(512 * MiB).capacityFrames).toBe(Infinity);
  });

  it('is measured from the size frames are actually stored at', () => {
    // Not from an assumed frame size: adaptive resolution flips the canvas
    // density mid-playback and cached frames keep whatever they were rendered
    // at, so one assumed size is wrong by up to 16x after a degrade.
    const hi = new FrameCache(512 * MiB);
    hi.setKey('k', 3840, 2160);
    hi.put(0, frameOf(3840, 2160));
    expect(hi.capacityFrames).toBe(16);

    const lo = new FrameCache(512 * MiB);
    lo.setKey('k', 1600, 900);
    lo.put(0, frameOf(1600, 900));
    expect(lo.capacityFrames).toBe(93);
  });

  it('reflects a mid-playback density change rather than the first frame seen', () => {
    const cache = new FrameCache(512 * MiB);
    cache.setKey('k', 3840, 2160);
    cache.put(0, frameOf(3840, 2160));
    const atFull = cache.capacityFrames;
    // Adaptive resolution degrades: later frames are a quarter of the pixels.
    for (let f = 1; f <= 9; f++) cache.put(f, frameOf(1920, 1080));
    expect(cache.capacityFrames).toBeGreaterThan(atFull);
  });

  it('drives the promotion depth end to end', () => {
    const hi = new FrameCache(512 * MiB);
    hi.setKey('k', 3840, 2160);
    hi.put(0, frameOf(3840, 2160));
    // 16 frames of room → 8 ahead, not 12.
    expect(diskLookAhead(hi.capacityFrames)).toBe(8);

    const lo = new FrameCache(512 * MiB);
    lo.setKey('k', 1600, 900);
    lo.put(0, frameOf(1600, 900));
    expect(diskLookAhead(lo.capacityFrames)).toBe(LOOK_AHEAD);
  });
});
