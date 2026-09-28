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
 *    stroke and light colour presently in the document. Nothing authors
 *    them, so nothing persists them; the engine recomputes them
 *    (`getDocumentColors`) on demand. Deliberately NOT a subscription: this walks every node and every
 *    paint, which is fine when a picker opens and unaffordable per frame. Call
 *    `refreshDocumentColors()` at the moment a surface becomes visible.
 *
 * Recents (in `ColorPicker`) stay in localStorage and stay per-machine. They
 * are a scratchpad of what you touched last, not a palette you curated, and
 * saving them into the file would mean a diff on every colour drag.
 */

import { create } from 'zustand';
import { getEventBus } from '@core/events/EventBus';
import { engine } from '@core/engine/engineInstance';
import { canonicalHex, collectDocumentColors as collectPaintColors } from '@core/paint/documentColors';
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

// The canonical form and the pure colour walk live with the engine's `getDocumentColors` answer
// (src/core/paint/documentColors.ts); re-exported for the palette's callers and tests.
export { canonicalHex };

/** Every distinct colour the given nodes paint with, first seen, at most the strip's limit (pure). */
export function collectDocumentColors(nodes: readonly SceneNode[]): string[] {
  return collectPaintColors(nodes, DOCUMENT_COLOR_LIMIT);
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
  // A document entry without a usable id gets `sw_doc_<n>`, not a clock-based
  // id: opening the same file must give the same ids (replay, the C++ engine).
  let minted = 0;
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object') continue;
    const rec = entry as Partial<ProjectSwatch>;
    const hex = canonicalHex(rec.hex);
    if (!hex) continue;
    let id = typeof rec.id === 'string' && rec.id && !usedIds.has(rec.id) ? rec.id : '';
    while (!id || usedIds.has(id)) id = `sw_doc_${++minted}`;
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
  /** Recompute `documentColors` (the engine's `getDocumentColors`; lands asynchronously). */
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
    // B4: the engine walks every layer's paint (`getDocumentColors`); the strip updates when the answer lands.
    void engine().query({ type: 'getDocumentColors', limit: DOCUMENT_COLOR_LIMIT }).then((r) => {
      if (r.ok) set({ documentColors: r.value.colors });
    }, () => { /* no engine (headless): the strip stays as it was */ });
  },
}));
