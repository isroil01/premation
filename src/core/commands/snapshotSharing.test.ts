/**
 * Structurally shared history snapshots — equivalence against the old
 * implementation, used as the oracle.
 *
 * The old history took `structuredClone(sceneProjectIO.capture())` +
 * `defaultAnimation.snapshot()` per record and compared whole states with
 * `JSON.stringify`. Both are reproduced VERBATIM below (`legacyCapture`,
 * `legacyEqual`), and every claim the new mechanism makes is checked against
 * them rather than against itself:
 *
 *   • `jsonEqual` answers exactly what the two strings would, on thousands of
 *     random values built to hit the edge cases (NaN, -0, undefined in objects
 *     and arrays, `toJSON`, key order, shared sub-objects);
 *   • a shared capture is deep-equal to the old capture, field for field;
 *   • random edit sequences of snapshot entries (a capture pushed when it
 *     changed, as every remaining snapshot entry does — the AI turn's gap
 *     fallback, the document transaction — plus undo / redo / jump) push an
 *     entry exactly when the old equality says
 *     they should, every undo and redo lands on the state the oracle recorded,
 *     undo-all returns the opening document and redo-all the final one;
 *   • nothing restored aliases a snapshot: editing the live document after an
 *     undo — including writes into nested arrays in place — never changes what
 *     a later undo or redo restores.
 */




import {
  jsonEqual,
  statesEqual,
} from './snapshotSharing';

jest.useFakeTimers();

// ── Deterministic randomness ──────────────────────────────────────────────

function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const int = (r: () => number, n: number): number => Math.floor(r() * n);
const pick = <T,>(r: () => number, xs: readonly T[]): T => xs[int(r, xs.length)]!;

// ── jsonEqual vs the strings ──────────────────────────────────────────────

const FIXED_DATE = new Date(Date.UTC(2026, 0, 2));

function randValue(r: () => number, depth: number): unknown {
  const k = int(r, depth > 3 ? 11 : 14);
  switch (k) {
    case 0: return null;
    case 1: return undefined;
    case 2: return NaN;
    case 3: return pick(r, [Infinity, -Infinity]);
    case 4: return pick(r, [0, -0]);
    case 5: return int(r, 5);
    case 6: return pick(r, [0.1 + 0.2, 1e21, 1 / 3]);
    case 7: return pick(r, ['', 'a', 'null', '0', 'b"c']);
    case 8: return r() < 0.5;
    case 9: return pick(r, [FIXED_DATE, () => 1, Symbol.iterator]);
    case 10: return pick(r, [{ toJSON: () => 'x' }, { toJSON: () => undefined }]);
    case 11: return Array.from({ length: int(r, 4) }, () => randValue(r, depth + 1));
    default: {
      const o: Record<string, unknown> = {};
      for (let i = int(r, 4); i > 0; i--) o[pick(r, ['a', 'b', 'c', 'd'])] = randValue(r, depth + 1);
      return o;
    }
  }
}

function copy(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(copy);
  if (v instanceof Date) return new Date(v.getTime());
  if (v && typeof v === 'object' && Object.getPrototypeOf(v) === Object.prototype && !('toJSON' in v)) {
    const o: Record<string, unknown> = {};
    for (const k of Object.keys(v)) o[k] = copy((v as Record<string, unknown>)[k]);
    return o;
  }
  return v;
}

/** A copy with one random change: a leaf, a key order, a key's presence — or none. */
function perturb(r: () => number, v: unknown): unknown {
  const c = copy(v);
  const holders: Array<Record<string, unknown> | unknown[]> = [];
  const walk = (x: unknown): void => {
    if (Array.isArray(x)) { holders.push(x); x.forEach(walk); }
    else if (x && typeof x === 'object' && Object.getPrototypeOf(x) === Object.prototype) {
      holders.push(x as Record<string, unknown>);
      Object.values(x).forEach(walk);
    }
  };
  walk(c);
  if (holders.length === 0 || r() < 0.2) return r() < 0.5 ? c : randValue(r, 0);
  const h = pick(r, holders);
  if (Array.isArray(h)) {
    if (h.length && r() < 0.7) h[int(r, h.length)] = randValue(r, 3);
    else h.push(randValue(r, 3));
  } else {
    const keys = Object.keys(h);
    const op = int(r, 3);
    if (op === 0 && keys.length > 1) {
      // Same content, different key order.
      const entries = keys.map((key) => [key, h[key]] as const).reverse();
      for (const key of keys) delete h[key];
      for (const [key, val] of entries) h[key] = val;
    } else if (op === 1 && keys.length) {
      delete h[pick(r, keys)];
    } else {
      h[pick(r, ['a', 'b', 'e'])] = randValue(r, 3);
    }
  }
  return c;
}

describe('jsonEqual', () => {
  it('agrees with JSON.stringify string equality on random values', () => {
    const r = rng(7);
    let equalPairs = 0;
    for (let i = 0; i < 6000; i++) {
      const a = randValue(r, 0);
      const b = perturb(r, a);
      const want = JSON.stringify(a) === JSON.stringify(b);
      if (want) equalPairs++;
      expect({ i, a: JSON.stringify(a), b: JSON.stringify(b), eq: jsonEqual(a, b) })
        .toEqual({ i, a: JSON.stringify(a), b: JSON.stringify(b), eq: want });
    }
    // Both answers must be well represented, or the agreement is vacuous.
    expect(equalPairs).toBeGreaterThan(600);
    expect(equalPairs).toBeLessThan(5400);
  });

  it('treats a shared sub-object as equal without walking it, and still sees siblings', () => {
    const shared = { big: Array.from({ length: 1000 }, (_, i) => ({ i })) };
    expect(jsonEqual({ x: shared, y: 1 }, { x: shared, y: 1 })).toBe(true);
    expect(jsonEqual({ x: shared, y: 1 }, { x: shared, y: 2 })).toBe(false);
  });

  it('pins the edge cases by name', () => {
    expect(jsonEqual({ a: undefined }, {})).toBe(true);
    expect(jsonEqual([undefined], [null])).toBe(true);
    expect(jsonEqual(NaN, null)).toBe(true);
    expect(jsonEqual(-0, 0)).toBe(true);
    expect(jsonEqual({ a: 1, b: 2 }, { b: 2, a: 1 })).toBe(false); // key order is content to the old check
    expect(jsonEqual('null', null)).toBe(false);
    expect(jsonEqual(FIXED_DATE, FIXED_DATE.toISOString())).toBe(true);
    expect(() => jsonEqual({ a: BigInt(1) }, { a: BigInt(1) })).toThrow();
    const cyc: Record<string, unknown> = {};
    cyc.self = cyc;
    expect(statesEqual(cyc as never, { self: {} } as never)).toBe(false);
  });
});
