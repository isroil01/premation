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
  | 'pencil'
  | 'brush'
  | 'eraser'
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
  '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24">' +
  '<g fill="none" stroke="#000" stroke-width="3" stroke-linecap="round" stroke-linejoin="round">' +
  '<path d="M4 12h16"/><path d="M8 8l-4 4 4 4"/><path d="M16 8l4 4-4 4"/></g>' +
  '<g fill="none" stroke="#fff" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">' +
  '<path d="M4 12h16"/><path d="M8 8l-4 4 4 4"/><path d="M16 8l4 4-4 4"/></g></svg>';

export const ROTATE_CURSOR_CSS =
  `url("data:image/svg+xml;utf8,${encodeURIComponent(ROTATE_SVG)}") 12 12, grab`;

const POINTER_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24">' +
  '<path d="M6 3 L16.5 13.5 L12.5 13.5 L15.5 20.5 L13 21.5 L10 14.5 L6 18.5 Z" fill="#000" stroke="#fff" stroke-width="1.5" stroke-linejoin="round"/>' +
  '</svg>';

export const POINTER_CURSOR_CSS =
  `url("data:image/svg+xml;utf8,${encodeURIComponent(POINTER_SVG)}") 6 3, default`;

const HAND_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24">' +
  '<g fill="none" stroke="#000" stroke-width="3.5" stroke-linecap="round" stroke-linejoin="round">' +
  '<path d="M10 10V5.5a1.5 1.5 0 0 1 3 0V11" /><path d="M13 11V4.5a1.5 1.5 0 0 1 3 0V11" /><path d="M16 11V6a1.5 1.5 0 0 1 3 0v6.5a5.5 5.5 0 0 1-5.5 5.5h-1a5.5 5.5 0 0 1-5.5-5.5v-1.5a1.5 1.5 0 0 1 3 0V14.5" />' +
  '</g>' +
  '<g fill="none" stroke="#fff" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">' +
  '<path d="M10 10V5.5a1.5 1.5 0 0 1 3 0V11" /><path d="M13 11V4.5a1.5 1.5 0 0 1 3 0V11" /><path d="M16 11V6a1.5 1.5 0 0 1 3 0v6.5a5.5 5.5 0 0 1-5.5 5.5h-1a5.5 5.5 0 0 1-5.5-5.5v-1.5a1.5 1.5 0 0 1 3 0V14.5" />' +
  '</g></svg>';

export const HAND_CURSOR_CSS =
  `url("data:image/svg+xml;utf8,${encodeURIComponent(HAND_SVG)}") 12 12, grab`;

const PEN_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="-3 -3 30 30">' +
  '<g fill="none" stroke="#000" stroke-width="3" stroke-linecap="round" stroke-linejoin="round">' +
  '<path d="M12 19l7-7 3 3-7 7-3-3z"/><path d="M18 13l-1.5-7.5L2 2l3.5 14.5L13 18l5-5z"/><path d="M2 2l7.586 7.586"/><circle cx="11" cy="11" r="2"/></g>' +
  '<g fill="none" stroke="#fff" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">' +
  '<path d="M12 19l7-7 3 3-7 7-3-3z"/><path d="M18 13l-1.5-7.5L2 2l3.5 14.5L13 18l5-5z"/><path d="M2 2l7.586 7.586"/><circle cx="11" cy="11" r="2"/></g></svg>';

export const PEN_CURSOR_CSS =
  `url("data:image/svg+xml;utf8,${encodeURIComponent(PEN_SVG)}") 4 4, crosshair`;

const PENCIL_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="-3 -3 30 30">' +
  '<g fill="none" stroke="#000" stroke-width="3" stroke-linecap="round" stroke-linejoin="round">' +
  '<path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z"/><path d="m15 5 4 4"/></g>' +
  '<g fill="none" stroke="#fff" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">' +
  '<path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z"/><path d="m15 5 4 4"/></g></svg>';

export const PENCIL_CURSOR_CSS =
  `url("data:image/svg+xml;utf8,${encodeURIComponent(PENCIL_SVG)}") 4 20, crosshair`;

const BRUSH_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="-3 -3 30 30">' +
  '<g fill="none" stroke="#000" stroke-width="3" stroke-linecap="round" stroke-linejoin="round">' +
  '<path d="m9.06 11.9 8.07-8.06a2.85 2.85 0 1 1 4.03 4.03l-8.06 8.08"/><path d="M7.07 14.94c-1.66 0-3 1.35-3 3.02 0 1.33-2.5 1.52-2 2.02 1.08 1.1 2.49 2.02 4 2.02 2.2 0 4-1.8 4-4.04a3.01 3.01 0 0 0-3-3.02z"/></g>' +
  '<g fill="none" stroke="#fff" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">' +
  '<path d="m9.06 11.9 8.07-8.06a2.85 2.85 0 1 1 4.03 4.03l-8.06 8.08"/><path d="M7.07 14.94c-1.66 0-3 1.35-3 3.02 0 1.33-2.5 1.52-2 2.02 1.08 1.1 2.49 2.02 4 2.02 2.2 0 4-1.8 4-4.04a3.01 3.01 0 0 0-3-3.02z"/></g></svg>';

export const BRUSH_CURSOR_CSS =
  `url("data:image/svg+xml;utf8,${encodeURIComponent(BRUSH_SVG)}") 4 20, crosshair`;

const ERASER_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="-3 -3 30 30">' +
  '<g fill="none" stroke="#000" stroke-width="3" stroke-linecap="round" stroke-linejoin="round">' +
  '<path d="m7 21-4.3-4.3c-1-1-1-2.5 0-3.4l9.6-9.6c1-1 2.5-1 3.4 0l5.6 5.6c1 1 1 2.5 0 3.4L13 21"/><path d="M22 21H7"/><path d="m5 11 9 9"/></g>' +
  '<g fill="none" stroke="#fff" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">' +
  '<path d="m7 21-4.3-4.3c-1-1-1-2.5 0-3.4l9.6-9.6c1-1 2.5-1 3.4 0l5.6 5.6c1 1 1 2.5 0 3.4L13 21"/><path d="M22 21H7"/><path d="m5 11 9 9"/></g></svg>';

export const ERASER_CURSOR_CSS =
  `url("data:image/svg+xml;utf8,${encodeURIComponent(ERASER_SVG)}") 5 19, crosshair`;

/** Maps semantic cursor types to CSS cursor values. */
export const CURSOR_CSS: Record<CursorType, string> = {
  default: POINTER_CURSOR_CSS,
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
  grab: HAND_CURSOR_CSS,
  grabbing: 'grabbing',
  text: 'text',
  pen: PEN_CURSOR_CSS,
  pencil: PENCIL_CURSOR_CSS,
  brush: BRUSH_CURSOR_CSS,
  eraser: ERASER_CURSOR_CSS,
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
