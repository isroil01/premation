/**
 * ToolManager — the registry + router for tools. It implements the InputSink,
 * translating screen-space input into world-projected `ToolPointerEvent`/
 * `ToolDragEvent` and dispatching to the active tool. Also handles
 * shortcut-based activation and a "temporary tool" stack (hold Space → hand,
 * release → previous tool).
 */

import type { Vec2 } from '../math/Vec2';
import type { InputSink, DragContext } from '../input/InputSystem';
import type { PointerInput, WheelInput, KeyInput } from '../input/events';
import type { TypedEmitter } from '../events/Emitter';
import type { WorkspaceEventMap } from '../events/WorkspaceEvents';
import type { Tool, ToolContext, ToolPointerEvent, ToolDragEvent } from './Tool';

export class ToolManager implements InputSink {
  private readonly tools = new Map<string, Tool>();
  private active: Tool | null = null;
  private temporaryFrom: string | null = null;

  constructor(
    private readonly ctx: ToolContext,
    private readonly events: TypedEmitter<WorkspaceEventMap>,
  ) {}

  register(tool: Tool): void {
    this.tools.set(tool.id, tool);
  }

  registerMany(tools: readonly Tool[]): void {
    for (const t of tools) this.register(t);
  }

  unregister(id: string): void {
    if (this.active?.id === id) this.active = null;
    this.tools.delete(id);
  }

  get(id: string): Tool | undefined {
    return this.tools.get(id);
  }

  list(): Tool[] {
    return [...this.tools.values()];
  }

  get activeTool(): Tool | null {
    return this.active;
  }

  get activeToolId(): string | null {
    return this.active?.id ?? null;
  }

  /** Activate a tool by id. No-op if unknown or already active. */
  setActive(id: string): boolean {
    const tool = this.tools.get(id);
    if (!tool || tool === this.active) return false;
    const previous = this.active?.id ?? null;
    this.active?.deactivate?.(this.ctx);
    this.active = tool;
    tool.activate?.(this.ctx);
    this.ctx.cursor.setBase(tool.cursor);
    this.events.emit('ToolChanged', { tool: id, previous });
    return true;
  }

  /** Temporarily switch to a tool, remembering the current one to restore. */
  pushTemporary(id: string): void {
    if (this.temporaryFrom !== null) return; // already in a temporary tool
    const from = this.active?.id ?? null;
    if (this.setActive(id)) this.temporaryFrom = from;
  }

  /** Restore the tool active before `pushTemporary`. */
  popTemporary(): void {
    if (this.temporaryFrom === null) return;
    const restore = this.temporaryFrom;
    this.temporaryFrom = null;
    if (restore) this.setActive(restore);
  }

  /** Try to activate a tool by its keyboard shortcut. Returns true if matched. */
  activateByShortcut(key: string): boolean {
    for (const tool of this.tools.values()) {
      if (tool.shortcut && tool.shortcut.toLowerCase() === key.toLowerCase()) {
        return this.setActive(tool.id);
      }
    }
    return false;
  }

  // ── InputSink implementation ─────────────────────────────────────
  onPointerDown(e: PointerInput): void {
    this.active?.onPointerDown?.(this.toPointer(e), this.ctx);
  }

  onPointerMove(e: PointerInput): void {
    this.active?.onPointerMove?.(this.toPointer(e), this.ctx);
  }

  onPointerUp(e: PointerInput): void {
    this.active?.onPointerUp?.(this.toPointer(e), this.ctx);
  }

  onClick(e: PointerInput): void {
    this.active?.onClick?.(this.toPointer(e), this.ctx);
  }

  onDoubleClick(e: PointerInput): void {
    this.active?.onDoubleClick?.(this.toPointer(e), this.ctx);
  }

  onDragStart(c: DragContext): void {
    this.events.emit('InteractionStarted', { tool: this.active?.id ?? '' });
    this.active?.onDragStart?.(this.toDrag(c), this.ctx);
  }

  onDrag(c: DragContext): void {
    this.active?.onDrag?.(this.toDrag(c), this.ctx);
  }

  onDragEnd(c: DragContext): void {
    this.active?.onDragEnd?.(this.toDrag(c), this.ctx);
    this.events.emit('InteractionEnded', { tool: this.active?.id ?? '' });
  }

  onWheel(e: WheelInput): void {
    const screen = e.position;
    if (this.active?.onWheel) {
      this.active.onWheel(
        {
          screen,
          world: this.ctx.screenToWorld(screen),
          deltaX: e.deltaX,
          deltaY: e.deltaY,
          isZoom: e.isZoom,
          modifiers: e.modifiers,
        },
        this.ctx,
      );
      return;
    }
    this.defaultWheelNav(e);
  }

  /**
   * Standard viewport navigation when the active tool doesn't consume the wheel:
   * ctrl / pinch → zoom to cursor; otherwise scroll-pan. Matches Figma/AE feel.
   */
  private defaultWheelNav(e: WheelInput): void {
    const anchor = this.ctx.screenToViewport(e.position);
    if (e.isZoom || e.modifiers.ctrl || e.modifiers.meta) {
      const factor = Math.exp(-e.deltaY * 0.0015);
      this.ctx.camera.zoomToCursor(factor, anchor);
    } else {
      this.ctx.camera.panByScreen(-e.deltaX, -e.deltaY);
    }
    this.ctx.requestRender();
  }

  onKeyDown(e: KeyInput): void {
    this.active?.onKeyDown?.(e, this.ctx);
  }

  onKeyUp(e: KeyInput): void {
    this.active?.onKeyUp?.(e, this.ctx);
  }

  private toPointer(e: PointerInput): ToolPointerEvent {
    return {
      screen: e.position,
      world: this.ctx.screenToWorld(e.position),
      modifiers: e.modifiers,
      pointer: e,
    };
  }

  private toDrag(c: DragContext): ToolDragEvent {
    const startWorld = this.ctx.screenToWorld(c.start);
    const currentWorld = this.ctx.screenToWorld(c.current);
    const prevScreen: Vec2 = { x: c.current.x - c.delta.x, y: c.current.y - c.delta.y };
    const prevWorld = this.ctx.screenToWorld(prevScreen);
    return {
      startScreen: c.start,
      currentScreen: c.current,
      startWorld,
      currentWorld,
      deltaScreen: { ...c.delta },
      totalScreen: { x: c.current.x - c.start.x, y: c.current.y - c.start.y },
      deltaWorld: { x: currentWorld.x - prevWorld.x, y: currentWorld.y - prevWorld.y },
      totalWorld: { x: currentWorld.x - startWorld.x, y: currentWorld.y - startWorld.y },
      modifiers: c.pointer.modifiers,
      pointer: c.pointer,
    };
  }
}
