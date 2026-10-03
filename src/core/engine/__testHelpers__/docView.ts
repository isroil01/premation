/**
 * A read-only view of the ENGINE's document for `*.native.test` suites: the
 * engine's `exportDocument` (the saved EditorDocument — scene nodes with their
 * components, animation tracks, data tracks and expressions, timelines, comps,
 * project items) parsed once, with the readers the suites used to call on the
 * page's TypeScript singletons. Plain data: nothing here evaluates or renders.
 *
 *   const v = await docView();          // the document NOW (after engineIdle)
 *   v.getNode(id)?.name; v.getTrackKeyframes(id, 'x'); v.layerIdsOfComp(comp);
 *
 * A view is a snapshot: take a new one after the next edit.
 */

import { unwrap } from '@motion/engine-api';
import type { Keyframe } from '@motion/animation';
import type { Effect } from '@core/effects/effects';
import type { LayerMask } from '@core/effects/mask';
import { engine, engineIdle } from '../engineInstance';

export interface ViewComponent {
  id: string;
  type: string;
  props: Record<string, unknown>;
}

export interface ViewNode {
  id: string;
  name: string;
  parent: string | null;
  children: string[];
  transform: { position: { x: number; y: number }; rotation: number; scale: { x: number; y: number } };
  components: ViewComponent[];
  visible: boolean;
  locked: boolean;
  [k: string]: unknown;
}

/** A stored scalar keyframe (the document's own record). */
export type ViewKeyframe = Keyframe;

export interface ViewDataKeyframe {
  t: number;
  value: unknown;
  [k: string]: unknown;
}

export interface ViewClip {
  id: string;
  sourceId: string;
  trackId: string;
  name: string;
  enabled: boolean;
  locked: boolean;
  clip: { start: number; duration: number; sourceIn: number; sourceDuration: number | null; [k: string]: unknown };
  [k: string]: unknown;
}

export interface ViewTimeline {
  id: string;
  duration: number;
  frameRate: { fps: number; [k: string]: unknown };
  tracks: Array<{ id: string; layers: ViewClip[]; [k: string]: unknown }>;
  markers: Array<{ id: string; frame: number; name: string; [k: string]: unknown }>;
  [k: string]: unknown;
}

interface ExportedDoc {
  scene: { nodes: ViewNode[] };
  animation: {
    tracks?: Record<string, Record<string, { keyframes: ViewKeyframe[] }>>;
    expressions?: Record<string, Record<string, { src: string; enabled?: boolean }>>;
    data?: Record<string, Record<string, { kind?: string; keyframes: ViewDataKeyframe[] }>>;
  };
  comps: Record<string, Record<string, unknown>>;
  timelines: Record<string, ViewTimeline>;
  projectItems?: Record<string, unknown>;
  [k: string]: unknown;
}

export class DocView {
  private readonly nodes = new Map<string, ViewNode>();

  constructor(readonly raw: ExportedDoc) {
    for (const n of raw.scene?.nodes ?? []) this.nodes.set(n.id, n);
  }

  // ── scene ──────────────────────────────────────────────────────────────

  getNode(id: string): ViewNode | undefined {
    return this.nodes.get(id);
  }

  /** Child ids, back to front (the stored order). */
  getChildOrder(id: string): string[] {
    return [...(this.nodes.get(id)?.children ?? [])];
  }

  getChildren(id: string): ViewNode[] {
    return this.getChildOrder(id).map((c) => this.nodes.get(c)).filter((n): n is ViewNode => !!n);
  }

  /** Every node, parents before children. */
  traverse(visit: (node: ViewNode) => void): void {
    for (const n of this.nodes.values()) visit(n);
  }

  /** A component's props by type (`Transform`, `Style`, `Text`, `fx`, …). */
  props(id: string, type: string): Record<string, unknown> | undefined {
    return this.nodes.get(id)?.components.find((c) => c.type === type)?.props;
  }

  /** The composition layers, top of the stack first, a parent before its children, never into a precomp (doc.ts layerIdsOfComp). */
  layerIdsOfComp(comp: string): string[] {
    const out: string[] = [];
    const walk = (parent: string): void => {
      const kids = this.getChildOrder(parent);
      for (let i = kids.length - 1; i >= 0; i--) {
        const node = this.nodes.get(kids[i]!);
        if (!node) continue;
        out.push(node.id);
        if (this.props(node.id, 'fx')?.precomp !== true) walk(node.id);
      }
    };
    walk(comp);
    return out;
  }

  /** The layer's effect stack (the `fx` component's `effects`). */
  getNodeEffects(id: string): Effect[] {
    const list = this.props(id, 'fx')?.effects;
    return Array.isArray(list) ? (list as Effect[]) : [];
  }

  /** The layer's masks (the `fx` component's `mask`). */
  getNodeMask(id: string): LayerMask {
    const m = this.props(id, 'fx')?.mask as LayerMask | undefined;
    return m && Array.isArray(m.paths) ? m : { paths: [] };
  }

  /** The primary fill (paint/fill.ts readNodeFill): the `fx` fill paint, else a legacy colour string. */
  getNodeFill(id: string): Record<string, unknown> | undefined {
    const node = this.nodes.get(id);
    if (!node) return undefined;
    const paint = this.props(id, 'fx')?.fill;
    if (paint && typeof paint === 'object' && typeof (paint as { type?: unknown }).type === 'string') return paint as Record<string, unknown>;
    for (const c of node.components) {
      const f = c.props.fill;
      if (typeof f === 'string') return { type: 'solid', color: f };
    }
    return undefined;
  }

  /** The fill stack, bottom to top (paint/fill.ts readNodeFills). */
  getNodeFills(id: string): Array<Record<string, unknown>> {
    const arr = this.props(id, 'fx')?.fills;
    if (Array.isArray(arr)) {
      const valid = arr.filter((p) => p && typeof p === 'object' && typeof (p as { type?: unknown }).type === 'string');
      if (valid.length > 0) return valid as Array<Record<string, unknown>>;
    }
    const one = this.getNodeFill(id);
    return one ? [one] : [];
  }

  /** The layer's stored time record (the `fx` time: reverse, freeze, frame blending…); empty = the defaults. */
  getNodeLayerTime(id: string): { reverse?: boolean; freeze?: boolean; frameBlend?: string; [k: string]: unknown } {
    return (this.props(id, 'fx')?.time as Record<string, unknown> | undefined) ?? {};
  }

  // ── animation ──────────────────────────────────────────────────────────

  getTrackKeyframes(id: string, prop: string): ViewKeyframe[] | undefined {
    return this.raw.animation?.tracks?.[id]?.[prop]?.keyframes;
  }

  isAnimated(id: string, prop: string): boolean {
    return (this.getTrackKeyframes(id, prop)?.length ?? 0) > 0;
  }

  /** The layer's keyed scalar tracks. */
  tracksFor(id: string): Array<{ prop: string; keyframes: ViewKeyframe[] }> {
    return Object.entries(this.raw.animation?.tracks?.[id] ?? {})
      .filter(([, t]) => t.keyframes.length > 0)
      .map(([prop, t]) => ({ prop, keyframes: t.keyframes }));
  }

  getDataTrack(id: string, prop: string): { kind?: string; keyframes: ViewDataKeyframe[] } | undefined {
    return this.raw.animation?.data?.[id]?.[prop];
  }

  isDataAnimated(id: string, prop: string): boolean {
    return (this.getDataTrack(id, prop)?.keyframes.length ?? 0) > 0;
  }

  dataTracksFor(id: string): string[] {
    return Object.keys(this.raw.animation?.data?.[id] ?? {});
  }

  getExpressionSrc(id: string, prop: string): string | undefined {
    return this.raw.animation?.expressions?.[id]?.[prop]?.src;
  }

  /** Every expression in the document. */
  allExpressions(): Array<{ nodeId: string; prop: string; src: string; enabled: boolean }> {
    const out: Array<{ nodeId: string; prop: string; src: string; enabled: boolean }> = [];
    for (const [nodeId, props] of Object.entries(this.raw.animation?.expressions ?? {})) {
      for (const [prop, e] of Object.entries(props)) out.push({ nodeId, prop, src: e.src, enabled: e.enabled !== false });
    }
    return out;
  }

  hasExpression(id: string, prop: string): boolean {
    return !!this.getExpressionSrc(id, prop);
  }

  isExpressionEnabled(id: string, prop: string): boolean {
    const e = this.raw.animation?.expressions?.[id]?.[prop];
    return !!e && e.enabled !== false;
  }

  // ── timelines ──────────────────────────────────────────────────────────

  timelineForComp(comp: string): ViewTimeline | undefined {
    return this.raw.timelines?.[comp];
  }

  /** A layer's bars (clips), by start. */
  getLayersForNode(id: string): Array<ViewClip & { start: number; duration: number }> {
    const out: Array<ViewClip & { start: number; duration: number }> = [];
    for (const tl of Object.values(this.raw.timelines ?? {})) {
      for (const tr of tl.tracks ?? []) {
        for (const l of tr.layers ?? []) if (l.sourceId === id) out.push({ ...l, start: l.clip.start, duration: l.clip.duration });
      }
    }
    return out.sort((a, b) => a.start - b.start);
  }
}

/** The engine's document now, as a {@link DocView}. */
export async function docView(): Promise<DocView> {
  await engineIdle();
  const { document } = unwrap(await engine().query({ type: 'exportDocument' }));
  return new DocView(JSON.parse(new TextDecoder().decode(document)) as ExportedDoc);
}
