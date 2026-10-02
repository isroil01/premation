import { SCENE_KIND_PROP } from '@core/scene/seedDefaultScene';
import { EXTRUSION_WALL_GAIN, EXTRUSION_BACK_GAIN } from '@core/scene/extrusion';
import {
  faceKindOf, resolveFaceMaterial, setNodeFaceMaterial, clearNodeFaceMaterials,
  getNodeFaceMaterials, DEFAULT_FACE_GAIN,
} from './faceMaterials';
import defaultSceneGraph from '@core/scene/DefaultSceneGraph';
import type { SceneNode } from '@core/types';

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
