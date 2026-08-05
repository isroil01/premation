/**
 * 1.5.0 → 1.6.0 — an expression's source string becomes `{ src, enabled }`.
 *
 * The two things this migration could get wrong, both silent:
 *
 *  1. It DROPS the expressions. `AnimationEngine.restore` reads one shape only
 *     — deliberately, so documents cannot stay un-migrated — which means an
 *     unconverted entry is not an error, it is an expression that quietly stops
 *     existing. The property keeps rendering, at its static value, and nobody
 *     notices until they scrub. Same failure mode as the 1.1.0 matte
 *     `sourceId` and the 1.4.0 trim.
 *  2. It CLOBBERS a disabled expression back to enabled. `captureDocument`
 *     stamps every document it writes `version: '1.1.0'` (see F31), so a
 *     project saved by this build carries the NEW shape under an OLD version
 *     number and runs through this step on every single load. A step that
 *     rewrote unconditionally would work perfectly until the first reopen.
 *
 * A pre-change fixture is loaded through the real chain, and the result is
 * pushed through `AnimationEngine.restore` — the actual consumer — rather than
 * only inspected as data. Rule 4c: the migration's output and the engine's
 * input are two guarded units, and the shape crossing between them is the whole
 * subject.
 */

import { v1_5_0_to_v1_6_0 } from './v1_5_0_to_v1_6_0';
import { migrateDocument, CURRENT_DOCUMENT_VERSION, MIGRATIONS, IMPLIED_LEGACY_VERSION } from './index';
import type { EditorDocument } from '@core/api/cloudDocument';
import { AnimationEngine } from '@motion/animation';
import type { ProjectFile } from '@core/types';

/** No scene is needed here — this step touches `animation` only. */
const EMPTY_SCENE = { version: '1.0.0', nodes: [] } as unknown as ProjectFile;

/** A 1.5.0 document: x keyframed 0 → 100 over 0..2s, with `value + 200` on it. */
function legacyDoc(version = '1.5.0'): EditorDocument {
  return {
    version,
    scene: EMPTY_SCENE,
    animation: {
      tracks: {
        n1: { x: { nodeId: 'n1', prop: 'x', keyframes: [{ t: 0, value: 0 }, { t: 2, value: 100 }] } },
      },
      // The pre-1.6.0 shape: a bare source string.
      expressions: { n1: { x: 'value + 200' } },
    } as unknown as EditorDocument['animation'],
  };
}

/** Read the migrated expression entry as plain data. */
function exprOf(doc: EditorDocument, nodeId = 'n1', prop = 'x'): unknown {
  return (doc.animation as unknown as { expressions: Record<string, Record<string, unknown>> })
    .expressions[nodeId]?.[prop];
}

describe('the step itself', () => {
  test('a bare source string becomes { src, enabled: true }', () => {
    const out = v1_5_0_to_v1_6_0.migrate(legacyDoc());
    expect(exprOf(out)).toEqual({ src: 'value + 200', enabled: true });
  });

  test('the input document is not mutated — migrations are pure', () => {
    const input = legacyDoc();
    v1_5_0_to_v1_6_0.migrate(input);
    expect(exprOf(input)).toBe('value + 200');
  });

  test('registered in the chain, and 1.6.0 is what this build writes', () => {
    expect(MIGRATIONS.map((m) => m.from)).toContain('1.5.0');
    expect(MIGRATIONS[MIGRATIONS.length - 1]!.to).toBe(CURRENT_DOCUMENT_VERSION);
    expect(CURRENT_DOCUMENT_VERSION).toBe('1.6.0');
  });

  test('a document with no expressions at all passes through untouched', () => {
    const doc: EditorDocument = {
      version: '1.5.0',
      scene: EMPTY_SCENE,
      animation: { tracks: {}, expressions: {} },
    };
    expect(v1_5_0_to_v1_6_0.migrate(doc)).toBe(doc); // same object, no clone
  });
});

describe('IDEMPOTENCE — the case every load actually takes', () => {
  /**
   * Rule 3a: the clean fixture is an old document, and it cannot reach the
   * commonest input this step sees. Because `captureDocument` stamps '1.1.0',
   * a document written by THIS build has `{ src, enabled }` already and is
   * migrated again on every open. `enabled: false` has to survive that.
   */
  test('an already-converted DISABLED expression stays disabled', () => {
    const doc: EditorDocument = {
      version: '1.5.0',
      scene: EMPTY_SCENE,
      animation: {
        tracks: {},
        expressions: { n1: { x: { src: 'value + 200', enabled: false } } },
      },
    };
    const out = v1_5_0_to_v1_6_0.migrate(doc);
    expect(exprOf(out)).toEqual({ src: 'value + 200', enabled: false });
  });

  test('migrating twice is the same as migrating once', () => {
    const once = v1_5_0_to_v1_6_0.migrate(legacyDoc());
    const twice = v1_5_0_to_v1_6_0.migrate(once);
    expect(exprOf(twice)).toEqual(exprOf(once));
  });

  test('a MIXED document converts the string and leaves the object alone', () => {
    const doc: EditorDocument = {
      version: '1.5.0',
      scene: EMPTY_SCENE,
      animation: {
        tracks: {},
        expressions: {
          old: { x: 'wiggle(2, 30)' },
          new: { y: { src: 'time * 90', enabled: false } },
        },
      } as unknown as EditorDocument['animation'],
    };
    const out = v1_5_0_to_v1_6_0.migrate(doc);
    expect(exprOf(out, 'old', 'x')).toEqual({ src: 'wiggle(2, 30)', enabled: true });
    expect(exprOf(out, 'new', 'y')).toEqual({ src: 'time * 90', enabled: false });
  });
});

describe('boundaries — what the clean fixture excludes', () => {
  /**
   * An EMPTY source. `setExpression('')` has always meant "remove", so an empty
   * string was never a valid attached expression — but the old shape could hold
   * one, and promoting it would produce a valid-looking entry that compiles to
   * nothing and shows an empty editor with a live toggle. The clean fixture's
   * non-empty source cannot reach this.
   */
  test('an empty source is DROPPED, not promoted to an enabled empty expression', () => {
    const doc: EditorDocument = {
      version: '1.5.0',
      scene: EMPTY_SCENE,
      animation: {
        tracks: {},
        expressions: { n1: { x: '', y: 'value + 1' } },
      } as unknown as EditorDocument['animation'],
    };
    const out = v1_5_0_to_v1_6_0.migrate(doc);
    expect(exprOf(out, 'n1', 'x')).toBeUndefined();
    expect(exprOf(out, 'n1', 'y')).toEqual({ src: 'value + 1', enabled: true });
  });

  /**
   * A document OLDER than 1.5.0. The chain has to walk it all the way, and the
   * expression conversion is the last step — so a document that starts at
   * 1.0.0 exercises the ordering, not just the step. The pre-1.1 recovery
   * branch enters here, at exactly this version.
   */
  test('a 1.0.0 document walks the whole chain and arrives converted', () => {
    const out = migrateDocument(legacyDoc(IMPLIED_LEGACY_VERSION));
    expect(out.version).toBe('1.6.0');
    expect(exprOf(out)).toEqual({ src: 'value + 200', enabled: true });
  });

  /** A document with no `animation` at all — every field is optional in practice. */
  test('a document with no animation block is left alone', () => {
    const doc = { version: '1.5.0', scene: { nodes: [] } } as unknown as EditorDocument;
    expect(v1_5_0_to_v1_6_0.migrate(doc)).toBe(doc);
  });
});

describe('the migrated document is one the ENGINE can actually read', () => {
  /**
   * The seam. Asserting the migration's output shape and asserting the engine
   * honours `enabled` are two guards over two units; neither watches the value
   * crossing between them. This one does — it restores the migrated document
   * into a real engine and samples it.
   */
  test('restores and drives: x@1 = 50 + 200', () => {
    const out = migrateDocument(legacyDoc());
    const a = new AnimationEngine();
    a.restore(out.animation);

    expect(a.hasExpression('n1', 'x')).toBe(true);
    expect(a.isExpressionEnabled('n1', 'x')).toBe(true);
    expect(a.sample('n1', 'x', 1)).toBeCloseTo(250);
  });

  test('WITHOUT the migration the engine sees nothing — this is what it prevents', () => {
    const a = new AnimationEngine();
    // The un-migrated 1.5.0 shape, fed straight in. `restore` reads one shape
    // only, so the expression silently does not exist and the property answers
    // its keyframed 50 — the exact silent loss the step is here to stop.
    a.restore(legacyDoc().animation);
    expect(a.hasExpression('n1', 'x')).toBe(false);
    expect(a.sample('n1', 'x', 1)).toBeCloseTo(50);
  });
});
