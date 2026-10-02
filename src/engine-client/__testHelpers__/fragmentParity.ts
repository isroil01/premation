/**
 * Parity between a client-built fragment (FragmentBuilder) and the legacy
 * off-document build of the same insert (offDocument.ts buildLayerFragment):
 * both decoded, then normalised for what may legitimately differ —
 *
 *   - ids: layer ids, component ids, and every nested `id` (gradient stops,
 *     path operators, keyframes) are minted per run; they are renamed `#n` in
 *     order of first appearance (canonical key order), everywhere they occur —
 *     values, object keys (track names), markup;
 *   - a top-level row's `parent` (the comp root vs null);
 *   - `solo` (the graph spells false out);
 *   - bars: the legacy build spells the default bar (the whole comp) out.
 */

import type { DocumentFragment } from '@motion/engine-api';
import { decodeFragmentLayers, type FragmentLayer } from '../fragmentBuilder';

function sortKeys(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sortKeys);
  if (v && typeof v === 'object') {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(v as Record<string, unknown>).sort()) out[k] = sortKeys((v as Record<string, unknown>)[k]);
    return out;
  }
  return v;
}

/** Every minted id in the layers, in first-appearance order. */
function collectIds(layers: FragmentLayer[]): string[] {
  const seen: string[] = [];
  const add = (s: unknown): void => {
    if (typeof s === 'string' && s !== '' && !seen.includes(s)) seen.push(s);
  };
  for (const l of layers) add(l.row.id);
  const walk = (v: unknown): void => {
    if (Array.isArray(v)) { v.forEach(walk); return; }
    if (!v || typeof v !== 'object') return;
    for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
      if (k === 'id' || k === 'nodeId') add(x);
      walk(x);
    }
  };
  walk(sortKeys(layers));
  return seen;
}

function renameIds(v: unknown, ids: string[]): unknown {
  // Longest first, so an id that prefixes another (`a_1` / `a_1_fx`) does not split it.
  const order = ids.map((id, i) => [id, `#${i}`] as const).sort((a, b) => b[0].length - a[0].length);
  const swap = (s: string): string => {
    let out = s;
    for (const [id, tag] of order) {
      if (!out.includes(id)) continue;
      out = out.split(id).join(tag);
      const scoped = id.replace(/[^\w-]/g, '_');
      if (scoped !== id) out = out.split(scoped).join(tag);
    }
    return out;
  };
  const walk = (x: unknown): unknown => {
    if (typeof x === 'string') return swap(x);
    if (Array.isArray(x)) return x.map(walk);
    if (!x || typeof x !== 'object') return x;
    return Object.fromEntries(Object.entries(x as Record<string, unknown>).map(([k, y]) => [swap(k), walk(y)]));
  };
  return walk(v);
}

/** The normalised form of a fragment's layers (see the header). */
export function normalizeFragment(f: DocumentFragment | FragmentLayer[], compFrames: number): unknown {
  const layers = Array.isArray(f) ? f : decodeFragmentLayers(f);
  const own = new Set(layers.map((l) => l.row.id));
  const shaped = layers.map((l) => ({
    row: {
      ...l.row,
      parent: l.row.parent && own.has(l.row.parent) ? l.row.parent : null,
      solo: l.row.solo === true,
    },
    anim: l.anim,
    bars: l.bars.length > 0 ? l.bars : [{ start: 0, duration: compFrames, sourceIn: 0, sourceDuration: null }],
  }));
  return renameIds(sortKeys(shaped), collectIds(layers));
}
