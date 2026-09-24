/**
 * D1's exit (NATIVE_CORE_PLAN §5): replayed sessions produce identical
 * evaluated values to the TypeScript engine — checked WITHOUT the engine
 * process, so it runs wherever `engine_core` builds (no Dawn).
 *
 * Every session of the replay corpus (B2 + family + generated) runs on the
 * TypeScript engine; every request and its response is recorded. After the
 * session, PROBES read the finished document densely: per composition, every
 * layer's property tree, every numeric property's evaluated and
 * pre-expression value at PROBE_TIMES (before the start, on and between
 * frames, inside and past stretched / remapped / frozen bars), the world
 * transforms of the whole stack (parenting), motion paths, dense samples
 * with speed of every animated property, and every property's keyframes.
 *
 * `native/engine/tests/test_d1_eval_parity.cpp` replays the same request
 * bytes into an in-process C++ `Session` (engine_core) and compares each
 * response BYTE FOR BYTE (seq and revision zeroed; refusals by error code, the
 * message text is each engine's own) and each revision step. It reports the
 * gap (per session: requests and probes that differ) and fails above the
 * ratchet it states.
 *
 * `GEN_NATIVE_D1=1 npx jest d1EvalParity` rewrites the fixture
 * (native/engine/tests/data/d1_eval_parity.bin); without it this test fails
 * when the checked-in fixture no longer matches the TypeScript.
 *
 * Format (little-endian; a blob is u32 length + bytes): "D1EV", u32 version,
 * u32 project-file count, per file a path blob + a JSON document blob (the
 * corpus fixtures, seeded into both engines' test ports); u32 session count;
 * per session a name blob, u32 record count; per record u8 kind
 * (0 = session request, 1 = probe), u32 revision step, a label blob (the
 * command / query type), the request — u8 form 0 + the encoded
 * EngineMessage{request} blob, or form 1 (a probe getPropertyValues over the
 * same properties as an earlier record): u32 that record's index, u32 seq,
 * f64 time, u8 evaluated — and the
 * response: u8 form, then for form 0 the encoded EngineMessage{response} blob
 * (seq = 0, revision = 0), for form 1 (responses above FULL_LIMIT bytes, so
 * the fixture stays small) u32 length + u32 u32 hash (two FNV-1a 32 lanes,
 * `hash64`) of those bytes. GEN_NATIVE_D1_FULL=<file> writes every response
 * in full to <file> instead (D1_FIXTURE=<file> points the C++ test at it, which
 * then explains each difference with both values).
 */

import { encodeEngineMessage, type PropertyInfo, type Query, type Request, type Response } from '@motion/engine-api';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { CORPUS as B2_CORPUS, CORPUS_FIXTURES, FAMILY_CORPUS, GENERATED_CORPUS } from '../__testHelpers__/corpus';
import { setupEngine, sec, type Harness } from '../__testHelpers__/harness';
import { installAppExpressionProviders } from './crossEngineProviders.test';

const OUT = path.resolve(__dirname, '../../../../native/engine/tests/data/d1_eval_parity.bin');
const CORPUS = { ...B2_CORPUS, ...FAMILY_CORPUS, ...GENERATED_CORPUS };

/** Composition times the values are read at (seconds): before 0, on frames, between frames, late. */
const PROBE_TIMES = [-0.25, 0, 1 / 60, 0.5, 1.25, 2, 2.75, 6];
const NUMERIC = new Set(['scalar', 'vec2', 'vec3', 'vec4', 'color', 'int']);

/** The corpus's project files as the sessions saw them (JSON). */
const FILES = new Map<string, string>();

interface RecordRow {
  kind: 0 | 1;
  step: number;
  label: string;
  request: Uint8Array;
  response: Uint8Array;
  /** A probe getPropertyValues that repeats record `base`'s properties at another time. */
  derive?: { base: number; seq: number; time: number; evaluated: boolean };
}

jest.useFakeTimers();

function normalized(res: Response): Uint8Array {
  // saveProject's byte count is each engine's own serializer's (and the TS one
  // stamps the save time): the C++ side compares its path only; store 0 so the
  // fixture is reproducible.
  const o = res.outcome;
  const outcome = o.kind === 'command' && o.value.type === 'saveProject' ? { ...o, value: { ...o.value, bytes: 0 } } : o;
  return encodeEngineMessage({ kind: 'response', value: { ...res, seq: 0, revision: 0, outcome } as Response });
}

/** mulberry32 — the legacy builders' scratch ids come from Math.random; seeded, the fixture is reproducible. */
function seededRandom(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A deep copy through the wire (the request exactly as the C++ engine will decode it). */
function wireCopy(req: Request): Uint8Array {
  return encodeEngineMessage({ kind: 'request', value: req });
}

async function recordSession(name: string): Promise<RecordRow[]> {
  const random = jest.spyOn(Math, 'random').mockImplementation(seededRandom(0x5eed));
  const h: Harness = await setupEngine();
  installAppExpressionProviders();
  // Made inside the harness: a fixture's text size follows the active comp
  // (defaultTextSize), so the fixture file stores what the sessions opened.
  for (const [p, make] of Object.entries(CORPUS_FIXTURES)) {
    const doc = make();
    h.files.set(p, structuredClone(doc));
    if (!FILES.has(p)) FILES.set(p, JSON.stringify(doc));
  }
  const rows: RecordRow[] = [];
  let seq = 1_000_000;
  try {
    const original = h.engine.request.bind(h.engine);
    let probing = false;
    let lastValues: { index: number; props: string } | null = null;
    h.engine.request = async (req: Request): Promise<Response> => {
      const bytes = wireCopy(req);
      const before = h.engine.documentRevision;
      const res = await original(req);
      const label = req.body.kind === 'batch' ? `batch(${req.body.value.commands.map((c) => c.type).join(',')})` : req.body.value.type;
      const row: RecordRow = { kind: probing ? 1 : 0, step: res.revision - before, label, request: bytes, response: normalized(res) };
      if (probing && req.body.kind === 'query' && req.body.value.type === 'getPropertyValues') {
        const q = req.body.value;
        const props = JSON.stringify(q.props);
        if (lastValues && lastValues.props === props) row.derive = { base: lastValues.index, seq: req.seq, time: q.time, evaluated: q.evaluated };
        else lastValues = { index: rows.length, props };
      }
      rows.push(row);
      return res;
    };
    await CORPUS[name]!(h);

    // Probes: the finished document, densely.
    probing = true;
    const ask = async (q: Query): Promise<Response> => h.engine.request({ seq: ++seq, body: { kind: 'query', value: q }, origin: 'script' } as Request);
    const docRes = await ask({ type: 'getDocument', includeProperties: false, includeKeyframes: false });
    if (docRes.outcome.kind !== 'query' || docRes.outcome.value.type !== 'getDocument') return rows;
    const doc = docRes.outcome.value;
    for (const comp of doc.comps) {
      const layers = comp.layers;
      for (const t of PROBE_TIMES) {
        if (layers.length > 0) await ask({ type: 'getLayerTransforms', layers, time: sec(t) });
      }
      for (const layer of layers) {
        await ask({ type: 'getMotionPath', layer, range: { start: sec(-0.5), duration: sec(4.5) }, samples: 19 });
        const tree = await ask({ type: 'getPropertyTree', layer, path: '', depth: 0 });
        await ask({ type: 'getPropertyTree', layer, path: '', depth: 0, time: sec(1.25) });
        if (tree.outcome.kind !== 'query' || tree.outcome.value.type !== 'getPropertyTree') continue;
        const nodes: PropertyInfo[] = tree.outcome.value.nodes;
        const props = nodes.filter((n) => n.kind === 'property');
        const numeric = props.filter((n) => n.dimensions > 0 && NUMERIC.has(n.valueType)).map((n) => ({ layer, path: n.path }));
        if (props.length > 0) await ask({ type: 'getKeyframes', props: props.map((n) => ({ layer, path: n.path })) });
        if (numeric.length > 0) {
          for (const t of PROBE_TIMES) await ask({ type: 'getPropertyValues', props: numeric, time: sec(t), evaluated: true });
          await ask({ type: 'getPropertyValues', props: numeric, time: sec(1.25), evaluated: false });
        }
        // Every animated (keyed or expression-driven) numeric property, densely, with speed.
        for (const n of props) {
          if (!(n.dimensions > 0 && NUMERIC.has(n.valueType))) continue;
          if (!(n.animated || n.keyframeCount > 0 || (n.expression && n.expressionEnabled))) continue;
          await ask({ type: 'sampleProperty', prop: { layer, path: n.path }, range: { start: sec(-0.5), duration: sec(5) }, samples: 31, speed: true });
        }
      }
    }
    return rows;
  } finally {
    await h.dispose();
    random.mockRestore();
  }
}

/** Responses larger than this are stored as length + hash. */
const FULL_LIMIT = 768;

/** Two FNV-1a 32-bit lanes (offset bases 2166136261 and 0x811c9dc5 ^ 0x5bd1e995), as the C++ test computes them. */
function hash64(b: Uint8Array): [number, number] {
  let h1 = 0x811c9dc5;
  let h2 = (0x811c9dc5 ^ 0x5bd1e995) >>> 0;
  for (let i = 0; i < b.length; i++) {
    h1 = Math.imul(h1 ^ b[i]!, 0x01000193) >>> 0;
    h2 = Math.imul(h2 ^ b[i]!, 0x01000193) >>> 0;
  }
  return [h1, h2];
}

function encodeFixture(sessions: Array<[string, RecordRow[]]>, full: boolean): Buffer {
  const parts: Uint8Array[] = [];
  const u32 = (n: number): void => {
    const b = new Uint8Array(4);
    new DataView(b.buffer).setUint32(0, n, true);
    parts.push(b);
  };
  const blob = (b: Uint8Array): void => {
    u32(b.length);
    parts.push(b);
  };
  const text = (s: string): void => blob(new TextEncoder().encode(s));
  parts.push(new TextEncoder().encode('D1EV'));
  u32(2);
  u32(FILES.size);
  for (const [p, doc] of FILES) {
    text(p);
    text(doc);
  }
  u32(sessions.length);
  for (const [name, rows] of sessions) {
    blob(new TextEncoder().encode(name));
    u32(rows.length);
    for (const r of rows) {
      parts.push(Uint8Array.of(r.kind));
      u32(r.step >>> 0);
      text(r.label);
      if (r.derive) {
        parts.push(Uint8Array.of(1));
        u32(r.derive.base);
        u32(r.derive.seq);
        const t = new Uint8Array(8);
        new DataView(t.buffer).setFloat64(0, r.derive.time, true);
        parts.push(t, Uint8Array.of(r.derive.evaluated ? 1 : 0));
      } else {
        parts.push(Uint8Array.of(0));
        blob(r.request);
      }
      if (full || r.response.length <= FULL_LIMIT) {
        parts.push(Uint8Array.of(0));
        blob(r.response);
      } else {
        parts.push(Uint8Array.of(1));
        const [h1, h2] = hash64(r.response);
        u32(r.response.length);
        u32(h1);
        u32(h2);
      }
    }
  }
  return Buffer.concat(parts);
}

describe('D1: evaluated values of the replay corpus (fixture for the C++ engine)', () => {
  const sessions: Array<[string, RecordRow[]]> = [];

  test.each(Object.keys(CORPUS))('%s', async (name) => {
    const rows = await recordSession(name);
    sessions.push([name, rows]);
    expect(rows.some((r) => r.kind === 1)).toBe(true);
  }, 240_000);

  afterAll(() => {
    // test.each runs in declaration order; sort anyway so the file never depends on it.
    sessions.sort((a, b) => Object.keys(CORPUS).indexOf(a[0]) - Object.keys(CORPUS).indexOf(b[0]));
    const fullTo = process.env.GEN_NATIVE_D1_FULL;
    if (fullTo) writeFileSync(fullTo, encodeFixture(sessions, true));
    const bytes = encodeFixture(sessions, false);
    const digest = createHash('sha256').update(bytes).digest('hex');
    const records = sessions.reduce((n, [, r]) => n + r.length, 0);
    const probes = sessions.reduce((n, [, r]) => n + r.filter((x) => x.kind === 1).length, 0);
    console.log(`[D1 eval parity] ${sessions.length} sessions, ${records} records (${probes} probes), ${bytes.length} bytes, sha256 ${digest}`);
    if (sessions.length !== Object.keys(CORPUS).length) return;  // a filtered run (-t) never writes or checks
    if (process.env.GEN_NATIVE_D1 === '1') {
      writeFileSync(OUT, bytes);
      return;
    }
    const stored = existsSync(OUT) ? createHash('sha256').update(readFileSync(OUT)).digest('hex') : '(missing)';
    if (stored !== digest) {
      throw new Error(`native/engine/tests/data/d1_eval_parity.bin is stale (stored ${stored}, now ${digest}); regenerate with GEN_NATIVE_D1=1 npx jest d1EvalParity`);
    }
  });
});
