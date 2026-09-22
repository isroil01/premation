/**
 * Wire-format benchmark, TypeScript side (docs/ENGINE_API.md §9.3).
 *
 *   npm run engine-api:bench
 *   ENGINE_API_BENCH_EXTRA=/abs/path/adapter.mjs npm run engine-api:bench   (adds a comparator, e.g. FlatBuffers)
 *
 * For each payload in ./benchDocument: encoded size and median encode / decode
 * time for this codec, JSON (stringify + UTF-8, what a naive pipe would carry)
 * and V8 structured-clone serialization (what Electron IPC does to a plain
 * object). "decode" always means "to plain JS objects the UI mirror can store".
 */

import { performance } from 'node:perf_hooks';
import { deserialize, serialize } from 'node:v8';
import { codecs } from '../src/generated/codec';
import { dragEvents, makeDocument, setPropertyCommand } from './benchDocument';

interface Contender {
  name: string;
  encode(v: unknown): Uint8Array;
  decode(b: Uint8Array): unknown;
}

interface Payload {
  name: string;
  value: unknown;
  ours: Contender;
  iterations: number;
}

const enc = new TextEncoder();
const dec = new TextDecoder();

const json: Contender = {
  name: 'JSON',
  encode: (v) => enc.encode(JSON.stringify(v)),
  decode: (b) => JSON.parse(dec.decode(b)),
};

const v8: Contender = {
  name: 'v8 serialize',
  encode: (v) => serialize(v),
  decode: (b) => deserialize(b),
};

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)]!;
}

function time(fn: () => unknown, iterations: number): number {
  // Warm up (JIT), then take the median of 7 batches.
  for (let i = 0; i < Math.max(3, iterations / 10); i++) fn();
  const batches: number[] = [];
  for (let b = 0; b < 7; b++) {
    const t0 = performance.now();
    for (let i = 0; i < iterations; i++) fn();
    batches.push((performance.now() - t0) / iterations);
  }
  return median(batches);
}

function fmtTime(ms: number): string {
  if (ms < 0.01) return `${(ms * 1000).toFixed(2)} µs`;
  if (ms < 1) return `${(ms * 1000).toFixed(1)} µs`;
  return `${ms.toFixed(2)} ms`;
}

function fmtSize(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KiB`;
  return `${(n / 1024 / 1024).toFixed(2)} MiB`;
}

async function main(): Promise<void> {
  const payloads: Payload[] = [
    { name: 'setProperty (one drag write)', value: setPropertyCommand, ours: codecs.Command, iterations: 100_000 },
    { name: 'drag event batch', value: dragEvents(), ours: codecs.EventBatch, iterations: 50_000 },
    { name: 'getDocument 2000 layers, headers', value: makeDocument(2000, false), ours: codecs.DocumentSnapshot, iterations: 20 },
    { name: 'getDocument 2000 layers, full', value: makeDocument(2000, true), ours: codecs.DocumentSnapshot, iterations: 5 },
  ].map((p) => ({ ...p, ours: { name: 'engine-api', ...(p.ours as unknown as Omit<Contender, 'name'>) } }));

  const extraPath = process.env.ENGINE_API_BENCH_EXTRA;
  const extra: Record<string, Contender> = {};
  if (extraPath) {
    const mod = (await import(/* @vite-ignore */ `file://${extraPath.replace(/\\/g, '/')}`)) as { contenders: Record<string, Contender> };
    Object.assign(extra, mod.contenders);
  }

  console.log(`node ${process.version} · ${process.platform} ${process.arch}`);
  for (const p of payloads) {
    console.log(`\n${p.name}`);
    const contenders: Contender[] = [p.ours, json, v8];
    const key = p.name.startsWith('setProperty') ? 'setProperty' : p.name.startsWith('drag') ? 'dragEvents' : p.name.includes('headers') ? 'docHeaders' : 'docFull';
    if (extra[key]) contenders.push(extra[key]!);
    if (extra[`${key}Lazy`]) contenders.push(extra[`${key}Lazy`]!);
    for (const c of contenders) {
      const bytes = c.encode(p.value);
      const e = time(() => c.encode(p.value), p.iterations);
      const d = time(() => c.decode(bytes), p.iterations);
      console.log(`  ${c.name.padEnd(22)} ${fmtSize(bytes.length).padStart(10)}   encode ${fmtTime(e).padStart(10)}   decode ${fmtTime(d).padStart(10)}`);
    }
  }
}

void main();
