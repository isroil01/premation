/**
 * InputSystem — normalizes and tracks raw device input, turning a stream of
 * pointer events into higher-level interactions (press, drag-with-threshold,
 * click, release) that tools consume. Framework-independent: a host feeds it via
 * the `feed*` methods; nothing here touches the DOM.
 *
 * Drag detection uses a small pixel threshold so a click with a tiny jitter is
 * not misread as a drag — the same feel as After Effects/Figma.
 */

import type { Vec2 } from '../math/Vec2';
import * as V from '../math/Vec2';
import type { PointerInput, WheelInput, KeyInput } from './events';

/** Drag context handed to tools while a pointer is held and moving. */
export interface DragContext {
  /** Screen-space position where the press started. */
  start: Vec2;
  /** Current screen-space position. */
  current: Vec2;
  /** Delta since the last move. */
  delta: Vec2;
  /** Delta since the press started. */
  total: Vec2;
  pointer: PointerInput;
}

/**
 * The sink tools/Workspace implement. All positions are screen-space; the
 * receiver projects to world as needed.
 */
export interface InputSink {
  onPointerDown(e: PointerInput): void;
  onPointerMove(e: PointerInput): void;
  onDragStart(ctx: DragContext): void;
  onDrag(ctx: DragContext): void;
  onDragEnd(ctx: DragContext): void;
  onPointerUp(e: PointerInput): void;
  onClick(e: PointerInput): void;
  onDoubleClick(e: PointerInput): void;
  onWheel(e: WheelInput): void;
  onKeyDown(e: KeyInput): void;
  onKeyUp(e: KeyInput): void;
}

export interface InputSystemOptions {
  /** Screen-pixel movement before a press becomes a drag. */
  dragThreshold?: number;
  /** Max ms + px between two clicks to count as a double-click. */
  doubleClickMs?: number;
  doubleClickPx?: number;
}

export class InputSystem {
  private sink: InputSink | null = null;
  private readonly dragThreshold: number;
  private readonly doubleClickMs: number;
  private readonly doubleClickPx: number;

  private down: PointerInput | null = null;
  private last: Vec2 | null = null;
  private dragging = false;
  private pressedKeys = new Set<string>();

  private lastClickTime = 0;
  private lastClickPos: Vec2 | null = null;

  constructor(opts: InputSystemOptions = {}) {
    this.dragThreshold = opts.dragThreshold ?? 3;
    this.doubleClickMs = opts.doubleClickMs ?? 300;
    this.doubleClickPx = opts.doubleClickPx ?? 4;
  }

  connect(sink: InputSink): void {
    this.sink = sink;
  }

  /** Keys currently held (by `KeyboardEvent.code`). */
  isKeyDown(code: string): boolean {
    return this.pressedKeys.has(code);
  }

  get isDragging(): boolean {
    return this.dragging;
  }

  // ── Feed methods (called by the host adapter) ────────────────────
  feedPointerDown(e: PointerInput): void {
    this.down = e;
    this.last = e.position;
    this.dragging = false;
    this.sink?.onPointerDown(e);
  }

  feedPointerMove(e: PointerInput): void {
    this.sink?.onPointerMove(e);
    if (!this.down || !this.last) return;
    const total = V.sub(e.position, this.down.position);
    if (!this.dragging && V.length(total) >= this.dragThreshold) {
      this.dragging = true;
      this.sink?.onDragStart(this.makeCtx(e, e.position));
    }
    if (this.dragging) {
      this.sink?.onDrag(this.makeCtx(e, e.position));
    }
    this.last = e.position;
  }

  feedPointerUp(e: PointerInput): void {
    if (this.dragging && this.down) {
      this.sink?.onDragEnd(this.makeCtx(e, e.position));
    } else if (this.down) {
      this.emitClick(e);
    }
    this.sink?.onPointerUp(e);
    this.down = null;
    this.last = null;
    this.dragging = false;
  }

  /** Pointer left the surface / capture lost — cancel any in-flight drag. */
  feedPointerCancel(e: PointerInput): void {
    if (this.dragging && this.down) {
      this.sink?.onDragEnd(this.makeCtx(e, e.position));
    }
    this.sink?.onPointerUp(e);
    this.down = null;
    this.last = null;
    this.dragging = false;
  }

  feedWheel(e: WheelInput): void {
    this.sink?.onWheel(e);
  }

  feedKeyDown(e: KeyInput): void {
    this.pressedKeys.add(e.code);
    this.sink?.onKeyDown(e);
  }

  feedKeyUp(e: KeyInput): void {
    this.pressedKeys.delete(e.code);
    this.sink?.onKeyUp(e);
  }

  /** Clear held-key/pointer state (e.g. on blur). */
  reset(): void {
    this.down = null;
    this.last = null;
    this.dragging = false;
    this.pressedKeys.clear();
  }

  /** Cancel through the normal end path so tools can clear drag state. */
  cancel(): void {
    if (this.down) {
      this.feedPointerCancel({
        ...this.down,
        position: this.last ?? this.down.position,
        buttons: { left: false, middle: false, right: false },
      });
    }
    this.pressedKeys.clear();
  }

  private emitClick(e: PointerInput): void {
    const isDouble =
      this.lastClickPos !== null &&
      e.time - this.lastClickTime <= this.doubleClickMs &&
      V.distance(e.position, this.lastClickPos) <= this.doubleClickPx;
    this.sink?.onClick(e);
    if (isDouble) {
      this.sink?.onDoubleClick(e);
      this.lastClickTime = 0;
      this.lastClickPos = null;
    } else {
      this.lastClickTime = e.time;
      this.lastClickPos = e.position;
    }
  }

  private makeCtx(e: PointerInput, current: Vec2): DragContext {
    const start = this.down!.position;
    const delta = this.last ? V.sub(current, this.last) : { x: 0, y: 0 };
    return { start, current, delta, total: V.sub(current, start), pointer: e };
  }
}
