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

/**
 * The rotate cursor, as an inline SVG data URI.
 *
 * CSS has no rotate cursor, so this used to fall back to `grab` — a hand, which
 * is the PAN gesture. Hovering a corner to rotate and being shown the icon for
 * "drag the canvas around" is the cursor stating the wrong thing, and the note
 * that used to sit here ("hosts usually swap in a custom rotate glyph")
 * described a swap no host ever made.
 *
 * A horizontal double-headed arrow, on the user's call. The first attempt drew
 * a curved arrow — semantically the obvious choice, and at 32px the arc plus its
 * tail read as a speech bubble rather than as rotation. A shape that has to be
 * squinted at to be identified is not doing a cursor's job, so this is the plain
 * one: the drag IS horizontal (swing left or right around the corner), and the
 * glyph says so at any size.
 *
 * Drawn twice, thick dark then thin white, so it stays legible on a bright
 * artboard AND on the dark pasteboard. Hotspot `16 16` puts the acting point in
 * the middle of the glyph. The trailing `, grab` only applies if a browser
 * refuses the data URI outright.
 */
const ROTATE_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 32 32">' +
  '<g fill="none" stroke="#000" stroke-width="3.6" stroke-linecap="round" stroke-linejoin="round">' +
  '<path d="M4 16h24"/><path d="M9 11l-5 5 5 5"/><path d="M23 11l5 5-5 5"/></g>' +
  '<g fill="none" stroke="#fff" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">' +
  '<path d="M4 16h24"/><path d="M9 11l-5 5 5 5"/><path d="M23 11l5 5-5 5"/></g></svg>';

export const ROTATE_CURSOR_CSS =
  `url("data:image/svg+xml;utf8,${encodeURIComponent(ROTATE_SVG)}") 16 16, grab`;

/** Maps semantic cursor types to CSS cursor values. */
export const CURSOR_CSS: Record<CursorType, string> = {
  default: 'default',
  move: 'move',
  rotate: ROTATE_CURSOR_CSS,
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
