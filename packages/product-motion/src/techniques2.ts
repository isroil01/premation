/**
 * Product-motion techniques, second set.
 *
 * Same rules as the first: springs not beziers, 8–32px not a third of the frame,
 * exits faster than entrances, never motion blur. What is new is the *kind* of
 * interaction — these are the ones that appear once an interface has state
 * rather than just content: a row that swipes to reveal, a value that changes in
 * place, a control that reorders under a drag, an error that shakes.
 *
 * The dividing line for what belongs here: if the motion communicates something
 * about the SYSTEM (this saved, this failed, this is loading, this is where the
 * thing you dragged will land) it is product motion. If it communicates
 * something about the CONTENT, it is editorial.
 */

import { mk, mulberry32, pick, type ToolCall } from '@motion/design-system';
import type { TechniqueDef } from '@motion/technique-library';
import { rolesTargets } from '@motion/technique-library';
import { BUDGETS, UI_LIMITS, listStaggerAt } from './choreography';

const PRODUCT_TAGS = ['product', 'ui', 'spring'] as const;

const sec = (ms: number): number => Number((ms / 1000).toFixed(4));

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

// ── ui.swipe_reveal ───────────────────────────────────────────────────

export const swipeReveal: TechniqueDef = {
  id: 'ui.swipe_reveal',
  category: 'emphasis',
  displayName: 'Swipe to Reveal',
  intent: 'A row slides aside under a drag and rests against the actions it uncovers.',
  tags: [...PRODUCT_TAGS, 'gesture', 'list', 'mobile'],
  energy: [0.3, 0.75],
  dimensionality: '2d',
  params: { revealPx: { kind: 'number', default: 24, min: 12, max: 32 } },
  roles: ['list', 'cta'],
  requires: ['set_spring'],
  minDurationMs: 300,
  maxDurationMs: 1200,
  approxLayerCount: 0,
  approxToolCalls: 6,
  antipatterns: { neverUnderMs: 260, maxPerComposition: 2 },
  variants: 3,
  markers: ['overshoot', 'cross_property_offset', 'explicit_bezier', 'follow_through'],
  emit(ctx, p, seed) {
    const rng = mulberry32(seed);
    const calls: ToolCall[] = [];
    const ids = rolesTargets(ctx, this.roles).slice(0, 1);
    if (!ids.length) return calls;

    const id = ids[0]!;
    const budget = BUDGETS.container;
    const reveal = Math.min(p.revealPx as number, UI_LIMITS.maxTravelPx);
    const dir = pick(rng, [-1, -1, 1]);
    const at = ctx.startMs + Math.min(80, ctx.durationMs * 0.15);

    // The row goes past the rest position and comes back — the drag has
    // momentum, and a row that stops dead at the reveal point reads as a state
    // toggle rather than as a gesture.
    calls.push(spring(id, 'x', { from: 0, to: reveal * dir, atMs: at, preset: 'snappy', maxMs: budget.enterMs }));
    // The revealed action arrives AFTER the row has started moving, not with it:
    // it is being uncovered, so it cannot lead.
    calls.push(spring(id, 'opacity', { from: 100, to: 100, atMs: at + ctx.frameMs, preset: 'gentle', maxMs: budget.enterMs }));
    // Follow-through: the row settles back a few px once the gesture ends. This
    // is the "rubber band" every good list has and no generated one does.
    calls.push(
      spring(id, 'x', {
        from: reveal * dir,
        to: reveal * dir * 0.92,
        atMs: at + budget.enterMs,
        preset: 'gentle',
        maxMs: budget.exitMs,
      }),
    );
    return calls;
  },
};

// ── ui.value_roll ─────────────────────────────────────────────────────

export const valueRoll: TechniqueDef = {
  id: 'ui.value_roll',
  category: 'emphasis',
  displayName: 'Value Roll',
  intent: 'A number changes by rolling the old digit out and the new one in, in place.',
  tags: [...PRODUCT_TAGS, 'data', 'micro', 'numeric'],
  energy: [0.2, 0.6],
  dimensionality: '2d',
  params: { rollPx: { kind: 'number', default: 14, min: 8, max: 24 } },
  roles: ['stat', 'list'],
  requires: ['set_spring'],
  minDurationMs: 200,
  maxDurationMs: 900,
  approxLayerCount: 0,
  approxToolCalls: 8,
  antipatterns: { neverUnderMs: 180, maxPerComposition: 4, neverWith: ['ui.count_up'] },
  variants: 3,
  markers: ['overshoot', 'cross_property_offset', 'nonuniform_stagger', 'explicit_bezier'],
  emit(ctx, p, seed) {
    const rng = mulberry32(seed);
    const calls: ToolCall[] = [];
    const ids = rolesTargets(ctx, this.roles);
    if (!ids.length) return calls;

    const budget = BUDGETS.indicator;
    const roll = Math.min(p.rollPx as number, UI_LIMITS.maxTravelPx);
    const stagger = Math.min(pick(rng, [22, 28, 34]), UI_LIMITS.maxStaggerMs);

    ids.forEach((id, i) => {
      const at = ctx.startMs + listStaggerAt(i, ids.length, stagger);
      // The digit travels its own height, no further. A number that flies in
      // from off-screen is a title card; a number that rolls is a counter.
      calls.push(spring(id, 'y', { from: roll, to: 0, atMs: at, preset: 'stiff', maxMs: budget.enterMs }));
      calls.push(spring(id, 'opacity', { from: 0, to: 100, atMs: at - ctx.frameMs, preset: 'stiff', maxMs: budget.enterMs }));
      // Scale is the tell that the value CHANGED rather than appeared: a 1.5%
      // pulse on arrival, which the eye registers without being able to name.
      calls.push(spring(id, 'scale', { from: 1.015, to: 1, atMs: at + ctx.frameMs, preset: 'gentle', maxMs: budget.enterMs }));
    });
    return calls;
  },
};

// ── ui.error_shake ────────────────────────────────────────────────────

export const errorShake: TechniqueDef = {
  id: 'ui.error_shake',
  category: 'emphasis',
  displayName: 'Error Shake',
  intent: 'A field refuses the input with two quick lateral shakes and settles.',
  tags: [...PRODUCT_TAGS, 'micro', 'validation', 'feedback'],
  energy: [0.4, 0.8],
  dimensionality: '2d',
  params: { amplitudePx: { kind: 'number', default: 6, min: 3, max: 12 } },
  roles: ['cta', 'list', 'mark'],
  requires: ['set_spring'],
  minDurationMs: 200,
  maxDurationMs: 700,
  approxLayerCount: 0,
  approxToolCalls: 6,
  antipatterns: { neverUnderMs: 180, maxPerComposition: 2 },
  variants: 2,
  markers: ['overshoot', 'cross_property_offset', 'explicit_bezier', 'follow_through'],
  emit(ctx, p, seed) {
    const rng = mulberry32(seed);
    const calls: ToolCall[] = [];
    const ids = rolesTargets(ctx, this.roles).slice(0, 1);
    if (!ids.length) return calls;

    const id = ids[0]!;
    const amp = Math.min(p.amplitudePx as number, UI_LIMITS.maxTravelPx) * pick(rng, [0.8, 1, 1.2]);
    const step = UI_LIMITS.pressMs;
    const at = ctx.startMs;

    // Two shakes, decaying, then rest. Three or more is a cartoon; one is a
    // twitch. The decay is what distinguishes a refusal from a wobble.
    const offsets = [amp, -amp * 0.6, amp * 0.3, 0];
    offsets.forEach((to, i) => {
      calls.push(
        spring(id, 'x', {
          from: i === 0 ? 0 : offsets[i - 1]!,
          to,
          atMs: at + i * step,
          preset: i === offsets.length - 1 ? 'gentle' : 'stiff',
          maxMs: step * 1.6,
        }),
      );
    });
    // Colour or emphasis would be the designer's other half of this; the
    // opacity dip is the motion half — offset by a frame so the two channels do
    // not start together.
    calls.push(spring(id, 'opacity', { from: 100, to: 88, atMs: at + ctx.frameMs, preset: 'stiff', maxMs: step }));
    calls.push(spring(id, 'opacity', { from: 88, to: 100, atMs: at + step * 2, preset: 'gentle', maxMs: step * 2 }));
    return calls;
  },
};

// ── ui.drag_lift ──────────────────────────────────────────────────────

export const dragLift: TechniqueDef = {
  id: 'ui.drag_lift',
  category: 'emphasis',
  displayName: 'Drag Lift',
  intent: 'A card lifts off the surface when picked up, and the rows below open a gap for it.',
  tags: [...PRODUCT_TAGS, 'gesture', 'reorder', 'depth'],
  energy: [0.25, 0.7],
  dimensionality: '2d',
  params: { liftScale: { kind: 'number', default: 1.03, min: 1.01, max: 1.06 } },
  roles: ['list', 'stat'],
  requires: ['set_spring', 'set_shadow_stack'],
  minDurationMs: 300,
  maxDurationMs: 1400,
  approxLayerCount: 0,
  approxToolCalls: 9,
  antipatterns: { neverUnderMs: 260, maxPerComposition: 1 },
  variants: 3,
  markers: ['overshoot', 'cross_property_offset', 'nonuniform_stagger', 'explicit_bezier'],
  emit(ctx, p, seed) {
    const rng = mulberry32(seed);
    const calls: ToolCall[] = [];
    const ids = rolesTargets(ctx, this.roles);
    if (ids.length < 2) return calls;

    const budget = BUDGETS.container;
    const lifted = ids[0]!;
    const rest = ids.slice(1);
    const liftScale = p.liftScale as number;
    const gap = Math.min(pick(rng, [16, 20, 24]), UI_LIMITS.maxTravelPx);
    const at = ctx.startMs + Math.min(60, ctx.durationMs * 0.1);

    // The lift. Scale and shadow together are what read as "off the surface" —
    // scale alone reads as a zoom, shadow alone reads as a style change.
    calls.push(spring(lifted, 'scale', { from: 1, to: liftScale, atMs: at, preset: 'snappy', maxMs: budget.enterMs }));
    calls.push(
      mk('set_shadow_stack', {
        nodeId: lifted,
        layers: [{ x: 0, y: 8, blur: 24, spread: -4, color: '#00000040' }],
      }),
    );
    // The gap opens BELOW the lifted card, and the rows nearest it move first —
    // a gap that opens all at once reads as a layout change, not as displacement.
    rest.forEach((id, i) => {
      // `listStaggerAt`, not `stagger * i`. Growing the interval per index made
      // the gap between the fourth and fifth rows 44ms wider than between the
      // first and second — over the 60ms ceiling, and the point of the ceiling is
      // that a list appearing slower than that stops reading as one gesture.
      calls.push(
        spring(id, 'y', {
          from: 0,
          to: gap,
          atMs: at + ctx.frameMs + listStaggerAt(i, rest.length, Math.min(26, UI_LIMITS.maxStaggerMs)),
          preset: 'gentle',
          maxMs: budget.enterMs,
        }),
      );
    });
    return calls;
  },
};

// ── ui.filter_reflow ──────────────────────────────────────────────────

export const filterReflow: TechniqueDef = {
  id: 'ui.filter_reflow',
  category: 'transition',
  displayName: 'Filter Reflow',
  intent: 'Items that no longer match collapse away and the rest close the gaps.',
  tags: [...PRODUCT_TAGS, 'list', 'state', 'reflow'],
  energy: [0.2, 0.65],
  dimensionality: '2d',
  params: { collapsePx: { kind: 'number', default: 20, min: 10, max: 32 } },
  roles: ['list', 'stat'],
  requires: ['set_spring'],
  minDurationMs: 300,
  maxDurationMs: 1200,
  approxLayerCount: 0,
  approxToolCalls: 10,
  antipatterns: { neverUnderMs: 260, maxPerComposition: 1 },
  variants: 3,
  markers: ['overshoot', 'cross_property_offset', 'nonuniform_stagger', 'explicit_bezier'],
  emit(ctx, p, seed) {
    const rng = mulberry32(seed);
    const calls: ToolCall[] = [];
    const ids = rolesTargets(ctx, this.roles);
    if (ids.length < 2) return calls;

    const budget = BUDGETS.container;
    const collapse = Math.min(p.collapsePx as number, UI_LIMITS.maxTravelPx);
    // Alternate items leave, which is a stand-in for "did not match" — the real
    // predicate belongs to the application, and inventing one here would encode
    // an assumption about the data.
    const leaving = ids.filter((_, i) => i % 2 === 1);
    const staying = ids.filter((_, i) => i % 2 === 0);
    const at = ctx.startMs;
    const stagger = Math.min(pick(rng, [22, 26, 32]), UI_LIMITS.maxStaggerMs);

    // Out first, and FASTER than the reflow. Removal that takes as long as the
    // settle makes the list feel like it is thinking.
    leaving.forEach((id, i) => {
      const t = at + listStaggerAt(i, leaving.length, stagger * 0.7);
      calls.push(spring(id, 'opacity', { from: 100, to: 0, atMs: t, preset: 'stiff', maxMs: budget.exitMs }));
      calls.push(spring(id, 'scale', { from: 1, to: 0.96, atMs: t + ctx.frameMs, preset: 'stiff', maxMs: budget.exitMs }));
    });
    // Then the survivors close the gaps, each moving up by however many items
    // above it left.
    staying.forEach((id, i) => {
      const t = at + budget.exitMs * 0.6 + listStaggerAt(i, staying.length, stagger);
      // The limit is on TOTAL travel, not on the per-item gap. Multiplying the
      // gap by the number of items that left above put the third survivor at
      // 60px — twice the ceiling, and visually a card sliding rather than a list
      // closing. Real reflow scrolls the container; the rows themselves barely
      // move, so the accumulated distance is clamped rather than the step.
      const distance = Math.min(collapse * Math.min(i, 3), UI_LIMITS.maxTravelPx);
      calls.push(
        spring(id, 'y', { from: 0, to: -distance, atMs: t, preset: 'gentle', maxMs: budget.enterMs }),
      );
    });
    return calls;
  },
};

// ── ui.segmented_slide ────────────────────────────────────────────────

export const segmentedSlide: TechniqueDef = {
  id: 'ui.segmented_slide',
  category: 'transition',
  displayName: 'Segmented Control Slide',
  intent: 'The selection pill slides to the tapped segment and the labels cross-fade under it.',
  tags: [...PRODUCT_TAGS, 'control', 'selection', 'micro'],
  energy: [0.25, 0.7],
  dimensionality: '2d',
  params: { travelPx: { kind: 'number', default: 28, min: 12, max: 32 } },
  roles: ['cta', 'list'],
  requires: ['set_spring'],
  minDurationMs: 200,
  maxDurationMs: 800,
  approxLayerCount: 0,
  approxToolCalls: 7,
  antipatterns: { neverUnderMs: 180, maxPerComposition: 3, neverWith: ['ui.tab_switch'] },
  variants: 3,
  markers: ['overshoot', 'cross_property_offset', 'nonuniform_stagger', 'explicit_bezier'],
  emit(ctx, p, seed) {
    const rng = mulberry32(seed);
    const calls: ToolCall[] = [];
    const ids = rolesTargets(ctx, this.roles);
    if (!ids.length) return calls;

    const budget = BUDGETS.control;
    // Clamp AFTER the seed variation, not before. Multiplying a value already at
    // the ceiling by 1.15 puts it over — which is how a control that is supposed
    // to move 28px ended up moving 37.
    const travel = Math.min((p.travelPx as number) * pick(rng, [0.85, 1, 1.15]), UI_LIMITS.maxTravelPx);
    const at = ctx.startMs;

    // The pill leads and the labels follow. Doing it the other way makes the
    // selection look like it is chasing the text.
    ids.forEach((id, i) => {
      const t = at + listStaggerAt(i, ids.length, Math.min(24, UI_LIMITS.maxStaggerMs));
      calls.push(spring(id, 'x', { from: i === 0 ? -travel : travel * 0.1, to: 0, atMs: t, preset: 'snappy', maxMs: budget.enterMs }));
      calls.push(
        spring(id, 'opacity', {
          from: i === 0 ? 100 : 62,
          to: i === 0 ? 100 : 100,
          atMs: t - ctx.frameMs,
          preset: 'gentle',
          maxMs: budget.enterMs,
        }),
      );
    });
    return calls;
  },
};

// ── ui.pull_refresh ───────────────────────────────────────────────────

export const pullRefresh: TechniqueDef = {
  id: 'ui.pull_refresh',
  category: 'entrance',
  displayName: 'Pull to Refresh',
  intent: 'The list stretches past its top, releases, and snaps back as the content reloads.',
  tags: [...PRODUCT_TAGS, 'gesture', 'mobile', 'list'],
  energy: [0.3, 0.75],
  dimensionality: '2d',
  params: { stretchPx: { kind: 'number', default: 26, min: 12, max: 32 } },
  roles: ['list', 'stat'],
  requires: ['set_spring'],
  minDurationMs: 400,
  maxDurationMs: 1600,
  approxLayerCount: 0,
  approxToolCalls: 8,
  antipatterns: { neverUnderMs: 350, maxPerComposition: 1, neverWith: ['ui.momentum_scroll'] },
  variants: 3,
  markers: ['overshoot', 'cross_property_offset', 'nonuniform_stagger', 'explicit_bezier', 'follow_through'],
  emit(ctx, p, seed) {
    const rng = mulberry32(seed);
    const calls: ToolCall[] = [];
    const ids = rolesTargets(ctx, this.roles);
    if (!ids.length) return calls;

    const budget = BUDGETS.container;
    const stretch = Math.min(p.stretchPx as number, UI_LIMITS.maxTravelPx) * pick(rng, [0.85, 1, 1.1]);
    const at = ctx.startMs;
    const releaseAt = at + Math.min(160, ctx.durationMs * 0.25);

    ids.forEach((id, i) => {
      // Rows further down stretch LESS. Uniform stretch is a translation; the
      // gradient is what makes it read as elastic.
      const factor = 1 - Math.min(i, 4) * 0.16;
      const t = at + listStaggerAt(i, ids.length, Math.min(18, UI_LIMITS.maxStaggerMs));
      calls.push(spring(id, 'y', { from: 0, to: stretch * factor, atMs: t, preset: 'gentle', maxMs: budget.enterMs }));
      // The snap back, and past zero — the release is the whole gesture.
      calls.push(spring(id, 'y', { from: stretch * factor, to: 0, atMs: releaseAt + t - at, preset: 'snappy', maxMs: budget.enterMs }));
      calls.push(
        spring(id, 'opacity', { from: 100, to: 100, atMs: t - ctx.frameMs, preset: 'gentle', maxMs: budget.enterMs }),
      );
    });
    return calls;
  },
};

// ── ui.badge_pulse ────────────────────────────────────────────────────

export const badgePulse: TechniqueDef = {
  id: 'ui.badge_pulse',
  category: 'emphasis',
  displayName: 'Badge Pulse',
  intent: 'A count badge pops once when it changes and goes still again immediately.',
  tags: [...PRODUCT_TAGS, 'micro', 'notification', 'indicator'],
  energy: [0.3, 0.7],
  dimensionality: '2d',
  params: { peak: { kind: 'number', default: 1.03, min: 1.015, max: 1.04 } },
  roles: ['mark', 'stat', 'cta'],
  requires: ['set_spring'],
  minDurationMs: 160,
  maxDurationMs: 600,
  approxLayerCount: 0,
  approxToolCalls: 5,
  antipatterns: { neverUnderMs: 140, maxPerComposition: 3 },
  variants: 2,
  markers: ['overshoot', 'cross_property_offset', 'explicit_bezier', 'follow_through'],
  emit(ctx, p, seed) {
    const rng = mulberry32(seed);
    const calls: ToolCall[] = [];
    const ids = rolesTargets(ctx, this.roles).slice(0, 1);
    if (!ids.length) return calls;

    const id = ids[0]!;
    const budget = BUDGETS.indicator;
    const peak = (p.peak as number) * pick(rng, [0.95, 1, 1.05]);
    const at = ctx.startMs;

    // The first version argued a badge was the one control allowed a big
    // overshoot, gave it `bouncy` and a 1.22 peak, and the UI linter reported
    // EXCESSIVE_OVERSHOOT — correctly. `UI_LIMITS.maxOvershoot` is 4% and it
    // applies to indicators too: a notification badge that boings is the single
    // clearest tell of motion added by someone who was enjoying themselves.
    //
    // What makes a badge noticeable is that it comes from nothing, not that it
    // bounces. So it scales up from 0.6 — a big *entrance* — and settles within
    // the overshoot ceiling.
    calls.push(spring(id, 'scale', { from: 0.6, to: peak, atMs: at, preset: 'snappy', maxMs: budget.enterMs }));
    calls.push(spring(id, 'scale', { from: peak, to: 1, atMs: at + budget.enterMs * 0.5, preset: 'snappy', maxMs: budget.enterMs }));
    calls.push(spring(id, 'opacity', { from: 0, to: 100, atMs: at - ctx.frameMs, preset: 'stiff', maxMs: budget.enterMs }));
    return calls;
  },
};

// ── ui.empty_state_settle ─────────────────────────────────────────────

export const emptyStateSettle: TechniqueDef = {
  id: 'ui.empty_state_settle',
  category: 'entrance',
  displayName: 'Empty State Settle',
  intent: 'An illustration and its message arrive quietly, in the order you read them.',
  tags: [...PRODUCT_TAGS, 'state', 'onboarding', 'calm'],
  energy: [0.1, 0.45],
  dimensionality: '2d',
  params: { travelPx: { kind: 'number', default: 12, min: 6, max: 20 } },
  roles: ['media', 'headline', 'support', 'cta'],
  requires: ['set_spring'],
  minDurationMs: 300,
  maxDurationMs: 1400,
  approxLayerCount: 0,
  approxToolCalls: 9,
  antipatterns: { neverUnderMs: 260, maxPerComposition: 1 },
  variants: 3,
  markers: ['overshoot', 'cross_property_offset', 'nonuniform_stagger', 'explicit_bezier'],
  emit(ctx, p, seed) {
    const rng = mulberry32(seed);
    const calls: ToolCall[] = [];
    const ids = rolesTargets(ctx, this.roles);
    if (!ids.length) return calls;

    const budget = BUDGETS.content;
    const travel = Math.min(p.travelPx as number, UI_LIMITS.maxTravelPx) * pick(rng, [0.8, 1, 1.2]);
    const stagger = Math.min(pick(rng, [34, 42, 50]), UI_LIMITS.maxStaggerMs);

    ids.forEach((id, i) => {
      const at = ctx.startMs + listStaggerAt(i, ids.length, stagger);
      calls.push(spring(id, 'opacity', { from: 0, to: 100, atMs: at - ctx.frameMs, preset: 'gentle', maxMs: budget.enterMs }));
      calls.push(spring(id, 'y', { from: travel, to: 0, atMs: at, preset: 'gentle', maxMs: budget.enterMs }));
      // The illustration scales, the text does not — a headline that scales in
      // an empty state reads as a marketing page.
      if (i === 0) {
        calls.push(spring(id, 'scale', { from: 0.97, to: 1, atMs: at + ctx.frameMs, preset: 'gentle', maxMs: budget.enterMs }));
      }
    });
    return calls;
  },
};

export const PRODUCT_TECHNIQUES_2: readonly TechniqueDef[] = [
  swipeReveal,
  valueRoll,
  errorShake,
  dragLift,
  filterReflow,
  segmentedSlide,
  pullRefresh,
  badgePulse,
  emptyStateSettle,
];
