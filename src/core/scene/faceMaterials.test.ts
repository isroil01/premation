import { buildSnapshot } from '@core/rendering/buildSnapshot';
import SceneGraph from '@core/scene/SceneGraph';
import { AnimationEngine } from '@motion/animation';
import { SCENE_KIND_PROP } from '@core/scene/seedDefaultScene';
import { EXTRUSION_WALL_GAIN, EXTRUSION_BACK_GAIN } from '@core/scene/extrusion';
import {
  faceKindOf, resolveFaceMaterial, setNodeFaceMaterial, clearNodeFaceMaterials,
  getNodeFaceMaterials, DEFAULT_FACE_GAIN,
} from './faceMaterials';
import defaultSceneGraph from '@core/scene/DefaultSceneGraph';
import type { SceneNode } from '@core/types';

// These cases pin the QUAD-SYNTHESIS extrusion (scene/extrusion.ts), which is
// now the FALLBACK behind the mesh path (scene/extrusionMesh.ts) — taken when
// an outline cannot be produced. The fallback is still live code, so its
// guarantees are kept by switching the mesh path off for this file.
import { setExtrusionMeshPath } from '@core/scene/extrusionMesh';
beforeAll(() => setExtrusionMeshPath(false));
afterAll(() => setExtrusionMeshPath(true));

const COMP = { width: 800, height: 600, background: '#101014' };

function cube(id: string, extra: Record<string, unknown> = {}): SceneNode {
  return {
    id, name: id, parent: null, children: [], visible: true, locked: false,
    transform: { position: { x: 400, y: 300 }, rotation: 0, scale: { x: 1, y: 1 } },
    components: [
      { id: `${id}_t`, type: 'Transform', props: {
        [SCENE_KIND_PROP]: 'shape', x: 400, y: 300, width: 100, height: 100,
        z: 0, rotationX: 0, rotationY: 0, extrusionDepth: 60, bevelDepth: 10, ...extra,
      } },
      { id: `${id}_s`, type: 'Style', props: { opacity: 100, fill: '#2b7eff' } },
    ],
  } as unknown as SceneNode;
}

const facesOf = (graph: SceneGraph, id: string) => {
  const s = buildSnapshot(graph, new AnimationEngine(), 0, undefined, undefined, undefined, undefined, COMP as never);
  const out = new Map<string, { fill?: string; gain: number | null }>();
  for (const l of s.layers) {
    if (!l.id.startsWith(id)) continue;
    const key = l.id.replace(id, '').replace('::ext-', '') || 'FRONT';
    out.set(key, { fill: l.fill, gain: l.lighting ? l.lighting[0] : null });
  }
  return out;
};

describe('faceKindOf', () => {
  it('separates side walls, bevel chamfers and the back cap', () => {
    expect(faceKindOf('wall', 'r')).toBe('side');
    expect(faceKindOf('wall', 'w7')).toBe('side');   // ellipse wall segment
    // Bevels ride role 'wall' — only the `c` suffix distinguishes them.
    expect(faceKindOf('wall', 'cfr')).toBe('bevel');
    expect(faceKindOf('wall', 'cbl')).toBe('bevel');
    expect(faceKindOf('back', 'back')).toBe('back');
  });
});

describe('resolveFaceMaterial', () => {
  it('falls back to the layer fill dimmed by the kind default', () => {
    expect(resolveFaceMaterial({}, 'side', '#ff0000')).toEqual({ fill: '#ff0000', gain: EXTRUSION_WALL_GAIN });
    expect(resolveFaceMaterial({}, 'back', '#ff0000')).toEqual({ fill: '#ff0000', gain: EXTRUSION_BACK_GAIN });
  });

  it('an explicit fill wins, and gain is independently overridable', () => {
    expect(resolveFaceMaterial({ side: { fill: '#00ff00' } }, 'side', '#ff0000').fill).toBe('#00ff00');
    expect(resolveFaceMaterial({ side: { gain: 0.3 } }, 'side', '#ff0000').gain).toBe(0.3);
  });
});

describe('per-face materials in the render snapshot', () => {
  // The point of the defaults: an untouched extruded layer must render exactly as
  // it did before this feature existed.
  it('with no overrides, output is unchanged (layer fill + original gains)', () => {
    const g = new SceneGraph();
    g.addNode(cube('c'));
    const f = facesOf(g, 'c');
    expect(f.get('r')).toEqual({ fill: '#2b7eff', gain: EXTRUSION_WALL_GAIN });
    expect(f.get('cfr')).toEqual({ fill: '#2b7eff', gain: EXTRUSION_WALL_GAIN });
    expect(f.get('back')).toEqual({ fill: '#2b7eff', gain: EXTRUSION_BACK_GAIN });
  });

  it('side / bevel / back take their own colours, front keeps the layer fill', () => {
    const g = new SceneGraph();
    g.addNode(cube('c2', {
      faceMaterials: { side: { fill: '#ffd400' }, bevel: { fill: '#ffffff' }, back: { fill: '#101014' } },
    }));
    const f = facesOf(g, 'c2');
    expect(f.get('r')!.fill).toBe('#ffd400');
    expect(f.get('t')!.fill).toBe('#ffd400');
    expect(f.get('cfr')!.fill).toBe('#ffffff');
    expect(f.get('back')!.fill).toBe('#101014');
    expect(f.get('FRONT')!.fill).toBe('#2b7eff');
  });

  // Dimming a colour the user explicitly picked would make the picker lie.
  it('an explicit colour is used as picked (gain 1), not dimmed', () => {
    const g = new SceneGraph();
    g.addNode(cube('c3', { faceMaterials: { side: { fill: '#ffd400' } } }));
    expect(facesOf(g, 'c3').get('r')!.gain).toBe(1);
  });

  it('a derived face still honours a custom gain', () => {
    const g = new SceneGraph();
    g.addNode(cube('c4', { faceMaterials: { side: { gain: 0.25 } } }));
    const side = facesOf(g, 'c4').get('r')!;
    expect(side.fill).toBe('#2b7eff');
    expect(side.gain).toBeCloseTo(0.25, 5);
  });
});

describe('face material writes', () => {
  it('patches one kind, clears it, and stores nothing when all are default', () => {
    defaultSceneGraph.addNode(cube('fm_w'));
    setNodeFaceMaterial('fm_w', 'side', { fill: '#123456' });
    expect(getNodeFaceMaterials('fm_w').side?.fill).toBe('#123456');

    setNodeFaceMaterial('fm_w', 'back', { gain: 0.4 });
    expect(getNodeFaceMaterials('fm_w').back?.gain).toBe(0.4);
    expect(getNodeFaceMaterials('fm_w').side?.fill).toBe('#123456');

    setNodeFaceMaterial('fm_w', 'side', null);
    expect(getNodeFaceMaterials('fm_w').side).toBeUndefined();

    clearNodeFaceMaterials('fm_w');
    expect(getNodeFaceMaterials('fm_w')).toEqual({});
  });

  it('default gains match the constants the renderer used to hardcode', () => {
    expect(DEFAULT_FACE_GAIN.side).toBe(EXTRUSION_WALL_GAIN);
    expect(DEFAULT_FACE_GAIN.back).toBe(EXTRUSION_BACK_GAIN);
  });
});
