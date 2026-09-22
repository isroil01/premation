/**
 * Round trips for EVERY message type in the schema, not a sample.
 *
 * For each struct and union the generator produces deterministic sample values
 * (every optional present / every optional absent / one per union variant).
 * Each must:
 *   1. encode with the generated TypeScript codec to EXACTLY the bytes the
 *      generator's independent reflective encoder produces — the same bytes
 *      native/protocol/generated/fixtures.inc carries into the C++ test, so
 *      this is also the cross-language agreement check;
 *   2. decode back to a value deep-equal to the sample.
 */

import { codecs, type CodecName } from './generated/codec';
import { SCHEMA_COUNTS, COMMANDS, QUERIES, EVENTS } from './generated/meta';
import { DecodeError, Reader, Writer } from './wire';
import type { Command, EngineMessage, SetProperty, Value } from './generated/types';

interface Sample {
  label: string;
  value: unknown;
}
interface Generator {
  loadSchema(): unknown;
  makeReflect(model: unknown): { encode(type: string, v: unknown): Uint8Array };
  makeSampler(model: unknown): { samplesFor(type: string): Sample[] };
  messageTypes(model: unknown): string[];
}

const gen = require('../codegen/generate.cjs') as Generator;
const model = gen.loadSchema();
const reflect = gen.makeReflect(model);
const sampler = gen.makeSampler(model);
const types = gen.messageTypes(model);

const hex = (b: Uint8Array): string => Buffer.from(b).toString('hex');

describe('engine-api codec — every message type', () => {
  it('has a codec for every schema type and nothing else', () => {
    expect(Object.keys(codecs).sort()).toEqual([...types].sort());
    expect(types.length).toBe(SCHEMA_COUNTS.structs + SCHEMA_COUNTS.unions);
  });

  const cases: [string, string, unknown][] = [];
  for (const t of types) for (const s of sampler.samplesFor(t)) cases.push([t, s.label, s.value]);

  it('covers a meaningful number of samples', () => {
    // Every type has ≥ 2 samples (full + min) or one per union variant.
    expect(cases.length).toBeGreaterThanOrEqual(types.length * 2 - SCHEMA_COUNTS.unions);
  });

  it.each(cases)('%s — %s', (type, _label, value) => {
    const codec = codecs[type as CodecName] as { encode(v: unknown): Uint8Array; decode(b: Uint8Array): unknown };
    const bytes = codec.encode(value);
    expect(hex(bytes)).toBe(hex(reflect.encode(type, value)));
    expect(codec.decode(bytes)).toEqual(value);
  });
});

describe('engine-api codec — wire edge cases', () => {
  const setProp = (value: Value, path = 'transform/position'): Command => ({
    type: 'setProperty',
    prop: { layer: 'layer-1', path },
    value,
  });

  it('encodes a typical drag write in a few dozen bytes', () => {
    const bytes = codecs.Command.encode(setProp({ kind: 'vec2', value: { x: 960.5, y: 540.25 } }));
    expect(bytes.length).toBeLessThan(64);
    expect(codecs.Command.decode(bytes)).toEqual(setProp({ kind: 'vec2', value: { x: 960.5, y: 540.25 } }));
  });

  it('widens length prefixes past 127 bytes and 16 KiB (nested)', () => {
    for (const n of [127, 128, 300, 20000]) {
      const cmd = setProp({ kind: 'string', value: 'x'.repeat(n) }, 'text/sourceText');
      expect(codecs.Command.decode(codecs.Command.encode(cmd))).toEqual(cmd);
    }
    const big: Value = { kind: 'scalars', value: { values: Array.from({ length: 5000 }, (_, i) => i * 0.5) } };
    expect(codecs.Value.decode(codecs.Value.encode(big))).toEqual(big);
  });

  it('round-trips unicode strings (non-ASCII fast-path fallback)', () => {
    const cmd = setProp({ kind: 'string', value: '제주 😀 مرحبا é' }, 'text/sourceText');
    expect(codecs.Command.decode(codecs.Command.encode(cmd))).toEqual(cmd);
  });

  it('keeps 64-bit integers exact up to the safe range', () => {
    for (const t of [0, 1, -1, 2 ** 31, -(2 ** 31) - 1, 2 ** 52 - 1, -(2 ** 52)]) {
      const c = setProp({ kind: 'int', value: t });
      expect(codecs.Command.decode(codecs.Command.encode(c))).toEqual(c);
    }
    expect(() => codecs.Command.encode(setProp({ kind: 'int', value: 2 ** 52 }))).toThrow(RangeError);
    expect(() => codecs.Command.encode(setProp({ kind: 'int', value: 1.5 }))).toThrow(RangeError);
  });

  it('refuses out-of-range u32 / invalid enum values on encode', () => {
    expect(() => codecs.Command.encode({ type: 'step', frames: 2 ** 31 } as Command)).toThrow(RangeError);
    expect(() => codecs.Command.encode({ type: 'setBlendMode', layers: [], mode: 'nope' } as unknown as Command)).toThrow(RangeError);
  });

  it('skips unknown fields (a newer peer added an optional field)', () => {
    const cmd: SetProperty = { prop: { layer: 'a', path: 'transform/opacity' }, value: { kind: 'scalar', value: 50 } };
    const w = new Writer();
    w.reset();
    const base = codecs.SetProperty.encode(cmd);
    for (const b of base) w.byte(b);
    // field 99 varint, field 100 length-delimited, field 101 fixed64, field 102 fixed32
    w.varint(99 * 8 + 0);
    w.varint(123456789);
    w.varint(100 * 8 + 2);
    w.str('future');
    w.varint(101 * 8 + 1);
    w.f64(1.5);
    w.varint(102 * 8 + 5);
    w.f32(2.5);
    expect(codecs.SetProperty.decode(w.finish())).toEqual(cmd);
  });

  it('reports an unknown command (newer client) as unknownVariant', () => {
    const w = new Writer();
    w.varint(60000 * 8 + 2);
    w.varint(0);
    try {
      codecs.Command.decode(w.finish());
      throw new Error('expected a DecodeError');
    } catch (e) {
      expect(e).toBeInstanceOf(DecodeError);
      expect((e as DecodeError).code).toBe('unknownVariant');
    }
  });

  it('reports a missing required field', () => {
    // SetProperty with only `prop` (field 1): `value` missing.
    const full = codecs.SetProperty.encode({ prop: { layer: 'a', path: 'b' }, value: { kind: 'none' } });
    const propOnly = full.subarray(0, 2 + full[1]!);
    expect(() => codecs.SetProperty.decode(propOnly)).toThrow(expect.objectContaining({ code: 'missingField' }));
  });

  it('rejects every truncation of a real message without a partial value', () => {
    const msg: EngineMessage = {
      kind: 'request',
      value: {
        seq: 42,
        origin: 'ui',
        body: { kind: 'command', value: setProp({ kind: 'color', value: { r: 1, g: 0.5, b: 0.25, a: 1 } }) },
      },
    };
    const bytes = codecs.EngineMessage.encode(msg);
    expect(codecs.EngineMessage.decode(bytes)).toEqual(msg);
    for (let n = 0; n < bytes.length; n++) {
      expect(() => codecs.EngineMessage.decode(bytes.subarray(0, n))).toThrow(DecodeError);
    }
  });

  it('rejects an unknown enum number', () => {
    // SetBlendMode { layers: [], mode: 999 }
    const w = new Writer();
    w.varint(2 * 8 + 0);
    w.varint(999);
    expect(() => codecs.SetBlendMode.decode(w.finish())).toThrow(expect.objectContaining({ code: 'badEnum' }));
  });

  it('rejects a varint that overruns 2^53 and a malformed wire type', () => {
    const r = new Reader(Uint8Array.from([0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0x7f]));
    expect(() => r.varint()).toThrow(DecodeError);
    expect(() => codecs.Empty.decode(Uint8Array.from([0x0b]))).toThrow(DecodeError);
  });
});

describe('engine-api metadata', () => {
  it('assigns every command a history kind and a unique id', () => {
    const ids = Object.values(COMMANDS).map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const c of Object.values(COMMANDS)) expect(['edit', 'control', 'io']).toContain(c.kind);
    expect(COMMANDS.undo.kind).toBe('control');
    expect(COMMANDS.setProperty.kind).toBe('edit');
    expect(COMMANDS.setProperty.coalesce).toBe(true);
    expect(COMMANDS.saveProject.kind).toBe('io');
  });

  it('marks status events ephemeral and document events revisioned', () => {
    expect(EVENTS.playhead.ephemeral).toBe(true);
    expect(EVENTS.layersChanged.ephemeral).toBe(false);
    expect(Object.keys(QUERIES).length).toBe(SCHEMA_COUNTS.queries);
  });
});
