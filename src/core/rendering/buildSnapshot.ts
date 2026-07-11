/**
 * SnapshotBuilder — projects (SceneGraph + animated values @ time) into an
 * immutable RenderSnapshot (TAD §6.4.3). Pure: reads only, mutates nothing.
 */

import type SceneGraph from '@core/scene/SceneGraph';
import type { SceneNode } from '@core/types';
import { flattenScene, readNodeKind, KIND_FILL } from '@core/scene/sceneDerive';
import { readNodeEffects, effectsToFilter } from '@core/effects/effects';
import { readNodeBlend } from '@core/effects/blendMode';
import { readNodeMask } from '@core/effects/mask';
import type { AnimationEngine } from '@motion/animation';
import type { RenderSnapshot, RenderLayer, LayerKind } from './RenderBackend';

const COMP_WIDTH = 1920;
const COMP_HEIGHT = 1080;
const COMP_BG = '#101014';

function num(v: unknown): number | undefined {
  return typeof v === 'number' ? v : undefined;
}

/** Read base (authoring) props off a node's components. */
function readBase(node: SceneNode): {
  x: number; y: number; rotation: number; opacity: number;
  scaleX: number; scaleY: number;
  fill?: string; text?: string; fontSize: number;
} {
  let x: number | undefined;
  let y: number | undefined;
  let rotation: number | undefined;
  let opacity = 100;
  let scaleX: number | undefined;
  let scaleY: number | undefined;
  let scale: number | undefined;
  let fill: string | undefined;
  let text: string | undefined;
  let fontSize = 48;
  for (const c of node.components) {
    const p = c.props as Record<string, unknown>;
    x = num(p.x) ?? x;
    y = num(p.y) ?? y;
    rotation = num(p.rotation) ?? rotation;
    opacity = num(p.opacity) ?? opacity;
    scaleX = num(p.scaleX) ?? scaleX;
    scaleY = num(p.scaleY) ?? scaleY;
    scale = num(p.scale) ?? scale;
    fontSize = num(p.fontSize) ?? fontSize;
    if (typeof p.fill === 'string') fill = p.fill;
    if (typeof p.content === 'string') text = p.content;
  }
  return {
    x: x ?? node.transform.position.x,
    y: y ?? node.transform.position.y,
    rotation: rotation ?? node.transform.rotation,
    opacity: opacity / 100,
    scaleX: scaleX ?? scale ?? 1,
    scaleY: scaleY ?? scale ?? 1,
    fill,
    text,
    fontSize,
  };
}

/** Fixed on-canvas size per layer kind (comp px). Shared with the Workspace
 *  interaction engine so hit-testing/selection overlays match what's drawn. */
export const SIZE: Record<LayerKind, { w: number; h: number }> = {
  shape: { w: 220, h: 220 },
  text: { w: 320, h: 80 },
  image: { w: 280, h: 180 },
  video: { w: 480, h: 270 },
};

/** Opacity multiplier applied to layers that are ghosted in Focus Mode. */
const GHOST_OPACITY = 0.12;

export interface SnapshotFocus {
  /** Returns true when a node should render as a dim ghost reference. */
  isGhost: (nodeId: string) => boolean;
}

export function buildSnapshot(
  graph: SceneGraph,
  anim: AnimationEngine,
  t: number,
  focus?: SnapshotFocus,
  overlays?: import('./RenderBackend').RenderOverlays,
  view?: import('./RenderBackend').RenderView,
): RenderSnapshot {
  const values = anim.evaluateScene(t);
  const layers: RenderLayer[] = [];

  // Solo (AE-style): when any node is soloed, only soloed nodes render.
  const nodes = flattenScene(graph);
  const anySolo = nodes.some((n) => n.solo === true);

  for (const node of nodes) {
    const kind = readNodeKind(node);
    if (kind === 'group') continue; // groups don't draw

    const base = readBase(node);
    const a = values.get(node.id);
    const scale = a?.get('scale');
    const scaleX = scale ?? base.scaleX;
    const scaleY = scale ?? base.scaleY;
    const layerKind = (kind === 'shape' || kind === 'text' || kind === 'image' || kind === 'video')
      ? kind
      : 'shape';
    const size = SIZE[layerKind];
    const name = (node.name ?? '').toLowerCase();
    const ghost = focus?.isGhost(node.id) ?? false;
    const baseOpacity = a?.has('opacity') ? (a.get('opacity') as number) / 100 : base.opacity;
    const filter = effectsToFilter(readNodeEffects(node)) || undefined;

    layers.push({
      id: node.id,
      kind: layerKind,
      blend: readNodeBlend(node),
      mask: readNodeMask(node),
      x: a?.get('x') ?? base.x,
      y: a?.get('y') ?? base.y,
      rotation: a?.get('rotation') ?? base.rotation,
      scaleX,
      scaleY,
      opacity: ghost ? baseOpacity * GHOST_OPACITY : baseOpacity,
      width: size.w,
      height: size.h,
      fill: base.fill ?? KIND_FILL[kind],
      visible: node.visible !== false && (!anySolo || node.solo === true),
      primitive: /circle|ellip|dot|orb/.test(name) ? 'ellipse' : 'rect',
      text: base.text,
      fontSize: base.fontSize,
      filter,
    });
  }

  return { width: COMP_WIDTH, height: COMP_HEIGHT, background: COMP_BG, layers, overlays, view };
}

export { COMP_WIDTH, COMP_HEIGHT };
