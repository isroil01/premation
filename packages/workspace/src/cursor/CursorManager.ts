/**
 * CursorManager — the single source of truth for the current cursor. Tools
 * request a base cursor; transient interactions (hovering a resize handle,
 * space-to-pan) push overrides that pop when released. Emits a change event with
 * a CSS-compatible cursor string the host applies to its canvas element.
 */

import { TypedEmitter } from '../events/Emitter';

export type CursorType =
  | 'default'
  | 'move'
  | 'rotate'
  | 'resize-n'
  | 'resize-s'
  | 'resize-e'
  | 'resize-w'
  | 'resize-ne'
  | 'resize-nw'
  | 'resize-se'
  | 'resize-sw'
  | 'crosshair'
  | 'grab'
  | 'grabbing'
  | 'text'
  | 'pen'
  | 'eyedropper'
  | 'zoom-in'
  | 'zoom-out'
  | 'not-allowed'
  | 'none';

/** Maps semantic cursor types to CSS cursor values. */
export const CURSOR_CSS: Record<CursorType, string> = {
  default: 'default',
  move: 'move',
  rotate: 'grab', // hosts usually swap in a custom rotate glyph
  'resize-n': 'ns-resize',
  'resize-s': 'ns-resize',
  'resize-e': 'ew-resize',
  'resize-w': 'ew-resize',
  'resize-ne': 'nesw-resize',
  'resize-nw': 'nwse-resize',
  'resize-se': 'nwse-resize',
  'resize-sw': 'nesw-resize',
  crosshair: 'crosshair',
  grab: 'grab',
  grabbing: 'grabbing',
  text: 'text',
  pen: 'crosshair',
  eyedropper: 'crosshair',
  'zoom-in': 'zoom-in',
  'zoom-out': 'zoom-out',
  'not-allowed': 'not-allowed',
  none: 'none',
};

interface CursorEvents {
  changed: { cursor: CursorType; css: string };
}

export class CursorManager {
  readonly events = new TypedEmitter<CursorEvents>();
  private base: CursorType = 'default';
  private overrides: CursorType[] = [];
  private customCss = new Map<CursorType, string>();

  /** The cursor the host should display right now. */
  get current(): CursorType {
    return this.overrides.length > 0 ? this.overrides[this.overrides.length - 1]! : this.base;
  }

  get css(): string {
    return this.cssFor(this.current);
  }

  /** Set the tool's resting cursor. */
  setBase(cursor: CursorType): void {
    if (this.base === cursor) return;
    const before = this.current;
    this.base = cursor;
    if (this.current !== before) this.emit();
  }

  /** Push a transient override (returns a disposer that pops it). */
  pushOverride(cursor: CursorType): () => void {
    const before = this.current;
    this.overrides.push(cursor);
    if (this.current !== before) this.emit();
    let popped = false;
    return () => {
      if (popped) return;
      popped = true;
      const idx = this.overrides.lastIndexOf(cursor);
      if (idx !== -1) this.overrides.splice(idx, 1);
      this.emit();
    };
  }

  clearOverrides(): void {
    if (this.overrides.length === 0) return;
    this.overrides = [];
    this.emit();
  }

  /** Register a custom CSS string (e.g. a data-URI) for a cursor type. */
  registerCustom(cursor: CursorType, css: string): void {
    this.customCss.set(cursor, css);
    if (this.current === cursor) this.emit();
  }

  private cssFor(cursor: CursorType): string {
    return this.customCss.get(cursor) ?? CURSOR_CSS[cursor];
  }

  private emit(): void {
    this.events.emit('changed', { cursor: this.current, css: this.css });
  }
}
