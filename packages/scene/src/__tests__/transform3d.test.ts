import {
  TransformComponent,
  computeWorldMatrix4,
  Matrix,
  Matrix4Math,
  Scene,
  createGroupNode,
  createRectangleNode,
} from '../index';

describe('TransformComponent — 3D extension', () => {
  it('defaults to pure 2D (is3D === false)', () => {
    const t = new TransformComponent({ position: { x: 5, y: 6 }, rotation: 30 });
    expect(t.is3D).toBe(false);
    expect(t.positionZ).toBe(0);
    expect(t.scaleZ).toBe(1);
  });

  it('flips to 3D when any depth field is set', () => {
    const t = new TransformComponent();
    t.setPositionZ(100);
    expect(t.is3D).toBe(true);
    t.setPositionZ(0);
    expect(t.is3D).toBe(false);
    t.setRotationY(10);
    expect(t.is3D).toBe(true);
  });

  it('getLocalMatrix4 of a 2D node equals its lifted 2D matrix', () => {
    const t = new TransformComponent({
      position: { x: 40, y: 10 },
      rotation: 45,
      scale: { x: 2, y: 1.5 },
      anchor: { x: 3, y: 4 },
    });
    const lifted = Matrix4Math.fromMatrix2D(t.getLocalMatrix());
    expect(Matrix4Math.equals(t.getLocalMatrix4() as never, lifted)).toBe(true);
  });

  it('a 3D local still agrees with the 2D affine on the z=0 plane', () => {
    // Only in-plane transforms (z rotation / xy scale) → 2D flatten must match.
    const t = new TransformComponent({
      position: { x: 12, y: 20 },
      rotation: 60,
      scale: { x: 1.4, y: 0.8 },
      anchor: { x: 5, y: 5 },
      positionZ: 0,
      scaleZ: 2, // makes it "3D" but does not affect the xy plane
    });
    expect(t.is3D).toBe(true);
    const flat = Matrix4Math.toMatrix2D(t.getLocalMatrix4() as never);
    expect(Matrix.equals(flat, t.getLocalMatrix(), 1e-9)).toBe(true);
  });

  it('recomputes the 4x4 after a mutation (dirty flag)', () => {
    const t = new TransformComponent();
    const before = Matrix4Math.clone(t.getLocalMatrix4() as never);
    t.setRotationX(90);
    const after = t.getLocalMatrix4() as never;
    expect(Matrix4Math.equals(before, after)).toBe(false);
  });

  it('serializes the 3D block only for 3D nodes', () => {
    const flat = new TransformComponent({ position: { x: 1, y: 2 } });
    expect(Object.keys(flat.serialize().data)).not.toContain('positionZ');

    const deep = new TransformComponent({ position: { x: 1, y: 2 }, positionZ: 50 });
    expect(deep.serialize().data.positionZ).toBe(50);
  });

  it('clone carries the 3D fields', () => {
    const t = new TransformComponent();
    t.setPositionZ(30);
    t.setRotationX(15);
    const c = t.clone();
    expect(c.positionZ).toBe(30);
    expect(c.rotationX).toBe(15);
    expect(c.is3D).toBe(true);
  });
});

describe('computeWorldMatrix4 — nested 3D under 2D ancestors', () => {
  it('composes a 3D child through a translated 2D parent', () => {
    const scene = new Scene();
    const parent = scene.add(createGroupNode());
    parent.transform.setPosition(100, 0);
    const child = scene.add(createRectangleNode(), parent);
    child.transform.setPositionZ(200); // 3D child

    const world = computeWorldMatrix4(child);
    // Parent's +100x translation must appear in the child's world translation,
    // and the child's z depth must survive.
    expect(world[12]).toBeCloseTo(100, 6);
    expect(world[14]).toBeCloseTo(200, 6);
  });

  it('matches computeWorldMatrix (2D) on the xy plane when everything is 2D', () => {
    const scene = new Scene();
    const parent = scene.add(createGroupNode());
    parent.transform.setPosition(50, 60);
    parent.transform.setRotation(30);
    const child = scene.add(createRectangleNode(), parent);
    child.transform.setPosition(10, 0);

    const world4 = computeWorldMatrix4(child);
    const flat = Matrix4Math.toMatrix2D(world4);
    // Reconstruct the 2D world the classic way.
    const world2 = Matrix.multiply(parent.transform.getLocalMatrix(), child.transform.getLocalMatrix());
    expect(Matrix.equals(flat, world2, 1e-9)).toBe(true);
  });
});
