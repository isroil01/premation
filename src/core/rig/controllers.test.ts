/**
 * Rig controllers — placement, linkage, and the two negatives.
 *
 * ## What these are shaped against
 *
 * A controller is a handle that drives something else, so the failures are
 * relational rather than local: it draws in the right place but grabs the wrong
 * bone; it drives its own bone and quietly drags a sibling; it looks right on a
 * fixture where every transform is identity and lands nowhere on a real rig.
 *
 * Every fixture here is therefore deliberately UNCLEAN — see `RIG` below.
 */

import {
  controllerPosition,
  controllerDragKind,
  controllerDrives,
  normalizeController,
  defaultControllerFor,
  newControllerId,
  DEFAULT_CONTROLLER_SIZE,
  type RigController,
} from './controllers';
import { computeWorldTransforms, boneRoot, type Bone } from './skeleton';
import { fromTRS, type Mat2D } from './mat2d';

const DEG = Math.PI / 180;

/**
 * A rig with nothing clean in it (rule 3a).
 *
 * Every value the "obvious" fixture would have used is excluded on purpose,
 * because each one hides a different class of bug:
 *   • **rotation ≠ 0** — a zero-rotation bone makes its world matrix a pure
 *     translation, so reading the wrong matrix element still gives the right
 *     answer;
 *   • **non-uniform scale** — equal scaleX/scaleY makes a transposed matrix
 *     indistinguishable from a correct one;
 *   • **a PARENTED bone** — an unparented chain means `computeWorldTransforms`
 *     could ignore composition entirely and still pass (this is F23's shape);
 *   • **a non-zero offset** — offset 0 makes "controller position" and "driven
 *     point" the same number, so a build that ignored the offset would agree;
 *   • **a root that is not at the origin** — a root at (0,0) makes local and
 *     world coordinates coincide.
 */
const ROOT: Bone = {
  id: 'root', parentId: null, length: 40,
  x: 37, y: -11, rotation: 25 * DEG, scaleX: 1.4, scaleY: 0.8,
};
const CHILD: Bone = {
  id: 'child', parentId: 'root', length: 30,
  x: 40, y: 0, rotation: -35 * DEG,
};
const BONES: Bone[] = [ROOT, CHILD];

const ctrl = (over: Partial<RigController> = {}): RigController => ({
  id: 'c1',
  shape: 'circle',
  side: 'centre',
  size: DEFAULT_CONTROLLER_SIZE,
  link: { kind: 'bone', boneId: 'child' },
  ...over,
});

function worldOf(bones: Bone[]): ReadonlyMap<string, Mat2D> {
  return computeWorldTransforms({ bones });
}

describe('placement', () => {
  it('the fixture is genuinely unclean — the exclusions above actually hold', () => {
    // Asserted rather than trusted. If someone "tidies" this rig later, the
    // tests below keep passing while covering much less, and nothing says so.
    expect(ROOT.rotation).not.toBe(0);
    expect(CHILD.rotation).not.toBe(0);
    expect(ROOT.scaleX).not.toBe(ROOT.scaleY);
    expect(CHILD.parentId).toBe('root');
    expect(ROOT.x === 0 && ROOT.y === 0).toBe(false);
  });

  it('an FK controller sits on its bone root, offset included — derived from the matrix', () => {
    // Expected value computed from the transform chain independently of
    // `controllerPosition`: compose the parent and child matrices with `fromTRS`
    // and read the translation. If the implementation and this ever disagree,
    // one of them is wrong — and neither is quoting the other.
    const world = worldOf(BONES);
    const m = world.get('child')!;
    const root = boneRoot(m);
    const c = ctrl({ offsetX: 12, offsetY: -7 });
    expect(controllerPosition(c, { worldTransforms: world, ikTargets: new Map() }))
      .toEqual({ x: root.x + 12, y: root.y - 7 });
  });

  it('the child bone really is composed through its parent', () => {
    // Guards the guard: if `computeWorldTransforms` ignored parenting, the child
    // root would be its own local (x, y) = (40, 0) and the test above would pass
    // against a broken composition.
    const root = boneRoot(worldOf(BONES).get('child')!);
    expect(root).not.toEqual({ x: 40, y: 0 });
    // Hand-derived: parent matrix is TRS(37, -11, 25°, 1.4, 0.8) and the child
    // sits at local (40, 0), so the child's root is
    //   (37 + 40·1.4·cos25°, -11 + 40·1.4·sin25°).
    const pm = fromTRS(ROOT.x, ROOT.y, ROOT.rotation, ROOT.scaleX, ROOT.scaleY);
    const expected = { x: pm[0] * 40 + pm[2] * 0 + pm[4], y: pm[1] * 40 + pm[3] * 0 + pm[5] };
    expect(root.x).toBeCloseTo(expected.x, 6);
    expect(root.y).toBeCloseTo(expected.y, 6);
    expect(root.x).toBeCloseTo(37 + 40 * 1.4 * Math.cos(25 * DEG), 6);
    expect(root.y).toBeCloseTo(-11 + 40 * 1.4 * Math.sin(25 * DEG), 6);
  });

  it('an IK controller sits on the LIVE goal, not on the bone', () => {
    const world = worldOf(BONES);
    const goal = { x: -63, y: 29 };
    const c = ctrl({ link: { kind: 'ikTarget', boneId: 'child' }, offsetX: 5, offsetY: 5 });
    expect(controllerPosition(c, { worldTransforms: world, ikTargets: new Map([['child', goal]]) }))
      .toEqual({ x: goal.x + 5, y: goal.y + 5 });
    // And it is NOT the bone root — the two must not be confusable.
    expect(controllerPosition(c, { worldTransforms: world, ikTargets: new Map([['child', goal]]) }))
      .not.toEqual(boneRoot(world.get('child')!));
  });

  it('a dangling link places nothing rather than stacking at the origin', () => {
    const c = ctrl({ link: { kind: 'bone', boneId: 'deleted' } });
    expect(controllerPosition(c, { worldTransforms: worldOf(BONES), ikTargets: new Map() })).toBeNull();
  });

  it('an IK controller whose goal is missing places nothing', () => {
    const c = ctrl({ link: { kind: 'ikTarget', boneId: 'child' } });
    expect(controllerPosition(c, { worldTransforms: worldOf(BONES), ikTargets: new Map() })).toBeNull();
  });
});

describe('the link drives the right thing — including the negatives', () => {
  it('names the drag mode its link implies', () => {
    expect(controllerDragKind(ctrl({ link: { kind: 'ikTarget', boneId: 'child' } }))).toBe('ik');
    expect(controllerDragKind(ctrl({ link: { kind: 'bone', boneId: 'child' } }))).toBe('fk');
  });

  it('a controller drives ONLY its own bone', () => {
    const c = ctrl({ link: { kind: 'bone', boneId: 'child' } });
    expect(controllerDrives(c, 'child')).toBe(true);
    // The negative, derived from the rig rather than hard-coded: every OTHER
    // bone in the fixture must be undriven, so adding a bone extends the check.
    for (const b of BONES.filter((b) => b.id !== 'child')) {
      expect({ bone: b.id, driven: controllerDrives(c, b.id) }).toEqual({ bone: b.id, driven: false });
    }
  });

  it('posing a bone moves its DESCENDANT controller and leaves the posed bone\'s own where it was', () => {
    // Two controllers on different bones, and ONE perturbation that must have
    // opposite effects on them — which is what makes this a negative test and
    // not two positives.
    //
    // Rotating `root` moves the child's ROOT (it hangs off the parent) but not
    // root's own root, because a bone's root is its own (x, y) and its own
    // rotation cannot move it. That asymmetry is the point: a controller that
    // read the wrong matrix would move both, or neither.
    //
    // The first draft perturbed `child` instead and asserted the child's
    // controller moved. It does not — rotating a bone moves its TIP and its
    // descendants, never its own pivot — so that fixture was asserting
    // something false about skeletons rather than something true about
    // controllers.
    const cRoot = ctrl({ id: 'cRoot', link: { kind: 'bone', boneId: 'root' } });
    const cChild = ctrl({ id: 'cChild', link: { kind: 'bone', boneId: 'child' } });
    const before = worldOf(BONES);
    const posed = worldOf(BONES.map((b) => (b.id === 'root' ? { ...b, rotation: 80 * DEG } : b)));
    const opts = (w: ReadonlyMap<string, Mat2D>) => ({ worldTransforms: w, ikTargets: new Map() });

    // The posed bone's own handle stays on its pivot.
    expect(controllerPosition(cRoot, opts(posed))).toEqual(controllerPosition(cRoot, opts(before)));
    // The descendant's handle follows the chain — so the fixture is not vacuous.
    expect(controllerPosition(cChild, opts(posed))).not.toEqual(controllerPosition(cChild, opts(before)));
  });
});

describe('left/right is not symmetric — rule 2b', () => {
  it('two controllers mirrored in SIDE but linked to different bones do not swap', () => {
    // A symmetric layout cannot show a left/right link swap: mirror the rig and
    // a swapped implementation reproduces the right picture. So the fixture is
    // asymmetric BY LINK, and the expected positions are the two bones' roots
    // computed independently — not a relationship between the two controllers'
    // own outputs.
    const world = worldOf(BONES);
    const left = ctrl({ id: 'L', side: 'left', link: { kind: 'bone', boneId: 'root' } });
    const right = ctrl({ id: 'R', side: 'right', link: { kind: 'bone', boneId: 'child' } });
    const opts = { worldTransforms: world, ikTargets: new Map() };

    const expectedLeft = boneRoot(world.get('root')!);
    const expectedRight = boneRoot(world.get('child')!);
    // Anchored to the matrices, so swapping the two links fails here.
    expect(controllerPosition(left, opts)).toEqual(expectedLeft);
    expect(controllerPosition(right, opts)).toEqual(expectedRight);
    // And the two are genuinely distinguishable — a symmetric rig would make
    // this equality hold and the assertions above meaningless.
    expect(expectedLeft).not.toEqual(expectedRight);
  });

  it('side carries no placement meaning — only colour', () => {
    // Stated as a test so nobody later "fixes" placement by reading `side`.
    const opts = { worldTransforms: worldOf(BONES), ikTargets: new Map() };
    const a = controllerPosition(ctrl({ side: 'left' }), opts);
    const b = controllerPosition(ctrl({ side: 'right' }), opts);
    expect(a).toEqual(b);
  });
});

describe('normalisation', () => {
  it('rejects a record with no id or no link', () => {
    expect(normalizeController({ shape: 'circle' })).toBeNull();
    expect(normalizeController({ id: 'x' })).toBeNull();
    expect(normalizeController({ id: 'x', link: { kind: 'bone' } })).toBeNull();
  });

  it('falls back on an unknown shape or side rather than throwing', () => {
    const c = normalizeController({ id: 'x', shape: 'blob', side: 'up', link: { kind: 'bone', boneId: 'b' } })!;
    expect(c.shape).toBe('circle');
    expect(c.side).toBe('centre');
  });

  it('omits a zero offset — absent and 0 must not be two spellings in a saved rig', () => {
    const c = normalizeController({ id: 'x', offsetX: 0, offsetY: 0, link: { kind: 'bone', boneId: 'b' } })!;
    expect('offsetX' in c).toBe(false);
    expect('offsetY' in c).toBe(false);
  });

  it('keeps a non-zero offset', () => {
    const c = normalizeController({ id: 'x', offsetX: -4, link: { kind: 'bone', boneId: 'b' } })!;
    expect(c.offsetX).toBe(-4);
  });

  it('an unknown link kind falls back to ikTarget', () => {
    const c = normalizeController({ id: 'x', link: { kind: 'nonsense', boneId: 'b' }, shape: 'square' })!;
    expect(c.link.kind).toBe('ikTarget');
  });
});

describe('creation defaults', () => {
  it('mints ids that do not collide with existing controllers', () => {
    const existing = [ctrl({ id: 'ctrl_1' }), ctrl({ id: 'ctrl_2' })];
    expect(existing.map((c) => c.id)).not.toContain(newControllerId(existing));
  });

  it('an IK link defaults to a circle, an FK link to an arc', () => {
    expect(defaultControllerFor({ kind: 'ikTarget', boneId: 'child' }, [], BONES).shape).toBe('circle');
    expect(defaultControllerFor({ kind: 'bone', boneId: 'child' }, [], BONES).shape).toBe('arc');
  });

  it('inherits the bone name so a fresh controller is readable', () => {
    const named: Bone[] = [{ ...CHILD, name: 'Forearm' }];
    expect(defaultControllerFor({ kind: 'bone', boneId: 'child' }, [], named).name).toBe('Forearm');
  });
});
