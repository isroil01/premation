/**
 * Path mode — clones along another layer's outline.
 *
 * Two layers of risk, tested separately. The PLAN half is spacing arithmetic
 * with the same failure mode radial had: a closed loop that divides by n-1
 * puts its last clone on its first, an open line that divides by n stops short
 * of its far end, and both composite into "the count looks off by one". The
 * RENDERER half is resolution: the clones must sit on the curve that is
 * actually drawn — same transform chain, same bezier flattening — which is why
 * `pathOf` goes through `nodeWorldOutline`, the exact function the boolean ops
 * use, rather than a second implementation that drifts.
 */

import defaultSceneGraph from './DefaultSceneGraph';
import { SCENE_KIND_PROP } from './seedDefaultScene';
import { buildSnapshot } from '@core/rendering/buildSnapshot';
import { defaultAnimation } from '@motion/animation';
import { useProjectStore } from '@stores/projectStore';
import { CLONER_PROP } from './clonerExpand';
import { clonerPlan, DEFAULT_CLONER, type ClonerConfig, type PathGeometry } from './cloner';
import type { SceneNode } from '@core/types';

const COMP = {
  width: 1920, height: 1080, fps: 30, durationSeconds: 10,
  background: '#000', transparent: false, startFrame: 0,
};

const cfg = (patch: Partial<ClonerConfig> = {}): ClonerConfig => ({
  ...DEFAULT_CLONER, enabled: true, ...patch,
});

// ── The plan ──────────────────────────────────────────────────────────

describe('spacing along a path (plan)', () => {
  const square: PathGeometry = {
    // 100×100 square, corner-anchored polyline.
    points: [
      { x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 100 }, { x: 0, y: 100 },
    ],
    closed: true,
  };
  const line: PathGeometry = {
    points: [{ x: 0, y: 0 }, { x: 300, y: 0 }],
    closed: false,
  };

  it('a CLOSED path divides by n — the last clone must not sit on the first', () => {
    // Perimeter 400, 4 clones → one per corner-ish, spaced 100 apart in arc
    // length. Dividing by n-1 would put clone 3 back at (0,0) under clone 0.
    const p = clonerPlan(cfg({ mode: 'path', count: 4 }), null, square);
    expect(p.map((c) => [Math.round(c.x), Math.round(c.y)])).toEqual([
      [0, 0], [100, 0], [100, 100], [0, 100],
    ]);
  });

  it('an OPEN path divides by n-1 — the clones reach BOTH ends', () => {
    const p = clonerPlan(cfg({ mode: 'path', count: 4 }), null, line);
    expect(p.map((c) => Math.round(c.x))).toEqual([0, 100, 200, 300]);
  });

  it('Follow rotates each clone to the path tangent', () => {
    const p = clonerPlan(cfg({ mode: 'path', count: 3, alignToRadius: true }), null, {
      points: [{ x: 0, y: 0 }, { x: 100, y: 100 }],
      closed: false,
    });
    // A 45°-up-right line: every tangent is 45°.
    for (const c of p) expect(Math.round(c.rotation)).toBe(45);
  });

  it('without Follow, clones keep rotation 0 from the arrangement', () => {
    const p = clonerPlan(cfg({ mode: 'path', count: 3 }), null, line);
    expect(p.every((c) => c.rotation === 0)).toBe(true);
  });

  it('a MISSING path falls back to the linear arrangement, not a stack at the origin', () => {
    // Same philosophy as a missing field driver: the broken half must be the
    // path picker, not the whole control — a pile of clones at (0,0) reads as
    // "the cloner broke" with nothing to diagnose from.
    const p = clonerPlan(cfg({ mode: 'path', count: 3, offsetX: 100, offsetY: 0 }), null, null);
    expect(p.map((c) => Math.round(c.x))).toEqual([-100, 0, 100]);
  });

  it('effectors apply ON TOP of the path arrangement', () => {
    const p = clonerPlan(
      cfg({ mode: 'path', count: 2, step: { ...DEFAULT_CLONER.step, y: 80 } }),
      null,
      line,
    );
    // Clone 1 (t=1) takes the full step ramp in y; its path position holds.
    expect(Math.round(p[1]!.x)).toBe(300);
    expect(Math.round(p[1]!.y)).toBe(80);
  });

  it('a single clone sits at the path start', () => {
    const p = clonerPlan(cfg({ mode: 'path', count: 1 }), null, line);
    expect([Math.round(p[0]!.x), Math.round(p[0]!.y)]).toEqual([0, 0]);
  });
});

// ── Through the renderer ──────────────────────────────────────────────

function resetScene(): void {
  const ids: string[] = [];
  defaultSceneGraph.traverse((n) => ids.push(n.id));
  for (const id of ids) defaultSceneGraph.removeNode(id);
  defaultAnimation.clear();
}

function addComp(id: string): void {
  defaultSceneGraph.addNode({
    id, name: id, parent: null, children: [], visible: true, locked: false,
    transform: { position: { x: 0, y: 0 }, rotation: 0, scale: { x: 1, y: 1 } },
    components: [{ id: `${id}_meta`, type: 'group', props: { [SCENE_KIND_PROP]: 'group' } }],
  } as unknown as SceneNode);
}

function addShape(
  id: string, x: number, y: number,
  opts: { w?: number; h?: number; cloner?: Partial<ClonerConfig>; geometry?: Record<string, unknown> } = {},
): void {
  defaultSceneGraph.addChild('comp_root', {
    id, name: id, parent: 'comp_root', children: [], visible: true, locked: false,
    transform: { position: { x, y }, rotation: 0, scale: { x: 1, y: 1 } },
    components: [
      { id: `${id}_t`, type: 'Transform', props: { [SCENE_KIND_PROP]: 'shape', x, y, width: opts.w ?? 40, height: opts.h ?? 40 } },
      { id: `${id}_s`, type: 'Style', props: { opacity: 100, fill: '#f00' } },
      ...(opts.geometry ? [{ id: `${id}_g`, type: 'Geometry', props: opts.geometry }] : []),
      {
        id: `${id}_fx`, type: 'fx',
        props: opts.cloner ? { [CLONER_PROP]: { ...DEFAULT_CLONER, enabled: true, ...opts.cloner } } : {},
      },
    ],
  } as never);
}

const at = (t: number): ReturnType<typeof buildSnapshot> =>
  buildSnapshot(defaultSceneGraph, defaultAnimation, t, undefined, undefined, undefined, undefined, {
    width: 1920, height: 1080, background: '#000', transparent: false, rootId: 'comp_root',
  });

const clones = (t = 0) => at(t).layers.filter((l) => l.id.includes('~c'));

beforeEach(() => {
  resetScene();
  addComp('comp_root');
  useProjectStore.getState().actions.replaceComps({
    comp_root: { id: 'comp_root', name: 'Main', ...COMP },
  });
  const proj = useProjectStore.getState();
  proj.actions.setActiveTab(proj.actions.openTab('comp_root', ['comp_root'], 'Main'));
});

afterEach(resetScene);

describe('path mode through the renderer', () => {
  it('clones sit ON the driver rectangle’s perimeter, in comp space', () => {
    addShape('cl', 0, 0, { cloner: { mode: 'path', count: 8, pathLayerId: 'driver' } });
    addShape('driver', 300, 200, { w: 100, h: 60 });
    const pts = clones();
    expect(pts).toHaveLength(8);
    for (const c of pts) {
      const dx = Math.abs(c.x - 300);
      const dy = Math.abs(c.y - 200);
      // On the boundary of a 100×60 rect centred at (300,200): one axis at its
      // half-extent, the other within it.
      const onEdge = (Math.abs(dx - 50) < 1 && dy <= 30.5) || (Math.abs(dy - 30) < 1 && dx <= 50.5);
      expect(onEdge).toBe(true);
    }
  });

  it('an OPEN pen path reaches both endpoints', () => {
    addShape('cl', 0, 0, { cloner: { mode: 'path', count: 3, pathLayerId: 'pen' } });
    // A straight open pen stroke from (100,100) to (500,100), authored as
    // Geometry points relative to the layer at (0,0) — corner anchors, handles
    // collapsed onto the vertices.
    addShape('pen', 0, 0, {
      geometry: {
        open: true,
        points: [
          { x: 100, y: 100, inX: 100, inY: 100, outX: 100, outY: 100 },
          { x: 500, y: 100, inX: 500, inY: 100, outX: 500, outY: 100 },
        ],
      },
    });
    const xs = clones().map((c) => Math.round(c.x)).sort((a, b) => a - b);
    expect(xs).toEqual([100, 300, 500]);
  });

  it('the clones FOLLOW an animated driver', () => {
    addShape('cl', 0, 0, { cloner: { mode: 'path', count: 4, pathLayerId: 'driver' } });
    addShape('driver', 300, 200, { w: 100, h: 60 });
    defaultAnimation.setKeyframe('driver', 'x', 0, 300, 'linear');
    defaultAnimation.setKeyframe('driver', 'x', 1, 700, 'linear');
    const cx = (t: number): number =>
      clones(t).reduce((s, c) => s + c.x, 0) / clones(t).length;
    // The ring of clones is centred on the driver wherever it is.
    expect(cx(0)).toBeCloseTo(300, 0);
    expect(cx(1)).toBeCloseTo(700, 0);
  });

  it('a deleted driver falls back to a linear run, not a stack', () => {
    addShape('cl', 0, 0, { cloner: { mode: 'path', count: 3, pathLayerId: 'ghost', offsetX: 100 } });
    const xs = clones().map((c) => Math.round(c.x)).sort((a, b) => a - b);
    expect(xs).toEqual([-100, 0, 100]);
  });

  it('the boolean-ops suite still passes with the shared outline', () => {
    // Cheap canary: nodeWorldPolygon now delegates to nodeWorldOutline. The
    // real assertions live in mergePaths.test.ts; this just pins that a cloner
    // scene with a driver does not disturb an unrelated layer.
    addShape('cl', 0, 0, { cloner: { mode: 'path', count: 2, pathLayerId: 'driver' } });
    addShape('driver', 300, 200, {});
    addShape('bystander', 900, 500, {});
    const b = at(0).layers.find((l) => l.id === 'bystander')!;
    expect([Math.round(b.x), Math.round(b.y)]).toEqual([900, 500]);
  });
});
