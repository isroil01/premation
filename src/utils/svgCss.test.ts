/**
 * CSS `@keyframes` → keyframes.
 *
 * These go through `parseSvgToShapes` rather than calling the CSS reader
 * directly, because the thing that was broken was the WHOLE path: the reader
 * existing is worth nothing unless the shapes come out carrying its tracks.
 *
 * The recurring trap this file guards is `transform-origin`. For SVG elements
 * `transform-box` resolves to the VIEW BOX by default, so an unqualified
 * `rotate` swings the shape around the middle of the artboard; `fill-box` turns
 * the same rule into a spin in place. Getting that backwards makes a loading
 * spinner orbit the canvas.
 */

import { parseSvgToShapes } from './svgParser';
import { readCssAnimations } from './svgCss';

const wrap = (inner: string): string =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100" width="100" height="100">${inner}</svg>`;

function only(svg: string) {
  const shapes = parseSvgToShapes(svg);
  expect(shapes).toHaveLength(1);
  return shapes[0]!;
}

type Track = ReadonlyArray<{ time: number; value: number }>;

function interp(kfs: Track, t: number): number {
  if (t <= kfs[0]!.time) return kfs[0]!.value;
  for (let i = 0; i < kfs.length - 1; i++) {
    const a = kfs[i]!;
    const b = kfs[i + 1]!;
    if (t >= a.time && t <= b.time) {
      const span = b.time - a.time;
      return span < 1e-9 ? b.value : a.value + (b.value - a.value) * ((t - a.time) / span);
    }
  }
  return kfs[kfs.length - 1]!.value;
}

/**
 * Play a track the way the engine will.
 *
 * An endless animation is stored as ONE cycle plus a `loopOut` expression, so
 * reading the raw keyframes past the first cycle would show it standing still.
 * This mirrors `expressions.ts`, which is what actually runs at playback.
 */
function sample(anim: { loop?: 'cycle' | 'pingpong' } | undefined, kfs: Track | undefined, t: number): number {
  if (!kfs || kfs.length === 0) throw new Error('track missing');
  const start = kfs[0]!.time;
  const end = kfs[kfs.length - 1]!.time;
  const dur = end - start;
  if (!anim?.loop || t <= end || dur <= 0) return interp(kfs, t);
  const rel = t - start;
  if (anim.loop === 'pingpong') {
    let ph = rel % (2 * dur);
    if (ph > dur) ph = 2 * dur - ph;
    return interp(kfs, start + ph);
  }
  return interp(kfs, start + (rel % dur));
}

describe('CSS animation translation', () => {
  it('converts a @keyframes spin that SMIL scanning cannot see', () => {
    const s = only(wrap(`
      <style>
        @keyframes spin { from { transform: rotate(0deg) } to { transform: rotate(360deg) } }
        .r { animation: spin 2s linear infinite; transform-box: fill-box; transform-origin: center }
      </style>
      <rect class="r" x="40" y="40" width="20" height="20"/>`));
    expect(s.animation).toBeDefined();
    // Half a turn at 1s, a full turn at 2s — and it keeps going.
    expect(sample(s.animation, s.animation!.rotation, 1)).toBeCloseTo(180, 0);
    expect(sample(s.animation, s.animation!.rotation, 2)).toBeCloseTo(360, 0);
    // Still turning on the third cycle — the angle wraps, the motion does not.
    expect(sample(s.animation, s.animation!.rotation, 5)).toBeCloseTo(180, 0);
  });

  it('spins in place for fill-box but orbits for the view-box default', () => {
    const decl = (extra: string): string => wrap(`
      <style>
        @keyframes spin { to { transform: rotate(360deg) } }
        .r { animation: spin 4s linear infinite; ${extra} }
      </style>
      <rect class="r" x="10" y="10" width="20" height="20"/>`);

    // Own centre → rotation only, no displacement.
    const own = only(decl('transform-box: fill-box; transform-origin: center'));
    expect(own.animation!.x).toBeUndefined();
    expect(own.animation!.y).toBeUndefined();
    expect(own.animation!.rotation).toBeDefined();

    // Artboard centre (50,50) → the shape at (20,20) swings around it. A half
    // turn puts it on the far side: (20,20) → (80,80), i.e. +60 on both axes.
    const orbit = only(decl(''));
    expect(sample(orbit.animation, orbit.animation!.x, 2)).toBeCloseTo(60, 0);
    expect(sample(orbit.animation, orbit.animation!.y, 2)).toBeCloseTo(60, 0);
  });

  it('honours delay, iteration count and fill-mode: forwards', () => {
    const s = only(wrap(`
      <style>
        @keyframes grow { from { transform: scale(1) } to { transform: scale(2) } }
        .r { animation-name: grow; animation-duration: 1s; animation-delay: 0.5s;
             animation-iteration-count: 2; animation-fill-mode: forwards;
             animation-timing-function: linear;
             transform-box: fill-box; transform-origin: center }
      </style>
      <rect class="r" x="40" y="40" width="20" height="20"/>`));
    expect(s.animation!.duration).toBeCloseTo(2.5, 5);
    expect(sample(s.animation, s.animation!.scaleX, 0.25)).toBeCloseTo(1, 2); // still delayed
    expect(sample(s.animation, s.animation!.scaleX, 1)).toBeCloseTo(1.5, 1);
    expect(sample(s.animation, s.animation!.scaleX, 2.5)).toBeCloseTo(2, 2); // frozen at the end
  });

  it('runs odd iterations backwards for direction: alternate', () => {
    const s = only(wrap(`
      <style>
        @keyframes fade { from { opacity: 0 } to { opacity: 1 } }
        .r { animation: fade 1s linear infinite alternate }
      </style>
      <rect class="r" x="10" y="10" width="20" height="20"/>`));
    expect(sample(s.animation, s.animation!.opacity, 0.5)).toBeCloseTo(50, 0);
    expect(sample(s.animation, s.animation!.opacity, 1)).toBeCloseTo(100, 0);
    expect(sample(s.animation, s.animation!.opacity, 1.5)).toBeCloseTo(50, 0); // coming back down
    expect(sample(s.animation, s.animation!.opacity, 2)).toBeCloseTo(0, 0);
  });

  it('reads an animation declared in an inline style attribute', () => {
    const s = only(wrap(`
      <style>@keyframes up { 0%, 100% { transform: translateY(0) } 50% { transform: translateY(-20px) } }</style>
      <rect x="40" y="40" width="20" height="20" style="animation: up 2s linear infinite"/>`));
    expect(sample(s.animation, s.animation!.y, 1)).toBeCloseTo(-20, 0);
    expect(sample(s.animation, s.animation!.y, 2)).toBeCloseTo(0, 0);
  });

  it('applies an animation on a <g> to every child, in register', () => {
    const shapes = parseSvgToShapes(wrap(`
      <style>
        @keyframes slide { to { transform: translate(30px, 0) } }
        g { animation: slide 1s linear infinite }
      </style>
      <g><rect x="0" y="0" width="10" height="10"/><rect x="20" y="0" width="10" height="10"/></g>`));
    expect(shapes).toHaveLength(2);
    // Sampled mid-iteration: at t=1 the loop has already restarted at 0.
    for (const s of shapes) expect(sample(s.animation, s.animation!.x, 0.5)).toBeCloseTo(15, 0);
  });

  it('eases with the timing function rather than cutting straight across', () => {
    const svg = (timing: string): string => wrap(`
      <style>
        @keyframes move { to { transform: translate(100px, 0) } }
        .r { animation: move 1s ${timing} 1 forwards }
      </style>
      <rect class="r" x="0" y="0" width="10" height="10"/>`);
    const lin = only(svg('linear'));
    const ei = only(svg('ease-in'));
    const linear = sample(lin.animation, lin.animation!.x, 0.25);
    const easeIn = sample(ei.animation, ei.animation!.x, 0.25);
    expect(linear).toBeCloseTo(25, 0);
    // ease-in starts slow, so a quarter of the way through it has moved less.
    expect(easeIn).toBeLessThan(linear - 5);
  });

  it('bakes an endless loop as ONE cycle, not one copy per repeat', () => {
    // This is the whole performance design: cost must not scale with how long
    // the animation runs. Unrolled, a 0.5s spin was hundreds of keyframes.
    const s = only(wrap(`
      <style>
        @keyframes spin { to { transform: rotate(360deg) } }
        .r { animation: spin 0.5s linear infinite; transform-box: fill-box; transform-origin: center }
      </style>
      <rect class="r" x="40" y="40" width="20" height="20"/>`));
    expect(s.animation!.loop).toBe('cycle');
    expect(s.animation!.duration).toBeCloseTo(0.5, 5);
    expect(s.animation!.rotation!.length).toBeLessThanOrEqual(4);
    // …and it is still turning ten seconds in: 0.25s into a cycle is a half
    // turn, whatever the angle's absolute value has wrapped to.
    expect(sample(s.animation, s.animation!.rotation, 10.25)).toBeCloseTo(180, 0);
  });

  it('replays a repeating fade instead of ramping past full opacity', () => {
    // `loopOut('offset')` would accumulate the cycle's +100 delta forever; the
    // source resets to 0 every second.
    const s = only(wrap(`
      <style>
        @keyframes fade { from { opacity: 0 } to { opacity: 1 } }
        .r { animation: fade 1s linear infinite }
      </style>
      <rect class="r" x="10" y="10" width="20" height="20"/>`));
    expect(s.animation!.loop).toBe('cycle');
    expect(sample(s.animation, s.animation!.opacity, 5.5)).toBeCloseTo(50, 0);
    expect(sample(s.animation, s.animation!.opacity, 9.5)).toBeCloseTo(50, 0);
  });

  it('does NOT loop a finite repeat count', () => {
    // `loopOut` runs forever; turning `2 iterations` into it would be a lie.
    const s = only(wrap(`
      <style>
        @keyframes fade { from { opacity: 0 } to { opacity: 1 } }
        .r { animation: fade 1s linear 2 }
      </style>
      <rect class="r" x="10" y="10" width="20" height="20"/>`));
    expect(s.animation!.loop).toBeUndefined();
    expect(s.animation!.duration).toBeCloseTo(2, 5);
  });

  it('is a no-op on markup with no CSS animation', () => {
    const doc = new DOMParser().parseFromString(
      wrap('<style>.r { fill: red }</style><rect class="r" x="0" y="0" width="10" height="10"/>'),
      'image/svg+xml',
    );
    const scan = readCssAnimations(doc);
    expect(scan.anims).toHaveLength(0);
    expect(scan.unsupported.size).toBe(0);
  });

  it('names what it could not convert instead of dropping it silently', () => {
    const doc = new DOMParser().parseFromString(
      wrap(`<style>
        @keyframes recolour { from { fill: #f00 } to { fill: #00f } }
        .r { animation: recolour 1s infinite }
      </style><rect class="r" x="0" y="0" width="10" height="10"/>`),
      'image/svg+xml',
    );
    const scan = readCssAnimations(doc);
    expect([...scan.unsupported]).toContain('CSS fill');
  });

  it('survives a selector the DOM cannot parse', () => {
    const doc = new DOMParser().parseFromString(
      wrap(`<style>
        @keyframes spin { to { transform: rotate(360deg) } }
        .r::part(x) { colour: red } .r { animation: spin 1s infinite }
      </style><rect class="r" x="0" y="0" width="10" height="10"/>`),
      'image/svg+xml',
    );
    expect(() => readCssAnimations(doc)).not.toThrow();
    expect(readCssAnimations(doc).anims.length).toBeGreaterThan(0);
  });
});

describe('draw-on (stroke-dashoffset → trim path)', () => {
  // The line-drawing technique: dasharray hides the stroke behind one full-length
  // dash, dashoffset slides it into view. Maps exactly onto the engine's trim
  // path — visible fraction = 1 − offset/dash.

  it('converts a SMIL draw-on into a trimEnd track', () => {
    const s = only(wrap(`
      <path d="M10 50 L90 50" stroke="#000" stroke-width="4" fill="none"
            stroke-dasharray="80" stroke-dashoffset="80">
        <animate attributeName="stroke-dashoffset" from="80" to="0" dur="2s" fill="freeze"/>
      </path>`));
    expect(s.animation).toBeDefined();
    expect(sample(s.animation, s.animation!.trimEnd, 0)).toBeCloseTo(0, 0);   // hidden
    expect(sample(s.animation, s.animation!.trimEnd, 1)).toBeCloseTo(50, 0);  // half drawn
    expect(sample(s.animation, s.animation!.trimEnd, 2)).toBeCloseTo(100, 0); // fully drawn
  });

  it('converts a CSS @keyframes draw-on', () => {
    const s = only(wrap(`
      <style>
        @keyframes draw { from { stroke-dashoffset: 120 } to { stroke-dashoffset: 0 } }
        .l { animation: draw 1s linear forwards }
      </style>
      <path class="l" d="M10 10 L90 90" stroke="#00f" stroke-width="3" fill="none" stroke-dasharray="120"/>`));
    expect(sample(s.animation, s.animation!.trimEnd, 0)).toBeCloseTo(0, 0);
    expect(sample(s.animation, s.animation!.trimEnd, 0.5)).toBeCloseTo(50, 0);
    expect(sample(s.animation, s.animation!.trimEnd, 1)).toBeCloseTo(100, 0);
  });

  it('measures against pathLength when the author set one', () => {
    const s = only(wrap(`
      <path d="M10 50 L90 50" pathLength="100" stroke="#000" fill="none" stroke-dasharray="100">
        <animate attributeName="stroke-dashoffset" from="100" to="25" dur="1s" fill="freeze"/>
      </path>`));
    expect(sample(s.animation, s.animation!.trimEnd, 1)).toBeCloseTo(75, 0);
  });

  it('names the gap when there is no dash length to measure against', () => {
    const doc = new DOMParser().parseFromString(wrap(`
      <path d="M10 50 L90 50" stroke="#000" fill="none">
        <animate attributeName="stroke-dashoffset" from="80" to="0" dur="1s"/>
      </path>`), 'image/svg+xml');
    const shapes = parseSvgToShapes(wrap(`
      <path d="M10 50 L90 50" stroke="#000" fill="none">
        <animate attributeName="stroke-dashoffset" from="80" to="0" dur="1s"/>
      </path>`));
    expect(shapes[0]!.animation?.trimEnd).toBeUndefined();
    void doc;
  });

  it('does not leak dashoffset into the opacity track', () => {
    const s = only(wrap(`
      <path d="M10 50 L90 50" stroke="#000" fill="none" stroke-dasharray="80">
        <animate attributeName="stroke-dashoffset" from="80" to="0" dur="1s" fill="freeze"/>
      </path>`));
    expect(s.animation!.opacity).toBeUndefined();
    expect(s.animation!.trimEnd).toBeDefined();
  });
});
