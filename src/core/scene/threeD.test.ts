import { is3DEnabled, readNode3D, THREE_D_PROPS } from './threeD';
import type { SceneNode } from '@core/types';

function node(props: Record<string, unknown>): SceneNode {
  return {
    id: 'n', name: 'n', parent: null, children: [], visible: true, locked: false,
    transform: { position: { x: 0, y: 0 }, rotation: 0, scale: { x: 1, y: 1 } },
    components: [{ id: 'n_t', type: 'Transform', props }],
  } as unknown as SceneNode;
}

describe('threeD helpers', () => {
  const ZERO = { z: 0, rotationX: 0, rotationY: 0, orientationX: 0, orientationY: 0, orientationZ: 0, anchorZ: 0 };

  it('a plain 2D layer is not 3D and reads zeros', () => {
    const n = node({ x: 10, y: 20, rotation: 0 });
    expect(is3DEnabled(n)).toBe(false);
    expect(readNode3D(n)).toEqual(ZERO);
  });

  it('any depth prop marks the layer 3D', () => {
    for (const p of THREE_D_PROPS) {
      expect(is3DEnabled(node({ x: 0, y: 0, [p]: 0 }))).toBe(true);
    }
  });

  it('reads the depth values back', () => {
    const n = node({ x: 0, y: 0, z: 250, rotationX: 30, rotationY: -45 });
    expect(readNode3D(n)).toEqual({ ...ZERO, z: 250, rotationX: 30, rotationY: -45 });
  });

  it('reads orientation and anchor Z back', () => {
    const n = node({ z: 0, orientationX: 15, orientationY: -20, orientationZ: 90, anchorZ: 120 });
    const r = readNode3D(n);
    expect(r.orientationX).toBe(15);
    expect(r.orientationY).toBe(-20);
    expect(r.orientationZ).toBe(90);
    expect(r.anchorZ).toBe(120);
  });

  it('a node without a Transform component is never 3D', () => {
    const n = { id: 'g', components: [{ id: 'g_s', type: 'Style', props: {} }] } as unknown as SceneNode;
    expect(is3DEnabled(n)).toBe(false);
    expect(readNode3D(n)).toEqual(ZERO);
  });
});
