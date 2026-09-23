/**
 * The canonical form of the saved project, for "same document?" checks
 * (undo parity, command replay — ENGINE_API.md §12).
 *
 * It is the document `captureDocument` saves, with:
 *   • editor state removed — open tabs, each timeline's playhead and view
 *     (zoom/scroll): never document state in the API (§2.3, §2.5 #10);
 *   • the ids the timeline package mints RANDOMLY (timeline, track and group
 *     ids, `uid()`) replaced by positional names — nothing outside a timeline
 *     references them, and bar ids are already deterministic (`clip:<node>`);
 *   • object keys sorted (key order is not meaning), arrays kept in order
 *     (array order IS meaning: stack order, keyframe order, node order).
 */

import { captureDocument } from '@core/api/cloudDocument';

function sortKeys(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sortKeys);
  if (v && typeof v === 'object') {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(v as Record<string, unknown>).sort()) {
      const x = (v as Record<string, unknown>)[k];
      if (x !== undefined) out[k] = sortKeys(x);
    }
    return out;
  }
  return v;
}

export function canonicalDocument(): unknown {
  const doc = structuredClone(captureDocument()) as unknown as Record<string, unknown>;
  delete doc.openTabs;
  const timelines = doc.timelines as Record<string, Record<string, unknown>> | undefined;
  if (timelines) {
    for (const [comp, tl] of Object.entries(timelines)) {
      delete tl.currentFrame;
      delete tl.view;
      tl.id = `timeline:${comp}`;
      const trackIds = new Map<string, string>();
      const tracks = (tl.tracks as Array<Record<string, unknown>> | undefined) ?? [];
      tracks.forEach((t, i) => {
        const id = String(t.id);
        trackIds.set(id, `track:${comp}:${i}`);
        t.id = `track:${comp}:${i}`;
        for (const l of (t.layers as Array<Record<string, unknown>> | undefined) ?? []) {
          if (typeof l.trackId === 'string') l.trackId = trackIds.get(l.trackId) ?? l.trackId;
        }
      });
      const groups = (tl.groups as Array<Record<string, unknown>> | undefined) ?? [];
      groups.forEach((g, i) => {
        g.id = `group:${comp}:${i}`;
        g.trackIds = ((g.trackIds as string[]) ?? []).map((x) => trackIds.get(x) ?? x);
      });
      const ranges = tl.ranges as Record<string, unknown> | undefined;
      // The loop range is a preview setting that follows the work area; keep it.
      void ranges;
    }
  }
  return sortKeys(doc);
}

export function canonicalJson(): string {
  return JSON.stringify(canonicalDocument());
}

/** FNV-1a over the canonical JSON, folded to 52 bits (exact as a JS number, fits the u64 field). */
export function hashString(s: string): number {
  let lo = 0x811c9dc5 >>> 0;
  let hi = 0x01000193 >>> 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    lo = Math.imul(lo ^ c, 0x01000193) >>> 0;
    hi = Math.imul(hi ^ (c + i), 0x0100019d) >>> 0;
  }
  return (hi & 0xfffff) * 0x100000000 + lo || 1;
}

export function documentHash(): number {
  return hashString(canonicalJson());
}
