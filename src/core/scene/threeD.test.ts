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
  const ZERO = { z: 0, rotationX: 0, rotationY: 0, orientationX: 0, orientationY: 0, orientationZ: 0, anchorZ: 0, extrusionDepth: 0, bevelDepth: 0, bevelStyle: 'angular' };

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

  it('reads extrusion depth back (clamped to ≥ 0)', () => {
    expect(readNode3D(node({ z: 0, extrusionDepth: 120 })).extrusionDepth).toBe(120);
    expect(readNode3D(node({ z: 0, extrusionDepth: -5 })).extrusionDepth).toBe(0);
    expect(readNode3D(node({ z: 0 })).extrusionDepth).toBe(0);
  });

  it('reads bevel depth (clamped ≥ 0) and bevel style (default angular)', () => {
    expect(readNode3D(node({ z: 0, bevelDepth: 24 })).bevelDepth).toBe(24);
    expect(readNode3D(node({ z: 0, bevelDepth: -3 })).bevelDepth).toBe(0);
    expect(readNode3D(node({ z: 0 })).bevelStyle).toBe('angular');
    expect(readNode3D(node({ z: 0, bevelStyle: 'convex' })).bevelStyle).toBe('convex');
    expect(readNode3D(node({ z: 0, bevelStyle: 'nonsense' })).bevelStyle).toBe('angular');
  });

  it('a node without a Transform component is never 3D', () => {
    const n = { id: 'g', components: [{ id: 'g_s', type: 'Style', props: {} }] } as unknown as SceneNode;
    expect(is3DEnabled(n)).toBe(false);
    expect(readNode3D(n)).toEqual(ZERO);
  });
});
