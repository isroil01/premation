/**
 * Ports — the seams through which the Workspace Engine talks to the rest of the
 * application without depending on any concrete implementation. The workspace is
 * a *coordinator*: it never mutates the Scene Graph directly, never draws, and
 * never runs the command stack itself. It calls these interfaces instead.
 *
 * A thin binding layer (e.g. over `@motion/scene`) implements them; tests supply
 * trivial in-memory fakes. This is what keeps the engine framework-independent
 * and unit-testable in a Node environment.
 */

import type { Vec2 } from '../math/Vec2';
import type { Mat2D } from '../math/Mat2D';
import type { Rect } from '../math/Rect';
import type { BezierPoint } from '../math/BezierPoint';

/** Opaque node identifier — a string id owned by the Scene Graph. */
export type NodeId = string;

/**
 * Read-only view of a Scene Graph node the workspace needs for hit-testing,
 * selection overlays, and snapping. The workspace treats nodes as data; the
 * binding decides how to derive these from the real graph.
 */
/** One editable mask outline on a layer. */
export interface WorkspaceMaskPath {
  readonly id: string;
  readonly points: readonly BezierPoint[];
}

export interface WorkspaceNode {
  readonly id: NodeId;
  /** Parent id, or null for a top-level node. */
  readonly parentId: NodeId | null;
  /** World-space axis-aligned bounding box (already transformed). */
  readonly worldBounds: Rect;
  /** Local → world matrix (for precise/local-space hit tests). */
  readonly worldMatrix: Mat2D;
  /** Untransformed local bounds (origin + size in the node's own space). */
  readonly localBounds: Rect;
  readonly visible: boolean;
  readonly locked: boolean;
  /** Higher renders on top; used to resolve overlapping hits. */
  readonly zIndex: number;
  /** Optional precise hit test in the node's *local* space (path/shape/mask). */
  readonly hitTestLocal?: (localPoint: Vec2) => boolean;
  /** Bezier path points in LOCAL space (only for shapes with custom paths). */
  readonly pathPoints?: readonly BezierPoint[];
  /**
   * The layer's mask outlines in LOCAL space, if any.
   *
   * Masks are bezier paths like `pathPoints`, but they live beside the layer's
   * geometry rather than replacing it — a text or image layer has masks and no
   * path points. Exposing them here is what lets the Direct Selection tool edit
   * a mask's shape at all; without it a mask was frozen the moment it was drawn.
   */
  readonly maskPaths?: readonly WorkspaceMaskPath[];
  /**
   * The pivot rotation and scale happen around, in LOCAL space (0,0 = centre).
   * Absent = centred. `worldMatrix` already folds it in, so the anchor's world
   * position is `Mat.apply(worldMatrix, anchor)`.
   */
  readonly anchor?: Vec2;
}

/**
 * The Scene Graph, as the workspace sees it. Enumeration is expected to be cheap
 * or cached by the binding; the workspace rebuilds its spatial index from these.
 */
export interface SceneGraphPort {
  /** All nodes eligible for interaction, in any order. */
  getNodes(): Iterable<WorkspaceNode>;
  getNode(id: NodeId): WorkspaceNode | undefined;
  /** Subscribe to structural/transform changes so the index can be rebuilt. */
  onChanged(listener: () => void): () => void;
}

/**
 * The Selection Engine. The workspace drives it in response to input but does
 * not own selection truth — the app does, so undo/redo and scripting stay
 * consistent.
 */
export interface SelectionPort {
  get(): readonly NodeId[];
  has(id: NodeId): boolean;
  set(ids: Iterable<NodeId>): void;
  add(id: NodeId): void;
  remove(id: NodeId): void;
  toggle(id: NodeId): void;
  clear(): void;
  onChanged(listener: (selected: readonly NodeId[]) => void): () => void;
}

/**
 * The Renderer, told only *what* to redraw and never *how* the user interacts.
 * The workspace pushes an overlay description (selection, marquee, guides, snap
 * lines) and marks dirty regions; the renderer schedules the frame.
 */
export interface RendererPort {
  /** Request a redraw of the given screen-space region (or the whole viewport). */
  markDirty(region?: Rect): void;
  /** Hand the renderer the current interaction overlay to composite on top. */
  setOverlay?(overlay: WorkspaceOverlay): void;
}

/** Everything the workspace wants painted above the scene, in screen pixels. */
export interface WorkspaceOverlay {
  selectionBounds: Rect | null;
  handles: readonly OverlayHandle[];
  marquee: Rect | null;
  snapLines: readonly SnapLine[];
  guides: readonly OverlayGuide[];
  hoveredBounds: Rect | null;
  /** Bezier path currently being drawn by a tool (e.g. PenTool). Screen-space. */
  pendingPath?: readonly BezierPoint[];
}

export interface OverlayHandle {
  id: string;
  position: Vec2;
  /** 'resize' | 'rotate' = bounding box handle, 'point' = vertex, 'tangent-in' | 'tangent-out' = bezier handle, 'anchor' = pan-behind pivot */
  kind: 'resize' | 'rotate' | 'point' | 'tangent-in' | 'tangent-out' | 'anchor';
}

export interface OverlayGuide {
  axis: 'x' | 'y';
  /** Screen-pixel position along the perpendicular axis. */
  position: number;
  locked: boolean;
}

export interface SnapLine {
  axis: 'x' | 'y';
  /** Screen-pixel position along the perpendicular axis. */
  position: number;
  from: number;
  to: number;
}

/**
 * The Command System. Interaction results (a move, a resize, a created shape)
 * are expressed as commands so the app owns undo/redo. The workspace only
 * *submits*; it does not maintain the history.
 */
export interface CommandPort {
  execute(command: WorkspaceCommand): void;
}

export interface WorkspaceCommand {
  readonly type: string;
  readonly payload: unknown;
}
