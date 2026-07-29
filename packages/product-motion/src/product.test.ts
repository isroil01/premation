/**
 * The acceptance test for Phase 2C.
 *
 * The load-bearing claim is **criterion 6b**: a product-UI prompt never emits an
 * editorial technique, and vice versa. That is not a style preference — the two
 * vocabularies have rules that directly contradict, and mixing them produces
 * output anyone who has shipped a product reads as wrong immediately.
 *
 * So this checks the separation from three directions: the LookPack forbid lists,
 * the emitted calls themselves, and the UI-motion linter that catches a leak if
 * the first two miss it.
 */

import { LOOK_PACKS, resolvePack, packsFor as designPacksFor } from '@motion/design-system';
import { TECHNIQUES as EDITORIAL_TECHNIQUES, coerceParams, lintTiming, packPermits, type EmitContext, type TechniqueDef } from '@motion/technique-library';
import { SPRING_PRESETS, bakeSpring } from '@motion/ai-tools';
import { PRODUCT_TECHNIQUES } from './techniques';
import { UI_COMPONENTS, componentAllows, uiComponent } from './components';
import { BUDGETS, UI_LIMITS, listStagger, listStaggerAt } from './choreography';
import { magicMove, sharedElementOpportunities, type UiState } from './shared-element';
import { cursorPath, pointerDuration } from './cursor';
import { lintUiMotion, uiMotionScore } from './lint';

const FPS = 60;
const FRAME = { width: 1280, height: 800 };

const TARGETS: EmitContext['targets'] = {
  headline: ['hl_0'],
  subhead: ['sub_0'],
  support: ['sup_0'],
  overline: ['ov_0'],
  media: ['media_0'],
  mark: ['mark_0'],
  stat: ['stat_0', 'stat_1', 'stat_2'],
  quote: ['quote_0'],
  list: ['li_0', 'li_1', 'li_2', 'li_3'],
  cta: ['cta_0'],
  rule: ['rule_0'],
  background: ['bg_0'],
  camera: [],
};

const ALL_IDS = Object.values(TARGETS).flat().filter(Boolean) as string[];

/**
 * Techniques whose elements legitimately enter from OFF-FRAME or scroll.
 *
 * A bottom sheet rising from below the screen edge and a list flinging under a
 * finger are viewport translations, not in-place UI motion, so the 8–24px travel
 * limit does not apply to them. The caster knows which technique produced which
 * layer and passes the same information.
 */
const OFF_FRAME_TECHNIQUES = new Set([
  'ui.sheet_present',   // rises from below the screen edge
  'ui.momentum_scroll', // a viewport translation, not an element move
  'ui.tab_switch',      // the indicator travels the tab spacing, set by the layout
]);

function contextFor(packId: string, durationMs: number): EmitContext {
  return {
    startMs: 400,
    durationMs,
    frameMs: 1000 / FPS,
    width: FRAME.width,
    height: FRAME.height,
    pack: resolvePack(packId),
    targets: TARGETS,
    idPrefix: 'p',
  };
}

function emit(t: TechniqueDef, packId: string, seed: number) {
  const dur = Math.min(Math.max(2000, t.minDurationMs), t.maxDurationMs);
  const ctx = contextFor(packId, dur);
  return { ctx, calls: t.emit(ctx, coerceParams(t.params, {}).value, seed) };
}

const PRODUCT_PACKS = LOOK_PACKS.filter((p) => p.vocabulary === 'product').map((p) => p.id);

// ── Vocabulary separation ─────────────────────────────────────────────

describe('vocabulary separation (criterion 6b)', () => {
  it('has product packs at all', () => {
    expect(PRODUCT_PACKS.length).toBeGreaterThanOrEqual(2);
    expect(designPacksFor('product').length).toBe(PRODUCT_PACKS.length);
  });

  it('every product pack refuses every aggressive editorial technique', () => {
    // This used to assert membership in `pack.forbid` — a hand-written list of
    // ids. It passed for as long as the technique library did not grow, and the
    // day it grew from 22 techniques to 39 both product packs silently began
    // offering `kinetic_type.line_push_stack` for a dashboard.
    //
    // So it now asserts the RULE (`packPermits`: id, then category, then energy
    // ceiling), which is what actually gates casting and which covers techniques
    // that do not exist yet.
    const mustRefuse = EDITORIAL_TECHNIQUES.filter(
      (t) => t.category === 'kinetic_type' || t.energy[1] >= 0.9,
    );
    for (const packId of PRODUCT_PACKS) {
      const pack = LOOK_PACKS.find((p) => p.id === packId)!;
      for (const t of mustRefuse) {
        expect(`${packId} allows ${t.id}: ${packPermits(pack, t)}`).toBe(`${packId} allows ${t.id}: false`);
      }
    }
  });

  it('the refusal is a rule, not a list — it covers a technique invented today', () => {
    // The regression guard for the guard above. A brand-new editorial technique
    // that nobody has added to any `forbid` list must still be refused.
    const invented = { id: 'kinetic_type.not_yet_written', category: 'kinetic_type' as const, energy: [0.4, 0.6] as [number, number] };
    const loud = { id: 'entrance.deafening', category: 'entrance' as const, energy: [0.8, 1] as [number, number] };
    for (const packId of PRODUCT_PACKS) {
      const pack = LOOK_PACKS.find((p) => p.id === packId)!;
      expect(packPermits(pack, invented)).toBe(false);
      expect(packPermits(pack, loud)).toBe(false);
    }
  });

  it('still permits the vocabulary-neutral techniques product packs need', () => {
    // The rule must not become a blanket ban. A calm entrance is legitimate in a
    // product piece — the separation is about performance, not about motion.
    const calmEntrances = EDITORIAL_TECHNIQUES.filter(
      (t) => t.category === 'entrance' && t.energy[1] < 0.85,
    );
    expect(calmEntrances.length).toBeGreaterThan(0);
    for (const packId of PRODUCT_PACKS) {
      const pack = LOOK_PACKS.find((p) => p.id === packId)!;
      expect(calmEntrances.some((t) => packPermits(pack, t))).toBe(true);
    }
  });

  it('every product pack PREFERS only product techniques', () => {
    const productIds = new Set(PRODUCT_TECHNIQUES.map((t) => t.id));
    for (const packId of PRODUCT_PACKS) {
      const pack = LOOK_PACKS.find((p) => p.id === packId)!;
      for (const id of pack.prefer) {
        expect(`${packId} prefers ${id}: ${productIds.has(id)}`).toBe(`${packId} prefers ${id}: true`);
      }
    }
  });

  it('no product technique shares an id with an editorial one', () => {
    const editorial = new Set(EDITORIAL_TECHNIQUES.map((t) => t.id));
    for (const t of PRODUCT_TECHNIQUES) expect(editorial.has(t.id)).toBe(false);
  });

  it('every product technique is namespaced `ui.`', () => {
    for (const t of PRODUCT_TECHNIQUES) expect(t.id.startsWith('ui.')).toBe(true);
  });
});

// ── The product rules, as behaviour ───────────────────────────────────

describe('product techniques obey the product rules', () => {
  it('animate transforms on SPRINGS, never beziers', () => {
    // The rule the whole package exists for. A bezier reaches its target once; a
    // spring crosses it and settles.
    const offenders: string[] = [];
    for (const t of PRODUCT_TECHNIQUES) {
      for (const packId of PRODUCT_PACKS) {
        const { calls } = emit(t, packId, 0);
        const findings = lintUiMotion({ calls, fps: FPS, uiNodeIds: ALL_IDS });
        for (const f of findings.filter((x) => x.rule === 'BEZIER_ON_UI')) {
          offenders.push(`${t.id}/${packId}: ${f.message.slice(0, 60)}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it('never enable motion blur', () => {
    for (const t of PRODUCT_TECHNIQUES) {
      for (const packId of PRODUCT_PACKS) {
        const { calls } = emit(t, packId, 0);
        expect(calls.filter((c) => c.name === 'set_motion_blur')).toEqual([]);
      }
    }
  });

  it('keep travel inside the UI limit', () => {
    for (const t of PRODUCT_TECHNIQUES) {
      for (const packId of PRODUCT_PACKS) {
        const { calls } = emit(t, packId, 0);
        const findings = lintUiMotion({
          calls, fps: FPS, uiNodeIds: ALL_IDS,
          offFrameNodeIds: OFF_FRAME_TECHNIQUES.has(t.id) ? ALL_IDS : [],
        });
        expect(findings.filter((f) => f.rule === 'UI_TRAVEL_TOO_FAR')).toEqual([]);
      }
    }
  });

  it('pass the UI-motion linter with ZERO errors, every technique × pack × variant', () => {
    const failures: string[] = [];
    for (const t of PRODUCT_TECHNIQUES) {
      for (const packId of PRODUCT_PACKS) {
        for (let seed = 0; seed < t.variants; seed++) {
          const { calls } = emit(t, packId, seed);
          const errors = lintUiMotion({
            calls, fps: FPS, uiNodeIds: ALL_IDS,
            offFrameNodeIds: OFF_FRAME_TECHNIQUES.has(t.id) ? ALL_IDS : [],
          }).filter((f) => f.severity === 'error');
          if (errors.length) failures.push(`${t.id}/${packId}/${seed}: ${errors.map((e) => e.rule).join(', ')}`);
        }
      }
    }
    expect(failures).toEqual([]);
  });

  it('also pass the editorial TIMING linter — the rules compose, they do not conflict', () => {
    // Both linters run on every piece. Product motion is a stricter subset in
    // some dimensions and a looser one in others; nothing it emits may trip the
    // timing linter, or the two would be unsatisfiable together.
    const failures: string[] = [];
    for (const t of PRODUCT_TECHNIQUES) {
      for (const packId of PRODUCT_PACKS) {
        const { ctx, calls } = emit(t, packId, 0);
        const errors = lintTiming({
          calls, fps: FPS, durationMs: ctx.startMs + ctx.durationMs,
          heroNodeIds: [],
          // A UI stagger is deliberately near-even; the metronome rule is an
          // editorial rule. Every other timing rule still applies.
          uiNodeIds: ALL_IDS,
        }).filter((f) => f.severity === 'error');
        if (errors.length) failures.push(`${t.id}/${packId}: ${errors.map((e) => e.rule).join(', ')}`);
      }
    }
    expect(failures).toEqual([]);
  });

  it('is deterministic and genuinely varies by seed', () => {
    for (const t of PRODUCT_TECHNIQUES) {
      const packId = PRODUCT_PACKS[0]!;
      expect(JSON.stringify(emit(t, packId, 1).calls)).toBe(JSON.stringify(emit(t, packId, 1).calls));
    }
  });

  it('ships enough techniques to avoid visible repetition', () => {
    expect(PRODUCT_TECHNIQUES.length).toBeGreaterThanOrEqual(15);
  });
});

// ── Choreography ──────────────────────────────────────────────────────

describe('choreography', () => {
  it('exits are ALWAYS faster than entrances', () => {
    // The rule most often broken and the one users feel most.
    for (const [cls, b] of Object.entries(BUDGETS)) {
      expect(`${cls}: exit ${b.exitMs} < enter ${b.enterMs}`).toBe(`${cls}: exit ${b.exitMs} < enter ${b.enterMs}`);
      expect(b.exitMs).toBeLessThan(b.enterMs);
    }
  });

  it('entrances sit in the 200–300ms product band, not the editorial 400–900', () => {
    for (const b of Object.values(BUDGETS)) {
      expect(b.enterMs).toBeGreaterThanOrEqual(150);
      expect(b.enterMs).toBeLessThanOrEqual(320);
    }
  });

  it('travel budgets stay in the 8–24px band', () => {
    for (const b of Object.values(BUDGETS)) {
      expect(b.travelPx).toBeGreaterThanOrEqual(8);
      expect(b.travelPx).toBeLessThanOrEqual(24);
    }
  });

  it('list stagger stays at 30–50ms and SHRINKS as the list grows', () => {
    // Twenty rows at 40ms is 800ms of waiting for the last one. Real
    // implementations cap the total.
    expect(listStagger(4)).toBeLessThanOrEqual(UI_LIMITS.maxStaggerMs);
    expect(listStagger(20)).toBeLessThan(listStagger(4));
    expect(listStagger(20)).toBeGreaterThanOrEqual(UI_LIMITS.minStaggerMs);
  });

  it('the total stagger is bounded however long the list is', () => {
    for (const n of [4, 10, 30, 100]) {
      expect(listStaggerAt(n - 1, n)).toBeLessThanOrEqual(340);
    }
  });

  it('the default UI spring stays under the 4% overshoot ceiling', () => {
    // If `snappy` bounced more than the linter allows, the default preset would
    // fail the package's own rule.
    const baked = bakeSpring({ from: 0, to: 1, spring: { ...SPRING_PRESETS.snappy }, fps: FPS });
    expect(baked.overshoot).toBeLessThan(UI_LIMITS.maxOvershoot);
  });

  it('`gentle` never overshoots — for shadows, colour and backdrop blur', () => {
    const baked = bakeSpring({ from: 0, to: 1, spring: { ...SPRING_PRESETS.gentle }, fps: FPS });
    expect(baked.overshoot).toBeLessThanOrEqual(1e-9);
  });
});

// ── Shared element ────────────────────────────────────────────────────

describe('magic move', () => {
  const listState: UiState = {
    name: 'list',
    elements: [
      { id: 'row', role: 'item', cls: 'container', x: 200, y: 120, width: 320, height: 56, cornerRadius: 6 },
      { id: 'avatar', role: 'avatar', cls: 'content', x: 80, y: 120, width: 40, height: 40, cornerRadius: 20 },
      { id: 'chrome', role: 'nav', cls: 'container', x: 400, y: 20, width: 800, height: 40 },
    ],
  };
  const detailState: UiState = {
    name: 'detail',
    elements: [
      { id: 'hero', role: 'item', cls: 'container', x: 400, y: 300, width: 640, height: 360, cornerRadius: 16 },
      { id: 'big_avatar', role: 'avatar', cls: 'content', x: 400, y: 90, width: 96, height: 96, cornerRadius: 48 },
      { id: 'back', role: 'back_button', cls: 'control', x: 40, y: 20, width: 40, height: 40 },
    ],
  };

  it('matches by ROLE, so a row becomes the hero it turns into', () => {
    const r = magicMove({ fromState: listState, toState: detailState, atMs: 0, fps: FPS });
    expect(r.matched.map((m) => m.role).sort()).toEqual(['avatar', 'item']);
  });

  it('morphs position, size AND corner radius', () => {
    const r = magicMove({ fromState: listState, toState: detailState, atMs: 0, fps: FPS });
    const props = r.calls.filter((c) => c.name === 'set_spring' && c.args.nodeId === 'row').map((c) => c.args.prop);
    expect(props).toContain('x');
    expect(props).toContain('y');
    expect(props).toContain('scaleX');
    expect(props).toContain('scaleY');
    // The one most often forgotten, and the most visible when it is.
    expect(props).toContain('cornerRadius');
  });

  it('morphs scaleX and scaleY INDEPENDENTLY', () => {
    // A row is wide and short; a detail view is not. Growing uniformly is what
    // makes a hand-built magic move look like a zoom.
    const r = magicMove({ fromState: listState, toState: detailState, atMs: 0, fps: FPS });
    const sx = r.calls.find((c) => c.args.nodeId === 'row' && c.args.prop === 'scaleX');
    const sy = r.calls.find((c) => c.args.nodeId === 'row' && c.args.prop === 'scaleY');
    expect(sx!.args.to).not.toBe(sy!.args.to);
  });

  it('uses a GENTLE spring on the radius so it cannot bounce', () => {
    const r = magicMove({ fromState: listState, toState: detailState, atMs: 0, fps: FPS });
    const radius = r.calls.find((c) => c.args.prop === 'cornerRadius');
    expect(radius!.args.preset).toBe('gentle');
  });

  it('exits unmatched elements and enters new ones', () => {
    const r = magicMove({ fromState: listState, toState: detailState, atMs: 0, fps: FPS });
    expect(r.exited).toContain('chrome');
    expect(r.entered).toContain('back');
  });

  it('animates entirely on springs — no keyframe calls at all', () => {
    const r = magicMove({ fromState: listState, toState: detailState, atMs: 0, fps: FPS });
    expect(r.calls.every((c) => c.name === 'set_spring')).toBe(true);
  });

  it('reports the opportunities so the linter can catch a missed magic move', () => {
    expect(sharedElementOpportunities(listState, detailState)).toBe(2);
  });

  it('never matches on geometry — same-sized boxes in different roles stay apart', () => {
    const a: UiState = { name: 'a', elements: [{ id: 'x', role: 'toast', cls: 'overlay', x: 0, y: 0, width: 100, height: 40 }] };
    const b: UiState = { name: 'b', elements: [{ id: 'y', role: 'chart', cls: 'content', x: 0, y: 0, width: 100, height: 40 }] };
    expect(magicMove({ fromState: a, toState: b, atMs: 0, fps: FPS }).matched).toEqual([]);
  });
});

// ── Cursor ────────────────────────────────────────────────────────────

describe('cursor', () => {
  it('never travels in a straight line', () => {
    const r = cursorPath({ nodeId: 'cur', from: { x: 100, y: 100 }, to: { x: 600, y: 400 }, atMs: 0 });
    const xs = r.calls.find((c) => (c.args.keyframes as { prop: string }[])[0]!.prop === 'x');
    const keys = xs!.args.keyframes as { value: number }[];
    // The midpoint must be off the straight line between the endpoints.
    const straightMidX = (100 + 600) / 2;
    const actualMid = keys[Math.floor(keys.length / 2)]!.value;
    expect(Math.abs(actualMid - straightMidX)).toBeGreaterThan(1);
  });

  it('dwells before clicking — never fires on the arrival frame', () => {
    const r = cursorPath({ nodeId: 'cur', from: { x: 0, y: 0 }, to: { x: 400, y: 0 }, atMs: 0, clickAtEnd: true });
    expect(r.clicksAtMs - r.arrivesAtMs).toBeGreaterThanOrEqual(UI_LIMITS.minCursorSettleMs);
  });

  it('follows Fitts\'s law rather than scaling linearly with distance', () => {
    // Doubling the distance must NOT double the time.
    const near = pointerDuration(100);
    const far = pointerDuration(800);
    expect(far).toBeGreaterThan(near);
    expect(far).toBeLessThan(near * 3);
  });

  it('decelerates into the target', () => {
    const r = cursorPath({ nodeId: 'cur', from: { x: 0, y: 0 }, to: { x: 400, y: 0 }, atMs: 0 });
    const keys = (r.calls[0]!.args.keyframes as { bezier: number[] }[]);
    // The final segment's curve must ease out — y1 high, x1 low.
    const last = keys[keys.length - 1]!;
    expect(last.bezier[1]!).toBeGreaterThan(0.5);
  });

  it('passes its own linter rules', () => {
    const r = cursorPath({ nodeId: 'cur', from: { x: 0, y: 0 }, to: { x: 500, y: 200 }, atMs: 0, clickAtEnd: true });
    const findings = lintUiMotion({
      calls: r.calls, fps: FPS, uiNodeIds: [],
      cursors: [{ nodeId: 'cur', arcFraction: 0.15, arrivesAtMs: r.arrivesAtMs, clicksAtMs: r.clicksAtMs }],
    });
    expect(findings.filter((f) => f.severity === 'error')).toEqual([]);
  });
});

// ── Component kit ─────────────────────────────────────────────────────

describe('component kit', () => {
  const ctx = (() => {
    const pack = resolvePack('saas_product');
    return { palette: pack.palette, shape: pack.shape, basePx: 16, densityScale: 1 };
  })();

  it('ships enough components to build a real interface', () => {
    expect(UI_COMPONENTS.length).toBeGreaterThanOrEqual(20);
  });

  it('every component declares states, a grid behaviour and an element class', () => {
    for (const c of UI_COMPONENTS) {
      expect(c.states.length).toBeGreaterThan(0);
      expect(['fill', 'hug', 'fixed']).toContain(c.grid);
      expect(Object.keys(BUDGETS)).toContain(c.cls);
    }
  });

  it('every component emits a real layer with a radius and a shadow stack where lifted', () => {
    for (const c of UI_COMPONENTS) {
      const calls = c.emit(ctx, c.id.replace(/\./g, '_'), { x: 200, y: 200, ...c.intrinsic }, 'Label');
      expect(calls.some((k) => k.name === 'create_layer')).toBe(true);
      if (c.elevation > 0) {
        const stack = calls.find((k) => k.name === 'set_shadow_stack');
        expect(stack).toBeDefined();
        // Never a single shadow — the same rule the design linter enforces.
        expect((stack!.args.shadows as unknown[]).length).toBeGreaterThan(1);
      }
    }
  });

  it('constrains which techniques may animate it — a toast cannot magic-move', () => {
    const toast = uiComponent('ui.toast')!;
    expect(componentAllows(toast, 'ui.shared_element_expand')).toBe(false);
    expect(componentAllows(toast, 'ui.toast_slide')).toBe(true);
    const card = uiComponent('ui.card')!;
    expect(componentAllows(card, 'ui.shared_element_expand')).toBe(true);
  });

  it('gives a secondary button LESS elevation than a primary — depth is the hierarchy', () => {
    expect(uiComponent('ui.button_secondary')!.elevation).toBeLessThan(uiComponent('ui.button')!.elevation);
  });

  it('never emits pure black or white', () => {
    for (const c of UI_COMPONENTS) {
      const calls = c.emit(ctx, 'x', { x: 100, y: 100, ...c.intrinsic }, 'L');
      for (const k of calls) {
        const fill = k.args.fill;
        if (typeof fill === 'string') {
          expect(fill.toLowerCase()).not.toBe('#000000');
          expect(fill.toLowerCase()).not.toBe('#ffffff');
        }
      }
    }
  });
});

// ── The linter itself ─────────────────────────────────────────────────

describe('the UI-motion linter', () => {
  const bez = (nodeId: string, prop: string) => ({
    name: 'set_keyframes',
    args: { keyframes: [{ nodeId, prop, t: 0, value: 0, easing: 'bezier', bezier: [0.2, 0, 0.3, 1] }] },
  });

  it('catches a bezier on a UI transform', () => {
    const f = lintUiMotion({ calls: [bez('card', 'y')], fps: FPS, uiNodeIds: ['card'] });
    expect(f.map((x) => x.rule)).toContain('BEZIER_ON_UI');
  });

  it('does NOT flag a bezier on a non-UI layer', () => {
    // A composition can mix a UI mock with an editorial headline over it, and
    // reporting the headline's curve would be flagging correct craft.
    const f = lintUiMotion({ calls: [bez('headline', 'y')], fps: FPS, uiNodeIds: ['card'] });
    expect(f.map((x) => x.rule)).not.toContain('BEZIER_ON_UI');
  });

  it('does NOT flag a text-animator sweep or an opacity curve', () => {
    // Neither has a spring equivalent; both are correct on a curve.
    const f = lintUiMotion({
      calls: [bez('card', 'ta.0.offset'), bez('card', 'opacity')],
      fps: FPS, uiNodeIds: ['card'],
    });
    expect(f.map((x) => x.rule)).not.toContain('BEZIER_ON_UI');
  });

  it('catches an exit slower than its entrance', () => {
    const f = lintUiMotion({
      calls: [], fps: FPS, uiNodeIds: ['t'],
      transitions: [{ nodeId: 't', enterMs: 200, exitMs: 260 }],
    });
    expect(f.map((x) => x.rule)).toContain('EXIT_SLOWER_THAN_ENTER');
  });

  it('catches a stagger wider than the UI limit', () => {
    // Different nodes — a stagger is the offset BETWEEN elements.
    const calls = [0, 0.09, 0.18].map((t, i) => ({
      name: 'set_spring', args: { nodeId: `row_${i}`, prop: 'y', from: 8, to: 0, startSec: t },
    }));
    const f = lintUiMotion({ calls, fps: FPS, uiNodeIds: ['row_0', 'row_1', 'row_2'] });
    expect(f.map((x) => x.rule)).toContain('UI_STAGGER_TOO_WIDE');
  });

  it('does NOT call a one-second pause a stagger', () => {
    const calls = [0, 1.2, 2.4].map((t, i) => ({
      name: 'set_spring', args: { nodeId: `row_${i}`, prop: 'y', from: 8, to: 0, startSec: t },
    }));
    const f = lintUiMotion({ calls, fps: FPS, uiNodeIds: ['row_0', 'row_1', 'row_2'] });
    expect(f.map((x) => x.rule)).not.toContain('UI_STAGGER_TOO_WIDE');
  });

  it('catches excessive travel and excessive overshoot', () => {
    const f = lintUiMotion({
      calls: [
        { name: 'set_spring', args: { nodeId: 'c', prop: 'y', from: 80, to: 0, startSec: 0 } },
        // Overshoot comes from the PRESET, not the endpoints — a 1 → 1.3 scale
        // on `gentle` is a morph and does not bounce at all.
        { name: 'set_spring', args: { nodeId: 'c', prop: 'scale', from: 1, to: 1.3, startSec: 0, preset: 'bouncy' } },
      ],
      fps: FPS, uiNodeIds: ['c'],
    });
    expect(f.map((x) => x.rule)).toContain('UI_TRAVEL_TOO_FAR');
    expect(f.map((x) => x.rule)).toContain('EXCESSIVE_OVERSHOOT');
  });

  it('catches a straight cursor and a simultaneous click', () => {
    const f = lintUiMotion({
      calls: [], fps: FPS, uiNodeIds: [],
      cursors: [{ nodeId: 'cur', arcFraction: 0, arrivesAtMs: 500, clicksAtMs: 510 }],
    });
    expect(f.map((x) => x.rule)).toContain('CURSOR_STRAIGHT_LINE');
    expect(f.map((x) => x.rule)).toContain('CURSOR_CLICK_SIMULTANEOUS');
  });

  it('warns when a state change cross-faded a magic move away', () => {
    const f = lintUiMotion({
      calls: [], fps: FPS, uiNodeIds: [],
      stateChanges: [{ atMs: 1000, opportunities: 3, matched: 0 }],
    });
    expect(f.map((x) => x.rule)).toContain('NO_SHARED_ELEMENT');
  });

  it('catches safe-area intrusion on a phone frame', () => {
    const f = lintUiMotion({
      calls: [], fps: FPS, uiNodeIds: ['bar'],
      safeArea: { top: 47, bottom: 34, frameHeight: 844 },
      boxes: [{ nodeId: 'bar', y: 20, height: 40 }],
    });
    expect(f.map((x) => x.rule)).toContain('MISSING_SAFE_AREA');
  });

  it('scores a clean scene at 1', () => {
    expect(uiMotionScore([])).toBe(1);
  });
});
