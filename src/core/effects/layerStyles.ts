/**
 * Layer styles (Prompt E8) — Photoshop-style, toggleable per-layer styling.
 *
 * The shadow/glow styles compile to the same CSS `filter` string the effect
 * stack uses, so they render through the Canvas2D backend with no extra
 * compositing plumbing (and are captured by History / autosave / export like
 * the other `fx` data). Stored on the node's `fx` component (key 'layerStyles').
 *
 * Implemented here (filter-renderable): DROP SHADOW + OUTER GLOW. Inner shadow
 * and colour/gradient overlays need real compositing passes and are a documented
 * follow-up — they can't be expressed as a CSS `filter` alone.
 */

import defaultSceneGraph from '@core/scene/DefaultSceneGraph';
import { getEventBus } from '@core/events/EventBus';
import { parseHex } from '@core/paint/fill';
import type { SceneNode } from '@core/types';

export interface DropShadowStyle {
  enabled: boolean;
  color: string;
  opacity: number;   // 0..1
  distance: number;  // px
  angle: number;     // degrees (0 = →, 90 = ↓)
  blur: number;      // px
}

export interface OuterGlowStyle {
  enabled: boolean;
  color: string;
  opacity: number; // 0..1
  size: number;    // px
}

export interface LayerStyles {
  dropShadow?: DropShadowStyle;
  outerGlow?: OuterGlowStyle;
}

export const DEFAULT_DROP_SHADOW: DropShadowStyle = {
  enabled: true, color: '#000000', opacity: 0.5, distance: 8, angle: 90, blur: 8,
};
export const DEFAULT_OUTER_GLOW: OuterGlowStyle = {
  enabled: true, color: '#78b4ff', opacity: 0.9, size: 16,
};

function rgba(hex: string, opacity: number): string {
  const c = parseHex(hex);
  const a = Math.max(0, Math.min(1, (c.a / 255) * opacity));
  return `rgba(${c.r}, ${c.g}, ${c.b}, ${a.toFixed(3)})`;
}

/**
 * Compile a layer's styles into a CSS `filter` string (empty when none apply).
 * Both styles map to `drop-shadow()`; the offset shadow uses distance+angle.
 */
export function layerStylesToFilter(styles: LayerStyles | undefined): string {
  if (!styles) return '';
  const parts: string[] = [];
  const ds = styles.dropShadow;
  if (ds?.enabled && (ds.blur > 0 || ds.distance > 0)) {
    const rad = (ds.angle * Math.PI) / 180;
    const dx = Math.round(ds.distance * Math.cos(rad) * 100) / 100;
    const dy = Math.round(ds.distance * Math.sin(rad) * 100) / 100;
    parts.push(`drop-shadow(${dx}px ${dy}px ${Math.max(0, ds.blur)}px ${rgba(ds.color, ds.opacity)})`);
  }
  const og = styles.outerGlow;
  if (og?.enabled && og.size > 0) {
    // A double pass reads as a fuller glow than a single soft shadow.
    parts.push(`drop-shadow(0 0 ${og.size}px ${rgba(og.color, og.opacity)})`);
    parts.push(`drop-shadow(0 0 ${Math.round(og.size / 2)}px ${rgba(og.color, og.opacity)})`);
  }
  return parts.join(' ');
}

// ── Read / write on the scene graph ──────────────────────────────────

export function readNodeLayerStyles(node: SceneNode): LayerStyles | undefined {
  const fx = node.components.find((c) => c.type === 'fx');
  const s = fx?.props.layerStyles as LayerStyles | undefined;
  if (!s || typeof s !== 'object') return undefined;
  const has = (s.dropShadow?.enabled) || (s.outerGlow?.enabled);
  return has ? s : undefined;
}

export function getNodeLayerStyles(nodeId: string): LayerStyles {
  const node = defaultSceneGraph.getNode(nodeId);
  const fx = node?.components.find((c) => c.type === 'fx');
  return (fx?.props.layerStyles as LayerStyles | undefined) ?? {};
}

function write(nodeId: string, styles: LayerStyles): void {
  const empty = !styles.dropShadow && !styles.outerGlow;
  defaultSceneGraph.setLayerStyles(nodeId, empty ? undefined : styles);
  getEventBus().emit('AnimationChanged', { nodeId });
}

/** Toggle a style on/off (creating it with defaults when first enabled). */
export function toggleDropShadow(nodeId: string): void {
  const cur = getNodeLayerStyles(nodeId);
  const next = cur.dropShadow
    ? { ...cur, dropShadow: undefined }
    : { ...cur, dropShadow: { ...DEFAULT_DROP_SHADOW } };
  write(nodeId, next);
}
export function toggleOuterGlow(nodeId: string): void {
  const cur = getNodeLayerStyles(nodeId);
  const next = cur.outerGlow
    ? { ...cur, outerGlow: undefined }
    : { ...cur, outerGlow: { ...DEFAULT_OUTER_GLOW } };
  write(nodeId, next);
}

export function updateDropShadow(nodeId: string, patch: Partial<DropShadowStyle>): void {
  const cur = getNodeLayerStyles(nodeId);
  write(nodeId, { ...cur, dropShadow: { ...DEFAULT_DROP_SHADOW, ...cur.dropShadow, ...patch } });
}
export function updateOuterGlow(nodeId: string, patch: Partial<OuterGlowStyle>): void {
  const cur = getNodeLayerStyles(nodeId);
  write(nodeId, { ...cur, outerGlow: { ...DEFAULT_OUTER_GLOW, ...cur.outerGlow, ...patch } });
}
