/**
 * 1.3.0 → 1.4.0 — Trim Paths folds into the path-operator chain.
 *
 * The two things a migration of this shape can get wrong, both silent:
 *
 *  1. It changes the PICTURE. Trim used to be a fixed stage after every
 *     operator, so the entry has to be APPENDED. Prepending it would re-render
 *     every document that has both a trim and a deformer — and it would look
 *     deliberate, because the shape is still valid.
 *  2. It drops the KEYFRAMES. `trim.end` is how a draw-on is animated, the
 *     most-animated parameter this feature has. Losing the track leaves the
 *     shape rendering, frozen at its static value — the same failure mode as
 *     the 1.1.0 matte `sourceId` and the 1.3.0 operator re-keying, and nobody
 *     notices until they scrub.
 *
 * A pre-change fixture is loaded through the real migration and both are
 * asserted, plus the actual RENDER through `buildSnapshot`.
 */

import { v1_3_0_to_v1_4_0 } from './v1_3_0_to_v1_4_0';
import { migrateDocument, CURRENT_DOCUMENT_VERSION, MIGRATIONS } from './index';
import type { EditorDocument } from '@core/api/cloudDocument';
import SceneGraph from '@core/scene/SceneGraph';
import { AnimationEngine } from '@motion/animation';
import { buildSnapshot } from '@core/rendering/buildSnapshot';
import { SCENE_KIND_PROP } from '@core/scene/seedDefaultScene';
import { readPathOps, readTrimOp } from '@core/scene/pathOps';
import type { SceneNode } from '@core/types';

const COMP = { width: 800, height: 600, background: '#101014' };

/** A 1.3.0 document: a shape with a zig-zag AND a trim, and an animated end. */
function legacyDoc(): EditorDocument {
  return {
    version: '1.3.0',
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
                pathOps: [{ id: 'z1', type: 'zigzag', amount: 16, detail: 5 }],
                trim: { start: 0, end: 65, offset: 0 },
              },
            },
          ],
        },
      ],
    },
    animation: {
      tracks: {
        rect: {
          'trim.end': { keyframes: [{ t: 0, v: 0 }, { t: 2, v: 100 }] },
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

describe('v1_3_0_to_v1_4_0 — shape', () => {
  it('APPENDS trim after the existing chain, reproducing pathOps → trim', () => {
    const ops = v1_3_0_to_v1_4_0.migrate(legacyDoc());
    const list = fxProps(ops).pathOps as Array<{ id: string; type: string; end?: number }>;
    expect(list.map((o) => o.type)).toEqual(['zigzag', 'trim']);
    expect(list[1]!.end).toBe(65);
  });

  it('DELETES fx.trim — no dual-shape reads, per the 1.3.0 precedent', () => {
    expect(fxProps(v1_3_0_to_v1_4_0.migrate(legacyDoc())).trim).toBeUndefined();
  });

  it('is a pure function of its input — the same doc twice gives the same ids', () => {
    // A random id would make two machines migrating one project produce
    // documents that differ, and a version-history diff would show a change
    // nobody made.
    expect(JSON.stringify(v1_3_0_to_v1_4_0.migrate(legacyDoc())))
      .toEqual(JSON.stringify(v1_3_0_to_v1_4_0.migrate(legacyDoc())));
  });

  it('leaves a document with no trim completely alone', () => {
    const doc = legacyDoc();
    delete fxProps(doc).trim;
    expect(v1_3_0_to_v1_4_0.migrate(doc)).toBe(doc); // same reference: untouched
  });

  it('cannot collide with a 1.3.0-migrated operator id on the same node', () => {
    // `op_<nodeId>` vs `trimop_<nodeId>`. Colliding would merge two operators'
    // keyframes into one.
    const list = fxProps(v1_3_0_to_v1_4_0.migrate(legacyDoc())).pathOps as Array<{ id: string }>;
    expect(list[1]!.id).toBe('trimop_rect');
    expect(list[1]!.id).not.toBe('op_rect');
  });
});

describe('v1_3_0_to_v1_4_0 — keyframes survive the reroute', () => {
  it('re-keys trim.end onto the new entry, preserving the keyframes', () => {
    const tracks = tracksOf(v1_3_0_to_v1_4_0.migrate(legacyDoc()));
    expect(tracks['trim.end']).toBeUndefined();
    expect(tracks['pathop.trimop_rect.end']).toEqual({ keyframes: [{ t: 0, v: 0 }, { t: 2, v: 100 }] });
  });

  it('does not orphan or duplicate the OTHER operator’s tracks', () => {
    const tracks = tracksOf(v1_3_0_to_v1_4_0.migrate(legacyDoc()));
    expect(tracks['pathop.z1.amount']).toEqual({ keyframes: [{ t: 0, v: 4 }] });
    expect(Object.keys(tracks).sort()).toEqual(['pathop.trimop_rect.end', 'pathop.z1.amount']);
  });

  it('re-keys start and offset too, not just end', () => {
    const doc = legacyDoc();
    tracksOf(doc)['trim.start'] = { keyframes: [{ t: 0, v: 10 }] };
    tracksOf(doc)['trim.offset'] = { keyframes: [{ t: 0, v: 20 }] };
    const tracks = tracksOf(v1_3_0_to_v1_4_0.migrate(doc));
    expect(tracks['pathop.trimop_rect.start']).toEqual({ keyframes: [{ t: 0, v: 10 }] });
    expect(tracks['pathop.trimop_rect.offset']).toEqual({ keyframes: [{ t: 0, v: 20 }] });
  });
});

describe('v1_3_0_to_v1_4_0 — registered in the chain', () => {
  it('brings a 1.3.0 document to the current version through the real walker', () => {
    const out = migrateDocument(legacyDoc());
    expect(out.version).toBe(CURRENT_DOCUMENT_VERSION);
    // NOT `toBe('1.4.0')` any more. This step is no longer the last one — the
    // repeater fold added 1.4.0 → 1.5.0 — and pinning the current version here
    // made a later, unrelated migration fail this suite. What the test is
    // actually for is that a 1.3.0 document walks all the way to today.
  });

  it('carries nothing but this change, and steps 1.3.0 → 1.4.0 exactly once', () => {
    const steps = MIGRATIONS.filter((m) => m.to === '1.4.0');
    expect(steps.map((m) => m.from)).toEqual(['1.3.0']);
  });
});

/**
 * The assertion that actually matters: the PICTURE is unchanged.
 *
 * A migrated document must render exactly as the old fixed `pathOps → trim`
 * pipeline rendered it. Built through the real `buildSnapshot`, comparing the
 * migrated document's geometry against the same shape assembled by hand in the
 * order the old pipeline used.
 */
describe('v1_3_0_to_v1_4_0 — render output is preserved', () => {
  function graphFrom(doc: EditorDocument): SceneGraph {
    const g = new SceneGraph();
    for (const n of (doc.scene as { nodes: SceneNode[] }).nodes) g.addNode(structuredClone(n));
    return g;
  }
  const geometryOf = (g: SceneGraph): string => {
    const layer = buildSnapshot(g, new AnimationEngine(), 0, undefined, undefined, undefined, undefined, COMP).layers[0]!;
    const runs = layer.subpaths ?? (layer.pathPoints ? [{ points: layer.pathPoints, open: false }] : []);
    return runs.map((r) => `${r.open ? 'O' : 'C'}:${r.points.map((p) => `${p.x.toFixed(3)},${p.y.toFixed(3)}`).join(' ')}`).join('||');
  };

  it('renders identically to the pre-migration fixed pipeline', () => {
    const migrated = graphFrom(v1_3_0_to_v1_4_0.migrate(legacyDoc()));

    // The OLD pipeline, spelled out: zig-zag the outline, then trim the result.
    const byHand = graphFrom(legacyDoc());
    byHand.setPathOps('rect', [
      { id: 'z1', type: 'zigzag', amount: 16, detail: 5 },
      { id: 'anything', type: 'trim', amount: 0, detail: 0, start: 0, end: 65, offset: 0 },
    ]);

    expect(geometryOf(migrated)).toBe(geometryOf(byHand));
    // And it is genuinely a cut path, not an untouched outline.
    expect(geometryOf(migrated)).toMatch(/^O:/);
  });

  it('the migrated chain is readable by the live scene helpers', () => {
    // A migration that produces a shape the reader cannot parse would leave the
    // trim silently absent rather than broken.
    const g = graphFrom(v1_3_0_to_v1_4_0.migrate(legacyDoc()));
    const node = g.getNode('rect')!;
    expect(readPathOps(node).map((o) => o.type)).toEqual(['zigzag', 'trim']);
    expect(readTrimOp(node)?.end).toBe(65);
  });
});
