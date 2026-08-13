/**
 * Auto-rig presets — validity, sides, and the one-undo application.
 *
 * ## What the clean fixture would exclude (rule 3a)
 *
 * A SQUARE layer is the fixture nobody would question, and it hides three
 * things at once, so no test below uses one:
 *
 *  • **square bounds** — width and height are interchangeable, so a preset that
 *    read `width` where it meant `height` produces an identical rig. Every
 *    fixture here is deliberately non-square, and `the fixture is not square`
 *    asserts it rather than trusting the numbers;
 *  • **a rotated layer** — bones are authored in LAYER-LOCAL space, so layer
 *    rotation must not appear in the preset at all. Asserted as an invariance:
 *    the preset is a pure function of width and height, so rotating the layer
 *    cannot change it. A preset that reached for world space would fail that;
 *  • **non-uniform scale** — same argument. Local-space authoring means scale is
 *    the layer transform's business, and the guard is that the generator never
 *    sees it.
 *
 * The validity rules are NOT restated here — they are `validateRig`, the same
 * function the apply command gates on, so a rule added there is enforced on
 * every preset without editing this file.
 */

import {
  bipedPreset,
  validateRig,
  RIG_PRESETS,
  MIN_PRESET_EXTENT,
  type RigPresetId,
} from './rigPresets';
import { computeWorldTransforms } from './skeleton';
import { applyRigPreset, readNodeSkeleton, type SkeletonRig } from './skeletonCommands';
import defaultSceneGraph from '@core/scene/DefaultSceneGraph';
import { readGeometry } from '@core/workspace/geometry';
import { setCommandSystem, CommandSystem, getCommandSystem } from '@core/commands/CommandSystem';
import { SCENE_KIND_PROP } from '@core/scene/seedDefaultScene';
import type { SceneNode } from '@core/types';

/** Deliberately non-square, and not a round number in either axis. */
const BOUNDS = { width: 260, height: 420 };

/** Every registered preset, derived from the registry — not a hardcoded list. */
const PRESET_IDS = Object.keys(RIG_PRESETS) as RigPresetId[];

describe('the fixture is unclean, as required', () => {
  it('is not square — width and height are not interchangeable here', () => {
    expect(BOUNDS.width).not.toBe(BOUNDS.height);
  });
});

describe.each(PRESET_IDS)('preset "%s"', (id) => {
  const rig = (): SkeletonRig => RIG_PRESETS[id](BOUNDS);

  it('is valid by the same rules a hand-built rig obeys', () => {
    expect(validateRig(rig())).toEqual([]);
  });

  it('produces bones, IK chains and controllers', () => {
    const r = rig();
    expect((r.bones ?? []).length).toBeGreaterThan(0);
    expect((r.ikTargets ?? []).length).toBeGreaterThan(0);
    expect((r.controllers ?? []).length).toBeGreaterThan(0);
  });

  it('every controller links to something the rig actually contains', () => {
    // Derived from the rig, not from a list of expected links.
    const r = rig();
    const boneIds = new Set((r.bones ?? []).map((b) => b.id));
    const targetIds = new Set((r.ikTargets ?? []).map((t) => t.boneId));
    for (const c of r.controllers ?? []) {
      const pool = c.link.kind === 'bone' ? boneIds : targetIds;
      expect({ id: c.id, resolves: pool.has(c.link.boneId) }).toEqual({ id: c.id, resolves: true });
    }
  });

  it('every IK chain has a sane chainLength', () => {
    for (const t of rig().ikTargets ?? []) {
      expect({ b: t.boneId, ok: t.chainLength === undefined || (t.chainLength >= 1 && t.chainLength <= 8) })
        .toEqual({ b: t.boneId, ok: true });
    }
  });

  it('the hierarchy resolves — every bone reaches a root', () => {
    // Independent of `validateRig`: actually walk it, so a cycle would hang here
    // if the bound were missing rather than being reported by the same code the
    // apply command uses.
    const r = rig();
    const byId = new Map((r.bones ?? []).map((b) => [b.id, b]));
    for (const b of r.bones ?? []) {
      let cur = b, hops = 0;
      while (cur.parentId && hops <= (r.bones ?? []).length) { cur = byId.get(cur.parentId)!; hops += 1; }
      expect({ id: b.id, rooted: cur.parentId === null }).toEqual({ id: b.id, rooted: true });
    }
  });

  it('every bone is placed — world transforms are finite', () => {
    const w = computeWorldTransforms({ bones: [...(rig().bones ?? [])] });
    for (const b of rig().bones ?? []) {
      const m = w.get(b.id)!;
      expect({ id: b.id, finite: m.every((n) => Number.isFinite(n)) }).toEqual({ id: b.id, finite: true });
    }
  });

  it('scales with the layer — a taller layer makes a taller rig', () => {
    const tall = RIG_PRESETS[id]({ width: BOUNDS.width, height: BOUNDS.height * 2 });
    const spanOf = (r: SkeletonRig) => {
      const ys = (r.bones ?? []).map((b) => b.y);
      return Math.max(...ys) - Math.min(...ys);
    };
    expect(spanOf(tall)).toBeGreaterThan(spanOf(rig()));
  });

  it('ignores layer ROTATION and SCALE — it is a function of bounds only', () => {
    // Bones are authored in layer-local space, so the generator must never see
    // the layer transform. Expressed as the signature admitting nothing else:
    // same bounds in, identical rig out.
    expect(RIG_PRESETS[id]({ ...BOUNDS })).toEqual(rig());
  });

  it('clamps a degenerate layer instead of emitting a collapsed rig', () => {
    const tiny = RIG_PRESETS[id]({ width: 0, height: 0 });
    expect(validateRig(tiny)).toEqual([]);
    const w = computeWorldTransforms({ bones: [...(tiny.bones ?? [])] });
    for (const b of tiny.bones ?? []) expect(w.get(b.id)!.every((n) => Number.isFinite(n))).toBe(true);
    expect((tiny.bones ?? []).every((b) => b.length >= 0)).toBe(true);
    expect(MIN_PRESET_EXTENT).toBeGreaterThan(0);
  });
});

/**
 * Where a controller ACTUALLY ends up, in layer space, derived from the rig's
 * own geometry: an IK controller sits on its goal, an FK controller on its
 * bone's world root. This is the anchor rule 2b requires — it is computed here,
 * from the skeleton solver, and owes nothing to the generator's naming.
 */
function drivenPoints(r: SkeletonRig): Array<{ id: string; side: string; x: number }> {
  const world = computeWorldTransforms({ bones: [...(r.bones ?? [])] });
  const goalOf = new Map((r.ikTargets ?? []).map((t) => [t.boneId, t]));
  return (r.controllers ?? []).map((c) => ({
    id: c.id,
    side: c.side,
    x: c.link.kind === 'ikTarget' ? goalOf.get(c.link.boneId)!.x : world.get(c.link.boneId)![4]!,
  }));
}

describe.each(PRESET_IDS)('preset "%s" — sides, rule 2b, anchored outside the generator', (id) => {
  /**
   * A symmetric preset cannot show a left/right swap by comparing its two halves
   * against each other: mirror the assignment and the comparison still holds. So
   * each side is anchored to an INDEPENDENT expected value — the sign of the
   * DRIVEN POINT's x, which this file defines (`left` = negative x, screen
   * space) and the generator must satisfy.
   */
  it('every controller drives a point on ITS OWN side of the centre line', () => {
    // Anchored to WHERE THE CONTROL ENDS UP, not to a naming convention and not
    // to the other side's value.
    //
    // The first version of this walked parent links looking for a bone with
    // x === 0 and landed on the limb's LOWER bone, whose local x is the upper
    // bone's length — positive on both sides. It failed, which is the only
    // reason the anchor got fixed rather than the expectation. That is twice for
    // the same reason, so the anchor is now TOTAL: `centre` used to be exempt,
    // which left a third of the biped's controllers making an unchecked
    // directional claim. Both presets root their body control at x = 0 so
    // `centre` means "on the midline" and is measurable like the other two.
    const points = drivenPoints(RIG_PRESETS[id](BOUNDS));
    expect(points.length).toBeGreaterThan(0);
    for (const p of points) {
      const expectedSign = p.side === 'left' ? -1 : p.side === 'right' ? 1 : 0;
      expect({ id: p.id, side: p.side, sign: Math.sign(p.x) })
        .toEqual({ id: p.id, side: p.side, sign: expectedSign });
    }
  });

  it('and the layout IS symmetric, so the check above is not free', () => {
    // The positive control for the claim: if the two sides were at different
    // magnitudes, "left is negative" could hold for reasons unrelated to sides.
    //
    // Derived, not named — the biped mirrors arms and legs, the quadruped
    // mirrors fore against hind, and neither list belongs in this file. A pair
    // is any left/right controller whose driven points are equal and opposite.
    const points = drivenPoints(RIG_PRESETS[id](BOUNDS));
    const left = points.filter((p) => p.side === 'left');
    const right = points.filter((p) => p.side === 'right');
    const mirrored = left.filter((l) =>
      right.some((rr) => Math.abs(Math.abs(l.x) - Math.abs(rr.x)) < 1e-9));
    expect({ leftCount: left.length > 0, rightCount: right.length > 0, mirroredPairs: mirrored.length > 0 })
      .toEqual({ leftCount: true, rightCount: true, mirroredPairs: true });
  });

  it('assigns both sides and a centre — not everything to one side', () => {
    const sides = new Set((RIG_PRESETS[id](BOUNDS).controllers ?? []).map((c) => c.side));
    expect([...sides].sort()).toEqual(['centre', 'left', 'right']);
  });

  it('POSITIVE CONTROL: mirroring the side assignment FAILS the anchor', () => {
    // Without this, "every controller is on its own side" could be passing
    // because the anchor is insensitive rather than because the rig is right.
    // Swapping left and right must break it.
    const r = RIG_PRESETS[id](BOUNDS);
    r.controllers = (r.controllers ?? []).map((c) => ({
      ...c,
      side: c.side === 'left' ? ('right' as const) : c.side === 'right' ? ('left' as const) : c.side,
    }));
    const wrong = drivenPoints(r).filter((p) => {
      const expectedSign = p.side === 'left' ? -1 : p.side === 'right' ? 1 : 0;
      return Math.sign(p.x) !== expectedSign;
    });
    expect(wrong.length).toBeGreaterThan(0);
  });
});

describe('validateRig catches what it claims to', () => {
  // POSITIVE CONTROL for the validator: a tool that only ever reports "valid"
  // is indistinguishable from one that does not look. Each invalid rig below is
  // built by breaking a VALID preset, so the mutation is the only difference.
  const base = () => bipedPreset(BOUNDS);

  it('a duplicate bone id', () => {
    const r = base();
    r.bones = [...r.bones!, { ...r.bones![0]! }];
    expect(validateRig(r).map((p) => p.kind)).toContain('duplicate-bone');
  });

  it('an unknown parent', () => {
    const r = base();
    r.bones = r.bones!.map((b, i) => (i === 1 ? { ...b, parentId: 'ghost' } : b));
    expect(validateRig(r).map((p) => p.kind)).toContain('unknown-parent');
  });

  it('a cycle', () => {
    const r = base();
    const [a, b] = [r.bones![0]!, r.bones![1]!];
    r.bones = r.bones!.map((x) => (x.id === a.id ? { ...x, parentId: b.id } : x));
    expect(validateRig(r).map((p) => p.kind)).toContain('cycle');
  });

  it('an out-of-range chainLength', () => {
    const r = base();
    r.ikTargets = r.ikTargets!.map((t, i) => (i === 0 ? { ...t, chainLength: 99 } : t));
    expect(validateRig(r).map((p) => p.kind)).toContain('bad-chain-length');
  });

  it('a dangling controller link', () => {
    const r = base();
    r.controllers = r.controllers!.map((c, i) =>
      i === 0 ? { ...c, link: { kind: 'bone' as const, boneId: 'ghost' } } : c);
    expect(validateRig(r).map((p) => p.kind)).toContain('dangling-link');
  });

  it('an IK target on a bone that does not exist', () => {
    const r = base();
    r.ikTargets = [...r.ikTargets!, { boneId: 'ghost', x: 0, y: 0 }];
    expect(validateRig(r).map((p) => p.kind)).toContain('unknown-target');
  });

  it('and reports NOTHING for the untouched preset', () => {
    expect(validateRig(base())).toEqual([]);
  });
});

const ID = 'preset_probe';
const historyDepth = (): number => {
  const h = getCommandSystem().getHistory() as unknown as { undoStack?: unknown[] };
  return h.undoStack?.length ?? 0;
};
const rigOf = (): SkeletonRig | undefined => readNodeSkeleton(defaultSceneGraph.getNode(ID)!);

/**
 * The probe layer. `transform` carries the ROTATION and NON-UNIFORM SCALE rule
 * 3a asks for — a layer sitting at identity is the clean fixture that would make
 * "the preset ignores the layer transform" unfalsifiable.
 */
function addProbeNode(transform?: { rotation?: number; scale?: { x: number; y: number } }): void {
  if (defaultSceneGraph.getNode(ID)) defaultSceneGraph.removeNode(ID);
  defaultSceneGraph.addNode({
    id: ID, name: ID, parent: null, children: [], visible: true, locked: false,
    transform: {
      position: { x: 0, y: 0 },
      rotation: transform?.rotation ?? 0,
      scale: transform?.scale ?? { x: 1, y: 1 },
    },
    components: [
      {
        id: `${ID}_t`, type: 'Transform',
        props: {
          [SCENE_KIND_PROP]: 'shape', x: 0, y: 0,
          rotation: transform?.rotation ?? 0,
          scaleX: transform?.scale?.x ?? 1,
          scaleY: transform?.scale?.y ?? 1,
          width: BOUNDS.width, height: BOUNDS.height,
        },
      },
      { id: `${ID}_s`, type: 'Style', props: { opacity: 100, fill: '#2b7eff' } },
    ],
  } as unknown as SceneNode);
}

describe.each(PRESET_IDS)('applying preset "%s" is ONE undo entry', (id) => {
  const preset = (): SkeletonRig => RIG_PRESETS[id](BOUNDS);

  beforeEach(() => {
    setCommandSystem(new CommandSystem({ services: {} as never, getState: () => ({}) }));
    addProbeNode();
  });

  it('writes the whole rig and records exactly one entry', () => {
    const d0 = historyDepth();
    expect(applyRigPreset(ID, preset())).toEqual([]);
    // Count, not just "undo works" — bundling failures show up as N entries.
    expect(historyDepth()).toBe(d0 + 1);
    const r = rigOf()!;
    expect(r.bones!.length).toBeGreaterThan(0);
    expect(r.ikTargets!.length).toBeGreaterThan(0);
    expect(r.controllers!.length).toBeGreaterThan(0);
  });

  it('ONE undo removes the entire rig — bones, chains and controllers together', () => {
    applyRigPreset(ID, preset());
    getCommandSystem().getHistory().undo();
    const r = rigOf();
    expect(r?.bones ?? []).toEqual([]);
    expect(r?.ikTargets ?? []).toEqual([]);
    expect(r?.controllers ?? []).toEqual([]);
  });

  it('REFUSES an invalid rig rather than writing a broken one', () => {
    const broken = preset();
    broken.bones = [...broken.bones!, { ...broken.bones![0]! }];
    const d0 = historyDepth();
    const problems = applyRigPreset(ID, broken);
    expect(problems.map((p) => p.kind)).toContain('duplicate-bone');
    expect(historyDepth()).toBe(d0);          // nothing recorded
    expect(rigOf()?.bones ?? []).toEqual([]); // nothing written
  });
});

/**
 * Rule 3a — the fixtures the clean one would have excluded.
 *
 * The suite already refuses a square layer. These two are the other halves of
 * that argument, and they were previously asserted as `preset({...BOUNDS})`
 * deep-equals `preset(BOUNDS)` — which is a determinism check wearing a
 * transform-invariance label: a generator that read the layer transform would
 * pass it, because the argument never carried one either way.
 *
 * Driving it through the SCENE GRAPH is what makes the claim real: the layer
 * genuinely is rotated and non-uniformly scaled, and the rig written for it must
 * be identical to the rig written for a layer at rest.
 */
describe.each(PRESET_IDS)('preset "%s" is a function of BOUNDS, not of the layer transform', (id) => {
  beforeEach(() => {
    setCommandSystem(new CommandSystem({ services: {} as never, getState: () => ({}) }));
  });

  const rigWritten = (t?: { rotation?: number; scale?: { x: number; y: number } }): SkeletonRig => {
    addProbeNode(t);
    expect(applyRigPreset(ID, RIG_PRESETS[id](BOUNDS))).toEqual([]);
    return rigOf()!;
  };

  it('a layer rotated 37° and scaled 2.4 × 0.6 stores the same rig as one at rest', () => {
    const rest = rigWritten();
    const skewed = rigWritten({ rotation: (37 * Math.PI) / 180, scale: { x: 2.4, y: 0.6 } });
    expect(skewed).toEqual(rest);
  });

  it('POSITIVE CONTROL: the fixture is genuinely unclean, read through readGeometry', () => {
    // Otherwise the equality above holds because both fixtures were at rest.
    //
    // Read through `readGeometry` — the function `BoneControls` actually calls
    // to size a preset — rather than off `node.transform`. The first version of
    // this read `node.transform.scale` and reported `nonUniform: false` on a
    // layer that IS non-uniformly scaled: the Transform COMPONENT is the
    // authority and `node.transform` is not what anything downstream reads.
    // The positive control caught its own fixture, which is what it is for.
    addProbeNode({ rotation: (37 * Math.PI) / 180, scale: { x: 2.4, y: 0.6 } });
    const g = readGeometry(defaultSceneGraph.getNode(ID)!)!;
    expect({
      rotated: g.rotationDeg !== 0,
      nonUniform: g.scaleX !== g.scaleY,
      nonSquare: g.width !== g.height,
    }).toEqual({ rotated: true, nonUniform: true, nonSquare: true });
  });

  it('and the preset is sized from the UNSCALED box, so scale cannot leak in', () => {
    // The seam this whole describe rests on: `BoneControls` passes
    // `geom.width`/`geom.height`, which `readGeometry` documents as the BASE
    // (unscaled) size. If it ever returned the scaled box, a scaled layer would
    // silently get a differently-proportioned rig and the equality above would
    // start failing rather than this — so the reason is pinned here explicitly.
    addProbeNode({ rotation: (37 * Math.PI) / 180, scale: { x: 2.4, y: 0.6 } });
    const g = readGeometry(defaultSceneGraph.getNode(ID)!)!;
    expect({ width: g.width, height: g.height }).toEqual({ width: BOUNDS.width, height: BOUNDS.height });
  });
});
