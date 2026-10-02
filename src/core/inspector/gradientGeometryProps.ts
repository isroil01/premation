/**
 * Gradient GEOMETRY as flat numeric properties.
 *
 * `fillAngle` / `fillCenterX|Y` / `fillRadius` (a layer's gradient fill, text
 * included) and `strokeAngle` / `strokeCenterX|Y` / `strokeRadius` (a text
 * layer's stroke gradient) are keyframeable scalars, but their static values
 * live INSIDE a paint object — which the property seam's flat component scan
 * cannot see. This is the static read and write for them, so a timeline row
 * for a keyframed gradient angle has a value to show and scrub, and a text
 * layer lists its gradient geometry among its rows.
 *
 * The keyframed values reach the renderer through `applyGradientTracks`
 * (`core/paint/gradientPaintTracks.ts`), which uses the same names.
 */

import type { SceneNode } from '@core/types';
import defaultSceneGraph from '@core/scene/DefaultSceneGraph';
import { readNodeFill, setNodeFill, type LinearFill, type RadialFill } from '@core/paint/fill';
import { readTextStrokePaint } from '@core/text/textExtras';
import {
  FILL_GRADIENT_TRACKS,
  TEXT_STROKE_GRADIENT_TRACKS,
  type GradientTrackNames,
} from '@core/paint/gradientPaintTracks';
import { updateNodeComponentProp } from './InspectorAPI';

type GradientPaint = LinearFill | RadialFill;
type Field = 'angle' | 'cx' | 'cy' | 'radius';

interface Channel {
  names: GradientTrackNames;
  read: (node: SceneNode) => GradientPaint | undefined;
  write: (nodeId: string, node: SceneNode, paint: GradientPaint) => boolean;
}

const textComponent = (node: SceneNode) => node.components.find((c) => c.type === 'Text');

const CHANNELS: ReadonlyArray<Channel> = [
  {
    names: FILL_GRADIENT_TRACKS,
    read: (node) => {
      const f = readNodeFill(node);
      return f && (f.type === 'linear' || f.type === 'radial') ? f : undefined;
    },
    write: (nodeId, _node, paint) => {
      setNodeFill(nodeId, paint);
      return true;
    },
  },
  {
    names: TEXT_STROKE_GRADIENT_TRACKS,
    read: (node) => readTextStrokePaint(node),
    write: (nodeId, node, paint) => {
      const tc = textComponent(node);
      if (!tc) return false;
      updateNodeComponentProp(defaultSceneGraph, nodeId, tc.id, 'strokePaint', paint);
      return true;
    },
  },
];

function locate(prop: string): { channel: Channel; field: Field } | null {
  for (const channel of CHANNELS) {
    const n = channel.names;
    if (prop === n.angle) return { channel, field: 'angle' };
    if (prop === n.centerX) return { channel, field: 'cx' };
    if (prop === n.centerY) return { channel, field: 'cy' };
    if (prop === n.radius) return { channel, field: 'radius' };
  }
  return null;
}

/** The fields a paint of this type actually has. */
const fieldsOf = (paint: GradientPaint): ReadonlyArray<Field> =>
  paint.type === 'linear' ? ['angle'] : ['cx', 'cy', 'radius'];

export function isGradientGeometryProp(prop: string): boolean {
  return locate(prop) !== null;
}

/** The static value, or undefined when the layer has no such gradient (or the type lacks the field). */
export function readGradientGeometryProp(node: SceneNode, prop: string): number | undefined {
  const at = locate(prop);
  const paint = at ? at.channel.read(node) : undefined;
  if (!at || !paint || !fieldsOf(paint).includes(at.field)) return undefined;
  return (paint as unknown as Record<Field, number>)[at.field];
}

export function writeGradientGeometryProp(nodeId: string, node: SceneNode, prop: string, value: number): boolean {
  const at = locate(prop);
  const paint = at ? at.channel.read(node) : undefined;
  if (!at || !paint || !fieldsOf(paint).includes(at.field) || !Number.isFinite(value)) return false;
  // The renderer floors the radius at 0.01; store what it will draw.
  const v = at.field === 'radius' ? Math.max(0.01, value) : value;
  return at.channel.write(nodeId, node, { ...paint, [at.field]: v } as GradientPaint);
}

/**
 * A TEXT layer's gradient geometry rows, in the order the paint panel shows
 * them: the fill gradient's, then the stroke gradient's. Shape layers are left
 * to the rows they already had.
 */
export function gradientGeometryPropsFor(node: SceneNode): string[] {
  if (!textComponent(node)) return [];
  const out: string[] = [];
  for (const channel of CHANNELS) {
    const paint = channel.read(node);
    if (!paint) continue;
    const n = channel.names;
    if (paint.type === 'linear') out.push(n.angle);
    else out.push(n.centerX, n.centerY, n.radius);
  }
  return out;
}
