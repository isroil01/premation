/*
 * Core TypeScript interfaces for architecture & data models.
 * - Scene graph
 * - Timeline model
 * - Assets
 * - Engine & service contracts
 */

export type ID = string;

// Basic transform for scene nodes
export interface Transform {
  position: { x: number; y: number; z?: number };
  rotation: number; // degrees
  scale: { x: number; y: number };
  separateDimensions?: boolean;
}

// Component attached to a SceneNode (renderable, behavior, etc.)
export interface Component {
  id: ID;
  type: string;
  props: Record<string, unknown>;
}

// Scene graph node
export interface SceneNode {
  id: ID;
  name?: string;
  children: ID[];
  parent?: ID | null;
  transform: Transform;
  components: Component[];
  visible?: boolean;
  locked?: boolean;
  /** Solo — when ANY node is soloed, only soloed nodes render (AE-style). */
  solo?: boolean;
  /** Label color (AE-style) — hex tint for the layer's Scene row / timeline
   *  track & clip bar. Absent = the kind's default category color. */
  color?: string;
}

// Timeline model
export interface Marker {
  id: ID;
  time: number;
  label?: string;
}

export interface Keyframe {
  id: ID;
  nodeId: ID;
  time: number;
  value?: unknown;
}

export interface Clip {
  id: ID;
  trackId: ID;
  nodeId?: ID;
  start: number;
  duration: number;
  label?: string;
  color?: string;
}

export interface Track {
  id: ID;
  name?: string;
  kind?: string;
  color?: string;
  keyframes?: Keyframe[];
  clips?: Clip[];
}

export interface TimelineModel {
  duration: number;
  frameRate: number;
  currentTime: number;
  pixelsPerSecond?: number;
  markers?: Marker[];
  tracks?: Track[];
}

// Asset model
export interface Asset {
  id: ID;
  name: string;
  type: 'image' | 'audio' | 'video' | 'json' | string;
  src: string;
  metadata?: Record<string, unknown>;
}

// Engine lifecycle
export interface EngineContext {
  tick: (dt: number, t: number) => void;
}

export interface Engine {
  id: string;
  init?: () => Promise<void> | void;
  dispose?: () => void;
  update?: (ctx: EngineContext) => void;
}

/**
 * Anything the ProjectManager can save and load.
 *
 * The IO layer is deliberately blind to the document's shape: the scene engine
 * once registered a scene-ONLY `ProjectFile`, which is why saving a `.motion`
 * silently dropped every keyframe. The app now registers a full EditorDocument
 * instead, and this is the only thing the persistence layer needs to know.
 */
export interface VersionedDocument {
  version: string;
}

// Persistence interface
export interface ProjectFile extends VersionedDocument {
  nodes: SceneNode[];
  timeline?: TimelineModel;
  assets?: Asset[];
}
