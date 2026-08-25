/**
 * Structured, per-frame diagnostics from inside the render passes (M8a).
 *
 * ── Why this exists ──────────────────────────────────────────────────
 * Some compositing operations cannot be honoured for reasons only the renderer
 * knows at draw time — a compositing group beyond the offscreen-target depth
 * cap, a matte whose source could not be isolated. The existing behaviour was to
 * fall through and draw the layer normally, which produces a picture that looks
 * finished and is wrong: a layer that should be cut to a shape renders whole,
 * with no signal anywhere.
 *
 * A renderer cannot decide what to DO about that, because the right answer
 * differs by surface:
 *
 *   preview — degrade and warn. The warning reaches the person who can act on it,
 *             and wrong pixels on screen are recoverable.
 *   export  — FAIL. The same warning during an export is a log line next to a
 *             file someone is about to ship. Wrong pixels encoded into a
 *             delivered MP4 are not recoverable.
 *
 * So the renderer's job is to STATE what happened, in a form the host can act
 * on, and the host's job is to choose. That asymmetry is the whole point of this
 * module; collapsing it back into "log a warning" would lose the export case.
 *
 * ── Why not an event bus ─────────────────────────────────────────────
 * This package is deliberately independent of the app shell, so it cannot reach
 * the app's EventBus. Collecting into a per-frame array that the host drains
 * keeps the dependency pointing the right way and keeps the renderer testable
 * without a bus.
 */

/** Things the renderer could not honour, and had to approximate or skip. */
export type RenderDiagnosticCode =
  /** A compositing group could not be isolated (offscreen-target depth cap). */
  | 'group-unavailable'
  /** A track matte's source could not be resolved or isolated; layer drew unmatted. */
  | 'matte-source-unavailable'
  /** An image/video source failed to decode; preview shows colour bars. */
  | 'media-unavailable';

export interface RenderDiagnostic {
  code: RenderDiagnosticCode;
  /** Human-readable, already specific enough to act on. */
  detail: string;
  /** The renderable this concerns, when there is one. */
  layerId?: string;
}

/**
 * Per-frame sink. Deliberately tiny and allocation-light: `push` is called from
 * inside the draw path, and the common case is that nothing is ever pushed.
 */
export class RenderDiagnostics {
  private items: RenderDiagnostic[] = [];

  push(d: RenderDiagnostic): void {
    // Bounded. A pathological scene (every layer beyond the cap) must not turn a
    // rendering problem into a memory problem, and the 33rd instance of the same
    // message tells the user nothing the 1st did not.
    if (this.items.length >= 32) return;
    this.items.push(d);
  }

  /** Everything collected this frame. */
  drain(): RenderDiagnostic[] {
    const out = this.items;
    this.items = [];
    return out;
  }

  get isEmpty(): boolean {
    return this.items.length === 0;
  }
}

/**
 * Format diagnostics for a host that must refuse to continue (export).
 *
 * Kept here rather than at the call site so preview and export quote the same
 * text — a user comparing a preview warning against an export failure should not
 * have to work out whether they are the same problem.
 */
export function describeDiagnostics(items: readonly RenderDiagnostic[]): string {
  if (items.length === 0) return '';
  const lines = items.map((d) => `  • ${d.detail}${d.layerId ? ` (layer ${d.layerId})` : ''}`);
  return `${items.length} compositing operation(s) could not be honoured:\n${lines.join('\n')}`;
}
