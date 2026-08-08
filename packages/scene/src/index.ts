/**
 * @motion/scene — the framework-independent Scene Graph Engine.
 *
 * The heart of the editor: every object is a SceneNode inside a Scene. This is
 * the public API surface. No React, no DOM, no rendering — pure data + systems.
 */

// ── Types ─────────────────────────────────────────────────────────
export type { Vec2, Vec3, Size, Matrix2D, Matrix4, BlendMode, Metadata, Timestamp, NodeId } from './types';

// ── Math / utils ──────────────────────────────────────────────────
export * as Matrix from './utils/matrix';
export * as Matrix4Math from './utils/matrix4';
export * as Project3D from './utils/project3d';
export type { Camera3D, Projected, OrthoView, Ray3D } from './utils/project3d';
export { uuid, newNodeId } from './utils/id';
// Per-vertex path offsetting — the shared geometry half of DECISION D4, used by
// the brush ribbon today and by stroke taper / variable-width feather next.
export { offsetAlongNormals, closedRibbon, type OffsetPoint, type OffsetSides } from './utils/pathOffset';

// ── Events ────────────────────────────────────────────────────────
export { TypedEmitter, type Disposable, type Handler, type EventMap } from './events/EventEmitter';
export type { SceneEventMap, SceneEventName } from './events/SceneEvents';

// ── Components ────────────────────────────────────────────────────
export {
  type Component,
  type SerializedComponent,
  ComponentRegistry,
  componentRegistry,
  deepCloneData,
} from './components/Component';
export { TransformComponent, type TransformData } from './components/TransformComponent';
export {
  DataComponent,
  createComponent,
  customComponent,
  DATA_COMPONENT_DEFAULTS,
  Fill, Stroke, Shadow, Blur, Mask, Gradient, Text, Media, Camera, Light, Particle, Physics,
} from './components/dataComponents';

// ── Nodes ─────────────────────────────────────────────────────────
export { SceneNode, type SceneNodeOptions, type NodeChangeListener } from './nodes/SceneNode';
export {
  type NodeType,
  createNode,
  registerNodeType,
  isRegisteredNodeType,
  createRootNode,
  createCompositionNode,
  createGroupNode,
  createNullNode,
  createRectangleNode,
  createEllipseNode,
  createPolygonNode,
  createPathNode,
  createTextNode,
  createImageNode,
  createVideoNode,
  createAudioNode,
  createSVGNode,
  createCameraNode,
  createLightNode,
  createComponentNode,
  createParticleNode,
} from './nodes/nodeTypes';

// ── Core ──────────────────────────────────────────────────────────
export { Scene, type NodePredicate } from './core/Scene';
export { SelectionModel } from './core/SelectionModel';
export { sceneMutationEpoch } from './core/mutationEpoch';
export {
  SceneValidationError,
  type ValidationCode,
  wouldCreateCycle,
  collectSubtreeIds,
  auditGraph,
} from './core/Validation';

// ── Systems ───────────────────────────────────────────────────────
export { dfs, bfs, descendants, visit, countNodes, type Visitor } from './systems/traversal';
export { updateWorldTransforms, computeWorldMatrix, computeWorldMatrix4 } from './systems/TransformSystem';

// ── Interop (bridges for loose-props / id-graph consumers) ────────
export {
  type FlatBinding,
  type FlatSchema,
  DEFAULT_FLAT_SCHEMA,
  readFlat,
  writeFlat,
  listFlat,
} from './interop/flatProps';
export { GraphFacade } from './interop/GraphFacade';

// ── Serialization ─────────────────────────────────────────────────
export {
  SCENE_FORMAT_VERSION,
  type SerializedScene,
  type SerializedNode,
  type Migration,
  serializeScene,
  deserializeScene,
  serializeNode,
  deserializeNode,
  registerMigration,
  migrate,
} from './serialization/Serializer';

// ── Graft serialize/toJSON onto Scene (no import cycle) ────────
// Loading is done with the exported `deserializeScene(doc)`.
import { Scene as SceneClass } from './core/Scene';
import { serializeScene as _ser } from './serialization/Serializer';
import type { SerializedScene as _SS } from './serialization/Serializer';

declare module './core/Scene' {
  interface Scene {
    /** Serialize the whole scene to a versioned, JSON-safe document. */
    serialize(): _SS;
    /** Serialize (alias of {@link Scene.serialize}). */
    toJSON(): _SS;
  }
}

SceneClass.prototype.serialize = function serialize(this: SceneClass): _SS {
  return _ser(this);
};
SceneClass.prototype.toJSON = function toJSON(this: SceneClass): _SS {
  return _ser(this);
};
