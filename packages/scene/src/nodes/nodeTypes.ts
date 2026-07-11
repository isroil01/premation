/**
 * Node types + a registry of their default component makeup. New node types
 * are added by registering their default components — no subclassing, no
 * changes to the node class. This keeps the type system open for extension.
 */

import { SceneNode, type SceneNodeOptions } from './SceneNode';
import { createComponent } from '../components/dataComponents';

export type NodeType =
  | 'root'
  | 'composition'
  | 'group'
  | 'null'
  | 'rectangle'
  | 'ellipse'
  | 'polygon'
  | 'path'
  | 'text'
  | 'image'
  | 'video'
  | 'audio'
  | 'svg'
  | 'camera'
  | 'light'
  | 'component'
  | 'particle';

/** The data components each node type is created with, by default. */
const NODE_TYPE_DEFAULTS: Record<string, string[]> = {
  root: [],
  composition: [],
  group: [],
  null: [],
  rectangle: ['fill', 'stroke'],
  ellipse: ['fill', 'stroke'],
  polygon: ['fill', 'stroke'],
  path: ['fill', 'stroke'],
  text: ['text'],
  image: ['media'],
  video: ['media'],
  audio: ['media'],
  svg: ['media'],
  camera: ['camera'],
  light: ['light'],
  component: ['effects'],
  particle: ['particle'],
};

/** Register a new node type with its default component makeup. */
export function registerNodeType(type: string, defaultComponents: string[] = []): void {
  NODE_TYPE_DEFAULTS[type] = defaultComponents;
}

export function isRegisteredNodeType(type: string): boolean {
  return type in NODE_TYPE_DEFAULTS;
}

/** Create a node of the given type with its default components attached. */
export function createNode(type: string, opts: SceneNodeOptions = {}): SceneNode {
  const node = new SceneNode(type, opts);
  const defaults = NODE_TYPE_DEFAULTS[type] ?? [];
  for (const componentType of defaults) node.addComponent(createComponent(componentType));
  return node;
}

// ── Named factory functions for the built-in node types ───────────
export const createRootNode = (o?: SceneNodeOptions): SceneNode => createNode('root', { name: 'Root', ...o });
export const createCompositionNode = (o?: SceneNodeOptions): SceneNode => createNode('composition', { name: 'Composition', ...o });
export const createGroupNode = (o?: SceneNodeOptions): SceneNode => createNode('group', { name: 'Group', ...o });
export const createNullNode = (o?: SceneNodeOptions): SceneNode => createNode('null', { name: 'Null', ...o });
export const createRectangleNode = (o?: SceneNodeOptions): SceneNode => createNode('rectangle', { name: 'Rectangle', ...o });
export const createEllipseNode = (o?: SceneNodeOptions): SceneNode => createNode('ellipse', { name: 'Ellipse', ...o });
export const createPolygonNode = (o?: SceneNodeOptions): SceneNode => createNode('polygon', { name: 'Polygon', ...o });
export const createPathNode = (o?: SceneNodeOptions): SceneNode => createNode('path', { name: 'Path', ...o });
export const createTextNode = (o?: SceneNodeOptions): SceneNode => createNode('text', { name: 'Text', ...o });
export const createImageNode = (o?: SceneNodeOptions): SceneNode => createNode('image', { name: 'Image', ...o });
export const createVideoNode = (o?: SceneNodeOptions): SceneNode => createNode('video', { name: 'Video', ...o });
export const createAudioNode = (o?: SceneNodeOptions): SceneNode => createNode('audio', { name: 'Audio', ...o });
export const createSVGNode = (o?: SceneNodeOptions): SceneNode => createNode('svg', { name: 'SVG', ...o });
export const createCameraNode = (o?: SceneNodeOptions): SceneNode => createNode('camera', { name: 'Camera', ...o });
export const createLightNode = (o?: SceneNodeOptions): SceneNode => createNode('light', { name: 'Light', ...o });
export const createComponentNode = (o?: SceneNodeOptions): SceneNode => createNode('component', { name: 'Component', ...o });
export const createParticleNode = (o?: SceneNodeOptions): SceneNode => createNode('particle', { name: 'Particles', ...o });
