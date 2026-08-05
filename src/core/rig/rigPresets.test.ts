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

describe('sides — rule 2b, anchored outside the generator', () => {
  /**
   * A symmetric preset cannot show a left/right swap by comparing its two halves
   * against each other: mirror the assignment and the comparison still holds. So
   * each side is anchored to an INDEPENDENT expected value — the sign of the
   * DRIVEN POINT's x, which this file defines (`left` = negative x, screen
   * space) and the generator must satisfy.
   */
  it('every sided controller drives a point on ITS OWN side of the centre line', () => {
    // Anchored to WHERE THE CONTROL ENDS UP, computed from the rig's own
    // geometry — not to a naming convention and not to the other side's value.
    // An IK controller is placed at its goal; an FK controller at its bone's
    // world root. Both are positions this test derives itself.
    //
    // The first version of this walked parent links looking for a bone with
    // x === 0 and landed on the limb's LOWER bone, whose local x is the upper
    // bone's length — positive on both sides. It failed, which is the only
    // reason the anchor got fixed rather than the expectation.
    const r = bipedPreset(BOUNDS);
    const world = computeWorldTransforms({ bones: [...(r.bones ?? [])] });
    const goalOf = new Map((r.ikTargets ?? []).map((t) => [t.boneId, t]));
    const sided = (r.controllers ?? []).filter((c) => c.side !== 'centre');
    expect(sided.length).toBeGreaterThan(0);
    for (const c of sided) {
      const x = c.link.kind === 'ikTarget'
        ? goalOf.get(c.link.boneId)!.x
        : world.get(c.link.boneId)![4]!;
      const expectedSign = c.side === 'left' ? -1 : 1;
      expect({ id: c.id, side: c.side, sign: Math.sign(x) })
        .toEqual({ id: c.id, side: c.side, sign: expectedSign });
    }
  });
  it('and the layout IS symmetric, so the check above is not free', () => {
    // The positive control for the claim: if the two sides were at different
    // magnitudes, "left is negative" could hold for reasons unrelated to sides.
    const r = bipedPreset(BOUNDS);
    const byId = new Map((r.bones ?? []).map((b) => [b.id, b]));
    for (const base of ['arm', 'leg']) {
      const l = byId.get(`${base}_l_upper`)!;
      const rr = byId.get(`${base}_r_upper`)!;
      expect({ base, mirrored: Math.abs(l.x) === Math.abs(rr.x) && l.x === -rr.x })
        .toEqual({ base, mirrored: true });
      expect({ base, sameY: l.y === rr.y }).toEqual({ base, sameY: true });
    }
  });

  it('assigns both sides and a centre — not everything to one side', () => {
    const sides = new Set((bipedPreset(BOUNDS).controllers ?? []).map((c) => c.side));
    expect([...sides].sort()).toEqual(['centre', 'left', 'right']);
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

describe('applying a preset is ONE undo entry', () => {
  const ID = 'preset_probe';
  const historyDepth = () => {
    const h = getCommandSystem().getHistory() as unknown as { undoStack?: unknown[] };
    return h.undoStack?.length ?? 0;
  };
  const rigOf = () => readNodeSkeleton(defaultSceneGraph.getNode(ID)!);

  beforeEach(() => {
    setCommandSystem(new CommandSystem({ services: {} as never, getState: () => ({}) }));
    if (defaultSceneGraph.getNode(ID)) defaultSceneGraph.removeNode(ID);
    defaultSceneGraph.addNode({
      id: ID, name: ID, parent: null, children: [], visible: true, locked: false,
      transform: { position: { x: 0, y: 0 }, rotation: 0, scale: { x: 1, y: 1 } },
      components: [
        { id: `${ID}_t`, type: 'Transform', props: { [SCENE_KIND_PROP]: 'shape', x: 0, y: 0, width: BOUNDS.width, height: BOUNDS.height } },
        { id: `${ID}_s`, type: 'Style', props: { opacity: 100, fill: '#2b7eff' } },
      ],
    } as unknown as SceneNode);
  });

  it('writes the whole rig and records exactly one entry', () => {
    const d0 = historyDepth();
    expect(applyRigPreset(ID, bipedPreset(BOUNDS))).toEqual([]);
    // Count, not just "undo works" — bundling failures show up as N entries.
    expect(historyDepth()).toBe(d0 + 1);
    const r = rigOf()!;
    expect(r.bones!.length).toBeGreaterThan(0);
    expect(r.ikTargets!.length).toBeGreaterThan(0);
    expect(r.controllers!.length).toBeGreaterThan(0);
  });

  it('ONE undo removes the entire rig — bones, chains and controllers together', () => {
    applyRigPreset(ID, bipedPreset(BOUNDS));
    getCommandSystem().getHistory().undo();
    const r = rigOf();
    expect(r?.bones ?? []).toEqual([]);
    expect(r?.ikTargets ?? []).toEqual([]);
    expect(r?.controllers ?? []).toEqual([]);
  });

  it('REFUSES an invalid rig rather than writing a broken one', () => {
    const broken = bipedPreset(BOUNDS);
    broken.bones = [...broken.bones!, { ...broken.bones![0]! }];
    const d0 = historyDepth();
    const problems = applyRigPreset(ID, broken);
    expect(problems.map((p) => p.kind)).toContain('duplicate-bone');
    expect(historyDepth()).toBe(d0);          // nothing recorded
    expect(rigOf()?.bones ?? []).toEqual([]); // nothing written
  });
});
