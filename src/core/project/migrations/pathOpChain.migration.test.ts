/**
 * The 1.2.0 → 1.3.0 path-operator-chain migration, against a fixture of the OLD
 * shape.
 *
 * Its own file rather than an addition to `migrations.test.ts`, because the
 * thing most worth protecting here is not the reshape — it is the KEYFRAME
 * RENAME that has to accompany it. A migration that moves the object into an
 * array and forgets the tracks produces a document that opens, renders, and has
 * silently lost every path-operator animation. Nothing throws; the shape simply
 * sits frozen at its static value until someone scrubs and notices.
 *
 * That is the same failure the 1.1.0 → 1.2.0 matte migration warned about with
 * `sourceId`, and it is the reason both steps carry a dedicated fixture test.
 */

import { migrateDocument, CURRENT_DOCUMENT_VERSION } from './index';
import type { EditorDocument } from '@core/api/cloudDocument';

/**
 * A 1.2.0 document: one shape with a single `fx.pathOp`, animated through the
 * old un-scoped `pathop.amount` track. Written literally rather than generated,
 * so it keeps describing the old shape after the code that produced it is gone.
 */
function fixtureV1_2_0(): EditorDocument {
  return {
    version: '1.2.0',
    scene: {
      nodes: [
        {
          id: 'shape_a',
          components: [
            {
              type: 'fx',
              props: {
                pathOp: { type: 'zigzag', amount: 20, detail: 4, wigglesPerSecond: 0, seed: 0 },
              },
            },
          ],
          children: [
            {
              id: 'shape_child',
              components: [
                { type: 'fx', props: { pathOp: { type: 'roughen', amount: 9, detail: 2 } } },
              ],
            },
          ],
        },
        { id: 'shape_plain', components: [{ type: 'fx', props: {} }] },
      ],
    },
    animation: {
      tracks: {
        shape_a: {
          'pathop.amount': { keys: [{ t: 0, v: 0 }, { t: 2, v: 40 }] },
          // A NON-path-op track on the same node, to prove the rename is
          // targeted rather than a blanket rewrite of everything.
          rotation: { keys: [{ t: 0, v: 0 }] },
        },
        shape_child: {
          'pathop.detail': { keys: [{ t: 0, v: 2 }] },
        },
      },
      expressions: {},
    },
  } as unknown as EditorDocument;
}

/** The `fx` props of a node, by id, walking children. */
function fxOf(doc: EditorDocument, id: string): Record<string, unknown> {
  const walk = (nodes: unknown[]): Record<string, unknown> | null => {
    for (const raw of nodes) {
      const n = raw as { id?: string; components?: Array<{ type?: string; props?: Record<string, unknown> }>; children?: unknown[] };
      if (n.id === id) {
        return n.components?.find((c) => c.type === 'fx')?.props ?? {};
      }
      const found = n.children ? walk(n.children) : null;
      if (found) return found;
    }
    return null;
  };
  return walk((doc.scene as { nodes?: unknown[] }).nodes ?? []) ?? {};
}

const tracksOf = (doc: EditorDocument, nodeId: string): Record<string, unknown> =>
  ((doc.animation as { tracks?: Record<string, Record<string, unknown>> }).tracks ?? {})[nodeId] ?? {};

describe('1.2.0 → 1.3.0 — path operators become a chain', () => {
  it('brings the document to the current version', () => {
    expect(migrateDocument(fixtureV1_2_0()).version).toBe(CURRENT_DOCUMENT_VERSION);
  });

  it('moves the single operator into an ordered array', () => {
    const out = migrateDocument(fixtureV1_2_0());
    const fx = fxOf(out, 'shape_a');
    expect(Array.isArray(fx.pathOps)).toBe(true);
    expect((fx.pathOps as unknown[]).length).toBe(1);
  });

  it('drops the legacy key so nothing can read the old shape back', () => {
    const fx = fxOf(migrateDocument(fixtureV1_2_0()), 'shape_a');
    expect(fx.pathOp).toBeUndefined();
  });

  it('preserves every parameter of the operator', () => {
    const [op] = fxOf(migrateDocument(fixtureV1_2_0()), 'shape_a').pathOps as Array<Record<string, unknown>>;
    expect(op).toMatchObject({ type: 'zigzag', amount: 20, detail: 4, wigglesPerSecond: 0, seed: 0 });
  });

  it('gives the migrated operator an id', () => {
    const [op] = fxOf(migrateDocument(fixtureV1_2_0()), 'shape_a').pathOps as Array<Record<string, unknown>>;
    expect(typeof op!.id).toBe('string');
    expect(op!.id).not.toBe('');
  });

  it('RE-KEYS the keyframe track onto that id', () => {
    // The assertion this file exists for. Without it the animation is orphaned
    // and the shape freezes at its static value, with nothing reporting an error.
    const out = migrateDocument(fixtureV1_2_0());
    const [op] = fxOf(out, 'shape_a').pathOps as Array<Record<string, unknown>>;
    const tracks = tracksOf(out, 'shape_a');

    expect(tracks['pathop.amount']).toBeUndefined();
    expect(tracks[`pathop.${op!.id as string}.amount`]).toBeDefined();
  });

  it('carries the keyframes across intact, not just the key', () => {
    const out = migrateDocument(fixtureV1_2_0());
    const [op] = fxOf(out, 'shape_a').pathOps as Array<Record<string, unknown>>;
    const moved = tracksOf(out, 'shape_a')[`pathop.${op!.id as string}.amount`];
    expect(moved).toEqual({ keys: [{ t: 0, v: 0 }, { t: 2, v: 40 }] });
  });

  it('leaves non-path-op tracks alone', () => {
    expect(tracksOf(migrateDocument(fixtureV1_2_0()), 'shape_a').rotation).toBeDefined();
  });

  it('reaches nested children, not just top-level nodes', () => {
    // Precomp subtrees hold layers too; a top-level-only walk would migrate half
    // a project and leave the rest unreadable.
    const out = migrateDocument(fixtureV1_2_0());
    const fx = fxOf(out, 'shape_child');
    expect(Array.isArray(fx.pathOps)).toBe(true);
    const [op] = fx.pathOps as Array<Record<string, unknown>>;
    expect(tracksOf(out, 'shape_child')[`pathop.${op!.id as string}.detail`]).toBeDefined();
  });

  it('leaves a node with no operator untouched', () => {
    expect(fxOf(migrateDocument(fixtureV1_2_0()), 'shape_plain').pathOps).toBeUndefined();
  });

  it('does not mutate the input document', () => {
    const input = fixtureV1_2_0();
    const before = structuredClone(input);
    migrateDocument(input);
    expect(input).toEqual(before);
  });

  it('is DETERMINISTIC — the same document in gives the same document out', () => {
    // Ids must be derived, never random. Two machines migrating the same project
    // would otherwise produce documents that differ, and a version-history diff
    // would show a change nobody made.
    expect(migrateDocument(fixtureV1_2_0())).toEqual(migrateDocument(fixtureV1_2_0()));
  });

  it('is idempotent — re-running finds nothing left to do', () => {
    const once = migrateDocument(fixtureV1_2_0());
    expect(migrateDocument(once)).toEqual(once);
  });
});
