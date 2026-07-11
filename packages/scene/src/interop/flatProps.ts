/**
 * Flat-property projection — an interop bridge for consumers that address a
 * node's animatable values by a FLAT name (e.g. "x", "rotation", "opacity",
 * "fill") rather than by typed component. Common in timeline/animation engines
 * and older loose-`props` models. A schema maps each flat key to a node field,
 * a transform part, or a data component key, so those consumers can read/write
 * without knowing the typed component layout.
 *
 * Generic (no app coupling): supply your own schema, or extend the default.
 */

import type { SceneNode } from '../nodes/SceneNode';
import type { TransformComponent } from '../components/TransformComponent';
import type { DataComponent } from '../components/dataComponents';
import { createComponent } from '../components/dataComponents';

export type FlatBinding =
  | { kind: 'node'; prop: 'opacity' | 'name' }
  | { kind: 'transform'; path: 'position.x' | 'position.y' | 'rotation' | 'scale.x' | 'scale.y' | 'skew.x' | 'skew.y' }
  | { kind: 'component'; type: string; key: string };

export type FlatSchema = Record<string, FlatBinding>;

/** A sensible default covering transform + common style/text keys. */
export const DEFAULT_FLAT_SCHEMA: FlatSchema = {
  x: { kind: 'transform', path: 'position.x' },
  y: { kind: 'transform', path: 'position.y' },
  rotation: { kind: 'transform', path: 'rotation' },
  scaleX: { kind: 'transform', path: 'scale.x' },
  scaleY: { kind: 'transform', path: 'scale.y' },
  skewX: { kind: 'transform', path: 'skew.x' },
  skewY: { kind: 'transform', path: 'skew.y' },
  opacity: { kind: 'node', prop: 'opacity' },
  fill: { kind: 'component', type: 'fill', key: 'color' },
  content: { kind: 'component', type: 'text', key: 'content' },
  fontSize: { kind: 'component', type: 'text', key: 'fontSize' },
};

function readTransform(t: TransformComponent, path: string): number {
  switch (path) {
    case 'position.x': return t.position.x;
    case 'position.y': return t.position.y;
    case 'rotation': return t.rotation;
    case 'scale.x': return t.scale.x;
    case 'scale.y': return t.scale.y;
    case 'skew.x': return t.skew.x;
    case 'skew.y': return t.skew.y;
    default: return 0;
  }
}

function writeTransform(t: TransformComponent, path: string, v: number): void {
  switch (path) {
    case 'position.x': t.setPosition(v, t.position.y); break;
    case 'position.y': t.setPosition(t.position.x, v); break;
    case 'rotation': t.setRotation(v); break;
    case 'scale.x': t.setScale(v, t.scale.y); break;
    case 'scale.y': t.setScale(t.scale.x, v); break;
    case 'skew.x': t.setSkew(v, t.skew.y); break;
    case 'skew.y': t.setSkew(t.skew.x, v); break;
  }
}

/** Read a flat property value from a node, or undefined if unbound/absent. */
export function readFlat(node: SceneNode, key: string, schema: FlatSchema = DEFAULT_FLAT_SCHEMA): unknown {
  const b = schema[key];
  if (!b) return undefined;
  if (b.kind === 'node') return b.prop === 'opacity' ? node.opacity : node.name;
  if (b.kind === 'transform') return readTransform(node.transform, b.path);
  const c = node.getComponent<DataComponent>(b.type);
  return c ? c.data[b.key] : undefined;
}

/** Write a flat property value to a node (creating the component if needed). */
export function writeFlat(node: SceneNode, key: string, value: unknown, schema: FlatSchema = DEFAULT_FLAT_SCHEMA): boolean {
  const b = schema[key];
  if (!b) return false;
  if (b.kind === 'node') {
    if (b.prop === 'opacity') node.opacity = Number(value);
    else node.name = String(value);
    return true;
  }
  if (b.kind === 'transform') {
    writeTransform(node.transform, b.path, Number(value));
    node.touch(`flat:${key}`);
    return true;
  }
  let c = node.getComponent<DataComponent>(b.type);
  if (!c) { c = createComponent(b.type); node.addComponent(c); }
  c.set(b.key, value);
  node.touch(`flat:${key}`);
  return true;
}

/** All flat keys that currently resolve to a value on the node. */
export function listFlat(node: SceneNode, schema: FlatSchema = DEFAULT_FLAT_SCHEMA): string[] {
  return Object.keys(schema).filter((k) => readFlat(node, k, schema) !== undefined);
}
