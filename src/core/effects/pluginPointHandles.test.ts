/**
 * On-canvas handles for a plugin's `point` parameters.
 *
 * The arithmetic is here, in a pure module, for the reason
 * `EffectHandleOverlay` states about its own: hit-testing and drag maths can be
 * tested and pointer plumbing cannot, so the untestable part should be the
 * smallest possible and contain no decisions.
 */

import {
  collectPluginPointHandles,
  hasPluginPointHandles,
  hitTestPointHandle,
  pointDragValue,
} from './pluginPointHandles';
import type { EffectContribution } from '@core/plugins/effectSchema';

const FS = '@fragment fn fs(@location(0) uv : vec2<f32>) -> @location(0) vec4<f32> {\n'
  + '  return textureSample(src, samp, uv);\n}';

const effect = (params: EffectContribution['params']): EffectContribution =>
  ({ id: 'fx', label: 'FX', shader: FS, params });

const POINT = (def: { x: number; y: number }, label?: string) =>
  ({ type: 'point' as const, default: def, ...(label ? { label } : {}) });

describe('finding the handles', () => {
  it('returns one per point parameter, at its live value', () => {
    const e = effect({ centre: POINT({ x: 0, y: 0 }), amount: { type: 'number', default: 1 } });
    expect(collectPluginPointHandles(e, { centre: { x: 120, y: -8 }, amount: 3 }))
      .toEqual([{ param: 'centre', label: 'centre', pos: { x: 120, y: -8 } }]);
  });

  it('★ prefers the LIVE value over the declared default', () => {
    /*
      A handle drawn from the declared value on an effect the user has already
      adjusted sits where the parameter used to be — and invites a drag that
      jumps the moment it is grabbed.
    */
    const e = effect({ centre: POINT({ x: 0, y: 0 }) });
    expect(collectPluginPointHandles(e, { centre: { x: 50, y: 60 } })[0]!.pos)
      .toEqual({ x: 50, y: 60 });
  });

  it('falls back to the declared default when the value is unset', () => {
    // An effect nobody has touched still has a position. A handle at (0,0) —
    // the composition's top-left corner — reads as a bug, not a default.
    const e = effect({ centre: POINT({ x: 32, y: 48 }) });
    expect(collectPluginPointHandles(e, {})[0]!.pos).toEqual({ x: 32, y: 48 });
  });

  it('falls back through a MALFORMED value, not just a missing one', () => {
    // A half-written point from a bad expression or a hand-edited document
    // must not put a handle at NaN, where it is invisible and unclickable.
    const e = effect({ centre: POINT({ x: 5, y: 6 }) });
    for (const bad of [null, 'nope', [1, 2], { x: 1 }, { x: Number.NaN, y: 2 }]) {
      expect(collectPluginPointHandles(e, { centre: bad })[0]!.pos).toEqual({ x: 5, y: 6 });
    }
  });

  it('uses the author label when there is one', () => {
    const e = effect({ centre: POINT({ x: 0, y: 0 }, 'Light Position') });
    expect(collectPluginPointHandles(e, {})[0]!.label).toBe('Light Position');
  });

  it('never leaves the label blank', () => {
    // It is the handle's accessible name. An unnamed control on a canvas is
    // unreachable rather than merely unlabelled.
    const e = effect({ centre: POINT({ x: 0, y: 0 }, '   ') });
    expect(collectPluginPointHandles(e, {})[0]!.label).toBe('centre');
  });

  it('ignores every other parameter type', () => {
    const e = effect({
      amount: { type: 'number', default: 1 },
      tint: { type: 'color', default: '#fff' },
      on: { type: 'boolean', default: true },
      // `layer` carries no default — it is a reference, and no id a package
      // names exists in someone else's project.
      map: { type: 'layer', default: null } as unknown as EffectContribution['params'][string],
    });
    expect(collectPluginPointHandles(e, {})).toEqual([]);
    expect(hasPluginPointHandles(e)).toBe(false);
  });

  it('reports several points in declaration order', () => {
    const e = effect({ from: POINT({ x: 0, y: 0 }), to: POINT({ x: 10, y: 10 }) });
    expect(collectPluginPointHandles(e, {}).map((h) => h.param)).toEqual(['from', 'to']);
    expect(hasPluginPointHandles(e)).toBe(true);
  });
});

describe('grabbing one', () => {
  const identity = (p: { x: number; y: number }) => p;
  const handles = [
    { param: 'a', label: 'A', pos: { x: 100, y: 100 } },
    { param: 'b', label: 'B', pos: { x: 140, y: 100 } },
  ];

  it('grabs the one under the pointer', () => {
    expect(hitTestPointHandle(handles, { x: 102, y: 98 }, identity, 10)?.param).toBe('a');
    expect(hitTestPointHandle(handles, { x: 138, y: 101 }, identity, 10)?.param).toBe('b');
  });

  it('grabs nothing outside the radius', () => {
    expect(hitTestPointHandle(handles, { x: 120, y: 100 }, identity, 10)).toBeNull();
  });

  it('★ takes the NEAREST when two are in range, not the first declared', () => {
    /*
      Two points at the same place is a real state — a plugin whose defaults
      coincide until the user separates them — and "first declared wins,
      forever" makes the second one impossible to grab.
    */
    const overlapping = [
      { param: 'a', label: 'A', pos: { x: 100, y: 100 } },
      { param: 'b', label: 'B', pos: { x: 106, y: 100 } },
    ];
    expect(hitTestPointHandle(overlapping, { x: 105, y: 100 }, identity, 20)?.param).toBe('b');
  });

  it('hit-tests in SCREEN space, through the projection it is given', () => {
    /*
      The radius is screen pixels. Testing in composition units would make a
      handle unhittable zoomed out and enormous zoomed in — which is why the
      projection is a parameter rather than assumed to be identity.
    */
    const zoomedOut = (p: { x: number; y: number }) => ({ x: p.x / 10, y: p.y / 10 });
    // 100,100 in comp is 10,10 on screen. A press at 12,10 is 2px away there
    // and 20 units away in comp — inside a 5px radius, outside a 5-unit one.
    expect(hitTestPointHandle(handles, { x: 12, y: 10 }, zoomedOut, 5)?.param).toBe('a');
  });
});

describe('dragging one', () => {
  it('★ applies the grab offset, so the handle does not jump', () => {
    /*
      Grab a handle 6px off its centre and the value must move by what the
      POINTER moved, not snap the centre under the cursor. A fraction of a
      pixel when you grab dead centre; very obvious when you grab the edge.
    */
    const v = pointDragValue({ x: 106, y: 100 }, { x: 100, y: 100 }, { x: 126, y: 130 });
    expect(v).toEqual({ x: 120, y: 130 });
  });

  it('is an identity when the pointer has not moved', () => {
    expect(pointDragValue({ x: 106, y: 100 }, { x: 100, y: 100 }, { x: 106, y: 100 }))
      .toEqual({ x: 100, y: 100 });
  });

  it('lets a point be dragged outside the composition', () => {
    // Not clamped. A light or a vignette centre off-frame is ordinary, and the
    // schema deliberately does not range-check a position either.
    expect(pointDragValue({ x: 0, y: 0 }, { x: 0, y: 0 }, { x: -500, y: -900 }))
      .toEqual({ x: -500, y: -900 });
  });
});
