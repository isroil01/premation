/**
 * What an ANIMATED SVG loses on the way in.
 *
 * Only animated files take the geometry parser at all — a static one is stored
 * intact and rasterized (the hybrid import). So every fidelity gap in this
 * parser presents to the user as "animated SVGs specifically import wrong":
 * parts in the wrong place, parts the wrong colour, parts simply absent, or an
 * animation that plays differently from the file.
 *
 * Each block below pins one of those, and every case here is one that shipped
 * broken. The animation cases assert the TRACKS rather than the picture on
 * purpose — a track with a constant offset welded into it is the defect, and
 * a rendered frame cannot tell you that is where it came from.
 */

import {
  parseSvgToShapes, parseSvgPathEx, textAnchorOffsetX,
  type ParsedShape, type SvgTextMeasurer,
} from './svgParser';

const only = (shapes: readonly ParsedShape[]): ParsedShape => {
  if (shapes.length !== 1) throw new Error(`expected 1 shape, got ${shapes.length}`);
  return shapes[0]!;
};

const parse = (svg: string): ParsedShape[] => parseSvgToShapes(svg, { maxDurationSeconds: 10 });

/** Every value a track holds, rounded — for "is this track constant?" */
const values = (kfs: ReadonlyArray<{ value: number }> | undefined): number[] =>
  (kfs ?? []).map((k) => Number(k.value.toFixed(3)));

// ---------------------------------------------------------------------------
// The coordinate system the delta is measured in.
// ---------------------------------------------------------------------------

describe('an animation delta carries no trace of the viewport it was measured in', () => {
  /**
   * `D = A(t)·S⁻¹` only cancels when `A` is rebuilt in the same space `S` was
   * baked in. `A` used to be assembled from `transform` ATTRIBUTES alone, so
   * every coordinate system that is NOT an attribute — the root viewBox map, a
   * `<use x/y>`, a nested viewport — survived as a constant residual on every
   * animated shape. It vanished whenever the root matrix happened to be the
   * identity, which is why `width`/`height` == `viewBox` files always looked
   * fine and everything else did not.
   */
  const spin = '<animateTransform attributeName="transform" type="rotate" from="0 25 25" to="360 25 25" dur="2s" repeatCount="indefinite"/>';

  it('does not scale the shape when the pixel box is larger than the viewBox', () => {
    const s = only(parse(
      `<svg xmlns="http://www.w3.org/2000/svg" width="200" height="200" viewBox="0 0 50 50">
         <rect x="20" y="5" width="10" height="10" fill="#fff">${spin}</rect>
       </svg>`));
    // Was a constant scaleX = scaleY = 0.25 — the shape shrank to a quarter the
    // instant it was given a keyframe.
    expect(s.animation?.scaleX).toBeUndefined();
    expect(s.animation?.scaleY).toBeUndefined();
    // And the orbit starts where the shape already is, not a hundred units away.
    expect(s.animation?.x?.[0]?.value).toBeCloseTo(0, 6);
    expect(s.animation?.y?.[0]?.value).toBeCloseTo(0, 6);
  });

  it('does not offset the shape when the viewBox origin is not (0,0)', () => {
    // `viewBox="-50 -50 100 100"` is the standard centred-spinner form.
    const s = only(parse(
      `<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100" viewBox="-50 -50 100 100">
         <rect x="-5" y="-45" width="10" height="10" fill="#fff">
           <animateTransform attributeName="transform" type="rotate" from="0 0 0" to="360 0 0" dur="2s" repeatCount="indefinite"/>
         </rect>
       </svg>`));
    expect(s.animation?.x?.[0]?.value).toBeCloseTo(0, 6);
    expect(s.animation?.y?.[0]?.value).toBeCloseTo(0, 6);
  });

  it('leaves an animated shape in register with its un-animated sibling', () => {
    // The clearest form of the bug: two identical rects, and the one whose only
    // animation is an opacity flash jumped 105 units and shrank to 25%.
    const shapes = parse(
      `<svg xmlns="http://www.w3.org/2000/svg" width="200" height="200" viewBox="0 0 50 50">
         <rect x="5" y="5" width="10" height="10" fill="#0f0"/>
         <rect x="30" y="5" width="10" height="10" fill="#f00">
           <animate attributeName="opacity" values="1;0;1" dur="1s" repeatCount="indefinite"/>
         </rect>
       </svg>`);
    const animated = shapes.find((s) => s.animation)!;
    expect(animated.animation?.opacity).toBeDefined();
    // An opacity animation must not move or resize anything.
    expect(animated.animation?.x).toBeUndefined();
    expect(animated.animation?.y).toBeUndefined();
    expect(animated.animation?.scaleX).toBeUndefined();
  });

  it('gives two <use> copies of one animated symbol the same track', () => {
    const shapes = parse(
      `<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100" viewBox="0 0 100 100">
         <defs><g id="ic"><rect x="0" y="0" width="10" height="10" fill="#e11">
           <animate attributeName="opacity" values="1;0.2;1" dur="1s" repeatCount="indefinite"/>
         </rect></g></defs>
         <use href="#ic" x="0" y="0"/>
         <use href="#ic" x="60" y="60"/>
       </svg>`);
    expect(shapes).toHaveLength(2);
    // The offset copy used to get x = y = −60 and snap back onto the first one.
    for (const s of shapes) {
      expect(s.animation?.x).toBeUndefined();
      expect(s.animation?.y).toBeUndefined();
    }
    expect(shapes[1]!.centerX).toBeCloseTo(65, 6);
  });

  it('does not offset or scale content inside a nested <svg> viewport', () => {
    const s = only(parse(
      `<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100" viewBox="0 0 100 100">
         <svg x="40" y="40" width="50" height="50" viewBox="0 0 10 10">
           <rect x="0" y="0" width="10" height="10" fill="#fff">
             <animate attributeName="opacity" values="1;0.2;1" dur="1s" repeatCount="indefinite"/>
           </rect>
         </svg>
       </svg>`));
    expect(s.animation?.x).toBeUndefined();
    expect(s.animation?.scaleX).toBeUndefined();
  });

  it('still translates by the right amount under a scaled root', () => {
    // The residual is gone but the SCALE is real: 20 viewBox units of travel is
    // 80 baked units when the file declares a 4× pixel box.
    const s = only(parse(
      `<svg xmlns="http://www.w3.org/2000/svg" width="200" height="200" viewBox="0 0 50 50">
         <rect x="5" y="5" width="10" height="10" fill="#fff">
           <animateTransform attributeName="transform" type="translate" from="0 0" to="20 0" dur="1s" fill="freeze"/>
         </rect>
       </svg>`));
    const xs = s.animation!.x!;
    expect(xs[0]!.value).toBeCloseTo(0, 6);
    expect(xs[xs.length - 1]!.value).toBeCloseTo(80, 3);
  });
});

// ---------------------------------------------------------------------------
// Presentation the parser used to ignore.
// ---------------------------------------------------------------------------

describe('a <style> block is read for colour, not only for animation', () => {
  it('applies class fills and strokes instead of defaulting everything to black', () => {
    const shapes = parse(
      `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100" width="100" height="100">
         <style>
           .ring { fill: none; stroke: #ff3366; stroke-width: 8; animation: spin 1s linear infinite }
           .dot  { fill: #22ddff }
           @keyframes spin { to { transform: rotate(360deg) } }
         </style>
         <circle class="ring" cx="50" cy="50" r="40"/>
         <circle class="dot" cx="50" cy="10" r="6"/>
       </svg>`);
    // Both used to come back fill="#000000", stroke=undefined: a black disc
    // where the ring should be, and a black dot.
    expect(shapes[0]!.fill).toBe('none');
    expect(shapes[0]!.strokeColor).toBe('#ff3366');
    expect(shapes[0]!.strokeWidth).toBe(8);
    expect(shapes[1]!.fill).toBe('#22ddff');
  });

  it('lets inline style beat a class, and a class beat a presentation attribute', () => {
    const shapes = parse(
      `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100" width="100" height="100">
         <style>.c { fill: #00ff00 } @keyframes k { to { opacity: 0 } } .c { animation: k 1s infinite }</style>
         <rect class="c" x="0" y="0" width="10" height="10" fill="#ff0000"/>
         <rect class="c" x="20" y="0" width="10" height="10" fill="#ff0000" style="fill:#0000ff"/>
       </svg>`);
    expect(shapes[0]!.fill).toBe('#00ff00');
    expect(shapes[1]!.fill).toBe('#0000ff');
  });

  it('resolves currentColor against the inherited color property', () => {
    // Verbatim `currentColor` is not a valid Canvas2D style; assigning one is
    // IGNORED, so the shape was painted with whatever colour was set last.
    const s = only(parse(
      `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="24" height="24"
            fill="none" stroke="currentColor" color="#3366ff">
         <path d="M4 12 L20 12"><animate attributeName="opacity" values="1;0;1" dur="1s" repeatCount="indefinite"/></path>
       </svg>`));
    expect(s.strokeColor).toBe('#3366ff');
    expect(s.fill).toBe('none');
  });

  it('falls back to black for currentColor with no color declared', () => {
    const s = only(parse(
      `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="24" height="24">
         <rect x="0" y="0" width="10" height="10" fill="currentColor">
           <animate attributeName="opacity" values="1;0;1" dur="1s" repeatCount="indefinite"/>
         </rect>
       </svg>`));
    expect(s.fill).toBe('#000000');
  });
});

describe('opacity and visibility survive the import', () => {
  const doc = `
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100" width="100" height="100">
      <rect id="faded"  x="0"  y="0"  width="20" height="20" fill="#f00" opacity="0.25"/>
      <rect id="gone"   x="30" y="0"  width="20" height="20" fill="#0f0" display="none"/>
      <rect id="hidden" x="60" y="0"  width="20" height="20" fill="#00f" visibility="hidden"/>
      <rect id="wash"   x="0"  y="40" width="20" height="20" fill="#ff0" fill-opacity="0.5"/>
      <g opacity="0.5"><rect id="nested" x="30" y="40" width="20" height="20" fill="#0ff" opacity="0.5"/></g>
    </svg>`;

  it('drops display:none and visibility:hidden elements', () => {
    const names = parse(doc).map((s) => s.name);
    expect(names).toEqual(['faded', 'wash', 'nested']);
  });

  it('keeps element, group and fill opacity', () => {
    const byName = new Map(parse(doc).map((s) => [s.name, s]));
    expect(byName.get('faded')!.opacity).toBeCloseTo(0.25, 6);
    expect(byName.get('wash')!.fillOpacity).toBeCloseTo(0.5, 6);
    // Group opacity MULTIPLIES down — flattening a group into its own layers is
    // the one case where that is the faithful translation.
    expect(byName.get('nested')!.opacity).toBeCloseTo(0.25, 6);
  });

  it('folds a static group opacity into an animated opacity track', () => {
    const s = only(parse(
      `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100" width="100" height="100">
         <g opacity="0.4">
           <rect x="0" y="0" width="10" height="10" fill="#fff">
             <animate attributeName="opacity" values="1;0;1" dur="1s" repeatCount="indefinite"/>
           </rect>
         </g>
       </svg>`));
    // A pulse inside a 40% group is 40% of the pulse, not the pulse.
    expect(values(s.animation?.opacity)).toEqual([40, 0, 40]);
  });
});

// ---------------------------------------------------------------------------
// Geometry: a path is a LIST of runs.
// ---------------------------------------------------------------------------

describe('a path with several M commands is several outlines', () => {
  it('splits runs instead of joining them into one blob', () => {
    const { subpaths } = parseSvgPathEx('M0 0 H10 V10 H0 Z M3 3 H7 V7 H3 Z');
    expect(subpaths).toHaveLength(2);
    expect(subpaths[0]!.points).toHaveLength(4);
    expect(subpaths[1]!.points).toHaveLength(4);
    expect(subpaths.every((r) => r.closed)).toBe(true);
  });

  it('starts a new run after Z when no M follows', () => {
    // SVG 1.1 §8.3.1 — the command after a close begins a fresh subpath.
    const { subpaths } = parseSvgPathEx('M0 0 H10 Z L20 0');
    expect(subpaths).toHaveLength(2);
  });

  it('keeps a single-run path on the flat shorthand', () => {
    const shape = only(parse(
      `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" width="20" height="20">
         <path d="M0 0 H10 V10 Z" fill="#fff">
           <animate attributeName="opacity" values="1;0;1" dur="1s" repeatCount="indefinite"/>
         </path>
       </svg>`));
    expect(shape.subpaths).toBeUndefined();
  });

  it('carries both runs of a donut through to the parsed shape', () => {
    const shape = only(parse(
      `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" width="20" height="20">
         <path d="M0 0 H20 V20 H0 Z M5 5 H15 V15 H5 Z" fill="#fff">
           <animate attributeName="opacity" values="1;0;1" dur="1s" repeatCount="indefinite"/>
         </path>
       </svg>`));
    expect(shape.subpaths).toHaveLength(2);
    // Centred like `points` — the outer run spans the full box.
    const outer = shape.subpaths![0]!.points;
    expect(Math.min(...outer.map((p) => p.x))).toBeCloseTo(-10, 6);
  });

  it('rewinds an even-odd hole so nonzero filling still cuts it', () => {
    // The renderer fills every run as one nonzero region. An `evenodd` file has
    // no reason to wind its inner ring the other way, so the hole would fill.
    const same = (d: string, rule: string): ReturnType<typeof parseSvgToShapes>[number] => only(parse(
      `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" width="20" height="20">
         <path d="${d}" fill="#fff" fill-rule="${rule}">
           <animate attributeName="opacity" values="1;0;1" dur="1s" repeatCount="indefinite"/>
         </path>
       </svg>`));
    // Both rings wound clockwise — evenodd draws a hole, nonzero does not.
    const d = 'M0 0 H20 V20 H0 Z M5 5 H15 V15 H5 Z';
    const inner = (s: ReturnType<typeof same>): Array<{ x: number; y: number }> =>
      s.subpaths![1]!.points.map((p) => ({ x: p.x, y: p.y }));
    expect(inner(same(d, 'evenodd'))).not.toEqual(inner(same(d, 'nonzero')));
    // Reversal, not mangling: the same vertices in the opposite order.
    const eo = inner(same(d, 'evenodd'));
    const nz = inner(same(d, 'nonzero'));
    expect(eo).toEqual([...nz].reverse());
  });
});

// ---------------------------------------------------------------------------
// Text.
// ---------------------------------------------------------------------------

describe('a text run resolves to a real box', () => {
  /**
   * A stand-in for the app's measurer with numbers a test can reason about:
   * 20 units of advance per character, a box 1.2× the font size tall, and a
   * baseline 30% of the font size BELOW the block centre — which is what a real
   * font reports (0.30em, measured on 32px Inter).
   */
  const measure: SvgTextMeasurer = (t) => ({
    advance: t.content.length * 20,
    width: t.content.length * 20,
    height: t.fontSize * 1.2,
    baselineOffset: t.fontSize * 0.3,
  });

  const textDoc = (attrs: string, groupAttrs = ''): string => `
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 200" width="400" height="200">
      <g ${groupAttrs}>
        <text ${attrs}>ABCD<animate attributeName="opacity" values="1;0;1" dur="1s" repeatCount="indefinite"/></text>
      </g>
    </svg>`;

  const parseText = (attrs: string, groupAttrs = ''): ParsedShape =>
    only(parseSvgToShapes(textDoc(attrs, groupAttrs), { maxDurationSeconds: 10, measureText: measure }));

  it('offsets the centre by the anchor, not the anchor point itself', () => {
    // `start` is SVG's DEFAULT, and it was the case being drawn half a label
    // too far left: the run extends RIGHT from x, so its centre is x + w/2.
    expect(parseText('x="100" y="50"').centerX).toBeCloseTo(100 + 40, 6);
    expect(parseText('x="100" y="50" text-anchor="middle"').centerX).toBeCloseTo(100, 6);
    expect(parseText('x="100" y="50" text-anchor="end"').centerX).toBeCloseTo(100 - 40, 6);
  });

  it('lifts the box off the baseline rather than centring on it', () => {
    // SVG's y is the BASELINE; the scene draws from the block centre. Getting
    // the SIGN wrong here moves every label by a whole line the wrong way, so
    // pin the direction as well as the value.
    const s = parseText('x="100" y="50" font-size="40"');
    expect(s.centerY).toBeLessThan(50);
    expect(s.centerY).toBeCloseTo(50 - 12, 6);
  });

  it('takes its box from the measurement instead of the 10x10 stand-in', () => {
    const s = parseText('x="100" y="50" font-size="40"');
    expect(s.width).toBeCloseTo(80, 6);
    expect(s.height).toBeCloseTo(48, 6);
  });

  it('keeps the stand-in box when nothing can measure', () => {
    const s = only(parseSvgToShapes(textDoc('x="100" y="50"'), { maxDurationSeconds: 10 }));
    expect([s.width, s.height, s.centerX, s.centerY]).toEqual([10, 10, 100, 50]);
  });

  it('inherits font properties from an ancestor group', () => {
    const s = parseText('x="100" y="50"', 'font-family="Georgia" font-weight="700" font-style="italic"');
    expect(s.fontFamily).toBe('Georgia');
    expect(s.fontWeight).toBe('700');
    expect(s.fontStyle).toBe('italic');
  });

  it('reads font-size and text-anchor from a stylesheet too', () => {
    const s = only(parseSvgToShapes(`
      <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 200" width="400" height="200">
        <style>
          .lbl { font-size: 30px; text-anchor: middle; font-family: Georgia }
          @keyframes k { to { opacity: 0 } } .lbl { animation: k 1s infinite }
        </style>
        <text class="lbl" x="100" y="50">ABCD</text>
      </svg>`, { maxDurationSeconds: 10, measureText: measure }));
    expect(s.fontSize).toBe(30);
    expect(s.fontFamily).toBe('Georgia');
    expect(s.centerX).toBeCloseTo(100, 6); // middle → no shift
  });

  it('falls back to the CSS initial font size, not an invented one', () => {
    expect(parseText('x="100" y="50"').fontSize).toBe(16);
  });
});

describe('textAnchorOffsetX', () => {
  it('is half the advance, signed by the anchor', () => {
    expect(textAnchorOffsetX('start', 200)).toBe(100);
    expect(textAnchorOffsetX('middle', 200)).toBe(0);
    expect(textAnchorOffsetX('end', 200)).toBe(-100);
  });
});

// ---------------------------------------------------------------------------
// Timing.
// ---------------------------------------------------------------------------

describe('CSS animation timing', () => {
  const dots = `
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 40" width="100" height="40">
      <style>
        circle { animation: b 0.9s linear infinite; transform-box: fill-box; transform-origin: center }
        .d2 { animation-delay: -0.3s } .d3 { animation-delay: -0.6s }
        @keyframes b { 0%,100% { transform: translateY(0) } 50% { transform: translateY(-12px) } }
      </style>
      <circle cx="20" cy="20" r="6" fill="#fff"/>
      <circle class="d2" cx="50" cy="20" r="6" fill="#fff"/>
      <circle class="d3" cx="80" cy="20" r="6" fill="#fff"/>
    </svg>`;

  it('treats a negative delay as a phase offset, not as zero', () => {
    // Clamping it to 0 gave three IDENTICAL tracks: a staggered loader bounced
    // in unison, which is the one thing the stagger exists to prevent.
    const shapes = parse(dots);
    expect(shapes).toHaveLength(3);
    const first = shapes.map((s) => s.animation!.y![0]!.value);
    expect(first[0]).toBeCloseTo(0, 6);
    expect(first[1]).not.toBeCloseTo(0, 3);
    expect(values(shapes[1]!.animation?.y)).not.toEqual(values(shapes[2]!.animation?.y));
    // A phase shift is still a whole period, so it still bakes as one cycle.
    for (const s of shapes) expect(s.animation?.loop).toBe('cycle');
  });

  it('does not fold a positive delay into the loop period', () => {
    // `end = begin + dur` made a 1 s animation delayed 0.5 s loop every 1.5 s,
    // so two circles on the same animation drifted apart forever.
    const shapes = parse(`
      <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 40" width="100" height="40">
        <style>
          .a { animation: p 1s linear infinite; transform-box: fill-box; transform-origin: center }
          .b { animation: p 1s linear 0.5s infinite; transform-box: fill-box; transform-origin: center }
          @keyframes p { 0% { transform: scale(1) } 50% { transform: scale(1.6) } 100% { transform: scale(1) } }
        </style>
        <circle class="a" cx="20" cy="20" r="6" fill="#fff"/>
        <circle class="b" cx="60" cy="20" r="6" fill="#fff"/>
      </svg>`);
    expect(shapes[0]!.animation?.loop).toBe('cycle');
    expect(shapes[0]!.animation?.duration).toBeCloseTo(1, 6);
    // The delayed one has a real lead-in, so it is unrolled rather than looped
    // — a wrong period is worse than a longer track.
    expect(shapes[1]!.animation?.loop).toBeUndefined();
  });

  it('reports a length it cannot resolve instead of silently dropping the motion', () => {
    // `translateX(100%)` resolved to 0, the track never left its base value and
    // was discarded — the file imported motionless under a toast that said the
    // animation had converted.
    const unsupportedOut = new Set<string>();
    parseSvgToShapes(`
      <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100" width="100" height="100">
        <style>.a{animation:slide 1s linear infinite} @keyframes slide{from{transform:translateX(0)}to{transform:translateX(100%)}}</style>
        <rect class="a" x="0" y="40" width="20" height="20" fill="#fff"/>
      </svg>`, { maxDurationSeconds: 10, unsupportedOut });
    expect([...unsupportedOut].join(' ')).toMatch(/translateX\(100%\)/);
  });
});

describe('SMIL repeat boundaries', () => {
  it('records the ramp of a one-shot animation that does not freeze', () => {
    // Both samples landed on instants where the animation contributes nothing
    // (t=0 is its start value, t=dur is after it has been removed), so the
    // track "never changed" and was dropped: the animation imported as nothing.
    const s = only(parse(
      `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100" width="100" height="100">
         <rect x="10" y="10" width="20" height="20" fill="#fff">
           <animateTransform attributeName="transform" type="translate" from="0 0" to="50 0" dur="1s"/>
         </rect>
       </svg>`));
    const xs = s.animation!.x!;
    expect(Math.max(...xs.map((k) => k.value))).toBeGreaterThan(49);
    // fill="remove" — it reverts at the end, as it does in a browser.
    expect(xs[xs.length - 1]!.value).toBeCloseTo(0, 3);
  });

  it('records every iteration of a finite repeat, including the last', () => {
    const s = only(parse(
      `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100" width="100" height="100">
         <rect x="10" y="10" width="20" height="20" fill="#fff">
           <animateTransform attributeName="transform" type="translate" from="0 0" to="50 0" dur="1s" repeatCount="2"/>
         </rect>
       </svg>`));
    const xs = s.animation!.x!;
    // Two ramps: a peak inside each of [0,1] and [1,2]. The second one was
    // missing — `repeatCount="2"` played once and then sat still.
    const peakIn = (lo: number, hi: number): number =>
      Math.max(...xs.filter((k) => k.time > lo && k.time <= hi).map((k) => k.value), 0);
    expect(peakIn(0, 1)).toBeGreaterThan(49);
    expect(peakIn(1, 2)).toBeGreaterThan(49);
  });
});
