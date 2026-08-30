/**
 * Tool system contracts. Every tool is a small, pluggable state machine that
 * receives already-projected input (screen *and* world coordinates) and acts
 * through the shared `ToolContext`. Tools never touch the DOM or the renderer;
 * they read services and submit commands/camera moves. New tools (including a
 * future AI tool) register with the `ToolManager` and need no core changes.
 */

import type { Vec2 } from '../math/Vec2';
import type { Rect } from '../math/Rect';
import type { Modifiers, PointerInput, KeyInput } from '../input/events';
import type { Camera } from '../camera/Camera';
import type { Viewport } from '../viewport/Viewport';
import type { CoordinateSystem } from '../coordinates/CoordinateSystem';
import type { SelectionController } from '../selection/SelectionController';
import type { HitTester } from '../hit/HitTester';
import type { OverlayHandle } from '../ports';
import type { CursorManager, CursorType } from '../cursor/CursorManager';
import type { SnapEngine, SnapTarget, SnapResult, SnapLine } from '../snap/SnapEngine';
import type { Grid } from '../grid/Grid';
import type { Guides } from '../guides/Guides';
import type { CommandPort, SceneGraphPort, WorkspaceCommand } from '../ports';
import type { TypedEmitter } from '../events/Emitter';
import type { WorkspaceEventMap } from '../events/WorkspaceEvents';

/** A pointer event enriched with the world-space projection. */
export interface ToolPointerEvent {
  screen: Vec2;
  world: Vec2;
  modifiers: Modifiers;
  pointer: PointerInput;
}

/** A drag event with both screen- and world-space deltas. */
export interface ToolDragEvent {
  startScreen: Vec2;
  currentScreen: Vec2;
  startWorld: Vec2;
  currentWorld: Vec2;
  /** Screen delta since last move. */
  deltaScreen: Vec2;
  /** Screen delta since press. */
  totalScreen: Vec2;
  /** World delta since last move. */
  deltaWorld: Vec2;
  /** World delta since press. */
  totalWorld: Vec2;
  modifiers: Modifiers;
  pointer: PointerInput;
}

export interface ToolWheelEvent {
  screen: Vec2;
  world: Vec2;
  deltaX: number;
  deltaY: number;
  isZoom: boolean;
  modifiers: Modifiers;
}

export type ToolKeyEvent = KeyInput;

/** Shared services a tool operates through. Provided by the Workspace. */
export interface ToolContext {
  readonly camera: Camera;
  readonly viewport: Viewport;
  readonly coordinates: CoordinateSystem;
  readonly selection: SelectionController;
  readonly hitTester: HitTester;
  readonly cursor: CursorManager;
  readonly snap: SnapEngine;
  readonly grid: Grid;
  readonly guides: Guides;
  readonly scene: SceneGraphPort;
  readonly commands: CommandPort;
  readonly events: TypedEmitter<WorkspaceEventMap>;

  /** Current selected node ids (read-only snapshot). */
  selectionIds(): readonly string[];
  /** Project a screen point to world. */
  screenToWorld(screen: Vec2): Vec2;
  /** Project a screen point to viewport-local pixels (camera anchor space). */
  screenToViewport(screen: Vec2): Vec2;
  /** Ask the renderer to repaint. */
  requestRender(): void;
  /** Publish snap-guide lines for the overlay (world space; [] to clear). */
  setSnapLines(lines: readonly SnapLine[]): void;
  /** Switch the active tool (e.g. space-bar temporary hand). */
  setTool(id: string): void;
  /** Submit a command to the app's undo/redo stack. */
  execute(command: WorkspaceCommand): void;
  /**
   * Build the snap targets (grid + guides + object edges) for a world region,
   * and the world-space threshold matching the snap engine's pixel threshold.
   */
  buildSnapTargets(region: Rect, excludeIds?: ReadonlySet<string>): { targets: SnapTarget[]; thresholdWorld: number };
  /** Convenience: run snapping on a rect using freshly-built targets. */
  snapRect(rect: Rect, excludeIds?: ReadonlySet<string>): SnapResult<Rect>;
}

/**
 * A pluggable tool. All handlers are optional; the manager only calls what a
 * tool implements. Return values are ignored — tools act through the context.
 */
export interface Tool {
  readonly id: string;
  /** Human label for palettes/menus. */
  readonly label: string;
  /** Keyboard shortcut (single key) that activates the tool, if any. */
  readonly shortcut?: string;
  /** Resting cursor while this tool is active. */
  readonly cursor: CursorType;

  activate?(ctx: ToolContext): void;
  deactivate?(ctx: ToolContext): void;
  
  /** Optional: points of a path currently being built by the tool. */
  readonly pendingPoints?: readonly Vec2[];

  /** Optional: allow the tool to yield its own overlay handles. */
  getHandles?(ctx: ToolContext): readonly OverlayHandle[];

  onPointerDown?(e: ToolPointerEvent, ctx: ToolContext): void;
  onPointerMove?(e: ToolPointerEvent, ctx: ToolContext): void;
  onPointerUp?(e: ToolPointerEvent, ctx: ToolContext): void;
  onClick?(e: ToolPointerEvent, ctx: ToolContext): void;
  onDoubleClick?(e: ToolPointerEvent, ctx: ToolContext): void;
  onDragStart?(e: ToolDragEvent, ctx: ToolContext): void;
  onDrag?(e: ToolDragEvent, ctx: ToolContext): void;
  onDragEnd?(e: ToolDragEvent, ctx: ToolContext): void;
  onWheel?(e: ToolWheelEvent, ctx: ToolContext): void;
  /**
   * Return `true` when the tool CONSUMED the key, so the host can skip its own
   * meaning for it.
   *
   * Escape is the case that forced this: the viewport's own Escape clears the
   * selection, and the pen's cancels the outline being drawn. Both are correct
   * — which one applies depends on whether a draft is in progress, and only the
   * tool knows that. `void` (every tool that predates this) reads as "not
   * handled", so the host keeps its existing behaviour untouched.
   */
  onKeyDown?(e: ToolKeyEvent, ctx: ToolContext): void | boolean;
  onKeyUp?(e: ToolKeyEvent, ctx: ToolContext): void;
}
