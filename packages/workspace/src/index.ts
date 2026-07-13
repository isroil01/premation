/**
 * @motion/workspace — the framework-independent Workspace Engine.
 *
 * The interaction layer between the user and the Scene Graph: viewport, camera,
 * coordinate systems, tools, input, selection, hit-testing, grid, guides, and
 * snapping. No React, no DOM rendering, no GPU. It coordinates; it does not draw.
 *
 * Wire it to the app through the ports (SceneGraphPort, SelectionPort,
 * RendererPort, CommandPort) and drive it with normalized input.
 */

// ── Orchestrator + public API ─────────────────────────────────────
export { Workspace, type WorkspaceOptions } from './Workspace';
export type { WorkspaceState } from './state/WorkspaceState';

// ── Math ──────────────────────────────────────────────────────────
export * as Vec from './math/Vec2';
export * as Mat from './math/Mat2D';
export * as Rect from './math/Rect';
export type { Vec2 } from './math/Vec2';
export type { Mat2D } from './math/Mat2D';
export type { Rect as RectType, Size } from './math';
export type { BezierPoint } from './math/BezierPoint';
export { corner as bezierCorner, smooth as bezierSmooth } from './math/BezierPoint';

// ── Events ────────────────────────────────────────────────────────
export { TypedEmitter, type Disposable, type Handler } from './events/Emitter';
export type { WorkspaceEventMap, WorkspaceEventName } from './events/WorkspaceEvents';

// ── Ports (integration seams) ─────────────────────────────────────
export type {
  NodeId,
  WorkspaceNode,
  SceneGraphPort,
  SelectionPort,
  RendererPort,
  CommandPort,
  WorkspaceCommand,
  WorkspaceOverlay,
  OverlayHandle,
  OverlayGuide,
  SnapLine as OverlaySnapLine,
} from './ports';

// ── Viewport / camera / coordinates ───────────────────────────────
export { Viewport, type ViewportState, type ViewportOptions } from './viewport/Viewport';
export { Camera, type CameraState, type CameraOptions } from './camera/Camera';
export { CameraAnimator, easeInOutCubic, type Easing } from './camera/CameraAnimator';
export { CoordinateSystem } from './coordinates/CoordinateSystem';

// ── Grid / guides / snapping ──────────────────────────────────────
export { Grid, type GridState, type GridLines } from './grid/Grid';
export { Guides, type Guide, type GuideAxis } from './guides/Guides';
export {
  SnapEngine,
  DEFAULT_SNAP_SETTINGS,
  type SnapSettings,
  type SnapTarget,
  type SnapLine,
  type SnapResult,
  type SnapSource,
} from './snap/SnapEngine';

// ── Hit testing ───────────────────────────────────────────────────
export { HitTester, type HitOptions, type HitResult } from './hit/HitTester';
export { SpatialIndex, type SpatialItem, type SpatialIndexOptions } from './hit/SpatialIndex';

// ── Selection ─────────────────────────────────────────────────────
export { SelectionController } from './selection/SelectionController';
export { Marquee, type MarqueeMode } from './selection/Marquee';
export { computeHandles, pickHandle, handleCursor, type Handle, type HandleId } from './selection/handles';
export { resizeBounds, rotationDelta, isResizeHandle } from './selection/transform';

// ── Cursor ────────────────────────────────────────────────────────
export { CursorManager, CURSOR_CSS, type CursorType } from './cursor/CursorManager';

// ── Input ─────────────────────────────────────────────────────────
export { InputSystem, type InputSink, type DragContext, type InputSystemOptions } from './input/InputSystem';
export type {
  PointerInput,
  WheelInput,
  KeyInput,
  GestureInput,
  Modifiers,
  PointerType,
  PointerButton,
} from './input/events';
export { NO_MODIFIERS } from './input/events';
export {
  modifiersFrom,
  pointerFrom,
  wheelFrom,
  keyFrom,
  type DomPointerEventLike,
  type DomWheelEventLike,
  type DomKeyEventLike,
} from './input/normalize';

// ── Tools ─────────────────────────────────────────────────────────
export {
  ToolManager,
  SelectTool,
  DirectSelectionTool,
  MoveTool,
  HandTool,
  ZoomTool,
  RectangleTool,
  EllipseTool,
  PenTool,
  TextTool,
  CameraTool,
  createBuiltinTools,
  type Tool,
  type ToolContext,
  type ToolPointerEvent,
  type ToolDragEvent,
  type ToolWheelEvent,
  type ToolKeyEvent,
} from './tools';

// ── Commands ──────────────────────────────────────────────────────
export {
  commands,
  WorkspaceCommandType,
  type WorkspaceCommandTypeName,
  type MoveNodesPayload,
  type ResizeNodePayload,
  type RotateNodePayload,
  type CreateNodePayload,
  type DeleteNodesPayload,
  type UpdateNodePathPayload,
} from './commands/WorkspaceCommands';

// ── In-memory adapters (headless / tests) ─────────────────────────
export { MemoryScene, MemorySelection, RecordingCommandPort, type MemoryNodeInit } from './adapters/memory';
