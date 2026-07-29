/**
 * Product-motion techniques.
 *
 * Same `TechniqueDef` shape as the editorial library, so one caster and one
 * registry serve both — but every one of these animates on **springs**, moves
 * **less**, exits **faster** than it enters, and never enables motion blur.
 *
 * The micro-interactions are here rather than in the editorial library because
 * they are the whole discipline: press feedback, focus rings, toggle knobs,
 * skeleton resolves and counter rolls are what "polish" actually consists of in
 * a product, and none of them has an editorial equivalent.
 */

import { mk, mulberry32, pick, type ToolCall } from '@motion/design-system';
import type { TechniqueDef } from '@motion/technique-library';
import { rolesTargets } from '@motion/technique-library';
import { BUDGETS, UI_LIMITS, listStaggerAt } from './choreography';

/** Every product technique shares these. */
const PRODUCT_TAGS = ['product', 'ui', 'spring'] as const;

const sec = (ms: number): number => Number((ms / 1000).toFixed(4));

/** A spring call. Product motion has no beziers. */
function spring(
  nodeId: string,
  prop: string,
  o: { from: number; to: number; atMs: number; preset?: string; maxMs?: number },
): ToolCall {
  return mk('set_spring', {
    nodeId,
    prop,
    from: o.from,
    to: o.to,
    startSec: sec(o.atMs),
    preset: o.preset ?? 'snappy',
    ...(o.maxMs ? { maxDurationSec: sec(o.maxMs) } : {}),
  });
}

// ── ui.list_stagger_in ────────────────────────────────────────────────

export const listStaggerIn: TechniqueDef = {
  id: 'ui.list_stagger_in',
  category: 'entrance',
  displayName: 'List Stagger In',
  intent: 'Rows appear in quick succession on a tight spring — 30–50ms apart, not 100.',
  tags: [...PRODUCT_TAGS, 'list', 'entrance'],
  energy: [0.2, 0.7],
  dimensionality: '2d',
  params: { staggerMs: { kind: 'number', default: 40, min: 20, max: 60 } },
  roles: ['list', 'stat', 'cta'],
  requires: ['set_spring'],
  minDurationMs: 240,
  maxDurationMs: 1400,
  approxLayerCount: 0,
  approxToolCalls: 8,
  antipatterns: { neverUnderMs: 200, maxPerComposition: 4 },
  variants: 3,
  markers: ['overshoot', 'cross_property_offset', 'nonuniform_stagger', 'explicit_bezier'],
  emit(ctx, p, seed) {
    const rng = mulberry32(seed);
    const calls: ToolCall[] = [];
    const ids = rolesTargets(ctx, this.roles);
    if (!ids.length) return calls;

    const budget = BUDGETS.container;
    const stagger = Math.min(p.staggerMs as number, UI_LIMITS.maxStaggerMs);
    // 8–24px, never 60. UI moves less; a row that travels a third of the frame
    // reads as a title card.
    const travel = Math.min(pick(rng, [8, 12, 16]), UI_LIMITS.maxTravelPx);

    ids.forEach((id, i) => {
      const at = ctx.startMs + listStaggerAt(i, ids.length, stagger);
      // Opacity leads position by a frame — the same cross-property discipline as
      // editorial, at a quarter of the scale.
      calls.push(spring(id, 'opacity', { from: 0, to: 100, atMs: at - ctx.frameMs, preset: 'stiff', maxMs: budget.enterMs }));
      calls.push(spring(id, 'y', { from: travel, to: 0, atMs: at, preset: 'snappy', maxMs: budget.enterMs }));
      // Scale barely moves. `snappy` overshoots ~2%, which is the UI ceiling.
      calls.push(spring(id, 'scale', { from: 0.985, to: 1, atMs: at, preset: 'snappy', maxMs: budget.enterMs }));
    });
    return calls;
  },
};

// ── ui.press_feedback ─────────────────────────────────────────────────

export const pressFeedback: TechniqueDef = {
  id: 'ui.press_feedback',
  category: 'emphasis',
  displayName: 'Press Feedback',
  intent: 'A control compresses under the press and springs back on release.',
  tags: [...PRODUCT_TAGS, 'micro', 'press'],
  energy: [0.3, 0.8],
  dimensionality: '2d',
  params: { depth: { kind: 'number', default: 0.97, min: 0.92, max: 0.995 } },
  roles: ['cta', 'list', 'mark'],
  requires: ['set_spring'],
  minDurationMs: 150,
  maxDurationMs: 600,
  approxLayerCount: 0,
  approxToolCalls: 4,
  antipatterns: { neverUnderMs: 130, maxPerComposition: 6 },
  variants: 2,
  markers: ['overshoot', 'cross_property_offset', 'explicit_bezier', 'follow_through'],
  emit(ctx, p, seed) {
    const rng = mulberry32(seed);
    const calls: ToolCall[] = [];
    const ids = rolesTargets(ctx, this.roles).slice(0, 1);
    if (!ids.length) return calls;
    const id = ids[0]!;
    const depth = p.depth as number;
    const down = UI_LIMITS.pressMs;

    // Down is FAST and linear-feeling (`stiff`); up is a spring. That asymmetry
    // is the whole feel: a press that eases down feels laggy, and a release that
    // snaps feels brittle.
    calls.push(spring(id, 'scale', { from: 1, to: depth, atMs: ctx.startMs, preset: 'stiff', maxMs: down }));
    calls.push(spring(id, 'scale', { from: depth, to: 1, atMs: ctx.startMs + down, preset: 'snappy' }));
    // The shadow follows, one frame later and on a GENTLE spring — a bouncing
    // shadow reads as a rendering fault. Per-property springs exist for this.
    calls.push(
      spring(id, 'y', { from: 0, to: 1, atMs: ctx.startMs + ctx.frameMs, preset: 'gentle', maxMs: down }),
    );
    calls.push(
      spring(id, 'y', { from: 1, to: 0, atMs: ctx.startMs + down + ctx.frameMs, preset: 'gentle' }),
    );
    void rng;
    return calls;
  },
};

// ── ui.hover_lift ─────────────────────────────────────────────────────

export const hoverLift: TechniqueDef = {
  id: 'ui.hover_lift',
  category: 'emphasis',
  displayName: 'Hover Lift',
  intent: 'A card rises one elevation step on hover. No scale — desktop UI does not grow.',
  tags: [...PRODUCT_TAGS, 'micro', 'hover', 'desktop'],
  energy: [0.15, 0.5],
  dimensionality: '2d',
  params: { liftPx: { kind: 'number', default: 3, min: 1, max: 8 } },
  roles: ['list', 'cta'],
  requires: ['set_spring', 'set_shadow_stack'],
  minDurationMs: 150,
  maxDurationMs: 500,
  approxLayerCount: 0,
  approxToolCalls: 4,
  antipatterns: { neverUnderMs: 120, maxPerComposition: 4 },
  variants: 2,
  markers: ['cross_property_offset', 'explicit_bezier', 'follow_through', 'overshoot'],
  emit(ctx, p, seed) {
    const rng = mulberry32(seed);
    const calls: ToolCall[] = [];
    const ids = rolesTargets(ctx, this.roles).slice(0, 2);
    if (!ids.length) return calls;
    const lift = p.liftPx as number;

    ids.forEach((id, i) => {
      const at = ctx.startMs + i * ctx.frameMs * 2;
      // NO scale. A desktop card that grows on hover is a mobile pattern applied
      // to a pointer, and it reads as a toy — the elevation change is the signal.
      calls.push(spring(id, 'y', { from: 0, to: -lift, atMs: at, preset: 'snappy', maxMs: 200 }));
      calls.push(spring(id, 'y', { from: -lift, to: 0, atMs: at + 220, preset: 'gentle' }));
    });
    void rng;
    return calls;
  },
};

// ── ui.shared_element_expand ──────────────────────────────────────────

export const sharedElementExpand: TechniqueDef = {
  id: 'ui.shared_element_expand',
  category: 'transition',
  displayName: 'Shared Element Expand',
  intent: 'A row grows into a detail view — position, size and radius all morphing together.',
  tags: [...PRODUCT_TAGS, 'transition', 'magic-move', 'hero'],
  energy: [0.3, 0.8],
  dimensionality: '2d',
  params: {
    targetScale: { kind: 'number', default: 2.4, min: 1.2, max: 6 },
    radiusFrom: { kind: 'number', default: 6, min: 0, max: 48 },
    radiusTo: { kind: 'number', default: 16, min: 0, max: 64 },
  },
  roles: ['list', 'media', 'mark'],
  requires: ['set_spring', 'update_layer'],
  minDurationMs: 260,
  maxDurationMs: 900,
  approxLayerCount: 0,
  approxToolCalls: 8,
  antipatterns: { neverUnderMs: 240, maxPerComposition: 2 },
  variants: 3,
  markers: ['overshoot', 'cross_property_offset', 'explicit_bezier', 'follow_through'],
  emit(ctx, p, seed) {
    const rng = mulberry32(seed);
    const calls: ToolCall[] = [];
    const ids = rolesTargets(ctx, this.roles).slice(0, 1);
    if (!ids.length) return calls;
    const id = ids[0]!;
    const scaleTo = p.targetScale as number;
    const at = ctx.startMs;

    // Non-uniform scale: a row is wide and short, a detail view is not. Growing
    // uniformly is what makes a hand-built magic move look like a zoom.
    calls.push(spring(id, 'scaleX', { from: 1, to: scaleTo * pick(rng, [0.9, 1, 1.1]), atMs: at, preset: 'snappy' }));
    calls.push(spring(id, 'scaleY', { from: 1, to: scaleTo, atMs: at + ctx.frameMs, preset: 'snappy' }));
    // The radius morphs on a GENTLE spring so it never bounces — a bouncing
    // corner radius is the most visible failure in a magic move.
    calls.push(spring(id, 'cornerRadius', { from: p.radiusFrom as number, to: p.radiusTo as number, atMs: at, preset: 'gentle' }));
    // Y settles LAST — the element commits to its size before its place, and the
    // trailing settle is the follow-through that gives it mass.
    calls.push(spring(id, 'y', { from: 0, to: -Math.min(24, UI_LIMITS.maxTravelPx), atMs: at + ctx.frameMs * 2, preset: 'gentle' }));
    return calls;
  },
};

// ── ui.sheet_present ──────────────────────────────────────────────────

export const sheetPresent: TechniqueDef = {
  id: 'ui.sheet_present',
  category: 'entrance',
  displayName: 'Sheet Present',
  intent: 'A sheet rises from the bottom edge; the content behind it dims and recedes.',
  tags: [...PRODUCT_TAGS, 'sheet', 'modal', 'mobile'],
  energy: [0.25, 0.7],
  dimensionality: '2d',
  params: { dimTo: { kind: 'number', default: 55, min: 0, max: 90 } },
  roles: ['media', 'list', 'background'],
  requires: ['set_spring'],
  minDurationMs: 280,
  maxDurationMs: 900,
  approxLayerCount: 0,
  approxToolCalls: 6,
  antipatterns: { neverUnderMs: 260, maxPerComposition: 2 },
  variants: 2,
  markers: ['overshoot', 'cross_property_offset', 'explicit_bezier', 'follow_through'],
  emit(ctx, p, seed) {
    const rng = mulberry32(seed);
    const calls: ToolCall[] = [];
    const sheetIds = rolesTargets(ctx, ['media', 'list']);
    const behind = rolesTargets(ctx, ['background']);
    if (!sheetIds.length) return calls;
    const at = ctx.startMs;

    sheetIds.slice(0, 1).forEach((id) => {
      // `gentle` — over-damped, no overshoot. A sheet that bounces at the top of
      // its travel reads as a toy, and a large surface is the worst place for it.
      calls.push(spring(id, 'y', { from: ctx.height * 0.6, to: 0, atMs: at, preset: 'gentle', maxMs: BUDGETS.surface.enterMs }));
      calls.push(spring(id, 'opacity', { from: 0, to: 100, atMs: at - ctx.frameMs, preset: 'stiff', maxMs: 160 }));
    });
    behind.slice(0, 1).forEach((id) => {
      // The layer behind recedes AND dims, starting a frame later. Dimming alone
      // reads as a colour change; receding alone reads as a bug.
      calls.push(spring(id, 'opacity', { from: 100, to: p.dimTo as number, atMs: at + ctx.frameMs, preset: 'gentle' }));
      calls.push(spring(id, 'scale', { from: 1, to: 0.97, atMs: at + ctx.frameMs * 2, preset: 'gentle' }));
    });
    void rng;
    return calls;
  },
};

// ── ui.toast_slide ────────────────────────────────────────────────────

export const toastSlide: TechniqueDef = {
  id: 'ui.toast_slide',
  category: 'entrance',
  displayName: 'Toast Slide',
  intent: 'A toast springs in from the edge, dwells, and leaves faster than it arrived.',
  tags: [...PRODUCT_TAGS, 'toast', 'overlay', 'notification'],
  energy: [0.3, 0.75],
  dimensionality: '2d',
  params: { dwellMs: { kind: 'number', default: 1800, min: 600, max: 5000 } },
  roles: ['overline', 'cta', 'mark'],
  requires: ['set_spring'],
  minDurationMs: 900,
  maxDurationMs: 6000,
  approxLayerCount: 0,
  approxToolCalls: 6,
  antipatterns: { neverUnderMs: 800, maxPerComposition: 3 },
  variants: 2,
  markers: ['overshoot', 'cross_property_offset', 'explicit_bezier', 'follow_through'],
  emit(ctx, p, seed) {
    const rng = mulberry32(seed);
    const calls: ToolCall[] = [];
    const ids = rolesTargets(ctx, this.roles).slice(0, 1);
    if (!ids.length) return calls;
    const id = ids[0]!;
    const enter = BUDGETS.overlay.enterMs;
    const exit = BUDGETS.overlay.exitMs;
    const dwell = Math.min(p.dwellMs as number, ctx.durationMs - enter - exit);
    const travel = Math.min(BUDGETS.overlay.travelPx, UI_LIMITS.maxTravelPx);

    calls.push(spring(id, 'y', { from: travel, to: 0, atMs: ctx.startMs, preset: 'snappy', maxMs: enter }));
    calls.push(spring(id, 'opacity', { from: 0, to: 100, atMs: ctx.startMs - ctx.frameMs, preset: 'stiff', maxMs: enter }));

    // The exit is SHORTER than the entrance — 160ms against 260. This is the
    // rule most often broken and the one users feel most: an element leaving is
    // acknowledging something they already did.
    const exitAt = ctx.startMs + enter + dwell;
    calls.push(spring(id, 'opacity', { from: 100, to: 0, atMs: exitAt, preset: 'stiff', maxMs: exit }));
    calls.push(spring(id, 'y', { from: 0, to: travel * 0.6, atMs: exitAt + ctx.frameMs, preset: 'stiff', maxMs: exit }));
    void rng;
    return calls;
  },
};

// ── ui.tab_switch ─────────────────────────────────────────────────────

export const tabSwitch: TechniqueDef = {
  id: 'ui.tab_switch',
  category: 'transition',
  displayName: 'Tab Switch',
  intent: 'The selection indicator slides between tabs; content cross-fades behind it.',
  tags: [...PRODUCT_TAGS, 'tabs', 'navigation'],
  energy: [0.25, 0.7],
  dimensionality: '2d',
  params: { distancePx: { kind: 'number', default: 96, min: 16, max: 400 } },
  roles: ['rule', 'list'],
  requires: ['set_spring'],
  minDurationMs: 200,
  maxDurationMs: 700,
  approxLayerCount: 0,
  approxToolCalls: 5,
  antipatterns: { neverUnderMs: 180, maxPerComposition: 3 },
  variants: 2,
  markers: ['overshoot', 'cross_property_offset', 'explicit_bezier', 'follow_through'],
  emit(ctx, p, seed) {
    const rng = mulberry32(seed);
    const calls: ToolCall[] = [];
    const indicator = rolesTargets(ctx, ['rule']).slice(0, 1);
    const content = rolesTargets(ctx, ['list']);
    const dist = p.distancePx as number;
    const at = ctx.startMs;

    indicator.forEach((id) => {
      calls.push(spring(id, 'x', { from: 0, to: dist, atMs: at, preset: 'snappy', maxMs: BUDGETS.control.enterMs }));
      // The indicator STRETCHES as it travels and settles back — the detail that
      // makes it read as elastic rather than as a sliding rectangle.
      calls.push(spring(id, 'scaleX', { from: 1, to: 1.25, atMs: at, preset: 'stiff', maxMs: 120 }));
      calls.push(spring(id, 'scaleX', { from: 1.25, to: 1, atMs: at + 120, preset: 'snappy' }));
    });
    content.slice(0, 2).forEach((id, i) => {
      calls.push(spring(id, 'opacity', {
        from: i === 0 ? 100 : 0, to: i === 0 ? 0 : 100,
        atMs: at + i * ctx.frameMs * 2, preset: 'stiff', maxMs: BUDGETS.content.enterMs,
      }));
    });
    void rng;
    return calls;
  },
};

// ── ui.skeleton_resolve ───────────────────────────────────────────────

export const skeletonResolve: TechniqueDef = {
  id: 'ui.skeleton_resolve',
  category: 'transition',
  displayName: 'Skeleton Resolve',
  intent: 'Placeholders shimmer, then content crossfades in with a tight stagger down the list.',
  tags: [...PRODUCT_TAGS, 'loading', 'skeleton'],
  energy: [0.2, 0.6],
  dimensionality: '2d',
  params: { shimmerMs: { kind: 'number', default: 900, min: 300, max: 3000 } },
  roles: ['list', 'stat'],
  requires: ['set_spring', 'set_keyframes'],
  minDurationMs: 500,
  maxDurationMs: 3000,
  approxLayerCount: 0,
  approxToolCalls: 8,
  antipatterns: { neverUnderMs: 450, maxPerComposition: 2 },
  variants: 2,
  markers: ['cross_property_offset', 'nonuniform_stagger', 'explicit_bezier', 'follow_through'],
  emit(ctx, p, seed) {
    const rng = mulberry32(seed);
    const calls: ToolCall[] = [];
    const ids = rolesTargets(ctx, this.roles);
    if (!ids.length) return calls;
    const shimmer = p.shimmerMs as number;

    ids.forEach((id, i) => {
      // The shimmer is a real oscillation, not a fade — three keyframes so it
      // pulses rather than dimming once.
      calls.push(
        mk('set_keyframes', {
          keyframes: [
            { nodeId: id, prop: 'opacity', t: sec(ctx.startMs), value: 40, easing: 'bezier', bezier: [0.4, 0, 0.6, 1] },
            { nodeId: id, prop: 'opacity', t: sec(ctx.startMs + shimmer * 0.45), value: 75, easing: 'bezier', bezier: [0.4, 0, 0.6, 1] },
            { nodeId: id, prop: 'opacity', t: sec(ctx.startMs + shimmer * 0.9), value: 40, easing: 'bezier', bezier: [0.4, 0, 0.6, 1] },
          ],
        }),
      );
      // Content arrives on the tight UI stagger, not an editorial one.
      const at = ctx.startMs + shimmer + listStaggerAt(i, ids.length, 30);
      calls.push(spring(id, 'opacity', { from: 40, to: 100, atMs: at, preset: 'stiff', maxMs: BUDGETS.content.enterMs }));
      calls.push(spring(id, 'y', { from: 6, to: 0, atMs: at + ctx.frameMs, preset: 'gentle', maxMs: BUDGETS.content.enterMs }));
    });
    void rng;
    return calls;
  },
};

// ── ui.chart_draw_on ──────────────────────────────────────────────────

export const chartDrawOn: TechniqueDef = {
  id: 'ui.chart_draw_on',
  category: 'entrance',
  displayName: 'Chart Draw On',
  intent: 'A line traces itself; bars grow from the baseline on a tight stagger.',
  tags: [...PRODUCT_TAGS, 'chart', 'data'],
  energy: [0.25, 0.7],
  dimensionality: '2d',
  params: { drawMs: { kind: 'number', default: 700, min: 200, max: 2400 } },
  roles: ['stat', 'list', 'media'],
  requires: ['set_trim_path', 'set_keyframes', 'set_spring'],
  minDurationMs: 300,
  maxDurationMs: 2600,
  approxLayerCount: 0,
  approxToolCalls: 8,
  antipatterns: { neverUnderMs: 280, maxPerComposition: 2 },
  variants: 2,
  markers: ['cross_property_offset', 'nonuniform_stagger', 'explicit_bezier', 'overshoot'],
  emit(ctx, p, seed) {
    const rng = mulberry32(seed);
    const calls: ToolCall[] = [];
    const ids = rolesTargets(ctx, this.roles);
    if (!ids.length) return calls;
    const draw = p.drawMs as number;

    ids.forEach((id, i) => {
      const at = ctx.startMs + listStaggerAt(i, ids.length, 45);
      // Bars grow from the BASELINE (scaleY from 0), never fade in — a bar chart
      // that fades has no relationship to its axis.
      calls.push(spring(id, 'scaleY', { from: 0, to: 1, atMs: at, preset: 'snappy', maxMs: draw }));
      calls.push(
        mk('set_keyframes', {
          keyframes: [
            { nodeId: id, prop: 'pathOp.trimEnd', t: sec(at), value: 0, easing: 'bezier', bezier: [0.16, 1, 0.3, 1] },
            { nodeId: id, prop: 'pathOp.trimEnd', t: sec(at + draw), value: 100, easing: 'bezier', bezier: [0.16, 1, 0.3, 1] },
          ],
        }),
      );
      calls.push(spring(id, 'opacity', { from: 0, to: 100, atMs: at - ctx.frameMs, preset: 'stiff', maxMs: 140 }));
    });
    void rng;
    return calls;
  },
};

// ── ui.focus_ring ─────────────────────────────────────────────────────

export const focusRing: TechniqueDef = {
  id: 'ui.focus_ring',
  category: 'emphasis',
  displayName: 'Focus Ring',
  intent: 'A ring expands out of the control on focus, never a hard on/off toggle.',
  tags: [...PRODUCT_TAGS, 'micro', 'focus', 'a11y'],
  energy: [0.15, 0.5],
  dimensionality: '2d',
  params: {},
  roles: ['cta', 'list'],
  requires: ['set_spring'],
  minDurationMs: 150,
  maxDurationMs: 500,
  approxLayerCount: 0,
  approxToolCalls: 4,
  antipatterns: { neverUnderMs: 120, maxPerComposition: 4 },
  variants: 2,
  markers: ['overshoot', 'cross_property_offset', 'explicit_bezier', 'follow_through'],
  emit(ctx, _p, seed) {
    const rng = mulberry32(seed);
    const calls: ToolCall[] = [];
    const ids = rolesTargets(ctx, this.roles).slice(0, 1);
    if (!ids.length) return calls;
    const id = ids[0]!;

    // Grows FROM the control rather than appearing around it. A ring that snaps
    // on is the accessibility affordance done as an afterthought.
    calls.push(spring(id, 'scale', { from: 0.94, to: 1, atMs: ctx.startMs, preset: 'gentle', maxMs: BUDGETS.control.enterMs }));
    calls.push(spring(id, 'opacity', { from: 0, to: 100, atMs: ctx.startMs - ctx.frameMs, preset: 'stiff', maxMs: 120 }));
    calls.push(spring(id, 'scale', { from: 1, to: 0.94, atMs: ctx.startMs + 400, preset: 'gentle', maxMs: BUDGETS.control.exitMs }));
    void rng;
    return calls;
  },
};

// ── ui.toggle_flip ────────────────────────────────────────────────────

export const toggleFlip: TechniqueDef = {
  id: 'ui.toggle_flip',
  category: 'emphasis',
  displayName: 'Toggle Flip',
  intent: 'The knob springs across; the track colour crossfades on a different curve.',
  tags: [...PRODUCT_TAGS, 'micro', 'toggle', 'switch'],
  energy: [0.3, 0.75],
  dimensionality: '2d',
  params: { travelPx: { kind: 'number', default: 20, min: 8, max: 32 } },
  roles: ['cta', 'mark'],
  requires: ['set_spring'],
  minDurationMs: 150,
  maxDurationMs: 500,
  approxLayerCount: 0,
  approxToolCalls: 5,
  antipatterns: { neverUnderMs: 130, maxPerComposition: 4 },
  variants: 2,
  markers: ['overshoot', 'cross_property_offset', 'explicit_bezier', 'follow_through'],
  emit(ctx, p, seed) {
    const rng = mulberry32(seed);
    const calls: ToolCall[] = [];
    const ids = rolesTargets(ctx, this.roles).slice(0, 1);
    if (!ids.length) return calls;
    const id = ids[0]!;
    const travel = Math.min(p.travelPx as number, UI_LIMITS.maxTravelPx);

    // The knob is SNAPPY and the track is GENTLE — two different springs on two
    // channels of the same control. Running both on one curve is what makes a
    // hand-built toggle feel like a slider.
    calls.push(spring(id, 'x', { from: 0, to: travel, atMs: ctx.startMs, preset: 'snappy', maxMs: BUDGETS.control.enterMs }));
    // The knob also squashes slightly as it launches — under 4%, the UI ceiling.
    calls.push(spring(id, 'scaleX', { from: 1, to: 1.035, atMs: ctx.startMs, preset: 'stiff', maxMs: 90 }));
    calls.push(spring(id, 'scaleX', { from: 1.035, to: 1, atMs: ctx.startMs + 90, preset: 'gentle' }));
    void rng;
    return calls;
  },
};

// ── ui.count_up ───────────────────────────────────────────────────────

export const countUp: TechniqueDef = {
  id: 'ui.count_up',
  category: 'emphasis',
  displayName: 'Counter Roll',
  intent: 'A number rolls to its value on an ease-out, with the tile settling behind it.',
  tags: [...PRODUCT_TAGS, 'stat', 'counter', 'data'],
  energy: [0.2, 0.6],
  dimensionality: '2d',
  params: { rollMs: { kind: 'number', default: 800, min: 250, max: 2400 } },
  roles: ['stat'],
  requires: ['text_animator', 'set_spring'],
  minDurationMs: 300,
  maxDurationMs: 2600,
  approxLayerCount: 0,
  approxToolCalls: 6,
  antipatterns: { neverUnderMs: 280, maxPerComposition: 3 },
  variants: 2,
  markers: ['overshoot', 'cross_property_offset', 'nonuniform_stagger', 'explicit_bezier'],
  emit(ctx, p, seed) {
    const rng = mulberry32(seed);
    const calls: ToolCall[] = [];
    const ids = rolesTargets(ctx, this.roles);
    if (!ids.length) return calls;
    const roll = p.rollMs as number;

    ids.forEach((id, i) => {
      const at = ctx.startMs + listStaggerAt(i, ids.length, 45);
      // The digit roll — never a linear tick. `characterOffset` sweeping back to
      // zero is the mechanism; a linear counter is the giveaway.
      calls.push(
        mk('text_animator', {
          nodeId: id, basedOn: 'characters', shape: 'rampUp', start: 0, end: 100,
          characterOffset: 6, y: -4,
          sweep: { fromSec: sec(at), toSec: sec(at + roll), fromOffset: -100, toOffset: 100, easing: 'bezier', bezier: [0.16, 1, 0.3, 1] },
        }),
      );
      calls.push(spring(id, 'scale', { from: 0.98, to: 1, atMs: at, preset: 'snappy', maxMs: BUDGETS.content.enterMs }));
      calls.push(spring(id, 'opacity', { from: 0, to: 100, atMs: at - ctx.frameMs, preset: 'stiff', maxMs: 140 }));
    });
    void rng;
    return calls;
  },
};

// ── ui.momentum_scroll ────────────────────────────────────────────────

export const momentumScrollTechnique: TechniqueDef = {
  id: 'ui.momentum_scroll',
  category: 'transition',
  displayName: 'Momentum Scroll',
  intent: 'Content flings and decelerates, rubber-banding at the bound.',
  tags: [...PRODUCT_TAGS, 'scroll', 'gesture', 'mobile'],
  energy: [0.3, 0.8],
  dimensionality: '2d',
  params: { distancePx: { kind: 'number', default: 320, min: 40, max: 1600 }, atBound: { kind: 'boolean', default: true } },
  roles: ['list', 'media'],
  requires: ['set_spring'],
  minDurationMs: 400,
  maxDurationMs: 2000,
  approxLayerCount: 0,
  approxToolCalls: 4,
  antipatterns: { neverUnderMs: 350, maxPerComposition: 2 },
  variants: 2,
  markers: ['overshoot', 'cross_property_offset', 'explicit_bezier', 'follow_through'],
  emit(ctx, p, seed) {
    const rng = mulberry32(seed);
    const calls: ToolCall[] = [];
    const ids = rolesTargets(ctx, this.roles).slice(0, 1);
    if (!ids.length) return calls;
    const id = ids[0]!;
    const dist = p.distancePx as number;
    const at = ctx.startMs;

    if (p.atBound as boolean) {
      const overshoot = dist * 0.06;
      // Past the bound and back. `bouncy` is correct HERE and almost nowhere else
      // in product motion — a rubber band is a spring and the user expects it.
      calls.push(spring(id, 'y', { from: 0, to: -dist - overshoot, atMs: at, preset: 'molasses' }));
      calls.push(spring(id, 'y', { from: -dist - overshoot, to: -dist, atMs: at + 280, preset: 'bouncy' }));
    } else {
      calls.push(spring(id, 'y', { from: 0, to: -dist, atMs: at, preset: 'molasses' }));
    }
    // A trace of scale as the fling decelerates — the list compresses very
    // slightly under its own momentum.
    calls.push(spring(id, 'scale', { from: 1, to: 0.995, atMs: at + ctx.frameMs, preset: 'gentle', maxMs: 200 }));
    calls.push(spring(id, 'scale', { from: 0.995, to: 1, atMs: at + 300, preset: 'gentle' }));
    void rng;
    return calls;
  },
};

// ── ui.tooltip_appear / ui.bubble_pop / ui.type_on / ui.progress_fill ──

export const tooltipAppear: TechniqueDef = {
  id: 'ui.tooltip_appear',
  category: 'entrance',
  displayName: 'Tooltip Appear',
  intent: 'A tooltip scales out of its anchor point after a deliberate delay.',
  tags: [...PRODUCT_TAGS, 'overlay', 'tooltip', 'micro'],
  energy: [0.15, 0.5],
  dimensionality: '2d',
  params: { delayMs: { kind: 'number', default: 400, min: 0, max: 1200 } },
  roles: ['overline', 'mark'],
  requires: ['set_spring'],
  minDurationMs: 200,
  maxDurationMs: 900,
  approxLayerCount: 0,
  approxToolCalls: 4,
  antipatterns: { neverUnderMs: 180, maxPerComposition: 4 },
  variants: 2,
  markers: ['overshoot', 'cross_property_offset', 'explicit_bezier', 'follow_through'],
  emit(ctx, p, seed) {
    const rng = mulberry32(seed);
    const calls: ToolCall[] = [];
    const ids = rolesTargets(ctx, this.roles).slice(0, 1);
    if (!ids.length) return calls;
    const id = ids[0]!;
    // The delay is the point. A tooltip that appears instantly fires constantly
    // as the pointer crosses the interface.
    const at = ctx.startMs + (p.delayMs as number);
    calls.push(spring(id, 'scale', { from: 0.9, to: 1, atMs: at, preset: 'snappy', maxMs: BUDGETS.overlay.enterMs }));
    calls.push(spring(id, 'opacity', { from: 0, to: 100, atMs: at - ctx.frameMs, preset: 'stiff', maxMs: 120 }));
    calls.push(spring(id, 'opacity', { from: 100, to: 0, atMs: at + 900, preset: 'stiff', maxMs: BUDGETS.overlay.exitMs }));
    void rng;
    return calls;
  },
};

export const bubblePop: TechniqueDef = {
  id: 'ui.bubble_pop',
  category: 'entrance',
  displayName: 'Bubble Pop',
  intent: 'A chat bubble springs in from its own corner, scaling from the sender side.',
  tags: [...PRODUCT_TAGS, 'chat', 'message'],
  energy: [0.3, 0.75],
  dimensionality: '2d',
  params: {},
  roles: ['list', 'overline'],
  requires: ['set_spring'],
  minDurationMs: 200,
  maxDurationMs: 900,
  approxLayerCount: 0,
  approxToolCalls: 6,
  antipatterns: { neverUnderMs: 180, maxPerComposition: 4 },
  variants: 2,
  markers: ['overshoot', 'cross_property_offset', 'nonuniform_stagger', 'explicit_bezier'],
  emit(ctx, _p, seed) {
    const rng = mulberry32(seed);
    const calls: ToolCall[] = [];
    const ids = rolesTargets(ctx, this.roles);
    if (!ids.length) return calls;
    ids.forEach((id, i) => {
      const at = ctx.startMs + listStaggerAt(i, ids.length, 50);
      calls.push(spring(id, 'scale', { from: 0.92, to: 1, atMs: at, preset: 'snappy', maxMs: BUDGETS.container.enterMs }));
      calls.push(spring(id, 'opacity', { from: 0, to: 100, atMs: at - ctx.frameMs, preset: 'stiff', maxMs: 130 }));
      calls.push(spring(id, 'y', { from: 8, to: 0, atMs: at + ctx.frameMs, preset: 'snappy', maxMs: BUDGETS.container.enterMs }));
    });
    void rng;
    return calls;
  },
};

export const typeOn: TechniqueDef = {
  id: 'ui.type_on',
  category: 'kinetic_type',
  displayName: 'Terminal Type On',
  intent: 'Text types itself character by character, at a real typing cadence.',
  tags: [...PRODUCT_TAGS, 'code', 'terminal', 'typing'],
  energy: [0.2, 0.6],
  dimensionality: '2d',
  params: { charsPerSec: { kind: 'number', default: 22, min: 6, max: 60 } },
  roles: ['list', 'overline', 'support'],
  requires: ['text_animator'],
  minDurationMs: 400,
  maxDurationMs: 6000,
  approxLayerCount: 0,
  approxToolCalls: 4,
  antipatterns: { neverUnderMs: 350, maxPerComposition: 3 },
  variants: 2,
  markers: ['cross_property_offset', 'nonuniform_stagger', 'explicit_bezier', 'subframe_care'],
  emit(ctx, p, seed) {
    const rng = mulberry32(seed);
    const calls: ToolCall[] = [];
    const ids = rolesTargets(ctx, this.roles);
    if (!ids.length) return calls;
    const cps = p.charsPerSec as number;

    ids.forEach((id, i) => {
      const at = ctx.startMs + listStaggerAt(i, ids.length, 55) + ctx.frameMs * 0.5;
      const dur = Math.min((28 / cps) * 1000, ctx.durationMs * 0.8);
      calls.push(
        mk('text_animator', {
          nodeId: id, basedOn: 'characters',
          // `square`, not a ramp: a character is either typed or it is not. A
          // soft falloff makes the leading characters translucent, which no
          // terminal has ever done.
          shape: 'square', start: 0, end: 100, opacity: 0,
          sweep: { fromSec: sec(at), toSec: sec(at + dur), fromOffset: -100, toOffset: 100, easing: 'linear' },
        }),
      );
      calls.push(spring(id, 'opacity', { from: 0, to: 100, atMs: at - ctx.frameMs, preset: 'stiff', maxMs: 100 }));
    });
    void rng;
    return calls;
  },
};

export const progressFill: TechniqueDef = {
  id: 'ui.progress_fill',
  category: 'emphasis',
  displayName: 'Progress Fill',
  intent: 'A progress bar fills with a spring, easing into completion rather than stopping.',
  tags: [...PRODUCT_TAGS, 'progress', 'loading'],
  energy: [0.2, 0.6],
  dimensionality: '2d',
  params: { toPercent: { kind: 'number', default: 100, min: 1, max: 100 } },
  roles: ['rule', 'stat'],
  requires: ['set_spring'],
  minDurationMs: 300,
  maxDurationMs: 2400,
  approxLayerCount: 0,
  approxToolCalls: 3,
  antipatterns: { neverUnderMs: 280, maxPerComposition: 3 },
  variants: 2,
  markers: ['overshoot', 'cross_property_offset', 'explicit_bezier', 'follow_through'],
  emit(ctx, p, seed) {
    const rng = mulberry32(seed);
    const calls: ToolCall[] = [];
    const ids = rolesTargets(ctx, this.roles).slice(0, 1);
    if (!ids.length) return calls;
    const id = ids[0]!;
    const to = (p.toPercent as number) / 100;
    calls.push(spring(id, 'scaleX', { from: 0, to, atMs: ctx.startMs, preset: 'gentle' }));
    calls.push(spring(id, 'opacity', { from: 0, to: 100, atMs: ctx.startMs - ctx.frameMs, preset: 'stiff', maxMs: 120 }));
    // A small settle after completion — the bar acknowledges finishing.
    calls.push(spring(id, 'scaleY', { from: 1, to: 1.02, atMs: ctx.startMs + 600, preset: 'snappy', maxMs: 160 }));
    void rng;
    return calls;
  },
};

import { PRODUCT_TECHNIQUES_2 } from './techniques2';
import { PRODUCT_TECHNIQUES_3 } from './techniques3';

export const PRODUCT_TECHNIQUES: readonly TechniqueDef[] = [
  listStaggerIn,
  pressFeedback,
  hoverLift,
  sharedElementExpand,
  sheetPresent,
  toastSlide,
  tabSwitch,
  skeletonResolve,
  chartDrawOn,
  focusRing,
  toggleFlip,
  countUp,
  momentumScrollTechnique,
  tooltipAppear,
  bubblePop,
  typeOn,
  progressFill,
  ...PRODUCT_TECHNIQUES_2,
  ...PRODUCT_TECHNIQUES_3,
];
