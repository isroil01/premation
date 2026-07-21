/**
 * Precomp isolation + particle routing in snapshotToFrameScene.
 *
 * Pins the isolation DECISION (when a container must render offscreen and
 * composite as one unit vs. the inline-collapse fast path) and the shape of the
 * emitted renderables: an isolated container becomes ONE textured renderable
 * carrying its subtree; a particle layer becomes a `particles:`-textured quad —
 * never the comp-sized black solid its carrier layer describes.
 */

import { snapshotToFrameScene, precompNeedsIsolation } from './snapshotToFrameScene';
import { DEFAULT_PARTICLE_CONFIG } from '@core/particles/particleSim';
import type { RenderLayer, RenderSnapshot } from './RenderBackend';

const layer = (over: Partial<RenderLayer> = {}): RenderLayer => ({
  id: over.id ?? 'l1',
  kind: 'shape',
  x: 100, y: 100, rotation: 0, scaleX: 1, scaleY: 1,
  opacity: 1,
  width: 50, height: 50,
  fill: '#ff0000',
  visible: true,
  ...over,
});

const container = (over: Partial<RenderLayer> = {}, children: RenderLayer[] = [layer({ id: 'c1' }), layer({ id: 'c2' })]): RenderLayer =>
  layer({
    id: 'group',
    x: 960, y: 540, width: 1920, height: 1080,
    fill: '#000',
    precompLayers: children,
    ...over,
  });

const snap = (layers: RenderLayer[]): RenderSnapshot => ({
  width: 1920, height: 1080, background: '#101014', layers,
});

describe('precompNeedsIsolation', () => {
  test('plain full-opacity container collapses inline', () => {
    expect(precompNeedsIsolation(container())).toBe(false);
  });

  test('group opacity < 1 over multiple children isolates', () => {
    expect(precompNeedsIsolation(container({ opacity: 0.5 }))).toBe(true);
  });

  test('group opacity < 1 over a SINGLE child stays collapsed (opacity folds)', () => {
    expect(precompNeedsIsolation(container({ opacity: 0.5 }, [layer({ id: 'only' })]))).toBe(false);
  });

  test('non-normal blend / mask / effects / matte-source all isolate', () => {
    expect(precompNeedsIsolation(container({ blend: 'screen' }))).toBe(true);
    expect(precompNeedsIsolation(container({ mask: { paths: [{ points: [], inverted: false, mode: 'add', feather: 0, closed: true } as never] } as never }))).toBe(true);
    expect(precompNeedsIsolation(container({ effects: [{ id: 'b', type: 'blur', params: { amount: 4 } }] }))).toBe(true);
    expect(precompNeedsIsolation(container({ isMatteSource: true }))).toBe(true);
  });

  test('a non-container layer never isolates', () => {
    expect(precompNeedsIsolation(layer({ opacity: 0.5, blend: 'screen' }))).toBe(false);
  });
});

describe('snapshotToFrameScene precomp routing', () => {
  test('collapse fast path: children flatten inline, opacity multiplies', () => {
    const scene = snapshotToFrameScene(snap([container({ opacity: 1 })]));
    const ids = scene.renderables.map((r) => r.id);
    expect(ids).toEqual(['c1', 'c2']);
    expect(scene.renderables.every((r) => r.precomp === undefined)).toBe(true);
  });

  test('isolation: ONE textured renderable carries the subtree', () => {
    const scene = snapshotToFrameScene(snap([container({ opacity: 0.5 })]));
    expect(scene.renderables).toHaveLength(1);
    const group = scene.renderables[0]!;
    expect(group.id).toBe('group');
    expect(group.kind).toBe('image');
    expect(group.textureKey).toBe('precomp:group');
    expect(group.opacity).toBeCloseTo(0.5, 6);
    expect(group.precomp?.renderables.map((r) => r.id)).toEqual(['c1', 'c2']);
    // Children isolate at FULL opacity — the group fade applies to the unit.
    for (const child of group.precomp!.renderables) expect(child.opacity).toBe(1);
  });

  test('isolated container keeps its blend and effects on the composite', () => {
    const scene = snapshotToFrameScene(snap([
      container({ blend: 'screen', effects: [{ id: 'b', type: 'blur', params: { amount: 6 } }] }),
    ]));
    const group = scene.renderables[0]!;
    expect(group.advancedBlend).toBeGreaterThan(0); // screen routes via combine
    expect(group.effects).toEqual([{ type: 'blur', radiusPx: 6 }]);
  });

  test('nested isolation: inner isolated group survives inside the outer payload', () => {
    const inner = container({ id: 'inner', opacity: 0.5 });
    const outer = container({ id: 'outer', opacity: 0.5 }, [inner, layer({ id: 'sib' })]);
    const scene = snapshotToFrameScene(snap([outer]));
    const out = scene.renderables[0]!;
    expect(out.precomp?.renderables.map((r) => r.id)).toEqual(['inner', 'sib']);
    const nested = out.precomp!.renderables[0]!;
    expect(nested.textureKey).toBe('precomp:inner');
    expect(nested.precomp?.renderables.map((r) => r.id)).toEqual(['c1', 'c2']);
  });
});

describe('snapshotToFrameScene particle routing', () => {
  test('a particle layer renders as its rasterized field, not a black solid', () => {
    const scene = snapshotToFrameScene(snap([
      layer({
        id: 'emit',
        x: 960, y: 540, width: 1920, height: 1080, fill: '#000',
        particles: { ...DEFAULT_PARTICLE_CONFIG },
      }),
    ]));
    expect(scene.renderables).toHaveLength(1);
    const r = scene.renderables[0]!;
    expect(r.kind).toBe('image');
    expect(r.textureKey).toBe('particles:emit');
    expect(r.sdf).toBeUndefined();
    // 'add' transfer (the default) composites the field additively (glow).
    expect(r.blend).toBe('add');
    // white tint — the field texture carries the colour.
    expect(r.color).toEqual({ r: 1, g: 1, b: 1, a: 1 });
  });

  test("'normal' transfer keeps normal compositing", () => {
    const scene = snapshotToFrameScene(snap([
      layer({ id: 'emit', particles: { ...DEFAULT_PARTICLE_CONFIG, blend: 'normal' } }),
    ]));
    expect(scene.renderables[0]!.blend).toBe('normal');
  });

  test('a particle matte source routes its field texture, flagged', () => {
    const scene = snapshotToFrameScene(snap([
      layer({ id: 'emit', particles: { ...DEFAULT_PARTICLE_CONFIG }, isMatteSource: true }),
      layer({ id: 'matted', matte: 'alpha' as never, matteSourceId: 'emit' }),
    ]));
    const src = scene.renderables.find((r) => r.id === 'emit')!;
    expect(src.matteSource).toBe(true);
    expect(src.textureKey).toBe('particles:emit');
  });
});
