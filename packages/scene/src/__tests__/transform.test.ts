import { Scene, createGroupNode, createRectangleNode, Matrix } from '../index';

describe('Transforms', () => {
  it('computes a local matrix from transform parts', () => {
    const scene = new Scene();
    const r = scene.add(createRectangleNode());
    r.transform.setPosition(100, 50);
    const m = r.transform.getLocalMatrix();
    expect(m.e).toBeCloseTo(100, 6);
    expect(m.f).toBeCloseTo(50, 6);
  });

  it('caches the local matrix until a part changes (dirty flag)', () => {
    const scene = new Scene();
    const r = scene.add(createRectangleNode());
    const m1 = r.transform.getLocalMatrix();
    const m2 = r.transform.getLocalMatrix();
    expect(m1).toBe(m2); // same cached object, not recomputed
    r.transform.setRotation(45);
    const m3 = r.transform.getLocalMatrix();
    expect(m3).toBe(m1); // in-place, but recomputed
    expect(m3.a).not.toBeCloseTo(1, 6);
  });

  it('composes nested world transforms', () => {
    const scene = new Scene();
    const parent = scene.add(createGroupNode());
    const child = scene.add(createRectangleNode(), parent);
    parent.transform.setPosition(100, 0);
    child.transform.setPosition(10, 5);
    scene.updateTransforms();
    const w = child.transform.getWorldMatrix();
    // child world position = parent(100,0) + child(10,5)
    expect(w.e).toBeCloseTo(110, 6);
    expect(w.f).toBeCloseTo(5, 6);
  });

  it('applies parent rotation to the child world position', () => {
    const scene = new Scene();
    const parent = scene.add(createGroupNode());
    const child = scene.add(createRectangleNode(), parent);
    parent.transform.setRotation(90);
    child.transform.setPosition(10, 0);
    scene.updateTransforms();
    const w = child.transform.getWorldMatrix();
    const p = Matrix.transformPoint(w, { x: 0, y: 0 });
    expect(p.x).toBeCloseTo(0, 6);
    expect(p.y).toBeCloseTo(10, 6);
  });

  it('emits TransformChanged when a transform edits', () => {
    const scene = new Scene();
    const r = scene.add(createRectangleNode());
    let count = 0;
    scene.on('TransformChanged', () => count++);
    r.transform.setPosition(1, 2);
    r.transform.setScale(2, 2);
    expect(count).toBe(2);
  });
});
