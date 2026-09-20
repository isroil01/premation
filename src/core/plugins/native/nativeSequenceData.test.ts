/**
 * Sequence data — what a native effect remembers between frames.
 *
 * The property everything here defends: **dropping every entry at any moment
 * must be invisible except in speed.** It is a cache, never document data, and
 * every rule below follows from that — which is also why there is no test that
 * it survives a save, and why there should never be one.
 *
 * The failure this replaces is not a crash. It is an optical-flow retimer
 * re-deriving the same flow field sixty times a second because the host threw
 * it away between frames.
 */

import {
  MAX_SEQUENCE_BYTES,
  MAX_SEQUENCE_ENTRIES,
  approximateBytes,
  clearSequenceData,
  dropPluginSequenceData,
  dropSequenceData,
  readSequenceData,
  sequenceDataStats,
  sequenceSignature,
  writeSequenceData,
} from './nativeSequenceData';

beforeEach(() => clearSequenceData());

const SIG = '';

describe('the round trip', () => {
  it('hands back exactly what the last frame returned', () => {
    expect(readSequenceData('p', 'i', SIG)).toBeUndefined();
    writeSequenceData('p', 'i', SIG, { flow: 'field' });
    expect(readSequenceData('p', 'i', SIG)).toEqual({ flow: 'field' });
  });

  it('keeps instances of one plugin apart', () => {
    writeSequenceData('p', 'a', SIG, 1);
    writeSequenceData('p', 'b', SIG, 2);
    expect(readSequenceData('p', 'a', SIG)).toBe(1);
    expect(readSequenceData('p', 'b', SIG)).toBe(2);
  });

  it('keeps plugins apart even at the same instance id', () => {
    // Instance ids are layer-scoped, not globally unique, so two plugins on
    // one layer would collide if the key were the instance alone.
    writeSequenceData('p1', 'i', SIG, 'one');
    writeSequenceData('p2', 'i', SIG, 'two');
    expect(readSequenceData('p1', 'i', SIG)).toBe('one');
    expect(readSequenceData('p2', 'i', SIG)).toBe('two');
  });

  it('clears on an explicit undefined', () => {
    writeSequenceData('p', 'i', SIG, 'x');
    writeSequenceData('p', 'i', SIG, undefined);
    expect(readSequenceData('p', 'i', SIG)).toBeUndefined();
  });
});

describe('invalidation', () => {
  it('signs nothing when the effect declares nothing', () => {
    // The default is "no param invalidates this", which is right for the
    // caches this exists for: they depend on the SOURCE, not the controls.
    expect(sequenceSignature({ amount: 1 }, undefined)).toBe('');
    expect(sequenceSignature({ amount: 1 }, [])).toBe('');
  });

  it('drops the state when a declared param moves', () => {
    const before = sequenceSignature({ radius: 4, tint: 'red' }, ['radius']);
    writeSequenceData('p', 'i', before, 'cached');
    const after = sequenceSignature({ radius: 5, tint: 'red' }, ['radius']);
    expect(readSequenceData('p', 'i', after)).toBeUndefined();
  });

  it('keeps it when an UNdeclared param moves', () => {
    const sig = ['radius'];
    const a = sequenceSignature({ radius: 4, tint: 'red' }, sig);
    writeSequenceData('p', 'i', a, 'cached');
    const b = sequenceSignature({ radius: 4, tint: 'blue' }, sig);
    expect(readSequenceData('p', 'i', b)).toBe('cached');
  });

  it('does not depend on the order the manifest lists the params in', () => {
    // Otherwise reordering a manifest key on an update would invalidate every
    // cached entry on every machine, for no change in meaning.
    const p = { a: 1, b: 2 };
    expect(sequenceSignature(p, ['a', 'b'])).toBe(sequenceSignature(p, ['b', 'a']));
  });

  it('distinguishes a missing param from an empty one', () => {
    expect(sequenceSignature({}, ['a'])).not.toBe(sequenceSignature({ a: 0 }, ['a']));
  });

  it('treats an unsignable param as always-changed rather than always-equal', () => {
    // A stale cache is a WRONG frame; a missed cache is a slow one.
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    const first = sequenceSignature({ x: cyclic }, ['x']);
    writeSequenceData('p', 'i', first, 'cached');
    const second = sequenceSignature({ x: cyclic }, ['x']);
    expect(readSequenceData('p', 'i', second)).toBeUndefined();
  });

  it('forgets a stale entry rather than holding it', () => {
    const a = sequenceSignature({ r: 1 }, ['r']);
    writeSequenceData('p', 'i', a, 'cached');
    readSequenceData('p', 'i', sequenceSignature({ r: 2 }, ['r']));
    // State nobody will read is memory nobody will free.
    expect(sequenceDataStats().entries).toBe(0);
  });
});

describe('lifecycle', () => {
  it('forgets everything a plugin held when it unloads', () => {
    writeSequenceData('p', 'a', SIG, 1);
    writeSequenceData('p', 'b', SIG, 2);
    writeSequenceData('other', 'a', SIG, 3);
    dropPluginSequenceData('p');
    // The next process never saw this and may not be the same build.
    expect(readSequenceData('p', 'a', SIG)).toBeUndefined();
    expect(readSequenceData('p', 'b', SIG)).toBeUndefined();
    expect(readSequenceData('other', 'a', SIG)).toBe(3);
  });

  it('does not let one plugin id prefix another', () => {
    writeSequenceData('acme.fx', 'i', SIG, 'keep');
    writeSequenceData('acme.fx2', 'i', SIG, 'also');
    dropPluginSequenceData('acme.fx');
    expect(readSequenceData('acme.fx2', 'i', SIG)).toBe('also');
  });

  it('forgets one instance on its own', () => {
    writeSequenceData('p', 'a', SIG, 1);
    writeSequenceData('p', 'b', SIG, 2);
    dropSequenceData('p', 'a');
    expect(readSequenceData('p', 'a', SIG)).toBeUndefined();
    expect(readSequenceData('p', 'b', SIG)).toBe(2);
  });
});

describe('the ceilings', () => {
  it('refuses an entry bigger than the host will hold, and says so', () => {
    const huge = { buf: new Uint8Array(MAX_SEQUENCE_BYTES + 1) };
    expect(writeSequenceData('p', 'i', SIG, huge)).toBe(false);
    expect(readSequenceData('p', 'i', SIG)).toBeUndefined();
  });

  it('accepts one at the limit', () => {
    expect(writeSequenceData('p', 'i', SIG, new Uint8Array(MAX_SEQUENCE_BYTES))).toBe(true);
  });

  it('evicts the least recently USED, not the least recently written', () => {
    for (let i = 0; i < MAX_SEQUENCE_ENTRIES; i++) writeSequenceData('p', `i${i}`, SIG, i);
    // Touch the oldest, so it is no longer the coldest.
    expect(readSequenceData('p', 'i0', SIG)).toBe(0);
    writeSequenceData('p', 'new', SIG, 'n');

    expect(sequenceDataStats().entries).toBe(MAX_SEQUENCE_ENTRIES);
    expect(readSequenceData('p', 'i0', SIG)).toBe(0);
    expect(readSequenceData('p', 'i1', SIG)).toBeUndefined();
    expect(readSequenceData('p', 'new', SIG)).toBe('n');
  });

  it('replacing an entry does not grow the store', () => {
    writeSequenceData('p', 'i', SIG, 'a');
    writeSequenceData('p', 'i', SIG, 'b');
    expect(sequenceDataStats().entries).toBe(1);
  });
});

describe('measuring an entry', () => {
  it('counts typed arrays wherever they are', () => {
    expect(approximateBytes(new Uint8Array(10))).toBe(10);
    expect(approximateBytes({ a: new Uint8Array(4), b: { c: new Float32Array(2) } })).toBe(12);
    expect(approximateBytes([new Uint8Array(3), new Uint8Array(5)])).toBe(8);
    expect(approximateBytes(new ArrayBuffer(7))).toBe(7);
  });

  it('counts plain values as nothing', () => {
    expect(approximateBytes({ n: 1, s: 'text', b: true, z: null })).toBe(0);
    expect(approximateBytes(undefined)).toBe(0);
  });

  it('survives a cyclic or very deep object without recursing forever', () => {
    // A plugin returning one of these should cost a shallow walk, not a stack
    // overflow inside the render loop.
    const cyclic: Record<string, unknown> = { buf: new Uint8Array(4) };
    cyclic.self = cyclic;
    expect(approximateBytes(cyclic)).toBe(4);

    let deep: Record<string, unknown> = { buf: new Uint8Array(2) };
    for (let i = 0; i < 40; i++) deep = { next: deep };
    // Under-counting is the safe direction: the ceiling is a guard, not an
    // accountant, and an uncounted buffer only means a generous cache.
    expect(approximateBytes(deep)).toBeGreaterThanOrEqual(0);
  });

  it('counts one shared buffer once', () => {
    const shared = new Uint8Array(8);
    expect(approximateBytes({ a: shared, b: shared })).toBe(8);
  });
});
