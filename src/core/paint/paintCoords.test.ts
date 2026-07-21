import { compToLayerLocal, isPaintableKind, layerScaleOf, localBrushSize } from './paintCoords';
import type { SceneNode } from '@core/types';

/** Minimal node with a Transform component carrying the given props. `kind` is
 *  stored as the `__kind` meta prop (how readNodeKind reads it). */
function node(props: Record<string, unknown>, kind?: string): SceneNode {
  const tProps: Record<string, unknown> = { ...props };
  if (kind) tProps.__kind = kind;
  return {
    id: 'n', name: 'n', parent: null, children: [], visible: true, locked: false,
    transform: { position: { x: 0, y: 0 }, rotation: 0, scale: { x: 1, y: 1 } },
    components: [{ id: 'n_t', type: 'Transform', props: tProps }],
  } as unknown as SceneNode;
}

describe('compToLayerLocal', () => {
  test('translation: subtracts the layer position', () => {
    const p = compToLayerLocal(node({ x: 100, y: 50 }), { x: 130, y: 70 });
    expect(p.x).toBeCloseTo(30);
    expect(p.y).toBeCloseTo(20);
  });

  test('uniform scale: divides out the scale', () => {
    const p = compToLayerLocal(node({ x: 0, y: 0, scale: 2 }), { x: 40, y: 20 });
    expect(p.x).toBeCloseTo(20);
    expect(p.y).toBeCloseTo(10);
  });

  test('non-uniform scaleX/scaleY', () => {
    const p = compToLayerLocal(node({ x: 0, y: 0, scaleX: 4, scaleY: 2 }), { x: 40, y: 20 });
    expect(p.x).toBeCloseTo(10);
    expect(p.y).toBeCloseTo(10);
  });

  test('rotation 90deg: inverts the rotation', () => {
    // Forward R(+90) maps local (10,0) -> comp (0,10); the inverse must recover it.
    const p = compToLayerLocal(node({ x: 0, y: 0, rotation: 90 }), { x: 0, y: 10 });
    expect(p.x).toBeCloseTo(10);
    expect(p.y).toBeCloseTo(0);
  });

  test('anchor offset is added back', () => {
    const p = compToLayerLocal(node({ x: 0, y: 0, anchorX: 5, anchorY: -3 }), { x: 30, y: 0 });
    expect(p.x).toBeCloseTo(35);
    expect(p.y).toBeCloseTo(-3);
  });

  test('falls back to node.transform when Transform props absent', () => {
    const n = node({});
    (n as unknown as { transform: { position: { x: number; y: number } } }).transform.position = { x: 10, y: 10 };
    const p = compToLayerLocal(n, { x: 25, y: 40 });
    expect(p.x).toBeCloseTo(15);
    expect(p.y).toBeCloseTo(30);
  });

  test('zero scale does not divide by zero', () => {
    const p = compToLayerLocal(node({ x: 0, y: 0, scaleX: 0, scaleY: 0 }), { x: 5, y: 5 });
    expect(Number.isFinite(p.x)).toBe(true);
    expect(Number.isFinite(p.y)).toBe(true);
  });
});

describe('layerScaleOf / localBrushSize', () => {
  test('unscaled layer keeps brush size in comp pixels', () => {
    expect(layerScaleOf(node({}))).toBeCloseTo(1);
    expect(localBrushSize(node({}), 18)).toBeCloseTo(18);
  });

  test('a tiny-geometry layer blown up by scale shrinks the brush to local units', () => {
    // Star case: geometry ~5u, scaleX 106 / scaleY 68 → mean ~85, so an 18px
    // comp brush must become ~0.2 local units (else it fills the whole shape).
    const s = layerScaleOf(node({ scaleX: 106, scaleY: 68 }));
    expect(s).toBeCloseTo(Math.sqrt(106 * 68));
    expect(localBrushSize(node({ scaleX: 106, scaleY: 68 }), 18)).toBeLessThan(0.3);
  });

  test('geometric mean of non-uniform scale; negatives use magnitude', () => {
    expect(layerScaleOf(node({ scaleX: -4, scaleY: -9 }))).toBeCloseTo(6);
  });
});

describe('isPaintableKind', () => {
  test('cameras/lights/audio are not paintable', () => {
    expect(isPaintableKind(node({}, 'camera'))).toBe(false);
    expect(isPaintableKind(node({}, 'light'))).toBe(false);
    expect(isPaintableKind(node({}, 'audio'))).toBe(false);
  });
  test('shape/image/text layers are paintable', () => {
    expect(isPaintableKind(node({}, 'shape'))).toBe(true);
    expect(isPaintableKind(node({}, 'image'))).toBe(true);
    expect(isPaintableKind(node({}, 'text'))).toBe(true);
  });
});
