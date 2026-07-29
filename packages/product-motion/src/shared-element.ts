/**
 * Shared-element transitions — "magic move".
 *
 * The highest-value technique in the product-motion library, and the clearest
 * single signal that a piece was made by someone who has shipped a product: an
 * element **persists** across a state change and morphs — position, size, corner
 * radius, and content all interpolating — rather than one thing fading out and
 * another fading in.
 *
 * A list item expanding into a detail view via magic move is the canonical case.
 * Cross-fading the two states instead is what generated UI motion always does,
 * and it is why it never looks like a real product.
 *
 * ## The solver
 *
 * Diff two UI states, match elements, emit:
 *  • a **morph** for each matched pair,
 *  • **exit** choreography for elements only in the "from" state,
 *  • **enter** choreography for elements only in the "to" state.
 *
 * Matching is by declared `role` first and by id second. Geometry is deliberately
 * NOT used for matching: two same-sized boxes in different roles are not the same
 * element, and matching them produces a morph that reads as a glitch.
 *
 * Pure — emits `ToolCall[]`.
 */

import { mk, type ToolCall } from '@motion/design-system';
import { SPRING_PRESETS, type SpringPresetName } from '@motion/ai-tools';
import { BUDGETS, UI_LIMITS, type UiElementClass } from './choreography';

export interface UiElement {
  id: string;
  /** What this element IS. The primary matching key. */
  role: string;
  cls: UiElementClass;
  x: number;
  y: number;
  width: number;
  height: number;
  cornerRadius?: number;
  opacity?: number;
  /** True when the content inside cannot morph and must cross-fade. */
  contentDiffers?: boolean;
}

export interface UiState {
  name: string;
  elements: readonly UiElement[];
}

export interface MagicMoveOptions {
  fromState: UiState;
  toState: UiState;
  /** Composition ms at which the transition begins. */
  atMs: number;
  fps: number;
  spring?: SpringPresetName;
  /** Morph the corner radius too. Almost always yes — it is half the effect. */
  morphRadius?: boolean;
  /** Cross-fade content that cannot morph. */
  crossfadeContent?: boolean;
}

export interface MagicMoveResult {
  calls: ToolCall[];
  /** Pairs that morphed. */
  matched: { fromId: string; toId: string; role: string }[];
  /** Elements that had to enter or exit because nothing matched. */
  entered: string[];
  exited: string[];
  /**
   * Pairs that COULD have matched by role but did not, because one side was
   * missing. Surfaced so the UI-motion linter can report `NO_SHARED_ELEMENT`
   * rather than silently cross-fading a transition that had a magic move in it.
   */
  missedOpportunities: number;
}

/** Match by role, then by id. Never by geometry — see the file docstring. */
function match(from: UiState, to: UiState): { pairs: [UiElement, UiElement][]; onlyFrom: UiElement[]; onlyTo: UiElement[] } {
  const pairs: [UiElement, UiElement][] = [];
  const usedTo = new Set<string>();
  const onlyFrom: UiElement[] = [];

  for (const f of from.elements) {
    const byRole = to.elements.find((t) => !usedTo.has(t.id) && t.role === f.role);
    const byId = to.elements.find((t) => !usedTo.has(t.id) && t.id === f.id);
    const hit = byRole ?? byId;
    if (hit) {
      usedTo.add(hit.id);
      pairs.push([f, hit]);
    } else {
      onlyFrom.push(f);
    }
  }
  return { pairs, onlyFrom, onlyTo: to.elements.filter((t) => !usedTo.has(t.id)) };
}

/**
 * Emit a magic-move transition between two UI states.
 *
 * Every animated channel is a SPRING, not a bezier — including the corner radius
 * and the shadow. Per-property springs are the point: a card's size can be snappy
 * while its shadow is gentle, and that difference is what makes the move feel
 * like an object rather than like a tween.
 */
export function magicMove(o: MagicMoveOptions): MagicMoveResult {
  const { pairs, onlyFrom, onlyTo } = match(o.fromState, o.toState);
  const calls: ToolCall[] = [];
  const preset = o.spring ?? 'snappy';
  const startSec = o.atMs / 1000;

  for (const [from, to] of pairs) {
    const budget = BUDGETS[to.cls];
    const spring = (SPRING_PRESETS[preset] ? preset : budget.spring) as SpringPresetName;

    const morph = (prop: string, a: number, b: number, s: SpringPresetName = spring): void => {
      if (Math.abs(a - b) < 0.01) return;
      calls.push(mk('set_spring', { nodeId: from.id, prop, from: a, to: b, startSec, preset: s }));
    };

    morph('x', from.x, to.x);
    morph('y', from.y, to.y);
    // Size morphs through scale, since the engine animates scale rather than
    // width/height. Non-uniform, so a square growing into a wide card actually
    // becomes wide instead of growing uniformly and being cropped.
    morph('scaleX', 1, to.width / Math.max(1, from.width));
    morph('scaleY', 1, to.height / Math.max(1, from.height));

    if (o.morphRadius !== false && from.cornerRadius !== undefined && to.cornerRadius !== undefined) {
      // A radius that snaps while the box morphs is the single most visible
      // failure in a hand-built magic move. `gentle` because a bouncing corner
      // radius looks like a rendering fault.
      morph('cornerRadius', from.cornerRadius, to.cornerRadius, 'gentle');
    }

    if (o.crossfadeContent !== false && (from.contentDiffers || to.contentDiffers)) {
      // Content that cannot morph cross-fades INSIDE the morphing container, and
      // faster than the container moves — so the new content is already legible
      // by the time the box stops. Fading them at the same rate leaves the user
      // reading a blend halfway through.
      calls.push(mk('set_spring', {
        nodeId: from.id, prop: 'opacity', from: 100, to: 0,
        startSec, preset: 'stiff', maxDurationSec: budget.enterMs / 1000,
      }));
      calls.push(mk('set_spring', {
        nodeId: to.id, prop: 'opacity', from: 0, to: 100,
        startSec: startSec + budget.enterMs * 0.35 / 1000, preset: 'stiff',
      }));
    }
  }

  // Unmatched elements get ordinary enter/exit — and the EXIT runs first and
  // faster, so the frame is clear before the new content arrives. Overlapping
  // them is what makes a transition feel congested.
  for (const el of onlyFrom) {
    const b = BUDGETS[el.cls];
    calls.push(mk('set_spring', {
      nodeId: el.id, prop: 'opacity', from: 100, to: 0, startSec, preset: 'stiff',
      maxDurationSec: b.exitMs / 1000,
    }));
  }
  for (const el of onlyTo) {
    const b = BUDGETS[el.cls];
    const at = startSec + (b.exitMs * 0.5) / 1000;
    calls.push(mk('set_spring', { nodeId: el.id, prop: 'opacity', from: 0, to: 100, startSec: at, preset: 'snappy' }));
    calls.push(mk('set_spring', {
      nodeId: el.id, prop: 'y', from: el.y + Math.min(b.travelPx, UI_LIMITS.maxTravelPx), to: el.y,
      startSec: at, preset: b.spring,
    }));
  }

  // How many pairs SHARED a role but were not matched — i.e. the transition had
  // a magic move available and did not take it.
  const fromRoles = new Set(o.fromState.elements.map((e) => e.role));
  const missed = o.toState.elements.filter(
    (t) => fromRoles.has(t.role) && !pairs.some(([, to]) => to.id === t.id),
  ).length;

  return {
    calls,
    matched: pairs.map(([f, t]) => ({ fromId: f.id, toId: t.id, role: f.role })),
    entered: onlyTo.map((e) => e.id),
    exited: onlyFrom.map((e) => e.id),
    missedOpportunities: missed,
  };
}

/**
 * Could these two states have shared elements?
 *
 * Used by the linter's `NO_SHARED_ELEMENT` rule: a state change where two or more
 * elements could have matched and none did is a cross-fade where a magic move
 * belonged.
 */
export function sharedElementOpportunities(from: UiState, to: UiState): number {
  return match(from, to).pairs.length;
}
