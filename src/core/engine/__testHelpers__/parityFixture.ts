/**
 * The cross-engine parity fixture format shared by d1EvalParity.test.ts (D1:
 * evaluated values) and undoParity.test.ts (F2: history): the TypeScript
 * engine's recorded requests and responses, replayed byte for byte into a C++
 * `Session` by native/engine/tests/parity_fixture.hpp.
 *
 * Format (little-endian; a blob is u32 length + bytes): "D1EV", u32 version
 * (2), u32 project-file count, per file a path blob + a JSON document blob
 * (seeded into both engines' test ports); u32 session count; per session a
 * name blob, u32 record count; per record u8 kind (0 = session request,
 * 1 = probe, 2 = a request the fixture adds — F2's history walk), u32
 * revision step, a label blob (the command / query type), the request — u8
 * form 0 + the encoded EngineMessage{request} blob, or form 1 (a probe
 * getPropertyValues over the same properties as an earlier record): u32 that
 * record's index, u32 seq, f64 time, u8 evaluated — and the response: u8
 * form, then for form 0 the encoded EngineMessage{response} blob (seq = 0,
 * revision = 0), for form 1 (responses above FULL_LIMIT bytes, so the fixture
 * stays small) u32 length + u32 u32 hash (two FNV-1a 32 lanes, `hash64`).
 */

import { encodeEngineMessage, type Request, type Response } from '@motion/engine-api';

export interface RecordRow {
  kind: 0 | 1 | 2;
  step: number;
  label: string;
  request: Uint8Array;
  response: Uint8Array;
  /** A probe getPropertyValues that repeats record `base`'s properties at another time. */
  derive?: { base: number; seq: number; time: number; evaluated: boolean };
  /** The response already reduced to length + hash (`compact`): `response` is then empty. */
  digest?: { length: number; h1: number; h2: number };
}

/**
 * Reduce a large response to its length + hash now (a long recording keeps
 * thousands of whole-document answers otherwise). Unless `full`, the fixture
 * stores exactly this for it anyway.
 */
export function compact(row: RecordRow, full: boolean): RecordRow {
  if (full || row.response.length <= FULL_LIMIT) return row;
  const [h1, h2] = hash64(row.response);
  return { ...row, response: new Uint8Array(0), digest: { length: row.response.length, h1, h2 } };
}

/** The response as the fixture stores it: seq and revision zeroed, saveProject's byte count 0. */
export function normalized(res: Response): Uint8Array {
  // saveProject's byte count is each engine's own serializer's (and the TS one
  // stamps the save time): the C++ side compares its path only; store 0 so the
  // fixture is reproducible.
  const o = res.outcome;
  const outcome = o.kind === 'command' && o.value.type === 'saveProject' ? { ...o, value: { ...o.value, bytes: 0 } } : o;
  return encodeEngineMessage({ kind: 'response', value: { ...res, seq: 0, revision: 0, outcome } as Response });
}

/** mulberry32 — the legacy builders' scratch ids come from Math.random; seeded, the fixture is reproducible. */
export function seededRandom(seed: number): () => number {
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
export function wireCopy(req: Request): Uint8Array {
  return encodeEngineMessage({ kind: 'request', value: req });
}

/** A request's label in the fixture (the command / query type, or the batch's command list). */
export function requestLabel(req: Request): string {
  return req.body.kind === 'batch' ? `batch(${req.body.value.commands.map((c) => c.type).join(',')})` : req.body.value.type;
}

/** Responses larger than this are stored as length + hash. */
export const FULL_LIMIT = 768;

/** Two FNV-1a 32-bit lanes (offset bases 2166136261 and 0x811c9dc5 ^ 0x5bd1e995), as the C++ test computes them. */
export function hash64(b: Uint8Array): [number, number] {
  let h1 = 0x811c9dc5;
  let h2 = (0x811c9dc5 ^ 0x5bd1e995) >>> 0;
  for (let i = 0; i < b.length; i++) {
    h1 = Math.imul(h1 ^ b[i]!, 0x01000193) >>> 0;
    h2 = Math.imul(h2 ^ b[i]!, 0x01000193) >>> 0;
  }
  return [h1, h2];
}

export function encodeFixture(files: ReadonlyMap<string, string>, sessions: Array<[string, RecordRow[]]>, full: boolean): Buffer {
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
  u32(files.size);
  for (const [p, doc] of files) {
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
      if (r.digest) {
        parts.push(Uint8Array.of(1));
        u32(r.digest.length);
        u32(r.digest.h1);
        u32(r.digest.h2);
      } else if (full || r.response.length <= FULL_LIMIT) {
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
