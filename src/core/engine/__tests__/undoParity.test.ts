/**
 * F2's undo parity suite (NATIVE_CORE_PLAN §5 Phase F: "the engine owns the
 * document and undo … exit: undo parity suite green").
 *
 * Every replay-corpus session (B2 + family + generated) runs on the
 * TypeScript engine. After EVERY request that is not a query, the recorder
 * probes the history (`getHistory`: labels, origins, position, can-undo/redo,
 * gesture open, limit) and the whole document (`getDocument` with property
 * trees and keyframes — values, keys, items, comps, layers, dirty flag).
 * After the session, a WALK drives the history harder than any session does:
 * undo to the start and one past it, redo to the end and one past it,
 * jumpToHistory to 0 / the middle / the end / past the end, a checkpoint
 * undone and redone, a gesture cancelled (Esc) and one committed, the
 * refusals inside a gesture (undo, checkpoint, a nested gesture), an empty
 * gesture, a new edit clearing the redo tail, a history limit that drops the
 * oldest entries, and clearHistory — every step probed the same way.
 *
 * `native/engine/tests/test_undo_parity.cpp` (`engine_undo_parity_tests`)
 * replays the same bytes into an in-process C++ `Session` and requires every
 * response byte-identical (refusals by error code) and every revision step
 * equal. Format: `__testHelpers__/parityFixture.ts`.
 *
 * `GEN_NATIVE_UNDO=1 npx jest undoParity` rewrites
 * native/engine/tests/data/undo_parity.bin; without it this test fails when
 * the checked-in fixture no longer matches the TypeScript.
 * GEN_NATIVE_UNDO_FULL=<file> writes every response in full (UNDO_FIXTURE=<file>
 * makes the C++ test explain each difference with both values).
 */

import type { Command, Query, Request, Response } from '@motion/engine-api';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { CORPUS as B2_CORPUS, CORPUS_FIXTURES, FAMILY_CORPUS, FIXTURE_BARE, FIXTURE_EXTRAS, GENERATED_CORPUS, type Session } from '../__testHelpers__/corpus';
import { setupEngine, sec, type Harness } from '../__testHelpers__/harness';
import { installAppExpressionProviders } from './crossEngineProviders.test';
import { compact, encodeFixture, normalized, requestLabel, seededRandom, wireCopy, type RecordRow } from '../__testHelpers__/parityFixture';

const OUT = path.resolve(__dirname, '../../../../native/engine/tests/data/undo_parity.bin');
/**
 * F2's own sessions: the document lifecycle the engine now owns — dirty
 * across save / undo / redo, `restoreDocument` (a cloud version, crash
 * recovery) undone and redone, a refused restore, revert, open, Save a Copy,
 * New — so history and dirty parity cover it (the D1 corpus never issues
 * `restoreDocument`).
 */
const LIFECYCLE_CORPUS: Record<string, Session> = {
  'F2: lifecycle — save, dirty across undo/redo, restoreDocument undone, refused restore, revert, open, copy, new': async (h) => {
    const scalar = (value: number) => ({ kind: 'scalar' as const, value });
    const { item: comp } = await h.run({ type: 'createComposition', settings: { name: 'Life', width: 640, height: 360 }, fromItems: [] });
    const { layer } = await h.run({ type: 'createLayer', comp, kind: 'solid', name: 'A', init: [] });
    const rot = { layer, path: 'transform/rotation' };
    await h.run({ type: 'setProperty', prop: rot, value: scalar(10) });
    await h.run({ type: 'saveProject', path: 'C:/f2/life.motion', copy: false });
    await h.run({ type: 'setProperty', prop: rot, value: scalar(20) });
    await h.run({ type: 'undo' });
    await h.run({ type: 'undo' });
    await h.run({ type: 'redo' });
    await h.run({ type: 'redo' });
    await h.run({ type: 'addKeyframes', keys: [0, 1].map((i) => ({ prop: rot, time: sec(i), value: scalar(90 * i), spatialIn: [], spatialOut: [] })) });
    // A cloud version / a recovery copy: one undoable entry.
    const version = new TextEncoder().encode(JSON.stringify(CORPUS_FIXTURES[FIXTURE_EXTRAS]!()));
    await h.run({ type: 'restoreDocument', document: version, label: 'Recover Unsaved Work' });
    await h.run({ type: 'undo' });
    await h.run({ type: 'redo' });
    await h.run({ type: 'undo' });
    await h.run({ type: 'restoreDocument', document: version });
    await h.engine.execute({ type: 'restoreDocument', document: new TextEncoder().encode('{not json') });  // decode
    await h.engine.execute({ type: 'restoreDocument', document: new TextEncoder().encode('[1,2]') });  // decode
    await h.run({ type: 'saveProject', path: 'C:/f2/life-copy.motion', copy: true });
    await h.run({ type: 'revertProject' });
    await h.run({ type: 'setProperty', prop: rot, value: scalar(30) });
    await h.run({ type: 'saveProject', copy: false });
    await h.run({ type: 'openProject', path: FIXTURE_BARE });
    await h.engine.execute({ type: 'undo' });  // nothingToUndo: open clears history
    await h.run({ type: 'openProject', path: 'C:/f2/life-copy.motion' });
    await h.run({ type: 'restoreDocument', document: version, label: 'Restore Version' });
    await h.run({ type: 'newProject' });
    await h.engine.execute({ type: 'revertProject' });  // nothing to revert to
  },
};

const CORPUS = { ...B2_CORPUS, ...FAMILY_CORPUS, ...GENERATED_CORPUS, ...LIFECYCLE_CORPUS };

/** GEN_NATIVE_UNDO_FULL=<file>: keep every response whole (one session at a time with -t, or it will not fit). */
const FULL = Boolean(process.env.GEN_NATIVE_UNDO_FULL);

/** The corpus's project files as the sessions saw them (JSON). */
const FILES = new Map<string, string>();

jest.useFakeTimers();

interface Recorder {
  rows: RecordRow[];
  /** Send one request through the recorder (kind 2 = the walk's own requests, then probed). */
  send(kind: 2, body: Request['body']): Promise<Response>;
}

async function recordSession(name: string): Promise<{ rows: RecordRow[]; walkSteps: number }> {
  const random = jest.spyOn(Math, 'random').mockImplementation(seededRandom(0x5eed));
  const h: Harness = await setupEngine();
  installAppExpressionProviders();
  for (const [p, make] of Object.entries(CORPUS_FIXTURES)) {
    const doc = make();
    h.files.set(p, structuredClone(doc));
    if (!FILES.has(p)) FILES.set(p, JSON.stringify(doc));
  }
  const rows: RecordRow[] = [];
  let seq = 1_000_000;
  /** Requests the recorder itself sends: kind per seq (1 probe, 2 walk). */
  const own = new Map<number, 1 | 2>();
  try {
    const original = h.engine.request.bind(h.engine);
    const probe = async (): Promise<void> => {
      const ask = (q: Query): Promise<Response> => {
        const s = ++seq;
        own.set(s, 1);
        return h.engine.request({ seq: s, body: { kind: 'query', value: q }, origin: 'script' } as Request);
      };
      await ask({ type: 'getHistory' });
      await ask({ type: 'getDocument', includeProperties: true, includeKeyframes: true });
    };
    h.engine.request = async (req: Request): Promise<Response> => {
      const bytes = wireCopy(req);
      const before = h.engine.documentRevision;
      const res = await original(req);
      // Rows are pushed on completion: the engine queue serializes requests,
      // so this is the order the engine ran them in, which the C++ replays.
      const kind = own.get(req.seq) ?? 0;
      // Whole-document probes are hashed at once: thousands of them would not fit in memory.
      rows.push(compact({ kind, step: res.revision - before, label: requestLabel(req), request: bytes, response: normalized(res) }, FULL));
      if (kind !== 1 && req.body.kind !== 'query') await probe();
      return res;
    };
    await CORPUS[name]!(h);

    const rec: Recorder = {
      rows,
      send: (kind, body) => {
        const s = ++seq;
        own.set(s, kind);
        return h.engine.request({ seq: s, body, origin: 'ui' } as Request);
      },
    };
    const walkStart = rows.length;
    await walk(rec);
    return { rows, walkSteps: rows.slice(walkStart).filter((r) => r.kind === 2).length };
  } finally {
    await h.dispose();
    random.mockRestore();
  }
}

/** The history walk every session ends with (see the header). */
async function walk(r: Recorder): Promise<void> {
  const cmd = (c: Command): Promise<Response> => r.send(2, { kind: 'command', value: c });
  const query = async <T extends Query['type']>(q: Query & { type: T }): Promise<unknown> => {
    const res = await r.send(2, { kind: 'query', value: q });
    return res.outcome.kind === 'query' ? res.outcome.value : null;
  };
  let hist = (await query({ type: 'getHistory' })) as { entries: unknown[]; position: number; gestureOpen: boolean };
  if (hist.gestureOpen) {
    await cmd({ type: 'endGesture', gesture: 0, commit: true });
    hist = (await query({ type: 'getHistory' })) as typeof hist;
  }
  const n = hist.entries.length;
  for (let i = hist.position; i > 0; i--) await cmd({ type: 'undo' });
  await cmd({ type: 'undo' });  // nothingToUndo
  for (let i = 0; i < n; i++) await cmd({ type: 'redo' });
  await cmd({ type: 'redo' });  // nothingToRedo
  await cmd({ type: 'jumpToHistory', position: 0 });
  await cmd({ type: 'jumpToHistory', position: Math.ceil(n / 2) });
  await cmd({ type: 'jumpToHistory', position: n });
  await cmd({ type: 'jumpToHistory', position: n + 1 });  // outOfRange
  await cmd({ type: 'addHistoryCheckpoint', label: 'F2 checkpoint' });
  await cmd({ type: 'undo' });
  await cmd({ type: 'redo' });
  await cmd({ type: 'addHistoryCheckpoint', label: '  ' });  // invalidArgument

  // A layer to drag: the first layer with a rotation property.
  const doc = (await query({ type: 'getDocument', includeProperties: false, includeKeyframes: false })) as { comps: Array<{ layers: string[] }> } | null;
  let layer: string | null = null;
  for (const comp of doc?.comps ?? []) {
    for (const l of comp.layers) {
      const v = await r.send(2, { kind: 'query', value: { type: 'getPropertyValues', props: [{ layer: l, path: 'transform/rotation' }], time: 0, evaluated: false } });
      if (v.outcome.kind === 'query') {
        layer = l;
        break;
      }
    }
    if (layer) break;
  }
  if (layer) {
    const rot = (deg: number): Command => ({ type: 'setProperty', prop: { layer: layer!, path: 'transform/rotation' }, value: { kind: 'scalar', value: deg } });
    // Esc: the gesture's edits revert as one revision; nothing enters history.
    const g1 = await cmd({ type: 'beginGesture', label: 'F2 drag (cancelled)' });
    await cmd(rot(15));
    await cmd(rot(30));
    await cmd({ type: 'undo' });  // gestureOpen
    await cmd({ type: 'redo' });  // gestureOpen
    await cmd({ type: 'jumpToHistory', position: 0 });  // gestureOpen
    await cmd({ type: 'addHistoryCheckpoint', label: 'inside' });  // gestureOpen
    await cmd({ type: 'beginGesture', label: 'nested' });  // gestureOpen
    await cmd({ type: 'clearHistory' });  // gestureOpen
    await cmd({ type: 'endGesture', gesture: 999_999, commit: true });  // invalidArgument
    await cmd(rot(45));
    const id1 = g1.outcome.kind === 'command' && g1.outcome.value.type === 'beginGesture' ? g1.outcome.value.gesture : 0;
    await cmd({ type: 'endGesture', gesture: id1, commit: false });
    await cmd({ type: 'endGesture', gesture: 0, commit: true });  // noGesture
    // A committed drag is ONE entry: first inverse, last value.
    await cmd({ type: 'beginGesture', label: 'F2 drag' });
    await cmd(rot(10));
    await cmd(rot(20));
    await cmd(rot(25));
    await cmd({ type: 'endGesture', gesture: 0, commit: true });
    await cmd({ type: 'undo' });
    await cmd({ type: 'redo' });
    await cmd({ type: 'undo' });
    // A new edit clears the redo tail.
    await cmd(rot(60));
    await cmd({ type: 'redo' });  // nothingToRedo
    // An empty gesture pushes nothing; a gesture that returns the value to its start pushes nothing either.
    await cmd({ type: 'beginGesture', label: 'F2 empty' });
    await cmd({ type: 'endGesture', gesture: 0, commit: true });
    await cmd({ type: 'beginGesture', label: 'F2 round trip' });
    await cmd(rot(61));
    await cmd(rot(60));
    await cmd({ type: 'endGesture', gesture: 0, commit: true });
    // A batch is one entry.
    await r.send(2, { kind: 'batch', value: { label: 'F2 batch', commands: [rot(1), rot(2), rot(3)] } });
    await cmd({ type: 'undo' });
    // The history limit drops the OLDEST entries, now and on push.
    await cmd({ type: 'setHistoryLimit', entries: 0 });  // outOfRange
    await cmd({ type: 'setHistoryLimit', entries: 2 });
    await cmd(rot(70));
    await cmd(rot(80));
    await cmd(rot(90));
    await cmd({ type: 'undo' });
    await cmd({ type: 'undo' });
    await cmd({ type: 'undo' });  // nothingToUndo
    await cmd({ type: 'jumpToHistory', position: 2 });
    await cmd({ type: 'setHistoryLimit', entries: 500 });
  }
  await cmd({ type: 'jumpToHistory', position: 0 });
  await cmd({ type: 'clearHistory' });
  await cmd({ type: 'undo' });  // nothingToUndo
  await cmd({ type: 'jumpToHistory', position: 0 });
}

describe('F2: undo parity — history walked on the replay corpus (fixture for the C++ engine)', () => {
  const sessions: Array<[string, RecordRow[]]> = [];

  test.each(Object.keys(CORPUS))('%s', async (name) => {
    const { rows, walkSteps } = await recordSession(name);
    sessions.push([name, rows]);
    expect(walkSteps).toBeGreaterThan(10);
  }, 600_000);

  afterAll(() => {
    sessions.sort((a, b) => Object.keys(CORPUS).indexOf(a[0]) - Object.keys(CORPUS).indexOf(b[0]));
    const fullTo = process.env.GEN_NATIVE_UNDO_FULL;
    if (fullTo) writeFileSync(fullTo, encodeFixture(FILES, sessions, true));
    const bytes = encodeFixture(FILES, sessions, false);
    const digest = createHash('sha256').update(bytes).digest('hex');
    const records = sessions.reduce((n, [, r]) => n + r.length, 0);
    const walk = sessions.reduce((n, [, r]) => n + r.filter((x) => x.kind === 2).length, 0);
    const probes = sessions.reduce((n, [, r]) => n + r.filter((x) => x.kind === 1).length, 0);
    console.log(`[F2 undo parity] ${sessions.length} sessions, ${records} records (${walk} walk steps, ${probes} probes), ${bytes.length} bytes, sha256 ${digest}`);
    if (sessions.length !== Object.keys(CORPUS).length) return;  // a filtered run (-t) never writes or checks
    if (process.env.GEN_NATIVE_UNDO === '1') {
      writeFileSync(OUT, bytes);
      return;
    }
    const stored = existsSync(OUT) ? createHash('sha256').update(readFileSync(OUT)).digest('hex') : '(missing)';
    if (stored !== digest) {
      throw new Error(`native/engine/tests/data/undo_parity.bin is stale (stored ${stored}, now ${digest}); regenerate with GEN_NATIVE_UNDO=1 npx jest undoParity`);
    }
  });
});
