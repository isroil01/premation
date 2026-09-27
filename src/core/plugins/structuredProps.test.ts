/**
 * Structured property writes — paths, gradients and strokes through the plugin
 * API.
 *
 * Two things are under test and they pull in opposite directions. One is that a
 * plugin can now express geometry at all, which is the feature. The other is
 * that everything arriving here crossed `postMessage` and is hostile until
 * parsed — so most of these cases are REFUSALS, and each one checks that the
 * document was not touched on the way to the error. A validator that rejects
 * after writing half the value is worse than no validator, because the layer is
 * left in a state neither the plugin nor the user asked for.
 */

import defaultSceneGraph from '@core/scene/DefaultSceneGraph';
import { getNodeStroke } from '@core/paint/stroke';
import { setupAppEngine } from '@core/engine/__testHelpers__/appEngine';
import type { Harness } from '@core/engine/__testHelpers__/harness';
import type { LocalEngine } from '@core/engine/LocalEngine';
import { createHostApi } from './hostApi';
import { MAX_PATH_POINTS, MAX_GRADIENT_STOPS, STRUCTURED_PROP_NAMES } from './structuredProps';
import type { PluginManifest } from './manifest';

const manifest = {
  id: 'studio.acme.gen',
  name: 'Generator',
  version: '1.0.0',
  description: 'Builds shapes.',
  apiVersion: 2,
  main: 'main.js',
  permissions: ['scene:write'],
  activationEvents: ['onStartup'],
  contributes: { commands: [], panels: [], layerKinds: [], effects: [], net: null },
} as unknown as PluginManifest;

const api = createHostApi(manifest, {
  registerCommand: () => {},
  openPanel: () => {},
  closePanel: () => {},
  warn: () => {},
  granted: () => new Set(['scene:write']) as never,
});

let h: Harness & { engine: LocalEngine };

/** A shape layer of the active composition, made through the engine (B5: the plugin verbs are engine commands). */
async function newLayer(): Promise<string> {
  return (await h.run({ type: 'createLayer', comp: 'comp_root', kind: 'shape', name: 'Shape', init: [] })).layer;
}

/** The `Geometry` component's props, which is where an outline lands. */
function geometry(id: string): Record<string, unknown> | undefined {
  return defaultSceneGraph.getNode(id)?.components.find((c) => c.type === 'Geometry')?.props as
    | Record<string, unknown>
    | undefined;
}

const setProp = (id: string, prop: string, value: unknown): unknown =>
  api['scene.setProperty']!(id, prop, value);

beforeEach(async () => { h = await setupAppEngine(); });
afterEach(async () => { await h.dispose(); });

describe('geometry', () => {
  it('writes an outline a plugin built', async () => {
    const id = await newLayer();
    expect(await setProp(id, 'points', [
      { x: -50, y: -50 },
      { x: 50, y: -50 },
      { x: 0, y: 50 },
    ])).toBe(true);

    const pts = geometry(id)!.points as Array<Record<string, number>>;
    expect(pts).toHaveLength(3);
    expect(pts[1]).toEqual({ x: 50, y: -50, inX: 0, inY: 0, outX: 0, outY: 0 });
  });

  it('★ defaults the tangents, so a polyline is {x, y} and nothing else', async () => {
    // The shape a generator writes first. Requiring all six fields would make
    // the simplest possible plugin four times longer for no expressive gain.
    const id = await newLayer();
    await setProp(id, 'points', [{ x: 0, y: 0 }, { x: 10, y: 10 }]);
    expect((geometry(id)!.points as Array<Record<string, number>>)[0]).toEqual({
      x: 0, y: 0, inX: 0, inY: 0, outX: 0, outY: 0,
    });
  });

  it('keeps the curve handles an author did supply', async () => {
    const id = await newLayer();
    await setProp(id, 'points', [{ x: 0, y: 0, inX: -5, inY: 0, outX: 5, outY: 0 }]);
    expect((geometry(id)!.points as Array<Record<string, number>>)[0]).toMatchObject({ inX: -5, outX: 5 });
  });

  it('writes several outlines through subpaths', async () => {
    const id = await newLayer();
    expect(await setProp(id, 'subpaths', [
      { points: [{ x: 0, y: 0 }, { x: 10, y: 0 }] },
      { points: [{ x: 2, y: 2 }, { x: 8, y: 2 }], open: true },
    ])).toBe(true);
    const subs = geometry(id)!.subpaths as Array<{ points: unknown[]; open: boolean }>;
    expect(subs).toHaveLength(2);
    expect(subs[0]!.open).toBe(false); // closed by default
    expect(subs[1]!.open).toBe(true);
  });
});

describe('the value is parsed, not cast', () => {
  it('★ refuses NaN rather than storing a path with no bounds', async () => {
    // This is the case that matters most. `NaN` propagates silently into the
    // rasterizer and the hit-tester, where it becomes a layer that cannot be
    // drawn, measured or clicked — and nothing points back at the plugin.
    const id = await newLayer();
    expect(() => setProp(id, 'points', [{ x: Number.NaN, y: 0 }])).toThrow(/finite number/);
    expect(geometry(id)?.points).not.toEqual([{ x: Number.NaN, y: 0, inX: 0, inY: 0, outX: 0, outY: 0 }]);
  });

  it('refuses Infinity for the same reason', async () => {
    const id = await newLayer();
    expect(() => setProp(id, 'points', [{ x: 0, y: Number.POSITIVE_INFINITY }])).toThrow(/finite number/);
  });

  it('names the offending index, so an author can find it in a generated path', async () => {
    const id = await newLayer();
    expect(() => setProp(id, 'points', [{ x: 0, y: 0 }, { x: 1, y: 'up' }])).toThrow(/points\[1\]\.y/);
  });

  it('★ refuses a path past the bound instead of clamping it', async () => {
    // Clamping would hand back a path that is not the one the plugin built,
    // with no way to notice. The bound is a refusal on purpose.
    const id = await newLayer();
    const huge = Array.from({ length: MAX_PATH_POINTS + 1 }, (_, i) => ({ x: i, y: 0 }));
    expect(() => setProp(id, 'points', huge)).toThrow(/limit is 10000/);
  });

  it('★ leaves the document untouched when validation fails partway', async () => {
    // The parse walks the array in order, so a bad point at the end is the case
    // where a careless implementation has already written the good ones.
    const id = await newLayer();
    await setProp(id, 'points', [{ x: 1, y: 1 }]);
    const before = JSON.stringify(geometry(id)!.points);

    expect(() => setProp(id, 'points', [
      { x: 2, y: 2 }, { x: 3, y: 3 }, { x: 4, y: Number.NaN },
    ])).toThrow();
    expect(JSON.stringify(geometry(id)!.points)).toBe(before);
  });

  it('refuses a prototype-polluting key', async () => {
    const id = await newLayer();
    const evil = JSON.parse('[{"x":0,"y":0,"__proto__":{"polluted":true}}]') as unknown;
    expect(() => setProp(id, 'points', evil)).toThrow(/__proto__/);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });
});

describe('paint', () => {
  it('sets a solid fill', async () => {
    const id = await newLayer();
    expect(await setProp(id, 'fillPaint', { type: 'solid', color: '#ff0000' })).toBe(true);
  });

  it('sets a gradient and MINTS the stop ids itself', async () => {
    // An id arriving from a worker is either a collision with a host-generated
    // one or a handle to something the plugin should not be able to name.
    const id = await newLayer();
    expect(await setProp(id, 'fillPaint', {
      type: 'linear',
      angle: 45,
      stops: [{ offset: 0, color: '#000000' }, { offset: 1, color: '#ffffff' }],
    })).toBe(true);

    const fill = defaultSceneGraph.getNode(id)!.components
      .flatMap((c) => Object.values(c.props as Record<string, unknown>))
      .find((v): v is { type: string; stops: Array<{ id: string }> } =>
        typeof v === 'object' && v !== null && (v as { type?: string }).type === 'linear');
    expect(fill).toBeDefined();
    for (const stop of fill!.stops) expect(typeof stop.id).toBe('string');
  });

  it('★ ignores a stop id the plugin supplied', async () => {
    const id = await newLayer();
    await setProp(id, 'fillPaint', {
      type: 'linear',
      stops: [
        { offset: 0, color: '#000000', id: 'forged' },
        { offset: 1, color: '#ffffff', id: 'forged' },
      ],
    });
    // Only the components — a SceneNode holds parent/child back-references and
    // does not survive JSON.stringify.
    const json = JSON.stringify(defaultSceneGraph.getNode(id)!.components);
    expect(json).not.toContain('forged');
  });

  it('refuses a colour the renderers do not agree on', async () => {
    const id = await newLayer();
    expect(() => setProp(id, 'fillPaint', { type: 'solid', color: 'red' })).toThrow(/hex colour/);
    expect(() => setProp(id, 'fillPaint', { type: 'solid', color: 'rgb(1,2,3)' })).toThrow(/hex colour/);
  });

  it('accepts #rgb, #rrggbb and #rrggbbaa', async () => {
    const id = await newLayer();
    for (const c of ['#f00', '#ff0000', '#ff0000cc']) {
      expect(await setProp(id, 'fillPaint', { type: 'solid', color: c })).toBe(true);
    }
  });

  it('refuses a one-stop gradient, which has no ramp', async () => {
    const id = await newLayer();
    expect(() => setProp(id, 'fillPaint', {
      type: 'linear', stops: [{ offset: 0, color: '#000000' }],
    })).toThrow(/at least two stops/);
  });

  it('refuses more stops than the bound', async () => {
    const id = await newLayer();
    const stops = Array.from({ length: MAX_GRADIENT_STOPS + 1 }, () => ({ offset: 0, color: '#000000' }));
    expect(() => setProp(id, 'fillPaint', { type: 'linear', stops })).toThrow(/limit is 64/);
  });

  it('refuses an unknown paint type by naming the three that exist', async () => {
    const id = await newLayer();
    expect(() => setProp(id, 'fillPaint', { type: 'conic', stops: [] })).toThrow(/solid.*linear.*radial/);
  });
});

describe('stroke', () => {
  it('sets width and colour', async () => {
    const id = await newLayer();
    expect(await setProp(id, 'stroke', { width: 4, color: '#00ff00' })).toBe(true);
    const s = getNodeStroke(id)!;
    expect(s.width).toBe(4);
    expect(s.color).toBe('#00ff00');
  });

  it('★ patches rather than replaces, so setting width keeps the cap', async () => {
    // A stroke has ten fields. An author changing one should not have to
    // restate the other nine to avoid resetting them to defaults.
    const id = await newLayer();
    await setProp(id, 'stroke', { width: 4, color: '#00ff00', cap: 'round', dash: [6, 3] });
    await setProp(id, 'stroke', { width: 9 });

    const s = getNodeStroke(id)!;
    expect(s.width).toBe(9);
    expect(s.cap).toBe('round');
    expect(s.dash).toEqual([6, 3]);
    expect(s.color).toBe('#00ff00');
  });

  it('refuses an alignment that is not one of the three', async () => {
    const id = await newLayer();
    expect(() => setProp(id, 'stroke', { align: 'middle' })).toThrow(/inside, center, outside/);
  });

  it('refuses a negative width', async () => {
    const id = await newLayer();
    expect(() => setProp(id, 'stroke', { width: -1 })).toThrow(/between 0 and/);
  });
});

describe('the gate around all of it', () => {
  it('★ refuses a structured value on a prop that does not take one, and lists the ones that do', async () => {
    const id = await newLayer();
    let message = '';
    try { setProp(id, 'opacity', { type: 'solid', color: '#ff0000' }); }
    catch (e) { message = (e as Error).message; }
    expect(message).toMatch(/does not take a structured value/);
    for (const name of STRUCTURED_PROP_NAMES) expect(message).toContain(name);
  });

  it('still refuses a scalar of the wrong type, and now points at the structured props', async () => {
    const id = await newLayer();
    expect(() => setProp(id, 'opacity', (() => undefined) as unknown)).toThrow(/number, string or boolean/);
  });

  it('leaves ordinary scalar writes exactly as they were', async () => {
    const id = await newLayer();
    // An engine `setProperty` since B5: the verb resolves.
    expect(await setProp(id, 'opacity', 50)).toBe(true);
  });

  it('★ refuses null, which typeof calls an object', async () => {
    // `typeof null === 'object'` is the oldest trap in JS, and the routing
    // check here is a typeof. Without the explicit null test it would reach
    // the structured planner and fail with a message about paths.
    const id = await newLayer();
    expect(() => setProp(id, 'points', null)).toThrow(/number, string or boolean/);
  });
});
