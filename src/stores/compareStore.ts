/**
 * Snapshot / A-B / wipe compare for the viewport.
 *
 * `F5` freezes what the content canvas is showing into an ImageBitmap; `Shift+F5`
 * shows or hides the comparison. Four ways to look at it:
 *
 *   toggle        the snapshot replaces the live frame (press again to flip)
 *   side-by-side  snapshot left, live right, each half at half width
 *   wipe          a draggable divider — snapshot on one side, live on the other
 *   difference    |live − snapshot|, brightened, so a one-pixel drift shows
 *
 * ## Why ImageBitmaps, and why the render loop takes them
 *
 * The content canvas is WebGL and its drawing buffer is only readable in the
 * same task that drew it — a `drawImage` from an event handler a frame later
 * reads black. So this store never reads the canvas itself: `requestCapture`
 * arms a request, and the viewport's render loop fulfils it immediately after
 * `renderFrameAt` (see `useWorkspace`), where the pixels are guaranteed
 * fresh. `captureFrom` is the one entry point that touches a canvas, and it
 * copies synchronously into a 2D canvas first, so the bitmap is decoupled
 * from the GL buffer's lifetime.
 *
 * "Compare with cached frame at time…" reads the RAM preview instead — those
 * frames are already 2D-readable copies.
 */

import { create } from 'zustand';
import { viewportFrameCache } from '@core/rendering/frameCache';

export type CompareMode = 'toggle' | 'side-by-side' | 'wipe' | 'difference';

export const COMPARE_MODE_LABEL: Record<CompareMode, string> = {
  toggle: 'Toggle (A/B)',
  'side-by-side': 'Side by side',
  wipe: 'Wipe',
  difference: 'Difference',
};

/**
 * What a snapshot draws from: the resolved ImageBitmap, or — until it
 * resolves, and in environments without `createImageBitmap` — the private 2D
 * canvas copy. Both are `drawImage` sources.
 */
export type CompareImage = ImageBitmap | HTMLCanvasElement;

export interface CompareSnapshot {
  id: string;
  label: string;
  /** Comp time the snapshot was taken at, seconds. */
  time: number;
  /** Wall-clock, for ordering / the label. */
  takenAt: number;
  bitmap: CompareImage;
  width: number;
  height: number;
  /** The comp→canvas view the snapshot was rendered under, for a sanity note. */
  view: { scale: number; offsetX: number; offsetY: number };
}

/** How many snapshots to keep. Each is a full-size bitmap. */
export const MAX_SNAPSHOTS = 6;

interface CompareStore {
  snapshots: CompareSnapshot[];
  /** Which snapshot the comparison shows. */
  activeId: string | null;
  visible: boolean;
  mode: CompareMode;
  /** Wipe divider, 0…1 of the stage width. */
  wipe: number;
  /** In `toggle` mode: true shows the snapshot, false the live frame. */
  showingSnapshot: boolean;
  /**
   * A capture the render loop should fulfil on its next real render. Set by
   * `requestCapture`, consumed by `captureFrom`.
   */
  pending: { label?: string } | null;

  requestCapture: (label?: string) => void;
  /**
   * Fulfil a pending capture from a canvas that was JUST drawn. No-op when
   * nothing is pending. Returns the snapshot's id, or null.
   */
  captureFrom: (
    canvas: HTMLCanvasElement,
    time: number,
    view: { scale: number; offsetX: number; offsetY: number },
  ) => string | null;
  /** Snapshot a RAM-preview frame by comp frame index. False when not cached. */
  captureCachedFrame: (frame: number, fps: number, view: { scale: number; offsetX: number; offsetY: number }) => boolean;
  addSnapshot: (snap: Omit<CompareSnapshot, 'id' | 'takenAt'>) => string;
  remove: (id: string) => void;
  clear: () => void;
  setActive: (id: string | null) => void;
  setVisible: (v: boolean) => void;
  toggleVisible: () => void;
  setMode: (m: CompareMode) => void;
  setWipe: (t: number) => void;
  /** Toggle-mode A/B flip. */
  flip: () => void;
  key: () => string;
}

let seq = 0;

/**
 * A synchronous 2D copy of a canvas — the step that makes the pixels safe to
 * turn into a bitmap later. Returns null when the canvas is empty.
 */
function copyCanvas(canvas: HTMLCanvasElement): HTMLCanvasElement | null {
  if (canvas.width < 1 || canvas.height < 1) return null;
  const copy = document.createElement('canvas');
  copy.width = canvas.width;
  copy.height = canvas.height;
  const ctx = copy.getContext('2d');
  if (!ctx) return null;
  ctx.drawImage(canvas, 0, 0);
  return copy;
}

/**
 * Build a bitmap from a 2D canvas. `createImageBitmap` is async in the DOM
 * but the SOURCE is a private copy, so the timing does not matter; in
 * environments without it (jsdom) a canvas-backed stand-in is returned so the
 * store stays testable.
 */
function bitmapOf(source: CompareImage): Promise<CompareImage> {
  if (typeof createImageBitmap === 'function') return createImageBitmap(source);
  return Promise.resolve(source);
}

function releaseBitmap(b: CompareImage): void {
  try {
    if ('close' in b && typeof b.close === 'function') b.close();
  } catch {
    /* already closed */
  }
}

export const useCompareStore = create<CompareStore>((set, get) => ({
  snapshots: [],
  activeId: null,
  visible: false,
  mode: 'toggle',
  wipe: 0.5,
  showingSnapshot: true,
  pending: null,

  requestCapture: (label) => set({ pending: { label } }),

  captureFrom: (canvas, time, view) => {
    const pending = get().pending;
    if (!pending) return null;
    set({ pending: null });
    const copy = copyCanvas(canvas);
    if (!copy) return null;
    const id = `snap_${++seq}`;
    const label = pending.label ?? `Snapshot ${get().snapshots.length + 1}`;
    // Insert a placeholder immediately with the 2D copy standing in for the
    // bitmap, so the user sees the comparison on the very next frame; the
    // real bitmap swaps in when it resolves.
    const placeholder: CompareImage = copy;
    const snap: CompareSnapshot = {
      id, label, time, takenAt: Date.now(), bitmap: placeholder,
      width: copy.width, height: copy.height, view,
    };
    set((s) => {
      const next = [...s.snapshots, snap];
      while (next.length > MAX_SNAPSHOTS) {
        const dropped = next.shift();
        if (dropped) releaseBitmap(dropped.bitmap);
      }
      return { snapshots: next, activeId: id, visible: true };
    });
    void bitmapOf(copy).then((bitmap) => {
      if (bitmap === placeholder) return;
      set((s) => ({
        snapshots: s.snapshots.map((x) => (x.id === id ? { ...x, bitmap } : x)),
      }));
    });
    return id;
  },

  captureCachedFrame: (frame, fps, view) => {
    const hit = viewportFrameCache.get(frame);
    if (!hit) return false;
    const label = `Cached frame ${frame} (${(frame / Math.max(1, fps)).toFixed(2)}s)`;
    set({ pending: null });
    const id = get().addSnapshot({
      label, time: frame / Math.max(1, fps), bitmap: hit, width: hit.width, height: hit.height, view,
    });
    // The cache OWNS `hit`; take a private copy so an eviction cannot close
    // the bitmap under the comparison.
    void bitmapOf(hit).then((bitmap) => {
      set((s) => ({ snapshots: s.snapshots.map((x) => (x.id === id ? { ...x, bitmap } : x)) }));
    });
    return true;
  },

  addSnapshot: (snap) => {
    const id = `snap_${++seq}`;
    set((s) => {
      const next = [...s.snapshots, { ...snap, id, takenAt: Date.now() }];
      while (next.length > MAX_SNAPSHOTS) {
        const dropped = next.shift();
        if (dropped) releaseBitmap(dropped.bitmap);
      }
      return { snapshots: next, activeId: id, visible: true };
    });
    return id;
  },

  remove: (id) =>
    set((s) => {
      const gone = s.snapshots.find((x) => x.id === id);
      if (gone) releaseBitmap(gone.bitmap);
      const snapshots = s.snapshots.filter((x) => x.id !== id);
      const activeId = s.activeId === id ? (snapshots[snapshots.length - 1]?.id ?? null) : s.activeId;
      return { snapshots, activeId, visible: s.visible && snapshots.length > 0 };
    }),

  clear: () =>
    set((s) => {
      for (const x of s.snapshots) releaseBitmap(x.bitmap);
      return { snapshots: [], activeId: null, visible: false };
    }),

  setActive: (id) => set({ activeId: id }),
  setVisible: (v) => set((s) => ({ visible: v && s.snapshots.length > 0 })),
  toggleVisible: () => set((s) => ({ visible: !s.visible && s.snapshots.length > 0 })),
  setMode: (m) => set({ mode: m }),
  setWipe: (t) => set({ wipe: Math.max(0, Math.min(1, t)) }),
  flip: () => set((s) => ({ showingSnapshot: !s.showingSnapshot })),
  key: () => {
    const s = get();
    return `${s.visible ? 1 : 0}:${s.activeId ?? '-'}:${s.mode}:${s.wipe.toFixed(3)}:${s.showingSnapshot ? 1 : 0}`;
  },
}));

/** The snapshot the comparison is showing, or null. */
export function activeSnapshot(s: Pick<CompareStore, 'snapshots' | 'activeId'>): CompareSnapshot | null {
  return s.snapshots.find((x) => x.id === s.activeId) ?? null;
}

/** True when a comparison can be shown at all. */
export function canCompare(): boolean {
  return useCompareStore.getState().snapshots.length > 0;
}

// ── The LIVE frame, for difference mode ────────────────────────────
//
// Toggle, side-by-side and wipe never need the live pixels: the overlay
// paints only the snapshot and leaves the rest transparent, so the content
// canvas underneath IS the live half. Difference is the exception — it has to
// subtract one image from the other, which means holding both.
//
// The same WebGL rule applies, so the live copy is taken by the render loop
// in the draw task (`captureLiveFrame`), not pulled by the overlay. It is a
// full-canvas `drawImage` per frame, which is why `needsLiveFrame()` gates it:
// nobody pays for it unless difference mode is actually on screen.
//
// Deliberately NOT zustand state: this is written up to 60×/s and a store
// write would re-render the viewport on every frame.

let liveCanvas: HTMLCanvasElement | null = null;
const liveListeners = new Set<() => void>();

/** Whether the render loop should copy the live frame this tick. */
export function needsLiveFrame(): boolean {
  const s = useCompareStore.getState();
  return s.visible && s.mode === 'difference' && s.snapshots.length > 0;
}

/**
 * Copy the just-drawn content canvas for the difference painter. Must be
 * called in the SAME task as the draw — see the module header.
 */
export function captureLiveFrame(content: HTMLCanvasElement): void {
  if (content.width < 1 || content.height < 1) return;
  if (!liveCanvas) liveCanvas = document.createElement('canvas');
  if (liveCanvas.width !== content.width || liveCanvas.height !== content.height) {
    liveCanvas.width = content.width;
    liveCanvas.height = content.height;
  }
  const ctx = liveCanvas.getContext('2d');
  if (!ctx) return;
  ctx.clearRect(0, 0, liveCanvas.width, liveCanvas.height);
  ctx.drawImage(content, 0, 0);
  for (const fn of [...liveListeners]) fn();
}

/** The last live copy, or null when difference mode has not run yet. */
export function liveFrame(): HTMLCanvasElement | null {
  return liveCanvas;
}

/** Notify me when a new live copy lands (difference mode only). */
export function subscribeLiveFrame(fn: () => void): () => void {
  liveListeners.add(fn);
  return () => {
    liveListeners.delete(fn);
  };
}

/** Test seam: drop the live copy and its listeners. */
export function resetLiveFrameForTest(): void {
  liveCanvas = null;
  liveListeners.clear();
}
