/**
 * The hybrid import contract.
 *
 * The promise this architecture makes is narrow and testable: importing an SVG
 * does NOT run the geometry parser, so a 200-path illustration becomes exactly
 * one layer, and the file itself is what gets rendered. Everything else in the
 * feature (fidelity, warnings, convert) hangs off that, so these guard it
 * directly rather than by proxy.
 *
 * The counterpart cost tests for the ANIMATED route — which still converts to
 * keyframes, because a texture compositor cannot play a stored SVG — live in
 * `scene/svgImportCost.test.ts` and are unchanged by this.
 */

import defaultSceneGraph from '@core/scene/DefaultSceneGraph';
import { insertSvgLayer, insertSvgShapeGroup } from '@core/scene/sceneInsert';
import { readSvgLayer, readRetainedSvgSource, svgLayerSrc, isSvgLayer } from './svgLayer';
import { readNodeKind } from '@core/scene/sceneDerive';
import { convertSvgLayerToShapes, canRevertToSvg, revertSvgGroupToLayer, describeConversion } from './svgConvert';
import { setCommandSystem, CommandSystem } from '@core/commands/CommandSystem';
import * as svgParser from '../../utils/svgParser';

// Convert/revert record ONE undo entry covering both the scene graph and the
// animation engine, so they need a live history to push into.
beforeAll(() => {
  setCommandSystem(new CommandSystem({ services: {} as never, getState: () => ({}) }));
});

/** A static illustration with `n` independent paths. */
function manyPaths(n: number): string {
  let inner = '';
  for (let i = 0; i < n; i += 1) {
    inner += `<path d="M${i} 0 L${i + 5} 0 L${i + 5} 5 L${i} 5 Z" fill="#0af"/>`;
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 400">${inner}</svg>`;
}

const GRADIENT_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">' +
  '<defs><linearGradient id="g"><stop offset="0" stop-color="#f00"/><stop offset="1" stop-color="#00f"/></linearGradient></defs>' +
  '<rect width="100" height="100" fill="url(#g)"/></svg>';

describe('insertSvgLayer', () => {
  it('produces exactly ONE layer for a 200-path file', () => {
    const before = defaultSceneGraph.size;
    const id = insertSvgLayer(manyPaths(200), 'illustration.svg');
    expect(id).not.toBeNull();
    // One node added, with no children — no layer explosion.
    expect(defaultSceneGraph.size).toBe(before + 1);
    expect(defaultSceneGraph.getChildren(id!)).toHaveLength(0);
  });

  it('stores the original markup verbatim, not a re-serialized copy', () => {
    const source = GRADIENT_SVG;
    const id = insertSvgLayer(source, 'logo.svg')!;
    const data = readSvgLayer(defaultSceneGraph.getNode(id)!)!;
    expect(data.sourceMarkup).toBe(source);
    expect(data.fileName).toBe('logo.svg');
  });

  it('reads back as kind "svg" and renders from its own document', () => {
    const id = insertSvgLayer(GRADIENT_SVG, 'logo.svg')!;
    const node = defaultSceneGraph.getNode(id)!;
    expect(readNodeKind(node)).toBe('svg');
    expect(isSvgLayer(node)).toBe(true);
    expect(svgLayerSrc(node)!.startsWith('data:image/svg+xml;base64,')).toBe(true);
  });

  it('hands back the SAME src reference across reads, so the texture is not re-decoded per frame', () => {
    const id = insertSvgLayer(GRADIENT_SVG, 'logo.svg')!;
    const node = defaultSceneGraph.getNode(id)!;
    expect(svgLayerSrc(node)).toBe(svgLayerSrc(node));
  });

  it('scopes ids per layer, so two copies cannot share a gradient', () => {
    const a = insertSvgLayer(GRADIENT_SVG, 'logo.svg')!;
    const b = insertSvgLayer(GRADIENT_SVG, 'logo.svg')!;
    const ma = readSvgLayer(defaultSceneGraph.getNode(a)!)!.sanitizedMarkup;
    const mb = readSvgLayer(defaultSceneGraph.getNode(b)!)!.sanitizedMarkup;
    expect(ma).not.toEqual(mb);
    expect(ma).toMatch(/url\(#[\w]+__g\)/);
  });

  it('carries the capability scan onto the layer', () => {
    const id = insertSvgLayer('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><text>hi</text></svg>', 'text.svg')!;
    const data = readSvgLayer(defaultSceneGraph.getNode(id)!)!;
    expect(data.capabilities.hasText).toBe(true);
  });

  it('returns null rather than inserting a broken layer for unreadable markup', () => {
    const before = defaultSceneGraph.size;
    expect(insertSvgLayer('not an svg', 'bad.svg')).toBeNull();
    expect(defaultSceneGraph.size).toBe(before);
  });
});

describe('import cost', () => {
  /** A large file whose bytes are almost entirely path geometry. */
  function bigSvg(minBytes: number): string {
    let inner = '';
    while (inner.length < minBytes) {
      inner += '<path d="M0 0 C10 10 20 20 30 30 L40 40 L50 50 Z" fill="#123456" stroke="#abcdef"/>';
    }
    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 400">${inner}</svg>`;
  }

  it('never invokes the geometry parser', () => {
    // §10 asks for <50ms on a 1MB file. That is a Chromium number, and jsdom is
    // far slower at DOM work than at the string work the parser does — so any
    // wall-clock or ratio assertion here would measure jsdom, not us.
    //
    // The invariant UNDERNEATH the budget is exact and hardware-independent:
    // import must not run the parse. That is the entire architectural claim,
    // and it is the thing a future change would silently undo.
    const spy = jest.spyOn(svgParser, 'parseSvgToShapes');
    try {
      const id = insertSvgLayer(bigSvg(300_000), 'huge.svg');
      expect(id).not.toBeNull();
      expect(defaultSceneGraph.getChildren(id!)).toHaveLength(0);
      expect(spy).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });

  /**
   * The scan was O(n²) once: a live HTMLCollection whose indexed access
   * re-walks the tree made a 1MB file take 33 SECONDS. This is the only test
   * here that can see that, because the difference is entirely in the cost.
   *
   * ── Why it is shaped the way it is ──────────────────────────────────────
   *
   * It used to time each size ONCE, at a 2× size ratio, against a ceiling of
   * 3 — and it failed under parallel jest load while passing in isolation.
   * Two separate reasons, and only one of them was noise:
   *
   *  1. **A floor that biases the ratio upward.** `Math.max(1, smallMs)` meant
   *     that once the small import dropped under a millisecond — which it does
   *     on any current machine — the denominator stopped being a measurement.
   *     The ratio then read `largeMs / 1`, which exceeds 3 whenever the large
   *     import takes 3ms, with nothing quadratic anywhere. That is a test that
   *     gets FLAKIER as hardware gets faster.
   *  2. **One sample of a one-sided distribution.** A descheduled worker or a
   *     GC pause only ever makes a timing LONGER. A single sample is therefore
   *     an upper bound, not an estimate, and dividing two upper bounds gives a
   *     number that can move in either direction by a lot.
   *
   * So: take the MINIMUM of several runs (the right statistic when the noise
   * is one-sided — the fastest run is the one that was interrupted least), and
   * widen the size ratio rather than tightening the ceiling. At 4× the input,
   * linear costs ~4× and quadratic ~16×; a ceiling of 8 sits an entire factor
   * of two clear of both, which is what makes it robust. The regression this
   * guards against was four orders of magnitude, not a factor of three — the
   * test never needed to be sensitive, only reliable.
   */
  it('stays linear in file size — no quadratic scan', () => {
    const small = bigSvg(150_000);
    const large = bigSvg(600_000);

    const bestOf = (runs: number, markup: string, name: string): number => {
      let best = Infinity;
      for (let i = 0; i < runs; i += 1) {
        const t = performance.now();
        insertSvgLayer(markup, name);
        best = Math.min(best, performance.now() - t);
      }
      return best;
    };

    // Warm the parse path once so JIT compilation is not charged to the first
    // measured size — it is otherwise a fixed cost paid entirely by `small`,
    // which shrinks the ratio and would hide a real regression.
    insertSvgLayer(bigSvg(20_000), 'warmup.svg');

    const smallMs = bestOf(3, small, 'small.svg');
    const largeMs = bestOf(3, large, 'large.svg');

    // No artificial floor. If the timer cannot resolve the small case there is
    // no ratio to test, and saying so is better than substituting a constant
    // for a measurement — which is exactly what the old floor did.
    expect(smallMs).toBeGreaterThan(0);
    expect(largeMs / smallMs).toBeLessThan(8);
  });
});

describe('describeConversion', () => {
  it('states the layer count the user is about to get', () => {
    const id = insertSvgLayer(manyPaths(47), 'many.svg')!;
    const data = readSvgLayer(defaultSceneGraph.getNode(id)!)!;
    expect(describeConversion(data).join(' ')).toMatch(/47 layers/);
  });
});

describe('convert and revert', () => {
  it('replaces the SVG layer with real shape layers', () => {
    const id = insertSvgLayer(manyPaths(6), 'six.svg')!;
    const groupId = convertSvgLayerToShapes(id);

    expect(groupId).not.toBeNull();
    expect(defaultSceneGraph.getNode(id)).toBeUndefined();
    expect(defaultSceneGraph.getChildren(groupId!).length).toBeGreaterThan(1);
  });

  it('retains the original on the group, and reverting restores it exactly', () => {
    const source = manyPaths(4);
    const id = insertSvgLayer(source, 'four.svg')!;
    const groupId = convertSvgLayerToShapes(id)!;

    expect(canRevertToSvg(groupId)).toBe(true);
    expect(readRetainedSvgSource(defaultSceneGraph.getNode(groupId)!)!.markup).toBe(source);

    const backId = revertSvgGroupToLayer(groupId)!;
    expect(defaultSceneGraph.getNode(groupId)).toBeUndefined();
    expect(readSvgLayer(defaultSceneGraph.getNode(backId)!)!.sourceMarkup).toBe(source);
  });

  it('does not offer revert on an SVG layer — it is already the original', () => {
    const id = insertSvgLayer(manyPaths(3), 'three.svg')!;
    expect(canRevertToSvg(id)).toBe(false);
  });

  it('reproduces exactly what today\'s import pipeline produces', () => {
    // §10: converting must be a no-regression path onto the EXISTING behaviour.
    // If the two ever diverge, users who convert get something subtly different
    // from what the same file used to import as, and nothing would say so.
    const source = manyPaths(9);

    const direct = insertSvgShapeGroup(source, 'direct.svg');
    const viaLayer = convertSvgLayerToShapes(insertSvgLayer(source, 'direct.svg')!);
    expect(direct).not.toBeNull();
    expect(viaLayer).not.toBeNull();

    /** The shape of a converted group, ignoring generated ids and positions. */
    const describe_ = (groupId: string) =>
      defaultSceneGraph.getChildren(groupId).map((child) => ({
        kind: readNodeKind(child),
        fill: child.components.find((c) => c.type === 'Style')?.props.fill,
        points: (child.components.find((c) => c.type === 'Geometry')?.props.points as unknown[] | undefined)?.length,
      }));

    expect(describe_(viaLayer!)).toEqual(describe_(direct!));
  });

  it('parses the ORIGINAL markup, not the id-scoped copy', () => {
    // The parser resolves url(#grad) by bare name; feeding it the scoped copy
    // would break exactly the fills the user converted in order to edit.
    const id = insertSvgLayer(GRADIENT_SVG, 'grad.svg')!;
    const groupId = convertSvgLayerToShapes(id);
    expect(groupId).not.toBeNull();
    expect(defaultSceneGraph.getChildren(groupId!).length).toBeGreaterThan(0);
  });
});
