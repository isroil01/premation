/**
 * swatchStore — the project's named colour swatches, and the derived list of
 * colours the document actually uses.
 *
 * TWO LISTS, TWO LIFETIMES, and the distinction is the whole point:
 *
 *  • **Project swatches** are AUTHORED. A user names them ("Brand Red"),
 *    reorders them and expects them back tomorrow, so they belong to the
 *    DOCUMENT and round-trip through `EditorDocument.swatches` exactly the way
 *    colour management and guides do. They are not preferences: a palette that
 *    followed the app rather than the file would be wrong the moment a second
 *    project opened.
 *
 *  • **Document colours** are DERIVED — every distinct fill, gradient stop,
 *    stroke and light colour presently in the scene graph. Nothing authors
 *    them, so nothing persists them; they are recomputed from the graph on
 *    demand. Deliberately NOT a subscription: this walks every node and every
 *    paint, which is fine when a picker opens and unaffordable per frame. Call
 *    `refreshDocumentColors()` at the moment a surface becomes visible.
 *
 * Recents (in `ColorPicker`) stay in localStorage and stay per-machine. They
 * are a scratchpad of what you touched last, not a palette you curated, and
 * saving them into the file would mean a diff on every colour drag.
 */

import { create } from 'zustand';
import { getEventBus } from '@core/events/EventBus';
import defaultSceneGraph from '@core/scene/DefaultSceneGraph';
import { readNodeFills } from '@core/paint/fill';
import { readNodeStrokes } from '@core/paint/stroke';
import type { FillPaint } from '@core/paint/fill';
import type { SceneNode } from '@core/types';

/** One named colour in the project palette. */
export interface ProjectSwatch {
  id: string;
  name: string;
  /** Canonical `#rrggbb` / `#rrggbbaa`, lowercase. */
  hex: string;
}

/**
 * The document-colour strip is a palette, not an inventory. A comp with two
 * hundred distinct greys would push everything else off the strip and tell the
 * user nothing, so the walk stops once it has more than any picker can show.
 */
export const DOCUMENT_COLOR_LIMIT = 48;

/** Persisted + document state: every mutation must tell autosave. */
function touched(): void {
  try {
    getEventBus().emit('DocumentChanged', { source: 'composition' });
  } catch {
    /* no bus in headless tests */
  }
}

let seq = 0;
function swatchId(): string {
  seq += 1;
  return `sw_${Date.now().toString(36)}_${seq.toString(36)}`;
}

/**
 * Normalise a colour into the canonical hex this store compares by, or null if
 * it is not a hex colour at all.
 *
 * Canonicalising is what makes deduplication honest: `#FFF`, `#ffffff` and
 * `#FFFFFFFF` are one colour, and a strip that showed them as three would be
 * reporting its own storage format rather than the document's palette. The
 * fully-opaque alpha byte is dropped for the same reason.
 *
 * Non-hex paints (the `rgba(...)` strings `sampleGradientColor` produces) are
 * rejected rather than parsed: nothing STORES that form, so accepting it would
 * be widening the contract for a case that cannot occur.
 */
export function canonicalHex(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  const body = (trimmed.startsWith('#') ? trimmed.slice(1) : trimmed).toLowerCase();
  if (!/^[0-9a-f]+$/.test(body)) return null;
  let full: string;
  if (body.length === 3) full = body.split('').map((c) => c + c).join('');
  else if (body.length === 4) full = body.split('').map((c) => c + c).join('');
  else if (body.length === 6 || body.length === 8) full = body;
  else return null;
  // A trailing `ff` is "opaque", which is what a 6-digit hex already means.
  if (full.length === 8 && full.endsWith('ff')) full = full.slice(0, 6);
  return `#${full}`;
}

/** Push every colour a paint carries (solid colour, or every gradient stop). */
function pushPaint(paint: FillPaint | undefined, out: string[], seen: Set<string>): void {
  if (!paint) return;
  if (paint.type === 'solid') {
    pushColor(paint.color, out, seen);
    return;
  }
  for (const stop of paint.stops) pushColor(stop.color, out, seen);
}

function pushColor(raw: unknown, out: string[], seen: Set<string>): void {
  if (out.length >= DOCUMENT_COLOR_LIMIT) return;
  const hex = canonicalHex(raw);
  if (!hex || seen.has(hex)) return;
  seen.add(hex);
  out.push(hex);
}

/**
 * Every distinct colour the given nodes paint with, in first-seen order.
 *
 * PURE: it reads the nodes handed to it and touches no graph, no store and no
 * clock, which is what makes it testable against a fixture instead of against
 * a live editor.
 *
 * Covers fills (including each gradient stop), the fill STACK, strokes and
 * gradient strokes. Light colours arrive for free: a light stores its colour as
 * a plain `fill` string on its style component, and `readNodeFills` resolves
 * exactly that through its legacy single-colour path — so lights need no case
 * of their own here, and adding one would double-count them.
 *
 * Layer LABEL colours (`node.color`) are deliberately excluded. They tint the
 * timeline row, not the picture; offering them beside the real paint would put
 * chrome into a palette of content.
 */
export function collectDocumentColors(nodes: readonly SceneNode[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const node of nodes) {
    if (out.length >= DOCUMENT_COLOR_LIMIT) break;
    for (const fill of readNodeFills(node)) pushPaint(fill, out, seen);
    for (const stroke of readNodeStrokes(node)) {
      // The gradient paint OVERRIDES `color` when present, but `color` remains
      // the fallback every non-gradient renderer draws — both are in the file,
      // so both are colours the document uses.
      pushColor(stroke.color, out, seen);
      pushPaint(stroke.paint, out, seen);
    }
  }
  return out;
}

/** Read the live scene graph and collect its colours. */
export function collectSceneColors(): string[] {
  const nodes: SceneNode[] = [];
  defaultSceneGraph.traverse((n) => nodes.push(n));
  return collectDocumentColors(nodes);
}

/**
 * Coerce whatever a document carried into a valid palette.
 *
 * Documents are user files and can be hand-edited, produced by an older build,
 * or truncated. Anything whose colour does not parse is DROPPED rather than
 * repaired to black — a swatch that silently became a different colour is worse
 * than one that is missing.
 */
export function normalizeSwatches(raw: unknown): ProjectSwatch[] {
  if (!Array.isArray(raw)) return [];
  const out: ProjectSwatch[] = [];
  const usedIds = new Set<string>();
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object') continue;
    const rec = entry as Partial<ProjectSwatch>;
    const hex = canonicalHex(rec.hex);
    if (!hex) continue;
    const id = typeof rec.id === 'string' && rec.id && !usedIds.has(rec.id) ? rec.id : swatchId();
    usedIds.add(id);
    out.push({ id, name: typeof rec.name === 'string' && rec.name.trim() ? rec.name : hex.toUpperCase(), hex });
  }
  return out;
}

interface SwatchStore {
  /** The authored palette, in the user's order. Persisted in the document. */
  swatches: ProjectSwatch[];
  /** Derived. Empty until `refreshDocumentColors()` runs — never live. */
  documentColors: string[];
  /** Adds (or returns the existing swatch for) a colour. Null if unparseable. */
  addSwatch: (hex: string, name?: string) => ProjectSwatch | null;
  renameSwatch: (id: string, name: string) => void;
  removeSwatch: (id: string) => void;
  /** Move a swatch to `toIndex`, clamped. No-op when the id is unknown. */
  moveSwatch: (id: string, toIndex: number) => void;
  /** Capture for the document. */
  list: () => ProjectSwatch[];
  /** Restore from a document. Replaces the palette wholesale. */
  restore: (raw: unknown) => void;
  /** Recompute `documentColors` from the live scene graph. */
  refreshDocumentColors: () => void;
}

export const useSwatchStore = create<SwatchStore>((set, get) => ({
  swatches: [],
  documentColors: [],

  addSwatch: (hexRaw, name) => {
    const hex = canonicalHex(hexRaw);
    if (!hex) return null;
    // Adding a colour already in the palette must not create a second row for
    // it — the "+" button in the picker is pressed by reflex, and a palette
    // that grows duplicates stops being a palette.
    const existing = get().swatches.find((s) => s.hex === hex);
    if (existing) return existing;
    const swatch: ProjectSwatch = { id: swatchId(), name: name?.trim() || hex.toUpperCase(), hex };
    set((s) => ({ swatches: [...s.swatches, swatch] }));
    touched();
    return swatch;
  },

  renameSwatch: (id, name) => {
    const trimmed = name.trim();
    set((s) => ({
      swatches: s.swatches.map((sw) => (sw.id === id ? { ...sw, name: trimmed || sw.hex.toUpperCase() } : sw)),
    }));
    touched();
  },

  removeSwatch: (id) => {
    set((s) => ({ swatches: s.swatches.filter((sw) => sw.id !== id) }));
    touched();
  },

  moveSwatch: (id, toIndex) => {
    const list = get().swatches;
    const from = list.findIndex((s) => s.id === id);
    if (from < 0) return;
    const moved = list[from];
    if (!moved) return;
    const next = list.slice();
    next.splice(from, 1);
    const to = Math.max(0, Math.min(next.length, toIndex));
    next.splice(to, 0, moved);
    set({ swatches: next });
    touched();
  },

  list: () => get().swatches.map((s) => ({ ...s })),

  restore: (raw) => {
    // Assigned unconditionally: a project opened after one that had a palette
    // must not inherit it. `restoreDocument` only calls this when the key is
    // present, and `createEmpty` states an empty palette explicitly so File ▸
    // New really does clear it.
    set({ swatches: normalizeSwatches(raw), documentColors: [] });
  },

  refreshDocumentColors: () => {
    set({ documentColors: collectSceneColors() });
  },
}));
