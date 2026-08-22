/**
 * The painter: what it renders, how often, and in what order.
 *
 * The cost is the whole story here — every ghost is a full comp render — so
 * most of these assert that renders DON'T happen: not while playing, not while
 * disabled, and not again when nothing that could change the ghosts changed.
 * An un-memoized painter still looks correct on screen; it just makes the
 * viewport unusable, which no screenshot would catch.
 */

import { createOnionSkinPainter } from './onionSkinPainter';
import { DEFAULT_ONION_SKIN, type OnionSkinSettings } from './onionSkin';

const VISIBLE = 'onionVisible';

function setup(initial: Partial<OnionSkinSettings> = {}) {
  const content = document.createElement('canvas');
  content.width = 40;
  content.height = 20;
  const target = document.createElement('canvas');

  let settings: OnionSkinSettings = { ...DEFAULT_ONION_SKIN, enabled: true, ...initial };
  const painter = createOnionSkinPainter({
    content: () => content,
    target: () => target,
    settings: () => settings,
    bounds: () => ({ min: 0, max: 1000 }),
    visibleClass: VISIBLE,
  });

  /** Times passed to renderAt, and whether each asked for the ghost variant. */
  const calls: Array<{ t: number; ghost: boolean }> = [];
  const renderAt = (t: number, ghost: boolean): void => { calls.push({ t, ghost }); };

  return {
    painter,
    target,
    calls,
    paint: (frame: number, playing = false, key = 'k1') =>
      painter.paint(renderAt, frame, 10, playing, key),
    update: (patch: Partial<OnionSkinSettings>) => { settings = { ...settings, ...patch }; },
  };
}

describe('when it must not render at all', () => {
  it('does nothing while disabled', () => {
    const s = setup({ enabled: false });
    s.paint(10);
    expect(s.calls).toEqual([]);
    expect(s.target.classList.contains(VISIBLE)).toBe(false);
  });

  it('does nothing while PLAYING', () => {
    // Several comp renders per displayed frame would make the one mode that has
    // to stay responsive the slowest thing in the app — and ghosts are
    // unreadable in motion anyway.
    const s = setup();
    s.paint(10, true);
    expect(s.calls).toEqual([]);
  });

  it('does nothing at a nonsense fps rather than dividing by zero', () => {
    const s = setup();
    s.painter.paint(() => {}, 10, 0, false, 'k');
    expect(s.calls).toEqual([]);
  });

  it('hides the layer when the ghosts are turned off after being drawn', () => {
    const s = setup();
    s.paint(10);
    expect(s.target.classList.contains(VISIBLE)).toBe(true);
    s.update({ enabled: false });
    s.paint(10);
    expect(s.target.classList.contains(VISIBLE)).toBe(false);
  });
});

describe('what it renders', () => {
  it('renders one ghost per planned frame, all with the ghost flag', () => {
    // The flag is what selects the transparent-background variant. Without it
    // every ghost is an opaque plate and only the last drawn is visible.
    const s = setup({ before: 2, after: 1 });
    s.paint(10);
    expect(s.calls).toHaveLength(3);
    expect(s.calls.every((c) => c.ghost)).toBe(true);
    expect(s.painter.lastDrawn).toBe(3);
  });

  it('renders at TIMES, converted from frames by fps', () => {
    const s = setup({ before: 1, after: 1 });
    s.paint(10); // fps 10 → frame 9 = 0.9s, frame 11 = 1.1s
    expect(s.calls.map((c) => Number(c.t.toFixed(4))).sort()).toEqual([0.9, 1.1]);
  });

  it('renders farthest-first, matching the plan draw order', () => {
    // Nearest ghost must be painted last so it lands on top; if this loop is
    // ever reordered the sense of direction inverts.
    const s = setup({ before: 3, after: 0 });
    s.paint(10);
    expect(s.calls.map((c) => Math.round(c.t * 10))).toEqual([7, 8, 9]);
  });

  it('drops ghosts outside the comp and renders only the rest', () => {
    const content = document.createElement('canvas');
    content.width = 10; content.height = 10;
    const target = document.createElement('canvas');
    const calls: number[] = [];
    const painter = createOnionSkinPainter({
      content: () => content,
      target: () => target,
      settings: () => ({ ...DEFAULT_ONION_SKIN, enabled: true, before: 3, after: 0 }),
      bounds: () => ({ min: 0, max: 100 }),
      visibleClass: VISIBLE,
    });
    painter.paint((t) => calls.push(Math.round(t * 10)), 1, 10, false, 'k');
    expect(calls).toEqual([0]);
  });

  it('hides the layer when the plan is empty', () => {
    const s = setup({ before: 0, after: 0 });
    s.paint(10);
    expect(s.calls).toEqual([]);
    expect(s.target.classList.contains(VISIBLE)).toBe(false);
  });
});

describe('memoization', () => {
  it('does not re-render when nothing relevant changed', () => {
    // THE assertion. Repaints happen on hover, selection, chrome toggles —
    // anything that calls render(). Without this, a mouse move over the canvas
    // costs `before + after` full comp renders.
    const s = setup({ before: 3, after: 3 });
    s.paint(10);
    const first = s.calls.length;
    s.paint(10);
    s.paint(10);
    expect(s.calls.length).toBe(first);
  });

  it('re-renders when the playhead moves', () => {
    const s = setup({ before: 1, after: 0 });
    s.paint(10);
    s.paint(11);
    expect(s.calls).toHaveLength(2);
  });

  it('re-renders when the invalidation key changes (an edit, or a pan)', () => {
    const s = setup({ before: 1, after: 0 });
    s.paint(10, false, 'k1');
    s.paint(10, false, 'k2');
    expect(s.calls).toHaveLength(2);
  });

  it('re-renders when a setting changes', () => {
    const s = setup({ before: 1, after: 0 });
    s.paint(10);
    s.update({ before: 2 });
    s.paint(10);
    expect(s.calls).toHaveLength(3); // 1 + 2
  });

  it('re-renders after being disabled and re-enabled', () => {
    // The memo has to be dropped on the way out, or re-enabling shows nothing
    // until something else happens to move the signature.
    const s = setup({ before: 1, after: 0 });
    s.paint(10);
    s.update({ enabled: false });
    s.paint(10);
    s.update({ enabled: true });
    s.paint(10);
    expect(s.calls).toHaveLength(2);
    expect(s.target.classList.contains(VISIBLE)).toBe(true);
  });

  it('re-renders after a playback pass, rather than staying stale', () => {
    const s = setup({ before: 1, after: 0 });
    s.paint(10);
    s.paint(10, true);  // playing: cleared
    s.paint(10, false); // paused again at the same frame
    expect(s.calls).toHaveLength(2);
  });
});

describe('the target layer', () => {
  it('is sized to the content canvas', () => {
    const s = setup({ before: 1, after: 0 });
    s.paint(10);
    expect([s.target.width, s.target.height]).toEqual([40, 20]);
  });
});
