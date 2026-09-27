/**
 * On-canvas UI: a plugin describes what it wants drawn, the host draws it, and
 * the host posts back the pointer and key events that landed on it.
 *
 * ── Why a retained draw list and not a draw callback ─────────────────────────
 *
 * After Effects gives a custom-UI effect a Drawbot context and calls it back on
 * a DRAW event. That works because an AE plugin is native code in the host's
 * own process. Here the plugin is a Worker: a callback cannot cross the
 * boundary, and one that could would be third-party code running inside the
 * viewport's paint — a stall in it is a frozen editor, and a `ctx` handed to it
 * is a handle on the app's own canvas, which is the one thing the sandbox
 * exists to withhold.
 *
 * So the plugin sends DATA. It posts a list of primitives — lines, rectangles,
 * circles, paths, text and HANDLES — and the host repaints that list every
 * frame with the layer's own transform applied, at whatever zoom the user is
 * at, with no plugin code in the paint at all. The plugin updates the list when
 * it wants to change what is on screen. This is also why the list is retained
 * rather than emitted per event: a drag has to keep drawing while the plugin is
 * thinking, and a list that had to be re-sent per frame would flicker at
 * exactly the moment it matters.
 *
 * ── Coordinates are the LAYER's ──────────────────────────────────────────────
 *
 * Every point is in the layer's own space, the same space its anchor point and
 * its mask vertices are in, and the host applies the layer's transform (with
 * parenting, 3D and animation) when it paints and un-applies it when it routes
 * an event back. A plugin therefore never sees a zoom level, a pan offset, a
 * DPR or a viewport size — it cannot, and it does not need to. `space: 'comp'`
 * is the escape hatch for a gizmo that belongs to the composition rather than
 * to a layer.
 *
 * ── Everything here is untrusted ─────────────────────────────────────────────
 *
 * A draw list crossed a `postMessage` from third-party code and then goes
 * straight into a 2D context. `sanitiseDrawList` is not politeness: an
 * unbounded item count is a frame-rate attack, an unclamped font size is a
 * plugin writing over the whole viewport, and a colour string that is not a hex
 * literal is a value going into `ctx.fillStyle`, which parses more grammars
 * than anyone wants to think about.
 */

import { StoreSnapshotCommand } from '@core/commands/snapshotCommand';
import { getCommandSystem } from '@core/commands/CommandSystem';
import { captureSharedState, statesEqual, type DocState } from '@core/commands/snapshotSharing';
import { bumpScene } from '@stores/sceneStore';

export interface PluginPoint { x: number; y: number }

/** One primitive in a draw list. `k` is the kind, short because these travel. */
export type PluginDrawItem =
  | { k: 'line'; from: PluginPoint; to: PluginPoint; color?: string; width?: number; dash?: boolean }
  | { k: 'rect'; x: number; y: number; w: number; h: number; color?: string; width?: number; fill?: string }
  | { k: 'circle'; x: number; y: number; r: number; color?: string; width?: number; fill?: string }
  | { k: 'path'; points: PluginPoint[]; close?: boolean; color?: string; width?: number; fill?: string }
  | { k: 'text'; x: number; y: number; text: string; color?: string; size?: number; align?: 'left' | 'center' | 'right' }
  /**
   * A grab point. The only item that is also an INPUT: it has an id, and a
   * pointer within `hitRadius` SCREEN pixels of it is delivered to the plugin
   * carrying that id, so the plugin writes "the user is dragging `p0`" rather
   * than doing its own hit-testing against a transform it cannot see.
   */
  | {
      k: 'handle';
      id: string;
      x: number;
      y: number;
      shape?: 'circle' | 'square';
      color?: string;
      fill?: string;
      /** Drawn radius, in SCREEN pixels — a handle does not grow with zoom. */
      radius?: number;
      /** Grab radius, in screen pixels. Defaults to `radius + 4`. */
      hitRadius?: number;
    };

export interface PluginDrawList {
  /**
   * Whose space the points are in. Null with `space: 'comp'`; required
   * otherwise — there is no layer-space without a layer.
   */
  layerId: string | null;
  space: 'layer' | 'comp';
  items: PluginDrawItem[];
}

/*
  Caps.

  Every item is painted on every frame of every viewport, on the same thread as
  the rest of the chrome. 512 is generous for a gizmo and cheap to draw; it is
  also low enough that a plugin cannot make the editor unusable by accident.
*/
export const MAX_DRAW_ITEMS = 512;
export const MAX_PATH_POINTS = 512;
const MAX_TEXT = 120;

const HEX_RE = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/;

const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));
const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

/** A colour we are willing to hand to a 2D context, or undefined. */
function colour(v: unknown): string | undefined {
  return typeof v === 'string' && HEX_RE.test(v) ? v : undefined;
}

function point(v: unknown): PluginPoint | null {
  if (!v || typeof v !== 'object') return null;
  const p = v as Record<string, unknown>;
  if (!finite(p.x) || !finite(p.y)) return null;
  // Bounded: a coordinate of 1e300 is a NaN factory once a transform touches it.
  return { x: clamp(p.x, -1e6, 1e6), y: clamp(p.y, -1e6, 1e6) };
}

/**
 * A draw list this host is willing to paint, or null.
 *
 * Returns a NEW object built field by field — never the plugin's, even when
 * every field passes. The list is retained across frames, and keeping a
 * reference to a structured-clone result from a worker means keeping whatever
 * else the plugin attached to it alive for as long as the layer is selected.
 */
export function sanitiseDrawList(raw: unknown): PluginDrawList | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const space = r.space === 'comp' ? 'comp' : 'layer';
  const layerId = typeof r.layerId === 'string' && r.layerId ? r.layerId : null;
  if (space === 'layer' && !layerId) return null;
  if (!Array.isArray(r.items)) return null;

  const items: PluginDrawItem[] = [];
  for (const entry of r.items.slice(0, MAX_DRAW_ITEMS)) {
    const item = sanitiseItem(entry);
    if (item) items.push(item);
  }
  return { layerId, space, items };
}

function sanitiseItem(raw: unknown): PluginDrawItem | null {
  if (!raw || typeof raw !== 'object') return null;
  const e = raw as Record<string, unknown>;
  const stroke = colour(e.color) ?? '#4da3ff';
  const width = finite(e.width) ? clamp(e.width, 0.5, 8) : 1;
  const fill = colour(e.fill);

  switch (e.k) {
    case 'line': {
      const from = point(e.from);
      const to = point(e.to);
      if (!from || !to) return null;
      return { k: 'line', from, to, color: stroke, width, ...(e.dash === true ? { dash: true } : {}) };
    }
    case 'rect': {
      if (!finite(e.x) || !finite(e.y) || !finite(e.w) || !finite(e.h)) return null;
      return {
        k: 'rect',
        x: clamp(e.x, -1e6, 1e6), y: clamp(e.y, -1e6, 1e6),
        w: clamp(e.w, -1e6, 1e6), h: clamp(e.h, -1e6, 1e6),
        color: stroke, width, ...(fill ? { fill } : {}),
      };
    }
    case 'circle': {
      if (!finite(e.x) || !finite(e.y) || !finite(e.r)) return null;
      return {
        k: 'circle',
        x: clamp(e.x, -1e6, 1e6), y: clamp(e.y, -1e6, 1e6), r: clamp(e.r, 0, 1e5),
        color: stroke, width, ...(fill ? { fill } : {}),
      };
    }
    case 'path': {
      if (!Array.isArray(e.points)) return null;
      const points: PluginPoint[] = [];
      for (const p of e.points.slice(0, MAX_PATH_POINTS)) {
        const pt = point(p);
        if (pt) points.push(pt);
      }
      if (points.length < 2) return null;
      return {
        k: 'path', points, color: stroke, width,
        ...(e.close === true ? { close: true } : {}),
        ...(fill ? { fill } : {}),
      };
    }
    case 'text': {
      if (!finite(e.x) || !finite(e.y) || typeof e.text !== 'string' || !e.text) return null;
      const align = e.align === 'center' || e.align === 'right' ? e.align : 'left';
      return {
        k: 'text',
        x: clamp(e.x, -1e6, 1e6), y: clamp(e.y, -1e6, 1e6),
        text: e.text.slice(0, MAX_TEXT),
        color: stroke,
        size: finite(e.size) ? clamp(e.size, 8, 32) : 11,
        align,
      };
    }
    case 'handle': {
      if (typeof e.id !== 'string' || !e.id || e.id.length > 64) return null;
      if (!finite(e.x) || !finite(e.y)) return null;
      const radius = finite(e.radius) ? clamp(e.radius, 2, 16) : 5;
      return {
        k: 'handle',
        id: e.id,
        x: clamp(e.x, -1e6, 1e6), y: clamp(e.y, -1e6, 1e6),
        shape: e.shape === 'circle' ? 'circle' : 'square',
        color: stroke,
        ...(fill ? { fill } : {}),
        radius,
        hitRadius: finite(e.hitRadius) ? clamp(e.hitRadius, 2, 32) : radius + 4,
      };
    }
    default:
      // A kind this build does not know, from a plugin written against a newer
      // vocabulary. Dropping the item beats drawing something that is not what
      // the author asked for.
      return null;
  }
}

// ── The live registry ────────────────────────────────────────────────

/** What a plugin is told happened on its drawing. */
export interface PluginCanvasEvent {
  type: 'down' | 'move' | 'up' | 'hover' | 'key';
  /** Layer space when the list said `layer`, composition space otherwise. */
  x: number;
  y: number;
  /** The handle under the pointer, when there is one. */
  handleId?: string;
  /** Which layer the coordinates belong to, echoing the list. */
  layerId: string | null;
  modifiers: { alt: boolean; ctrl: boolean; meta: boolean; shift: boolean };
  /** `key` events only. */
  key?: string;
}

type DeliverHook = (pluginId: string, event: PluginCanvasEvent) => void;

const lists = new Map<string, PluginDrawList>();
const listeners = new Set<() => void>();
let deliver: DeliverHook | null = null;

function emit(): void {
  for (const fn of [...listeners]) fn();
}

/**
 * Wire the registry to whatever can reach a plugin's worker.
 *
 * Injected, so the viewport can import this module without importing the plugin
 * host — and so a test can assert what a gesture posted without a worker.
 */
export function configurePluginCanvas(hooks: { deliver: DeliverHook }): void {
  deliver = hooks.deliver;
}

/** Repaint when a plugin changes what it wants drawn. */
export function onPluginDrawChanged(fn: () => void): () => void {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}

/** Set (or with null, clear) one plugin's drawing. Returns false if refused. */
export function setPluginDrawList(pluginId: string, raw: unknown): boolean {
  if (raw === null || raw === undefined) {
    if (lists.delete(pluginId)) emit();
    return true;
  }
  const list = sanitiseDrawList(raw);
  if (!list) return false;
  lists.set(pluginId, list);
  emit();
  return true;
}

export function clearPluginDrawList(pluginId: string): void {
  if (lists.delete(pluginId)) emit();
}

/** Every drawing on screen right now, in plugin-id order so paint is stable. */
export function pluginDrawLists(): Array<{ pluginId: string; list: PluginDrawList }> {
  return [...lists.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([pluginId, list]) => ({ pluginId, list }));
}

/**
 * The handle nearest `local` within its own grab radius, or null.
 *
 * `scale` converts the layer's units to screen pixels, because a handle's grab
 * radius is in SCREEN pixels: a 9-pixel target has to stay a 9-pixel target at
 * 25% zoom, which is exactly when the user needs it most.
 */
export function findHandleAt(
  list: PluginDrawList,
  local: PluginPoint,
  scale: number,
): { id: string; x: number; y: number } | null {
  let best: { id: string; x: number; y: number } | null = null;
  let bestDist = Infinity;
  const s = scale > 0 ? scale : 1;
  for (const item of list.items) {
    if (item.k !== 'handle') continue;
    const dx = (item.x - local.x) * s;
    const dy = (item.y - local.y) * s;
    const d = Math.hypot(dx, dy);
    const reach = item.hitRadius ?? (item.radius ?? 5) + 4;
    // Nearest wins, not first: overlapping handles are normal (a tangent on its
    // vertex), and "first in the list" would make which one you grab depend on
    // the order the plugin happened to emit them in.
    if (d <= reach && d < bestDist) {
      bestDist = d;
      best = { id: item.id, x: item.x, y: item.y };
    }
  }
  return best;
}

/** Post one event to a plugin. No-op when nothing is wired up. */
export function dispatchPluginCanvasEvent(pluginId: string, event: PluginCanvasEvent): void {
  deliver?.(pluginId, event);
}

// ── One gesture, one undo entry ──────────────────────────────────────

/**
 * A drag on a plugin handle is ONE act to the user, and it has to be one
 * Ctrl-Z — but the plugin makes it out of many `scene.setProperty` calls, each
 * of which is its own engine entry. Fifty entries for one drag is the
 * behaviour every native tool in this editor already avoids.
 *
 * So the gesture brackets them: snapshot at pointer-down, SUSPEND history for
 * the duration (the suspension is counted, so each inner edit
 * suspends and resumes inside ours and pushes nothing), and push one entry at
 * pointer-up. A whole-document snapshot entry, split across two ticks
 * because a drag is.
 *
 * `end` is guaranteed by the viewport's pointer-up AND pointer-cancel paths: a
 * gesture left open would suppress every undo entry in the session.
 */
let gesture: { label: string; before: DocState } | null = null;

export function beginPluginGesture(label: string): void {
  if (gesture) endPluginGesture();
  gesture = { label, before: captureSharedState() };
  getCommandSystem().getHistory().suspend();
}

export function endPluginGesture(): void {
  if (!gesture) return;
  const { label, before } = gesture;
  gesture = null;
  const history = getCommandSystem().getHistory();
  history.resume();
  const after = captureSharedState();
  if (!statesEqual(before, after)) history.push(new StoreSnapshotCommand(label, before, after));
  bumpScene();
}

export function pluginGestureActive(): boolean {
  return gesture !== null;
}

/** Tests only — the registry is process-wide. */
export function resetPluginCanvasForTests(): void {
  lists.clear();
  listeners.clear();
  deliver = null;
  if (gesture) {
    getCommandSystem().getHistory().resume();
    gesture = null;
  }
}
