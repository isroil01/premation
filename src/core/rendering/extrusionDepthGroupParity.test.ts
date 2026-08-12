/**
 * Every face of ONE extruded object must reach the SAME render path.
 *
 * WHY THIS EXISTS. `depthEligible3D` is asked per RENDERABLE, but an extrusion
 * is one OBJECT spread across up to fourteen of them. The predicate has no way
 * to know that, so any per-renderable exclusion silently splits a solid in half:
 * `CompositionPass.renderList` builds contiguous runs of depth-eligible
 * renderables, so the excluded faces drop to the affine painter path — no depth
 * state at all — while their siblings stay in the depth-tested group.
 *
 * That is not hypothetical. `glass` and `backdropBlur` are excluded (correctly
 * — they read what is composited beneath, which the depth pass cannot supply),
 * and only the front face and the back cap carried them, because those two were
 * built by spreading `...layer` while the four walls were constructed
 * field-by-field from scratch. So a glass extrusion sent its walls to the depth
 * group and its caps to the painter, and the glass panel visibly detached from
 * the body with its rim overlapping the top wall.
 *
 * The asymmetry is the general defect and glass is one instance of it: ANY
 * `RenderLayer` field outside the walls' explicit list reached the back cap
 * alone. So the assertion is about the whole object rather than about glass —
 * the same shape as `lightShaderParity.test.ts`, which pins a boundary rather
 * than a symptom.
 *
 * IF THIS FAILS: a face is carrying a field its siblings are not. Fix the
 * construction so all faces are built the same way; do not special-case the
 * field in `depthEligible3D`.
 */

import { buildSnapshot } from './buildSnapshot';
import { snapshotToFrameScene } from './snapshotToFrameScene';
import SceneGraph from '@core/scene/SceneGraph';
import { AnimationEngine } from '@motion/animation';
import type { SceneNode } from '@core/types';
import { SCENE_KIND_PROP } from '@core/scene/seedDefaultScene';
import { depthEligible3D } from '@motion/renderer';

const COMP = { width: 800, height: 600, background: '#101014' };

function node3D(id: string, kind: string, props: Record<string, unknown>, style: Record<string, unknown> = {}): SceneNode {
  return {
    id, name: id, parent: null, children: [], visible: true, locked: false,
    transform: { position: { x: 400, y: 300 }, rotation: 0, scale: { x: 1, y: 1 } },
    components: [
      { id: `${id}_t`, type: 'Transform', props: { [SCENE_KIND_PROP]: kind, x: 400, y: 300, rotation: 0, width: 160, height: 100, z: 0, ...props } },
      { id: `${id}_s`, type: 'Style', props: { opacity: 100, fill: '#2b7eff', ...style } },
    ],
  } as unknown as SceneNode;
}

/**
 * Glass is a LAYER STYLE (`readNodeLayerStyles(node)?.glass`), not a Style
 * component prop — putting it on the Style component silently resolves to
 * `undefined` and the case passes for the wrong reason.
 */
const GLASS_STYLE = { glass: { enabled: true, blur: 12, saturation: 120, tintColor: '#ffffff', tintOpacity: 0.1 } };

/** Every renderable belonging to `id` — the layer itself plus its `::ext-*` faces. */
function facesOf(graph: SceneGraph, id: string) {
  const snap = buildSnapshot(graph, new AnimationEngine(), 0, undefined, undefined, undefined, undefined, COMP);
  const scene = snapshotToFrameScene(snap);
  return scene.renderables.filter((r) => r.id === id || r.id.startsWith(`${id}::ext-`));
}

/** `{ eligible, ineligible }` face ids, so a failure names the odd ones out. */
function partition(rs: ReturnType<typeof facesOf>) {
  return {
    eligible: rs.filter((r) => depthEligible3D(r)).map((r) => r.id),
    ineligible: rs.filter((r) => !depthEligible3D(r)).map((r) => r.id),
  };
}

describe('an extruded object does not split across render paths', () => {
  const cases: Array<[string, Record<string, unknown>, Record<string, unknown>, boolean]> = [
    ['a plain box', { extrusionDepth: 60 }, {}, false],
    ['a bevelled box', { extrusionDepth: 60, bevelDepth: 12 }, {}, false],
    ['a rounded box', { extrusionDepth: 60, cornerRadius: 24 }, {}, false],
    ['an ellipse', { extrusionDepth: 60, shapeType: 'ellipse' }, {}, false],
    // The reported case. Glass is legitimately depth-INELIGIBLE, so what this
    // asserts is agreement, not eligibility: whichever path the object takes,
    // every face of it must take the same one.
    ['a GLASS box', { extrusionDepth: 60 }, {}, true],
    ['a backdrop-blurred box', { extrusionDepth: 60 }, { backdropBlur: 14 }, false],
  ];

  for (const [name, transform, style, glass] of cases) {
    it(`${name}: every face lands on the same path`, () => {
      const g = new SceneGraph();
      g.addNode(node3D('obj', 'shape', transform, style));
      if (glass) (g as unknown as { setLayerStyles(id: string, s: unknown): void }).setLayerStyles('obj', GLASS_STYLE);
      const rs = facesOf(g, 'obj');
      // Guard the guard: a case that produced no faces would pass vacuously.
      expect(rs.length).toBeGreaterThan(4);
      const { eligible, ineligible } = partition(rs);
      expect([eligible.length === 0 || ineligible.length === 0, { eligible, ineligible }])
        .toEqual([true, { eligible, ineligible }]);
    });
  }

  it('extruded TEXT: every slice lands on the same path as its front face', () => {
    const g = new SceneGraph();
    g.addNode(node3D('t', 'text', { extrusionDepth: 60, text: 'DEPTH', fontSize: 48 }));
    const rs = facesOf(g, 't');
    expect(rs.length).toBeGreaterThan(4);
    const { eligible, ineligible } = partition(rs);
    expect([eligible.length === 0 || ineligible.length === 0, { eligible, ineligible }])
      .toEqual([true, { eligible, ineligible }]);
  });

  /**
   * The general form of the defect, stated directly.
   *
   * The split is a SYMPTOM of the back cap being built by spreading `...layer`
   * while the walls are built field-by-field. Comparing the two constructions
   * on the fields that decide the render path catches the next such field
   * before it becomes another visible bug — which is the whole reason glass was
   * only the observed case rather than the only one.
   */
  it('no synthesized face carries a path-deciding field its siblings lack', () => {
    const g = new SceneGraph();
    g.addNode(node3D('obj', 'shape', { extrusionDepth: 60 }, {
      backdropBlur: 14,
      preserveTransparency: true,
    }));
    (g as unknown as { setLayerStyles(id: string, s: unknown): void }).setLayerStyles('obj', GLASS_STYLE);
    const faces = facesOf(g, 'obj').filter((r) => r.id.startsWith('obj::ext-'));
    expect(faces.length).toBeGreaterThan(3);
    const DECIDES_PATH = ['glass', 'backdropBlur', 'preserveTransparency', 'advancedBlend', 'matte', 'adjustment', 'precomp', 'deformedMesh'] as const;
    const shapeOf = (r: (typeof faces)[number]) =>
      DECIDES_PATH.map((k) => `${k}=${(r as unknown as Record<string, unknown>)[k] === undefined ? '-' : 'set'}`).join(' ');
    const shapes = new Set(faces.map(shapeOf));
    expect([shapes.size, [...shapes]]).toEqual([1, [...shapes]]);
  });
});

/**
 * The DIRECTION of the agreement.
 *
 * "Every face on the same path" is satisfiable two ways, and only one of them
 * is correct. Glass and backdrop blur read what is composited beneath the
 * layer, which the depth pass cannot supply — so the resolution must be that
 * the whole object leaves the depth group, never that the excluded faces are
 * forced into it. Without this, a change that made `depthExempt` clear the flag
 * instead of setting it would pass every assertion above.
 */
describe('the agreement resolves toward the painter path, not into the depth group', () => {
  it('a GLASS extrusion leaves the depth group ENTIRELY', () => {
    const g = new SceneGraph();
    g.addNode(node3D('obj', 'shape', { extrusionDepth: 60 }));
    (g as unknown as { setLayerStyles(id: string, s: unknown): void }).setLayerStyles('obj', GLASS_STYLE);
    const rs = facesOf(g, 'obj');
    expect(rs.length).toBeGreaterThan(4);
    expect(rs.every((r) => !depthEligible3D(r))).toBe(true);
  });

  it('an ordinary extrusion is left in the depth group', () => {
    // The control: the pass must not exempt objects that never disagreed.
    const g = new SceneGraph();
    g.addNode(node3D('obj', 'shape', { extrusionDepth: 60 }));
    const rs = facesOf(g, 'obj');
    expect(rs.length).toBeGreaterThan(4);
    expect(rs.every((r) => depthEligible3D(r))).toBe(true);
    expect(rs.every((r) => r.depthExempt === undefined)).toBe(true);
  });

  it('one glass extrusion does not exempt an unrelated one beside it', () => {
    const g = new SceneGraph();
    g.addNode(node3D('glassy', 'shape', { extrusionDepth: 60 }));
    (g as unknown as { setLayerStyles(id: string, s: unknown): void }).setLayerStyles('glassy', GLASS_STYLE);
    g.addNode(node3D('plain', 'shape', { extrusionDepth: 60, x: 600 }));
    expect(facesOf(g, 'glassy').every((r) => !depthEligible3D(r))).toBe(true);
    expect(facesOf(g, 'plain').every((r) => depthEligible3D(r))).toBe(true);
  });
});
