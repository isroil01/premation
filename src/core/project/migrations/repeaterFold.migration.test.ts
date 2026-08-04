/**
 * 1.4.0 → 1.5.0 — the Repeater folds into the path-operator chain.
 *
 * The two things a migration of this shape can get wrong, both silent:
 *
 *  1. It changes the PICTURE where it did not have to. The repeater was a fixed
 *     stage after every operator and after trim, so the entry has to be
 *     APPENDED. Prepending it would re-render every document that has both.
 *  2. It drops the KEYFRAMES. All eight numeric repeater params were animatable
 *     under `rep.<param>`; losing one leaves the shape rendering, frozen at its
 *     static value — the same failure mode as the 1.1.0 matte `sourceId`, the
 *     1.3.0 operator re-keying and the 1.4.0 trim, and nobody notices until
 *     they scrub.
 *
 * And the thing this migration does NOT claim. It is not lossless: copies used
 * to be placed in COMP space and are now baked into layer-local geometry, so a
 * repeater on a ROTATED or SCALED layer deliberately moves. That is asserted
 * here as a positive fact, not left as prose — see the render section — because
 * a migration whose stated limits are untested is a migration whose limits will
 * drift.
 */

import { v1_4_0_to_v1_5_0 } from './v1_4_0_to_v1_5_0';
import { migrateDocument, CURRENT_DOCUMENT_VERSION, MIGRATIONS } from './index';
import type { EditorDocument } from '@core/api/cloudDocument';
import SceneGraph from '@core/scene/SceneGraph';
import { AnimationEngine } from '@motion/animation';
import { buildSnapshot } from '@core/rendering/buildSnapshot';
import { SCENE_KIND_PROP } from '@core/scene/seedDefaultScene';
import { readPathOps, readRepeaterOp } from '@core/scene/pathOps';
import type { SceneNode } from '@core/types';

const COMP = { width: 800, height: 600, background: '#101014' };

/**
 * A 1.4.0 document: a shape with a zig-zag, a trim AND a repeater, with an
 * animated per-copy rotation.
 *
 * All three operators on purpose. The append has to land after the trim that
 * 1.4.0 itself appended, which a fixture carrying only a deformer could not
 * distinguish from landing after the deformer.
 */
function legacyDoc(): EditorDocument {
  return {
    version: '1.4.0',
    scene: {
      nodes: [
        {
          id: 'rect',
          name: 'rect',
          parent: null,
          children: [],
          visible: true,
          locked: false,
          transform: { position: { x: 200, y: 300 }, rotation: 0, scale: { x: 1, y: 1 } },
          components: [
            { id: 'rect_t', type: 'Transform', props: { [SCENE_KIND_PROP]: 'shape', x: 200, y: 300, rotation: 0 } },
            { id: 'rect_s', type: 'Style', props: { opacity: 100, fill: '#2b7eff' } },
            {
              id: 'rect_fx',
              type: 'fx',
              props: {
                pathOps: [
                  { id: 'z1', type: 'zigzag', amount: 16, detail: 5 },
                  { id: 'trimop_rect', type: 'trim', amount: 0, detail: 0, start: 0, end: 100, offset: 0 },
                ],
                repeater: {
                  copies: 4, offsetX: 100, offsetY: 0, offsetRotation: 0,
                  offsetScale: 1, offsetOpacity: 0.5, composite: 'above',
                },
              },
            },
          ],
        },
      ],
    },
    animation: {
      tracks: {
        rect: {
          'rep.offsetRotation': { keyframes: [{ t: 0, v: 0 }, { t: 2, v: 90 }] },
          'rep.copies': { keyframes: [{ t: 0, v: 1 }, { t: 2, v: 8 }] },
          'pathop.z1.amount': { keyframes: [{ t: 0, v: 4 }] },
        },
      },
    },
  } as unknown as EditorDocument;
}

function fxProps(doc: EditorDocument): Record<string, unknown> {
  const node = (doc.scene as { nodes: Array<{ components: Array<{ type: string; props: Record<string, unknown> }> }> }).nodes[0]!;
  return node.components.find((c) => c.type === 'fx')!.props;
}
function tracksOf(doc: EditorDocument): Record<string, unknown> {
  return (doc.animation as { tracks: Record<string, Record<string, unknown>> }).tracks.rect!;
}

describe('v1_4_0_to_v1_5_0 — shape', () => {
  it('APPENDS the repeater LAST, reproducing pathOps → trim → repeater', () => {
    const list = fxProps(v1_4_0_to_v1_5_0.migrate(legacyDoc())).pathOps as Array<{ id: string; type: string }>;
    expect(list.map((o) => o.type)).toEqual(['zigzag', 'trim', 'repeater']);
  });

  it('carries every parameter across, not just the ones with defaults', () => {
    const list = fxProps(v1_4_0_to_v1_5_0.migrate(legacyDoc())).pathOps as Array<Record<string, unknown>>;
    const rep = list[2]!;
    expect(rep.copies).toBe(4);
    expect(rep.offsetX).toBe(100);
    expect(rep.offsetOpacity).toBe(0.5);
    expect(rep.composite).toBe('above');
    // The four that postdate the original feature default to their no-op value,
    // exactly as `readRepeaterConfig` used to read them.
    expect(rep.offset).toBe(0);
    expect(rep.anchorX).toBe(0);
    expect(rep.anchorY).toBe(0);
    expect(rep.offsetRotation).toBe(0);
  });

  it('DELETES fx.repeater — no dual-shape reads, per the 1.3.0 and 1.4.0 precedent', () => {
    expect(fxProps(v1_4_0_to_v1_5_0.migrate(legacyDoc())).repeater).toBeUndefined();
  });

  it('is a pure function of its input — the same doc twice gives the same ids', () => {
    // A random id would make two machines migrating one project produce
    // documents that differ, and a version-history diff would show a change
    // nobody made.
    expect(JSON.stringify(v1_4_0_to_v1_5_0.migrate(legacyDoc())))
      .toEqual(JSON.stringify(v1_4_0_to_v1_5_0.migrate(legacyDoc())));
  });

  it('leaves a document with no repeater completely alone', () => {
    const doc = legacyDoc();
    delete fxProps(doc).repeater;
    expect(v1_4_0_to_v1_5_0.migrate(doc)).toBe(doc); // same reference: untouched
  });

  it('cannot collide with the 1.3.0 operator or 1.4.0 trim id on the same node', () => {
    // `op_<nodeId>` / `trimop_<nodeId>` / `repop_<nodeId>`. Colliding would
    // merge two operators' keyframes into one.
    const list = fxProps(v1_4_0_to_v1_5_0.migrate(legacyDoc())).pathOps as Array<{ id: string }>;
    expect(list[2]!.id).toBe('repop_rect');
    expect(list.map((o) => o.id)).toEqual(['z1', 'trimop_rect', 'repop_rect']);
  });
});

describe('v1_4_0_to_v1_5_0 — keyframes survive the reroute', () => {
  it('re-keys every animated repeater param onto the new entry', () => {
    const tracks = tracksOf(v1_4_0_to_v1_5_0.migrate(legacyDoc()));
    expect(tracks['rep.offsetRotation']).toBeUndefined();
    expect(tracks['rep.copies']).toBeUndefined();
    expect(tracks['pathop.repop_rect.offsetRotation'])
      .toEqual({ keyframes: [{ t: 0, v: 0 }, { t: 2, v: 90 }] });
    expect(tracks['pathop.repop_rect.copies'])
      .toEqual({ keyframes: [{ t: 0, v: 1 }, { t: 2, v: 8 }] });
  });

  it('does not orphan or duplicate the OTHER operator’s tracks', () => {
    const tracks = tracksOf(v1_4_0_to_v1_5_0.migrate(legacyDoc()));
    expect(tracks['pathop.z1.amount']).toEqual({ keyframes: [{ t: 0, v: 4 }] });
    expect(Object.keys(tracks).sort()).toEqual([
      'pathop.repop_rect.copies', 'pathop.repop_rect.offsetRotation', 'pathop.z1.amount',
    ]);
  });

  it('covers ALL NINE params, not just the two the fixture animates', () => {
    // The list is spelled out in the migration rather than imported from the
    // live one, so nothing but a test keeps the two in step. A param missing
    // from it loses its animation in silence.
    const doc = legacyDoc();
    const params = [
      'copies', 'offsetX', 'offsetY', 'offsetRotation', 'offsetScale',
      'offsetOpacity', 'offset', 'anchorX', 'anchorY',
    ];
    for (const p of params) tracksOf(doc)[`rep.${p}`] = { keyframes: [{ t: 0, v: 1 }] };
    const tracks = tracksOf(v1_4_0_to_v1_5_0.migrate(doc));
    for (const p of params) {
      expect(tracks[`rep.${p}`]).toBeUndefined();
      expect(tracks[`pathop.repop_rect.${p}`]).toEqual({ keyframes: [{ t: 0, v: 1 }] });
    }
  });

  it('a document with no animation block at all does not throw', () => {
    const doc = legacyDoc();
    delete (doc as { animation?: unknown }).animation;
    expect(() => v1_4_0_to_v1_5_0.migrate(doc)).not.toThrow();
  });
});

describe('v1_4_0_to_v1_5_0 — registered in the chain', () => {
  it('brings a 1.4.0 document to the current version through the real walker', () => {
    const out = migrateDocument(legacyDoc());
    expect(out.version).toBe(CURRENT_DOCUMENT_VERSION);
    expect(CURRENT_DOCUMENT_VERSION).toBe('1.5.0');
  });

  it('is the last step and carries nothing but this change', () => {
    const last = MIGRATIONS[MIGRATIONS.length - 1]!;
    expect(last.from).toBe('1.4.0');
    expect(last.to).toBe('1.5.0');
  });
});

/**
 * THE RENDER, which is the only place the claim can actually be checked.
 *
 * The migrated document is loaded into a real SceneGraph and put through
 * `buildSnapshot`, and the copies' comp positions are compared against the
 * numbers the PRE-FOLD renderer produced — 200, 300, 400, 500 for four copies
 * at offsetX 100 from x=200, which is what `buildSnapshotRepeater.test.ts`
 * asserted before the fold.
 */
describe('v1_4_0_to_v1_5_0 — what the migration honestly claims', () => {
  function loadMigrated(mutate?: (props: Record<string, unknown>) => void): SceneGraph {
    const doc = legacyDoc();
    // The fixture's zigzag and trim would move the geometry for reasons that
    // have nothing to do with the repeater; drop them so the comparison is
    // about placement only.
    (fxProps(doc).pathOps as unknown[]).length = 0;
    if (mutate) {
      const node = (doc.scene as { nodes: Array<{ components: Array<{ type: string; props: Record<string, unknown> }> }> }).nodes[0]!;
      mutate(node.components.find((c) => c.type === 'Transform')!.props);
    }
    const migrated = v1_4_0_to_v1_5_0.migrate(doc);
    const nodes = (migrated.scene as { nodes: SceneNode[] }).nodes;
    const graph = new SceneGraph();
    graph.addNode(nodes[0]!);
    return graph;
  }

  function centresX(graph: SceneGraph): number[] {
    const layer = buildSnapshot(graph, new AnimationEngine(), 0, undefined, undefined, undefined, undefined, COMP).layers[0]!;
    const rad = ((layer.rotation ?? 0) * Math.PI) / 180;
    return layer.subpaths!.map((s) => {
      const cx = s.points.reduce((a, p) => a + p.x, 0) / s.points.length;
      const cy = s.points.reduce((a, p) => a + p.y, 0) / s.points.length;
      const sx = cx * (layer.scaleX ?? 1);
      const sy = cy * (layer.scaleY ?? 1);
      return Math.round(layer.x + sx * Math.cos(rad) - sy * Math.sin(rad));
    });
  }

  it('reads back as a chain entry the live code understands', () => {
    const node = loadMigrated().getNode('rect')!;
    expect(readPathOps(node).map((o) => o.type)).toEqual(['repeater']);
    expect(readRepeaterOp(node)!.copies).toBe(4);
  });

  it('IDENTICAL on an untransformed layer — the claim it does make', () => {
    expect(centresX(loadMigrated())).toEqual([200, 300, 400, 500]);
  });

  it('CHANGED on a rotated layer — the claim it does NOT make', () => {
    // 180 degrees, so the ladder runs backwards along comp +X and the numbers
    // stay exact rather than needing a tolerance.
    //   pre-fold:  200, 300, 400, 500   (arrangement pinned to comp +X)
    //   post-fold: 200, 100,   0, -100  (the layer turns the whole group)
    const rotated = centresX(loadMigrated((t) => { t.rotation = 180; }));
    expect(rotated).toEqual([200, 100, 0, -100]);
    expect(rotated).not.toEqual([200, 300, 400, 500]);
  });

  it('CHANGED on a scaled layer — likewise, and not implied by rotation', () => {
    // Rotation changes the ladder's DIRECTION; scale changes its LENGTH.
    const scaled = centresX(loadMigrated((t) => { t.scaleX = 2; t.scaleY = 2; }));
    expect(scaled).toEqual([200, 400, 600, 800]);
  });
});
