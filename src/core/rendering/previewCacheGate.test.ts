/**
 * The preview cache's serve/fill gate.
 *
 * The interesting cases are the ones where being slightly too generous shows
 * wrong pixels and being slightly too strict shows nothing at all, so the tests
 * come in pairs: this must be allowed, that must not.
 */

import {
  mayServeCachedFrame,
  mayFillFromPausedRender,
  isOnFrameGrid,
  playbackBlitWorthwhile,
  MIN_PLAYBACK_BLIT_RUN,
  type PreviewCacheState,
} from './previewCacheGate';

const settled = (patch: Partial<PreviewCacheState> = {}): PreviewCacheState => ({
  playing: false,
  interacting: false,
  onionSkins: false,
  timeSec: 1,
  fps: 30,
  frame: 30,
  ...patch,
});

describe('serving', () => {
  it('serves a settled paused playhead — the bug this exists to fix', () => {
    // Scrubbing back over an already-green region used to re-render every
    // frame, because the read was inside `if (playing)`.
    expect(mayServeCachedFrame(settled())).toBe(true);
  });

  it('still serves during playback, unconditionally', () => {
    // Playback renders `f / fps` exactly and never mid-gesture, so none of the
    // paused conditions can apply to it.
    expect(mayServeCachedFrame(settled({ playing: true, interacting: true, onionSkins: true, timeSec: 1.017 }))).toBe(true);
  });

  it('refuses mid-gesture — the hazard the old gate was written for', () => {
    // An interactive repaint can move the picture without moving the key, so a
    // blit would paint the pre-gesture frame over a live drag.
    expect(mayServeCachedFrame(settled({ interacting: true }))).toBe(false);
  });

  it('refuses with onion skins on', () => {
    // Ghosts are painted INTO the content canvas by a step the blit path skips;
    // serving would make them vanish wherever the cache happened to be warm.
    expect(mayServeCachedFrame(settled({ onionSkins: true }))).toBe(false);
  });

  it('refuses a playhead between two frames', () => {
    // 1.017s at 30fps rounds to frame 31 but is not frame 31. Serving frame 31
    // here is footage one frame out from everything else in the picture.
    expect(mayServeCachedFrame(settled({ timeSec: 1.017, frame: 31 }))).toBe(false);
  });
});

describe('filling', () => {
  const fill = (patch: Partial<PreviewCacheState> & { mediaExact?: boolean } = {}) =>
    mayFillFromPausedRender({
      interacting: false, timeSec: 1, fps: 30, frame: 30, mediaExact: true, ...patch,
    });

  it('fills from a settled paused render, so a scrub leaves a trail', () => {
    expect(fill()).toBe(true);
  });

  it('refuses mid-gesture — a half-dragged frame must not be blitted back', () => {
    expect(fill({ interacting: true })).toBe(false);
  });

  it('refuses a frame the renderer says holds stand-in footage', () => {
    // Otherwise it replays those stale pixels at that timecode on every later
    // pass — the rule the playback writer already enforced.
    expect(fill({ mediaExact: false })).toBe(false);
  });

  it('refuses an off-grid render rather than filing it under the wrong frame', () => {
    expect(fill({ timeSec: 1.017, frame: 31 })).toBe(false);
  });
});

describe('isOnFrameGrid', () => {
  it('accepts an exact frame time at any rate', () => {
    for (const fps of [23.976, 24, 25, 29.97, 30, 50, 59.94, 60, 120]) {
      for (const f of [0, 1, 7, 300]) {
        expect(isOnFrameGrid(f / fps, fps, f)).toBe(true);
      }
    }
  });

  it('rejects a half-frame offset at any rate', () => {
    for (const fps of [24, 30, 60]) {
      expect(isOnFrameGrid((7 + 0.5) / fps, fps, 7)).toBe(false);
    }
  });

  it('tolerates float noise from a frame/fps round trip', () => {
    // The playhead arrives as `frame / fps` and is multiplied back by fps; the
    // epsilon exists for that, not to accept a real offset.
    const fps = 29.97;
    const f = 1237;
    expect(isOnFrameGrid(f / fps, fps, f)).toBe(true);
  });

  it('refuses nonsense rather than answering it', () => {
    expect(isOnFrameGrid(1, 0, 30)).toBe(false);
    expect(isOnFrameGrid(NaN, 30, 30)).toBe(false);
    expect(isOnFrameGrid(1, 30, NaN)).toBe(false);
  });
});

describe('playbackBlitWorthwhile', () => {
  it('refuses an isolated hit — the toggle storm case', () => {
    // One cached frame in a fragmented set. Blitting it parks the video
    // elements; the very next frame is a miss that demands them back at the
    // playhead — a hard mid-GOP seek per fragment boundary, felt as freeze,
    // old stand-in frames, then a fast catch-up. Rendering the hit live is
    // strictly cheaper than serving it.
    expect(playbackBlitWorthwhile(100, 100)).toBe(false);
  });

  it('refuses a run shorter than one seek of runway', () => {
    for (let end = 100; end < 100 + MIN_PLAYBACK_BLIT_RUN; end++) {
      expect(playbackBlitWorthwhile(100, end)).toBe(false);
    }
  });

  it('serves a real run — the warmed second pass this cache exists for', () => {
    expect(playbackBlitWorthwhile(100, 100 + MIN_PLAYBACK_BLIT_RUN)).toBe(true);
    expect(playbackBlitWorthwhile(0, 287)).toBe(true);
  });

  it('hands the tail of a run back to the live path before it ends', () => {
    // The last frames of a genuine run render live even though they are
    // cached — a few wasted renders, paid so the pipeline switches once per
    // run instead of once per fragment. The wrap then re-enters the blit path
    // at the head of the span, where the runway is long again.
    const end = 287;
    expect(playbackBlitWorthwhile(end - MIN_PLAYBACK_BLIT_RUN, end)).toBe(true);
    expect(playbackBlitWorthwhile(end - MIN_PLAYBACK_BLIT_RUN + 1, end)).toBe(false);
    expect(playbackBlitWorthwhile(end, end)).toBe(false);
  });
});
