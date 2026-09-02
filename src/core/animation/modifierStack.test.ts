/**
 * The stack as STORED STATE, and as an undoable edit.
 *
 * `modifierCompile.test.ts` proves the compiled text evaluates to the right
 * numbers. This file is the other half: that the rows survive a save/open
 * round trip, that installing a stack does not destroy the expression that was
 * there first, and that removing it puts that expression back — including its
 * enabled bit, which is a state a bare string cannot carry.
 *
 * The `previous` capture is the one place this can quietly go wrong. A version
 * that re-captured on every edit would pass every test that installs a stack
 * once and removes it, and would silently make "Remove stack" a no-op for
 * anybody who had touched a slider in between. That case has its own test.
 */

import { defaultAnimation } from '@motion/animation';
import defaultSceneGraph from '@core/scene/DefaultSceneGraph';
import { SCENE_KIND_PROP } from '@core/scene/seedDefaultScene';
import { setCommandSystem, CommandSystem, getCommandSystem } from '@core/commands/CommandSystem';
import { EventBus, setEventBus } from '@core/events/EventBus';
import { useHistoryStore, attachHistoryRecording, baselineHistory } from '@stores/historyStore';
import { getTimelineController } from '@core/timeline/TimelineController';
import BEHAVIOR_PRESETS from './behaviorPresets';
import {
  MODIFIERS_PROP,
  MODIFIER_KINDS,
  MODIFIER_LABELS,
  MODIFIER_HINTS,
  BEHAVIOR_RECIPES,
  applyBehaviorRecipe,
  applyModifierStack,
  bakeModifierStack,
  defaultModifier,
  describeModifier,
  instantiateRecipe,
  moveModifier,
  patchModifier,
  readModifierStack,
  readModifierStacks,
  removeModifier,
  removeModifierStack,
  type Modifier,
  type OffsetModifier,
} from './modifierStack';
import type { SceneNode } from '@core/types';

const NODE = 'stack-node';
const FPS = 30;

beforeAll(() => {
  setCommandSystem(new CommandSystem({ services: {} as never, getState: () => ({}) }));
});

function addNode(id = NODE): void {
  defaultSceneGraph.addNode({
    id, name: id, parent: null, children: [], visible: true, locked: false,
    transform: { position: { x: 0, y: 0 }, rotation: 0, scale: { x: 1, y: 1 } },
    components: [
      {
        id: `${id}_t`,
        type: 'Transform',
        props: { [SCENE_KIND_PROP]: 'shape', x: 0, y: 0, rotation: 0, scaleX: 1, scaleY: 1, opacity: 100 },
      },
    ],
  } as unknown as SceneNode);
}

function clearClips(): void {
  const c = getTimelineController();
  for (const track of c.timeline.getTracks()) {
    for (const layer of [...track.layers]) c.timeline.removeLayer(layer.id);
  }
  c.clearWorkArea();
  c.invalidateLayerIndex();
}

beforeEach(() => {
  const ids: string[] = [];
  defaultSceneGraph.traverse((n) => ids.push(n.id));
  for (const id of ids) defaultSceneGraph.removeNode(id);
  defaultAnimation.clear();
  getCommandSystem().getHistory().clear();
  clearClips();
  addNode();
});

const offset = (amount: number): OffsetModifier => ({ ...defaultModifier('offset') as OffsetModifier, amount });

// ── Pure list edits ─────────────────────────────────────────────────

describe('reordering is a pure list edit', () => {
  const a = offset(1);
  const b = offset(2);
  const c = offset(3);

  test('moves without mutating the input', () => {
    const list = [a, b, c];
    expect(moveModifier(list, 0, 2).map((m) => m.id)).toEqual([b.id, c.id, a.id]);
    expect(moveModifier(list, 2, 0).map((m) => m.id)).toEqual([c.id, a.id, b.id]);
    expect(list.map((m) => m.id)).toEqual([a.id, b.id, c.id]);
  });

  test('a target past either end clamps rather than dropping the row', () => {
    // The arrow buttons on the first and last rows are disabled, but a drag can
    // land anywhere — losing a row to an off-by-one would be silent.
    expect(moveModifier([a, b, c], 0, -5)).toHaveLength(3);
    expect(moveModifier([a, b, c], 0, 99).map((m) => m.id)).toEqual([b.id, c.id, a.id]);
  });

  test('an out-of-range source is a no-op, not a crash', () => {
    expect(moveModifier([a, b], 7, 0).map((m) => m.id)).toEqual([a.id, b.id]);
  });

  test('patch touches one row and keeps the rest identical', () => {
    const next = patchModifier([a, b, c], b, { amount: 99 });
    expect((next[1] as OffsetModifier).amount).toBe(99);
    expect(next[0]).toBe(a);
    expect(next[2]).toBe(c);
  });

  test('remove takes the row with that id and only that one', () => {
    expect(removeModifier([a, b, c], b.id).map((m) => m.id)).toEqual([a.id, c.id]);
  });
});

describe('every kind is constructible and describable', () => {
  test.each(MODIFIER_KINDS)('%s has a default, a label and a hint', (kind) => {
    const m = defaultModifier(kind);
    expect(m.kind).toBe(kind);
    expect(m.enabled).toBe(true);
    expect(m.id).not.toBe('');
    expect(MODIFIER_LABELS[kind]).toBeTruthy();
    expect(MODIFIER_HINTS[kind]).toBeTruthy();
    // The row's summary line — shown collapsed, so it must never be empty.
    expect(describeModifier(m).length).toBeGreaterThan(0);
  });

  test('ids are unique across calls, so React keys survive a reorder', () => {
    const ids = MODIFIER_KINDS.map(() => defaultModifier('offset').id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

// ── Persistence ─────────────────────────────────────────────────────

describe('persistence on the node', () => {
  test('round-trips through the hidden __modifiers map on Transform', () => {
    applyModifierStack(NODE, 'x', [offset(10), { ...defaultModifier('multiply'), factor: 3 } as Modifier]);
    const node = defaultSceneGraph.getNode(NODE)!;
    const stack = readModifierStack(node, 'x');
    expect(stack?.modifiers).toHaveLength(2);
    expect(stack?.modifiers[0]?.kind).toBe('offset');
    // On the Transform component, `__`-prefixed, so the generic NodeInspector
    // property list never shows it — same convention as __audioDriver.
    const t = node.components.find((c) => c.type === 'Transform');
    expect(t?.props[MODIFIERS_PROP]).toBeTruthy();
  });

  test('a garbled record degrades to defaults instead of throwing', () => {
    const node = defaultSceneGraph.getNode(NODE)!;
    const t = node.components.find((c) => c.type === 'Transform')!;
    defaultSceneGraph.writeProp(NODE, t.id, MODIFIERS_PROP, {
      x: {
        modifiers: [
          { kind: 'wiggle', freq: 'fast', amp: null, octaves: -3 },
          { kind: 'nonsense', amount: 1 },
          'not an object',
        ],
        previous: { src: 42 },
      },
    });
    const stack = readModifierStack(defaultSceneGraph.getNode(NODE)!, 'x')!;
    // The unknown kind and the non-object are DROPPED — a row nothing can
    // render is worse than a row that is not there.
    expect(stack.modifiers).toHaveLength(1);
    const w = stack.modifiers[0]!;
    expect(w.kind).toBe('wiggle');
    expect(w.kind === 'wiggle' && Number.isFinite(w.freq)).toBe(true);
    expect(w.kind === 'wiggle' && w.octaves >= 1).toBe(true);
    // A non-string source is not an expression state.
    expect(stack.previous).toBeNull();
  });

  test('stacks on different properties are independent', () => {
    applyModifierStack(NODE, 'x', [offset(10)]);
    applyModifierStack(NODE, 'y', [offset(20)]);
    const stacks = readModifierStacks(defaultSceneGraph.getNode(NODE)!);
    expect(Object.keys(stacks).sort()).toEqual(['x', 'y']);
    removeModifierStack(NODE, 'x');
    expect(Object.keys(readModifierStacks(defaultSceneGraph.getNode(NODE)!))).toEqual(['y']);
  });
});

// ── Install / restore ───────────────────────────────────────────────

describe('installing a stack', () => {
  test('attaches the compiled expression and ENABLES it', () => {
    defaultAnimation.setKeyframe(NODE, 'x', 0, 0, 'linear');
    defaultAnimation.setKeyframe(NODE, 'x', 2, 100, 'linear');
    applyModifierStack(NODE, 'x', [offset(10)]);
    expect(defaultAnimation.getExpressionSrc(NODE, 'x')).toBe('(value + 10)');
    expect(defaultAnimation.isExpressionEnabled(NODE, 'x')).toBe(true);
    expect(defaultAnimation.sample(NODE, 'x', 1)).toBeCloseTo(60);
  });

  test('lands ENABLED even when the property’s old expression was switched off', () => {
    // `setExpression` preserves an existing enabled bit, so without the explicit
    // enable the new stack would be born switched off and appear to do nothing.
    defaultAnimation.setExpression(NODE, 'x', 'value + 5');
    defaultAnimation.setExpressionEnabled(NODE, 'x', false);
    applyModifierStack(NODE, 'x', [offset(10)]);
    expect(defaultAnimation.isExpressionEnabled(NODE, 'x')).toBe(true);
  });

  test('is one undo step that puts the previous expression back', () => {
    // The stack rides the debounced {scene, anim} snapshot (one entry for the
    // expression AND the record), so this test wires history recording the way
    // boot does and flushes the debounce before counting.
    setEventBus(new EventBus());
    const recording = attachHistoryRecording();
    try {
      defaultAnimation.setExpression(NODE, 'x', 'value + 5');
      baselineHistory();
      const before = getCommandSystem().getHistory().getEntries().length;
      applyModifierStack(NODE, 'x', [offset(10)]);
      useHistoryStore.getState().flush();
      expect(defaultAnimation.getExpressionSrc(NODE, 'x')).toBe('(value + 10)');
      expect(getCommandSystem().getHistory().getEntries().length - before).toBe(1);
      getCommandSystem().getHistory().undo();
      expect(defaultAnimation.getExpressionSrc(NODE, 'x')).toBe('value + 5');
      expect(readModifierStacks(defaultSceneGraph.getNode(NODE)!)['x']).toBeUndefined();
    } finally {
      recording.dispose();
    }
  });
});

describe('removing a stack restores what was there first', () => {
  test('a hand-written expression comes back, source and enabled bit together', () => {
    defaultAnimation.setExpression(NODE, 'x', 'value * 3');
    defaultAnimation.setExpressionEnabled(NODE, 'x', false);

    applyModifierStack(NODE, 'x', [offset(10)]);
    expect(removeModifierStack(NODE, 'x')).toBe(true);

    expect(defaultAnimation.getExpressionSrc(NODE, 'x')).toBe('value * 3');
    // OFF, as the user left it. Restoring the source with a default enabled bit
    // would re-run a formula they had switched off.
    expect(defaultAnimation.isExpressionEnabled(NODE, 'x')).toBe(false);
    expect(readModifierStack(defaultSceneGraph.getNode(NODE)!, 'x')).toBeNull();
  });

  test('no previous expression means the compiled one is removed outright', () => {
    applyModifierStack(NODE, 'x', [offset(10)]);
    removeModifierStack(NODE, 'x');
    expect(defaultAnimation.hasExpression(NODE, 'x')).toBe(false);
  });

  test('`previous` is captured ONCE — later edits do not overwrite it', () => {
    defaultAnimation.setExpression(NODE, 'x', 'value * 3');
    applyModifierStack(NODE, 'x', [offset(10)]);
    // Two more edits, each of which re-attaches a compiled expression.
    applyModifierStack(NODE, 'x', [offset(20)]);
    applyModifierStack(NODE, 'x', [offset(20), defaultModifier('clamp')]);
    removeModifierStack(NODE, 'x');
    // Re-capturing on edit would have stored '(value + 10)' here and made this
    // restore a lie that looks exactly like a success.
    expect(defaultAnimation.getExpressionSrc(NODE, 'x')).toBe('value * 3');
  });

  test('removing a stack that is not there is a no-op, not a throw', () => {
    expect(removeModifierStack(NODE, 'x')).toBe(false);
  });
});

// ── Bake ────────────────────────────────────────────────────────────

describe('bake to keyframes', () => {
  function addClip(startFrames: number, lenFrames: number): void {
    const c = getTimelineController();
    const trackId = c.timeline.getTracks()[0]!.id;
    c.timeline.addLayer(String(trackId), {
      name: NODE, sourceId: NODE, clip: { start: startFrames, duration: lenFrames },
    });
    c.invalidateLayerIndex();
  }

  test('writes keyframes, disables the expression, and KEEPS the rows', () => {
    addClip(0, FPS);
    defaultAnimation.setKeyframe(NODE, 'x', 0, 0, 'linear');
    defaultAnimation.setKeyframe(NODE, 'x', 1, 100, 'linear');
    applyModifierStack(NODE, 'x', [offset(10)]);

    const before = defaultAnimation.sample(NODE, 'x', 0.5);
    const result = bakeModifierStack(NODE, 'x');
    expect(result.refusal).toBeNull();
    expect(result.written.get('x')).toBeGreaterThan(1);
    // The picture does not move — the invariant convertExpressionToKeyframes
    // owns, checked here only at the seam.
    expect(defaultAnimation.sample(NODE, 'x', 0.5)).toBeCloseTo(before!);
    expect(defaultAnimation.isExpressionEnabled(NODE, 'x')).toBe(false);
    // The stack is still the description of that motion: a user who bakes and
    // then wants one more row should find it where they left it.
    expect(readModifierStack(defaultSceneGraph.getNode(NODE)!, 'x')?.modifiers).toHaveLength(1);
  });
});

// ── Behaviour recipes ───────────────────────────────────────────────

describe('behaviour recipes', () => {
  test('every recipe names a real behaviour preset', () => {
    // The §2·0 seam: `behaviorPresets.ts` is untouched by this feature, so
    // nothing but this assertion stops a rename over there from leaving a menu
    // entry pointing at a behaviour that no longer exists.
    const names = new Set(BEHAVIOR_PRESETS.map((p) => p.name));
    for (const r of BEHAVIOR_RECIPES) expect(names.has(r.preset)).toBe(true);
  });

  test('the old preset entries still exist and still carry their expressions', () => {
    // "Keep the old preset entries working" made literal: applying Drift from
    // the preset browser must still be the expression it always was.
    const drift = BEHAVIOR_PRESETS.find((p) => p.name === 'Drift');
    expect(drift?.expressions?.map((e) => e.prop)).toEqual(['x', 'y']);
    expect(drift?.expressions?.[0]?.expr).toContain('wiggle');
  });

  test('instantiating gives every row a fresh id', () => {
    const recipe = BEHAVIOR_RECIPES[0]!;
    const first = instantiateRecipe(recipe.props[0]!);
    const second = instantiateRecipe(recipe.props[0]!);
    expect(first[0]!.id).not.toBe(second[0]!.id);
  });

  test('Drift installs an editable wiggle stack on x and y', () => {
    const drift = BEHAVIOR_RECIPES.find((r) => r.preset === 'Drift')!;
    expect(applyBehaviorRecipe(NODE, drift)).toEqual(['x', 'y']);
    const stacks = readModifierStacks(defaultSceneGraph.getNode(NODE)!);
    expect(stacks.x?.modifiers[0]?.kind).toBe('wiggle');
    expect(stacks.y?.modifiers[0]?.kind).toBe('wiggle');
    // The point of the exercise: it is a typed row with numbers on it, not an
    // opaque formula.
    const w = stacks.x!.modifiers[0]!;
    expect(w.kind === 'wiggle' && w.freq).toBe(0.35);
    expect(defaultAnimation.getExpressionSrc(NODE, 'x')).toBe('wiggle(0.35, 38.4)');
  });

  test('Pendulum reproduces its preset’s rate to well under a visible margin', () => {
    const pendulum = BEHAVIOR_RECIPES.find((r) => r.preset === 'Pendulum')!;
    applyBehaviorRecipe(NODE, pendulum);
    const src = defaultAnimation.getExpressionSrc(NODE, 'rotation')!;
    // The preset is `value + Math.sin(time * 1.8) * 6`; the recipe stores Hz
    // and multiplies back by 2π, so the emitted rate must land on 1.8.
    const rate = Number(/time \* ([0-9.]+)/.exec(src)?.[1]);
    expect(rate).toBeCloseTo(1.8, 5);
    expect(src).toContain('* 6)');
  });
});
