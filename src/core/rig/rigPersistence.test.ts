/**
 * Rig data survives a save → load round trip.
 *
 * Everything the rig adds rides on plain JSON (component props + animation
 * tracks), so this SHOULD be free — but "should be free" is exactly the claim
 * that turns into a corrupted project when one field happens to be a typed
 * array, a Map, or a numeric-keyed object. Phase 3/4 added several candidates:
 * `weightPaint.bones` is keyed by vertex INDEX (numbers become strings in JSON),
 * and spatial tangents are sparse arrays containing nulls.
 */

import { serializeProject, parseProject } from '@core/persistence/ProjectSerializer';
import { applyWeightPaint, emptyWeightPaint, paintWeights } from './weightPaint';
import { sampleDataTrack, type DataTrack } from '@motion/animation';
import type { PuppetRig } from './puppet';
import type { SkeletonRig } from './skeletonCommands';
import type { VertexWeight } from './skinning';

/** Round trip anything through the real project serializer. */
function roundTrip<T>(value: T): T {
  const doc = { version: '1.0.0', payload: value } as never;
  return (parseProject(serializeProject(doc)) as unknown as { payload: T }).payload;
}

describe('puppet rig round trip', () => {
  const rig: PuppetRig = {
    meshDensity: 22,
    meshExpansion: 6,
    solver: 'arap',
    maxRotationDeg: 35,
    meshMode: 'silhouette',
    pins: [
      { id: 'pin_1', name: 'Anchor', x: -40, y: 12 },
      {
        id: 'pin_2', name: 'Mover', x: 40, y: -12,
        rotation: 33, stiffness: 1.25, scale: 1.7, overlap: -60, overlapExtent: 2.5,
      },
    ],
  };

  it('preserves every field, including the Phase 3 additions', () => {
    expect(roundTrip(rig)).toEqual(rig);
  });

  it('does not invent defaults for absent optional fields', () => {
    const bare: PuppetRig = { pins: [{ id: 'p', name: 'p', x: 0, y: 0 }] };
    const out = roundTrip(bare);
    expect(out).toEqual(bare);
    expect(out.pins[0]!.scale).toBeUndefined();
    expect(out.meshMode).toBeUndefined();
  });
});

describe('skeleton rig round trip', () => {
  it('preserves bones, names, scales, IK targets and pole vectors', () => {
    const skel: SkeletonRig = {
      bones: [
        { id: 'b1', name: 'Upper Arm', parentId: null, length: 50, x: -10, y: 0, rotation: 0.5 },
        { id: 'b2', name: 'Forearm', parentId: 'b1', length: 40, x: 50, y: 0, rotation: -0.25, scaleX: 1.8, scaleY: 0.6 },
      ],
      ikTargets: [{ boneId: 'b2', x: 20, y: 30, enabled: true, chainLength: 2, pole: { x: 0, y: -90 } }],
      meshDensity: 14,
      meshExpansion: 4,
    };
    expect(roundTrip(skel)).toEqual(skel);
  });
});

describe('weight paint round trip', () => {
  /** A 3-vertex mesh is enough — the risk is key TYPE, not size. */
  const verts = new Float32Array([0, 0, 0, 0, 10, 0, 0, 0, 20, 0, 0, 0]);

  function painted() {
    return paintWeights(emptyWeightPaint(3), 'b1', verts, { x: 0, y: 0 }, 50, {
      mode: 'add', strength: 1, falloff: 0,
    });
  }

  it('survives JSON despite being keyed by vertex INDEX', () => {
    const before = painted();
    const after = roundTrip(before);
    expect(after.vertexCount).toBe(before.vertexCount);
    // JSON turns numeric keys into strings; the important thing is that lookup
    // by NUMBER still resolves, because that is how applyWeightPaint reads it.
    expect(after.bones.b1![0]).toBeCloseTo(before.bones.b1![0]!, 6);
    expect(after.bones.b1![2]).toBeCloseTo(before.bones.b1![2]!, 6);
  });

  it('still merges into the auto binding after a round trip', () => {
    const auto: VertexWeight[] = [
      { boneId: 'b1', weight: 0.4 },
      { boneId: 'b2', weight: 0.6 },
    ];
    const before = applyWeightPaint(auto, 0, painted());
    const after = applyWeightPaint(auto, 0, roundTrip(painted()));
    expect(after).toEqual(before);
    expect(after.reduce((s, w) => s + w.weight, 0)).toBeCloseTo(1, 6);
  });
});

describe('animation track round trip', () => {
  it('a pin position track keeps easing AND spatial tangents', () => {
    const track: DataTrack = {
      nodeId: 'n', prop: 'puppet.p.position', kind: 'points',
      keyframes: [
        { t: 0, value: [{ x: 0, y: 0 }], easing: 'bezier', bezier: [0.4, 0, 0.6, 1], so: [{ x: 30, y: -20 }] },
        // A sparse tangent array containing null is the shape padTangents makes.
        { t: 2, value: [{ x: 100, y: 0 }], easing: 'easeIn', si: [null] },
      ],
    } as DataTrack;

    const out = roundTrip(track);
    expect(out).toEqual(track);
    // And it still SAMPLES the same — the curve survived, not just the bytes.
    for (const t of [0, 0.5, 1, 1.5, 2]) {
      expect(sampleDataTrack(out, t)).toEqual(sampleDataTrack(track, t));
    }
  });

  it('a curved segment still reads as curved after reloading', () => {
    const track: DataTrack = {
      nodeId: 'n', prop: 'puppet.p.position', kind: 'points',
      keyframes: [
        { t: 0, value: [{ x: -100, y: 0 }], so: [{ x: 40, y: -110 }] },
        { t: 2, value: [{ x: 100, y: 0 }], si: [{ x: -40, y: -110 }] },
      ],
    } as DataTrack;
    const mid = sampleDataTrack(roundTrip(track), 1) as Array<{ x: number; y: number }>;
    // The chord is flat; a surviving tangent bows the path well above it.
    expect(mid[0]!.y).toBeLessThan(-20);
  });
});
