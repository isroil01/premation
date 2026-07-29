/**
 * Product-motion techniques, third set — closing the M2 target.
 *
 * Same discipline throughout, and each rule here is a linter failure from an
 * earlier set rather than a preference:
 *
 *  • Travel is clamped AFTER seed variation, never before. Multiplying a value
 *    already at the ceiling by 1.15 puts it over.
 *  • Accumulated distance is what the limit governs, not the per-step gap.
 *  • Stagger comes from `listStaggerAt`; an interval that grows with the index
 *    exceeds the 60ms ceiling by the fourth row.
 *  • `UI_LIMITS.maxOvershoot` is 4% and applies to indicators too. A badge that
 *    boings is the clearest sign of motion added by someone enjoying themselves.
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

/** A technique built from one shared shape, so the set stays consistent. */
function microReveal(
  ctx: Parameters<TechniqueDef['emit']>[0],
  ids: readonly string[],
  o: { travel: number; axis: 'x' | 'y'; stagger: number; budget: (typeof BUDGETS)[keyof typeof BUDGETS]; preset?: string },
): ToolCall[] {
  const calls: ToolCall[] = [];
  ids.forEach((id, i) => {
    const at = ctx.startMs + listStaggerAt(i, ids.length, o.stagger);
    // Opacity leads position by a frame — the same cross-property discipline as
    // editorial, at a quarter of the scale.
    calls.push(spring(id, 'opacity', { from: 0, to: 100, atMs: at - ctx.frameMs, preset: 'stiff', maxMs: o.budget.enterMs }));
    calls.push(spring(id, o.axis, { from: o.travel, to: 0, atMs: at, preset: o.preset ?? 'snappy', maxMs: o.budget.enterMs }));
    calls.push(spring(id, 'scale', { from: 0.985, to: 1, atMs: at + ctx.frameMs, preset: 'gentle', maxMs: o.budget.enterMs }));
  });
  return calls;
}

const def = (
  id: string,
  displayName: string,
  intent: string,
  o: {
    category: TechniqueDef['category'];
    tags: string[];
    energy: [number, number];
    roles: TechniqueDef['roles'];
    techniqueBudget: keyof typeof BUDGETS;
    axis?: 'x' | 'y';
    minDurationMs?: number;
    maxDurationMs?: number;
    maxPerComposition?: number;
    neverWith?: string[];
    preset?: string;
  },
): TechniqueDef => ({
  id,
  category: o.category,
  displayName,
  intent,
  tags: [...PRODUCT_TAGS, ...o.tags],
  energy: o.energy,
  dimensionality: '2d',
  params: { travelPx: { kind: 'number', default: 14, min: 6, max: 32 } },
  roles: o.roles,
  requires: ['set_spring'],
  minDurationMs: o.minDurationMs ?? 240,
  maxDurationMs: o.maxDurationMs ?? 1200,
  approxLayerCount: 0,
  approxToolCalls: 9,
  antipatterns: {
    neverUnderMs: (o.minDurationMs ?? 240) - 40,
    maxPerComposition: o.maxPerComposition ?? 3,
    ...(o.neverWith ? { neverWith: o.neverWith } : {}),
  },
  variants: 3,
  markers: ['overshoot', 'cross_property_offset', 'nonuniform_stagger', 'explicit_bezier'],
  emit(ctx, p, seed) {
    const rng = mulberry32(seed);
    const ids = rolesTargets(ctx, this.roles);
    if (!ids.length) return [];
    // Clamp AFTER the variation, never before — see the file header.
    const travel = Math.min((p.travelPx as number) * pick(rng, [0.8, 1, 1.2]), UI_LIMITS.maxTravelPx);
    const stagger = Math.min(pick(rng, [26, 34, 42]), UI_LIMITS.maxStaggerMs);
    return microReveal(ctx, ids, {
      travel,
      axis: o.axis ?? 'y',
      stagger,
      budget: BUDGETS[o.techniqueBudget],
      ...(o.preset ? { preset: o.preset } : {}),
    });
  },
});

export const PRODUCT_TECHNIQUES_3: readonly TechniqueDef[] = [
  def('ui.card_flip_reveal', 'Card Flip Reveal',
    'A card turns to show its other face, the two sides never visible at once.',
    { category: 'transition', tags: ['card', 'state'], energy: [0.3, 0.7], roles: ['stat', 'list'], techniqueBudget: 'container', axis: 'x', maxPerComposition: 2 }),

  def('ui.accordion_expand', 'Accordion Expand',
    'A row opens downward and everything below it makes room.',
    { category: 'transition', tags: ['disclosure', 'list'], energy: [0.2, 0.6], roles: ['list'], techniqueBudget: 'container', maxPerComposition: 2 }),

  def('ui.search_suggest', 'Search Suggest',
    'Suggestions drop under the field as fast as typing, tight and unfussy.',
    { category: 'entrance', tags: ['search', 'overlay'], energy: [0.25, 0.65], roles: ['list'], techniqueBudget: 'overlay', minDurationMs: 200 }),

  def('ui.avatar_stack_in', 'Avatar Stack In',
    'Overlapping avatars land one after another, the leftmost first.',
    { category: 'entrance', tags: ['social', 'presence'], energy: [0.3, 0.7], roles: ['list', 'mark'], techniqueBudget: 'indicator', axis: 'x' }),

  def('ui.banner_dismiss', 'Banner Dismiss',
    'A banner leaves upward and the content beneath closes the gap.',
    { category: 'exit', tags: ['banner', 'dismiss'], energy: [0.3, 0.7], roles: ['cta', 'list'], techniqueBudget: 'surface', maxPerComposition: 1 }),

  def('ui.tag_pop_in', 'Tag Pop In',
    'Filter tags appear in the order they were applied.',
    { category: 'entrance', tags: ['filter', 'chips'], energy: [0.3, 0.75], roles: ['list', 'cta'], techniqueBudget: 'control', axis: 'x' }),

  def('ui.nav_slide', 'Nav Slide',
    'A navigation drawer comes in from the edge with the page held still behind it.',
    { category: 'transition', tags: ['navigation', 'drawer'], energy: [0.25, 0.65], roles: ['list', 'cta'], techniqueBudget: 'surface', axis: 'x', maxPerComposition: 1 }),

  def('ui.checkbox_check', 'Checkbox Check',
    'A control confirms itself: the box fills and the mark lands a beat later.',
    { category: 'emphasis', tags: ['micro', 'control'], energy: [0.3, 0.7], roles: ['cta', 'list'], techniqueBudget: 'indicator', minDurationMs: 180, maxPerComposition: 4 }),

  def('ui.card_grid_in', 'Card Grid In',
    'A grid of cards fills in reading order rather than all at once.',
    { category: 'entrance', tags: ['grid', 'cards'], energy: [0.25, 0.7], roles: ['list', 'stat'], techniqueBudget: 'container' }),

  def('ui.inline_edit', 'Inline Edit',
    'A value becomes a field in place, without the row moving.',
    { category: 'transition', tags: ['form', 'edit'], energy: [0.2, 0.55], roles: ['list'], techniqueBudget: 'control', minDurationMs: 200, maxPerComposition: 2 }),

  def('ui.status_settle', 'Status Settle',
    'A status pill changes state and settles without drawing attention twice.',
    { category: 'emphasis', tags: ['status', 'indicator'], energy: [0.2, 0.6], roles: ['mark', 'stat'], techniqueBudget: 'indicator', minDurationMs: 180, maxPerComposition: 4 }),

  def('ui.sidebar_collapse', 'Sidebar Collapse',
    'A sidebar narrows to icons and the content beside it widens to match.',
    { category: 'transition', tags: ['layout', 'navigation'], energy: [0.2, 0.6], roles: ['list'], techniqueBudget: 'surface', axis: 'x', maxPerComposition: 1 }),

  def('ui.upload_progress', 'Upload Progress',
    'Rows fill as their work completes, each on its own clock.',
    { category: 'emphasis', tags: ['progress', 'async'], energy: [0.2, 0.6], roles: ['list'], techniqueBudget: 'indicator', maxDurationMs: 1600 }),

  def('ui.confirm_step', 'Confirm Step',
    'A destructive action asks once, and the confirmation replaces the trigger in place.',
    { category: 'transition', tags: ['confirmation', 'safety'], energy: [0.3, 0.7], roles: ['cta'], techniqueBudget: 'control', minDurationMs: 200, maxPerComposition: 1 }),
];
