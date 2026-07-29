/**
 * The UI-motion linter.
 *
 * Runs alongside the timing and design linters, and enforces the rules that are
 * *specific to product motion* — the ones that directly contradict editorial
 * practice. A piece can pass the timing linter perfectly and still be wrong here:
 * a beautifully curved 700ms bezier entrance with a 90ms stagger and heavy motion
 * blur is excellent editorial craft and completely wrong on a card.
 *
 * This is also what makes acceptance criterion 6b checkable — "a product-UI
 * prompt never emits an editorial technique, and vice versa". The LookPack's
 * allow/forbid lists express the intent; `BEZIER_ON_UI` and `MOTION_BLUR_ON_UI`
 * catch it if the intent leaks.
 *
 * Pure — operates on `ToolCall[]`.
 */

import type { ToolCall } from '@motion/design-system';
import { UI_LIMITS } from './choreography';

export type UiRule =
  | 'BEZIER_ON_UI'
  | 'EXIT_SLOWER_THAN_ENTER'
  | 'UI_STAGGER_TOO_WIDE'
  | 'UI_TRAVEL_TOO_FAR'
  | 'EXCESSIVE_OVERSHOOT'
  | 'NO_SHARED_ELEMENT'
  | 'CURSOR_STRAIGHT_LINE'
  | 'CURSOR_CLICK_SIMULTANEOUS'
  | 'MOTION_BLUR_ON_UI'
  | 'NO_PRESS_STATE'
  | 'MISSING_SAFE_AREA';

export type Severity = 'error' | 'warn';

export interface UiFinding {
  rule: UiRule;
  severity: Severity;
  nodeIds: string[];
  message: string;
}

const ERROR_RULES: ReadonlySet<UiRule> = new Set([
  'BEZIER_ON_UI',
  'EXIT_SLOWER_THAN_ENTER',
  'UI_STAGGER_TOO_WIDE',
  'UI_TRAVEL_TOO_FAR',
  'EXCESSIVE_OVERSHOOT',
  'CURSOR_STRAIGHT_LINE',
  'CURSOR_CLICK_SIMULTANEOUS',
  'MISSING_SAFE_AREA',
]);

export interface UiLintScene {
  calls: readonly ToolCall[];
  fps: number;
  /**
   * Layer ids that are UI-class elements.
   *
   * The scope is everything. A composition can legitimately mix a UI mock with
   * an editorial headline over it, and applying these rules to the headline
   * would report correct editorial craft as a defect.
   */
  uiNodeIds: readonly string[];
  /** Enter/exit pairs, for the exit-speed rule. */
  transitions?: readonly { nodeId: string; enterMs: number; exitMs: number }[];
  /** Cursor paths, for the pointer rules. */
  cursors?: readonly { nodeId: string; arcFraction: number; arrivesAtMs: number; clicksAtMs?: number }[];
  /** A state change and how many elements could have been shared. */
  stateChanges?: readonly { atMs: number; opportunities: number; matched: number }[];
  /** Device-frame safe areas, for the phone-frame rule. */
  safeArea?: { top: number; bottom: number; frameHeight: number };
  /** Element boxes, for the safe-area check. */
  boxes?: readonly { nodeId: string; y: number; height: number }[];
  /** Interactive element ids, for the press-state rule. */
  interactiveNodeIds?: readonly string[];
  /**
   * Elements exempt from the travel limit, because their distance is set by
   * something other than motion design.
   *
   * Three legitimate cases, and none of them is a loophole:
   *  • **Off-frame presentation** — a sheet rising from below the screen edge, a
   *    drawer sliding in. Capping these at 24px makes a bottom sheet peek.
   *  • **Scroll** — a list flinging under a finger is a translation of the
   *    *viewport*, not of an element within a layout.
   *  • **Selection tracking** — a tab indicator travels the distance between the
   *    tabs, which is set by the layout.
   *
   * The 8–24px rule is about elements ARRIVING: a card that crosses a third of
   * the frame to get where it is going reads as a title card, and that is the
   * failure this catches.
   */
  offFrameNodeIds?: readonly string[];
}

const find = (rule: UiRule, nodeIds: string[], message: string): UiFinding => ({
  rule,
  severity: ERROR_RULES.has(rule) ? 'error' : 'warn',
  nodeIds,
  message,
});

interface SpringCall {
  nodeId: string;
  prop: string;
  from: number;
  to: number;
  startSec: number;
  preset?: string;
}

/**
 * Peak overshoot per preset, as a fraction of travel — measured from the solver,
 * not guessed. `gentle` is over-damped and reaches zero.
 */
const PRESET_OVERSHOOT: Record<string, number> = {
  gentle: 0,
  stiff: 0.006,
  snappy: 0.021,
  molasses: 0,
  bouncy: 0.104,
};

function springs(calls: readonly ToolCall[]): SpringCall[] {
  return calls
    .filter((c) => c.name === 'set_spring')
    .map((c) => ({
      nodeId: String(c.args.nodeId ?? ''),
      prop: String(c.args.prop ?? ''),
      from: Number(c.args.from ?? 0),
      to: Number(c.args.to ?? 0),
      startSec: Number(c.args.startSec ?? 0),
      ...(c.args.preset ? { preset: String(c.args.preset) } : {}),
    }));
}

export function lintUiMotion(scene: UiLintScene): UiFinding[] {
  const out: UiFinding[] = [];
  const ui = new Set(scene.uiNodeIds);

  // ── BEZIER_ON_UI ──────────────────────────────────────────────────────────
  // A UI element animating on `set_keyframes` with a bezier instead of a spring.
  // A bezier cannot produce the settle characteristic of a spring — it reaches
  // its target exactly once — and that difference is the single clearest tell
  // between real product motion and faked product motion.
  const bezierUi: string[] = [];
  for (const c of scene.calls) {
    if (c.name !== 'set_keyframes') continue;
    const kfs = c.args.keyframes;
    if (!Array.isArray(kfs)) continue;
    for (const raw of kfs) {
      const k = raw as Record<string, unknown>;
      const nodeId = String(k.nodeId ?? '');
      if (!ui.has(nodeId)) continue;
      // A text-animator selector sweep and an opacity shimmer are not transform
      // motion — they have no spring equivalent and are correct on a curve.
      const prop = String(k.prop ?? '');
      if (prop.startsWith('ta.') || prop.startsWith('pathOp.') || prop === 'opacity') continue;
      if (k.easing === 'bezier') bezierUi.push(`${nodeId}.${prop}`);
    }
  }
  if (bezierUi.length) {
    out.push(find('BEZIER_ON_UI', [...new Set(bezierUi.map((b) => b.split('.')[0]!))],
      `${bezierUi.length} UI transform(s) animate on a bezier instead of a spring: ` +
      `${[...new Set(bezierUi)].slice(0, 5).join(', ')}. A bezier reaches its target once; a spring ` +
      `crosses it and settles, and every shipped design system animates UI on springs. Use set_spring.`));
  }

  // ── MOTION_BLUR_ON_UI ─────────────────────────────────────────────────────
  const blurred = scene.calls
    .filter((c) => c.name === 'set_motion_blur' && c.args.nodeId && c.args.enabled !== false)
    .map((c) => String(c.args.nodeId))
    .filter((id) => ui.has(id));
  if (blurred.length) {
    out.push(find('MOTION_BLUR_ON_UI', [...new Set(blurred)],
      `Motion blur is enabled on ${new Set(blurred).size} UI element(s). Real interfaces do not blur — ` +
      `a browser does not smear a card as it moves — so blurred UI reads as fake immediately.`));
  }

  // ── UI_TRAVEL_TOO_FAR / EXCESSIVE_OVERSHOOT ───────────────────────────────
  const offFrame = new Set(scene.offFrameNodeIds ?? []);
  const farTravel: string[] = [];
  const bigOvershoot: string[] = [];
  for (const s of springs(scene.calls)) {
    if (!ui.has(s.nodeId)) continue;
    if (
      !offFrame.has(s.nodeId) &&
      (s.prop === 'x' || s.prop === 'y') &&
      Math.abs(s.to - s.from) > UI_LIMITS.maxTravelPx
    ) {
      farTravel.push(`${s.nodeId}.${s.prop} (${Math.abs(s.to - s.from).toFixed(0)}px)`);
    }
    // Overshoot is a property of the SPRING, not of the distance it covers.
    //
    // Measuring it as "the scale endpoints differ by more than 8%" reported
    // `ui.shared_element_expand` — which scales a row to 2.4× as it becomes a
    // detail view — as excessive overshoot. That is a **morph**: the element is
    // changing size, and how far it travels says nothing about whether it bounces
    // when it gets there. `snappy` overshoots ~2% whether it moves 1% or 240%.
    if (s.prop.startsWith('scale') && s.preset) {
      const overshoot = PRESET_OVERSHOOT[s.preset];
      if (overshoot !== undefined && overshoot > UI_LIMITS.maxOvershoot) {
        bigOvershoot.push(`${s.nodeId}.${s.prop} (${s.preset}, ${(overshoot * 100).toFixed(1)}%)`);
      }
    }
  }
  if (farTravel.length) {
    out.push(find('UI_TRAVEL_TOO_FAR', [...new Set(farTravel.map((f) => f.split('.')[0]!))],
      `${farTravel.length} UI element(s) travel more than ${UI_LIMITS.maxTravelPx}px: ` +
      `${farTravel.slice(0, 4).join(', ')}. UI moves 8–24px; a card crossing a third of the frame is ` +
      `a title card, not an interface.`));
  }
  if (bigOvershoot.length) {
    out.push(find('EXCESSIVE_OVERSHOOT', [...new Set(bigOvershoot.map((b) => b.split('.')[0]!))],
      `${bigOvershoot.length} UI scale(s) exceed the ${(UI_LIMITS.maxOvershoot * 100).toFixed(0)}% overshoot ` +
      `ceiling: ${bigOvershoot.slice(0, 4).join(', ')}. Large overshoot reads as a toy. Use the 'snappy' ` +
      `preset (≈2%) rather than 'bouncy' (≈10%).`));
  }

  // ── UI_STAGGER_TOO_WIDE ───────────────────────────────────────────────────
  const byProp = new Map<string, Map<string, number>>();
  for (const s of springs(scene.calls)) {
    if (!ui.has(s.nodeId)) continue;
    if (s.prop !== 'y' && s.prop !== 'opacity') continue;
    const perNode = byProp.get(s.prop) ?? new Map<string, number>();
    // FIRST start per node. A stagger is the offset between DIFFERENT elements;
    // one element's later return to rest is a settle, and counting it reported
    // `ui.hover_lift` — a single card lifting and dropping back — as a 220ms
    // stagger.
    const prev = perNode.get(s.nodeId);
    if (prev === undefined || s.startSec * 1000 < prev) perNode.set(s.nodeId, s.startSec * 1000);
    byProp.set(s.prop, perNode);
  }
  for (const [prop, perNode] of byProp) {
    const sorted = [...perNode.values()].sort((a, b) => a - b);
    if (sorted.length < 3) continue;
    for (let i = 1; i < sorted.length; i++) {
      const gap = sorted[i]! - sorted[i - 1]!;
      // Only a gap in the stagger range counts. A one-second pause between two
      // separate events is not a stagger.
      if (gap > UI_LIMITS.maxStaggerMs && gap < 400) {
        out.push(find('UI_STAGGER_TOO_WIDE', [],
          `A ${gap.toFixed(0)}ms stagger on '${prop}' exceeds the ${UI_LIMITS.maxStaggerMs}ms UI limit. ` +
          `A UI list is not a title sequence — above ~60ms it stops feeling like the list appeared and ` +
          `starts feeling like it is loading. Use listStagger(), which targets 30–50ms.`));
        break;
      }
    }
  }

  // ── EXIT_SLOWER_THAN_ENTER ────────────────────────────────────────────────
  for (const t of scene.transitions ?? []) {
    if (t.exitMs >= t.enterMs) {
      out.push(find('EXIT_SLOWER_THAN_ENTER', [t.nodeId],
        `'${t.nodeId}' exits in ${t.exitMs}ms but enters in ${t.enterMs}ms. An exit must be FASTER — ` +
        `it acknowledges something the user already did, so every millisecond it spends is the ` +
        `interface feeling slow. Target ~60% of the entrance.`));
    }
  }

  // ── CURSOR rules ──────────────────────────────────────────────────────────
  for (const c of scene.cursors ?? []) {
    if (c.arcFraction <= 0.001) {
      out.push(find('CURSOR_STRAIGHT_LINE', [c.nodeId],
        `Cursor '${c.nodeId}' travels in a dead-straight line. A real pointer arcs — a straight path ` +
        `is the clearest sign the cursor is a keyframed rectangle. Use cursorPath(), which bows the ` +
        `midpoint perpendicular to the travel.`));
    }
    if (c.clicksAtMs !== undefined && c.clicksAtMs - c.arrivesAtMs < UI_LIMITS.minCursorSettleMs) {
      out.push(find('CURSOR_CLICK_SIMULTANEOUS', [c.nodeId],
        `Cursor '${c.nodeId}' clicks ${(c.clicksAtMs - c.arrivesAtMs).toFixed(0)}ms after arriving. ` +
        `People arrive, pause, then click — ~${UI_LIMITS.minCursorDwellMs}ms of dwell. A click on the ` +
        `arrival frame is the tell that gives away every synthetic demo.`));
    }
  }

  // ── NO_SHARED_ELEMENT (warn) ──────────────────────────────────────────────
  for (const change of scene.stateChanges ?? []) {
    if (change.opportunities >= 2 && change.matched === 0) {
      out.push(find('NO_SHARED_ELEMENT', [],
        `The state change at ${(change.atMs / 1000).toFixed(1)}s had ${change.opportunities} element(s) ` +
        `that could have been shared, and cross-faded instead. A list item expanding into a detail view ` +
        `via magic move is the clearest "made by a real product designer" signal there is.`));
    }
  }

  // ── NO_PRESS_STATE (warn) ─────────────────────────────────────────────────
  const pressed = new Set(
    springs(scene.calls).filter((s) => s.prop.startsWith('scale') && s.to < 1).map((s) => s.nodeId),
  );
  const unpressed = (scene.interactiveNodeIds ?? []).filter((id) => !pressed.has(id));
  if (unpressed.length) {
    out.push(find('NO_PRESS_STATE', unpressed,
      `${unpressed.length} interactive element(s) animate with no press feedback. A control that does ` +
      `not acknowledge the press feels broken even when it works — 3% compression over 80ms is enough.`));
  }

  // ── MISSING_SAFE_AREA ─────────────────────────────────────────────────────
  if (scene.safeArea && scene.boxes) {
    const { top, bottom, frameHeight } = scene.safeArea;
    const violating = scene.boxes
      .filter((b) => ui.has(b.nodeId))
      .filter((b) => b.y - b.height / 2 < top || b.y + b.height / 2 > frameHeight - bottom)
      .map((b) => b.nodeId);
    if (violating.length) {
      out.push(find('MISSING_SAFE_AREA', violating,
        `${violating.length} element(s) intrude into the status-bar or home-indicator inset. Phone ` +
        `chrome is not decoration — content underneath it is genuinely unreadable on the device.`));
    }
  }

  return out;
}

/** Weighted pass rate, 0..1. Reported alongside craftScore and designScore. */
export function uiMotionScore(findings: readonly UiFinding[]): number {
  const errors = findings.filter((f) => f.severity === 'error').length;
  const warns = findings.filter((f) => f.severity === 'warn').length;
  return Math.max(0, 1 - (errors * 3 + warns) / 20);
}

export function formatUiFindings(findings: readonly UiFinding[]): string | null {
  if (!findings.length) return null;
  const errors = findings.filter((f) => f.severity === 'error');
  const warns = findings.filter((f) => f.severity === 'warn');
  const lines: string[] = [];
  if (errors.length) {
    lines.push(`${errors.length} UI-motion error(s) — these block:`);
    lines.push(...errors.map((f) => `  [${f.rule}] ${f.message}`));
  }
  if (warns.length) {
    lines.push(`${warns.length} UI-motion warning(s):`);
    lines.push(...warns.map((f) => `  [${f.rule}] ${f.message}`));
  }
  return lines.join('\n');
}
