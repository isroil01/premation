/**
 * `LayoutTemplate` — the static equivalent of a motion technique.
 *
 * ## Why layouts are authored, not invented
 *
 * Ask a model to lay out a headline and it produces a centred text box on a flat
 * fill, because that is the mean of everything it has seen. The mean of all
 * layouts is not a good layout; it is the *absence* of a layout decision. So the
 * decision is made here, once, by hand, and the model's job is reduced to
 * choosing which authored decision fits the brief.
 *
 * ## Slots
 *
 * A template declares slots by ROLE — `headline`, `support`, `media`, `mark`,
 * `stat` — and the caster fills them with content. Roles are also how motion
 * casting is constrained: a technique declares which roles it can animate, so
 * casting motion onto a layout is a bounded match rather than free invention.
 *
 * ## The frame test
 *
 * Every template must pass this: pause the finished piece at any moment and the
 * still frame should survive being posted as a static design. If a layout only
 * works because things are moving, the design layer failed and no amount of
 * motion craft rescues it.
 *
 * Pure — `compose()` returns `ToolCall[]` and touches nothing.
 */

import type { GridSpec } from './grid';
import { grid, negativeSpaceRatio } from './grid';
import { baseSizeFor, typeStyle, type TypeScaleOptions } from './type';
import type { ResolvedPack } from './packs';
import type { ToolCall } from './toolcall';

export type SlotRole =
  | 'headline'
  | 'subhead'
  | 'support'
  | 'overline'
  | 'media'
  | 'mark'
  | 'stat'
  | 'quote'
  | 'list'
  | 'cta'
  | 'rule';

export interface SlotDef {
  role: SlotRole;
  required: boolean;
  /** Max items for a repeating slot (stats, list rows). 1 for singular slots. */
  max?: number;
}

/** Content the caster hands a template. */
export interface SlotContent {
  headline?: string;
  subhead?: string;
  support?: string;
  overline?: string;
  quote?: string;
  attribution?: string;
  cta?: string;
  /** Repeating: `[{ value, label }]` for stats, `[{ title, body }]` for tiles. */
  items?: readonly { value?: string; label?: string; title?: string; body?: string }[];
  /** Asset id from `list_assets`, when a media slot is filled with real imagery. */
  mediaAssetId?: string;
}

export interface ComposeContext {
  pack: ResolvedPack;
  grid: GridSpec;
  type: TypeScaleOptions;
  /** Frame, for convenience. */
  width: number;
  height: number;
  /**
   * Composition seconds this layout occupies. Templates emit STATIC design and
   * generally ignore time — but a template that creates a background needs to
   * know how long it should live.
   */
  startMs: number;
  durationMs: number;
  /** Prefix for generated layer ids, so two instances never collide. */
  idPrefix: string;
}

/** Build a ComposeContext from a resolved pack and a frame. */
export function composeContext(
  pack: ResolvedPack,
  width: number,
  height: number,
  o: { startMs?: number; durationMs?: number; idPrefix?: string; gridOver?: Partial<GridSpec> } = {},
): ComposeContext {
  const g = grid(width, height, o.gridOver);
  return {
    pack,
    grid: g,
    type: { pairing: pack.typePairing, basePx: baseSizeFor(height) },
    width,
    height,
    startMs: o.startMs ?? 0,
    durationMs: o.durationMs ?? 5000,
    idPrefix: o.idPrefix ?? 'l',
  };
}

/**
 * What a template returns.
 *
 * `slots` maps each filled role to the layer ids it produced. That map is the
 * handoff to motion casting: a technique that animates `headline` is given those
 * ids and never has to guess which layer is the headline.
 */
export interface ComposeResult {
  calls: ToolCall[];
  slots: Partial<Record<SlotRole, string[]>>;
  /** Element boxes, for the negative-space check. */
  boxes: { width: number; height: number }[];
  /**
   * Layer id → the fill of the surface it sits on, for text that is NOT on the
   * composition background (a label inside a button, copy on a card).
   *
   * The design linter's contrast rule needs this. Without it, a white label on an
   * accent button is measured against the frame background and reported as a
   * failure — and "fixing" that would break the button. Only the template knows
   * what an element sits on, so the template is what records it. Absent entries
   * are assumed to be on the composition background.
   */
  surfaces?: Record<string, string>;
}

export interface LayoutTemplate {
  id: string;
  displayName: string;
  /** Cast-time metadata — short and evocative. This is what the LLM sees. */
  intent: string;
  tags: readonly string[];
  /** LookPack ids this template is allowed in. */
  packs: readonly string[];
  slots: readonly SlotDef[];
  /** Target emptiness, as a fraction of frame. */
  negativeSpaceRatio: [number, number];
  variants: number;
  compose(ctx: ComposeContext, content: SlotContent, seed: number): ComposeResult;
}

// ── Shared emit helpers ───────────────────────────────────────────────

let _anon = 0;

/** A stable-per-context layer id. */
export function layerId(ctx: ComposeContext, role: string, index = 0): string {
  return `${ctx.idPrefix}_${role}${index ? `_${index}` : ''}`;
}

/** Reset the anonymous counter — tests only, so ids stay comparable. */
export function resetAnonIds(): void {
  _anon = 0;
}

export function anonId(prefix: string): string {
  return `${prefix}_${(_anon += 1)}`;
}

/**
 * A text layer, fully typeset.
 *
 * Every template creates text through here rather than emitting `create_layer`
 * directly, because this is where the tracking curve and the role line-height get
 * applied. A template that emitted its own `create_layer` would silently produce
 * display type at zero tracking — the exact failure the type system exists to
 * prevent, and the reason `DEFAULT_TRACKING` is an *error* in the design linter.
 */
export function emitText(
  ctx: ComposeContext,
  id: string,
  text: string,
  role: Parameters<typeof typeStyle>[1],
  o: {
    x: number; y: number; width?: number; fill?: string; weight?: number;
    align?: 'left' | 'center' | 'right';
  },
): ToolCall[] {
  const s = typeStyle(ctx.type, role, o.weight);
  return [
    { name: 'create_layer', args: { id, kind: 'text', name: `${role}: ${text.slice(0, 24)}`, text, x: o.x, y: o.y } },
    {
      name: 'update_layer',
      args: {
        nodeId: id,
        fontFamily: s.family,
        fontSize: s.fontSizePx,
        fontWeight: s.fontWeight,
        // The two fields that decide whether this reads as typeset. They are set
        // on EVERY text layer this package emits — never omitted, never 0 by
        // default on a display size.
        letterSpacing: s.letterSpacingPx,
        lineHeight: s.lineHeight,
        align: o.align ?? 'center',
        fill: o.fill ?? ctx.pack.palette.fg,
        ...(o.width !== undefined ? { width: o.width } : {}),
      },
    },
  ];
}

/** The style values a text layer should carry for a role — for tests and linting. */
export function textMetricsFor(ctx: ComposeContext, role: Parameters<typeof typeStyle>[1], weight?: number) {
  return typeStyle(ctx.type, role, weight);
}

/** Negative space for a composed result. */
export function resultNegativeSpace(ctx: ComposeContext, r: ComposeResult): number {
  return negativeSpaceRatio(ctx.grid, r.boxes);
}
