/**
 * The three entry points for Convert Expression to Keyframes.
 *
 * ── WHY THIS IS A SEPARATE FILE (rule 4c) ───────────────────────────────────
 *
 * `convertExpressionToKeyframes.test.ts` proves the BAKE is right. It calls the
 * module directly, so it would pass in full on a build where nothing invokes
 * it. That is the F29 shape and it is exactly what a menu entry can be missing
 * without anything going red.
 *
 * Worse, the natural guard for wiring is the one rule 4c warns about: assert
 * that the menu model mentions the command id. That reads source text. It stays
 * green when the id is a typo, when the command is never registered, and when
 * the command's `execute` does something other than bake. The menu's id and the
 * registry's id are two guarded units and the STRING crossing between them is
 * what has to be watched.
 *
 * So each entry point is checked at the point where its claim becomes false:
 *
 * | Entry | Watched by |
 * |---|---|
 * | Command palette | the id is in the registered list AND its `execute` bakes |
 * | Animation menu | the id it names is in that same registered list |
 * | Property context menu | the built item's `onSelect` bakes, and only its own prop |
 */

import { buildStaticCommands } from '@providers/Providers';
import { APP_MENU } from '@layout/Menu/menuModel';
import { engineRowMenuItems } from '@layout/Inspector/propertyRowMenu';
import { setCommandSystem, CommandSystem } from '@core/commands/CommandSystem';
import { useSelectionStore } from '@stores/selectionStore';
import { setupAppEngine, historyLabels, trackRef } from '@core/engine/__testHelpers__/appEngine';
import { docView } from '@core/engine/__testHelpers__/docView';
import type { Harness } from '@core/engine/__testHelpers__/appEngine';
import { engineIdle } from '@core/engine/engineInstance';
import { documentMirror } from '@stores/documentMirror';

const COMMAND_ID = 'animation.convertExpressionToKeyframes';

beforeAll(() => {
  setCommandSystem(new CommandSystem({ services: {} as never, getState: () => ({}) }));
});

beforeEach(() => {
  useSelectionStore.getState().clear();
});

const command = () => buildStaticCommands().find((c) => c.id === COMMAND_ID);

/**
 * The command signature takes a `CommandContext`, and this one reads nothing
 * from it — it goes to the selection store for its node, like its neighbours.
 * Passing an empty object is honest about that; a richer fake would be a claim
 * about an API the command does not use.
 */
const run = (): void => { void command()!.execute({} as never); };

/**
 * The command bakes through the engine API (`convertExpressionToKeyframes`,
 * one undo entry), so executing it needs the app's engine and a layer made
 * through it — the expressions set with the engine's own `setExpression`, on
 * the member the legacy track names. The layer is selected.
 */
async function engineLayerWith(exprs: Record<string, string>): Promise<{ h: Harness; layer: string }> {
  const h = await setupAppEngine();
  const { layer } = await h.run({ type: 'createLayer', comp: 'comp_root', kind: 'shape', name: 'L', init: [] });
  for (const [track, source] of Object.entries(exprs)) {
    const b = await trackRef(layer, track);
    await h.run({ type: 'setExpression', prop: { layer, path: b.path }, source, enabled: true, ...(b.member !== undefined ? { member: b.member } : {}) });
  }
  await engineIdle();
  useSelectionStore.getState().set([layer]);
  return { h, layer };
}

/** Run the command, and check it made ONE undo entry that undo takes back whole. */
async function runAsOneEntry(h: Harness): Promise<() => Promise<void>> {
  const before = (await h.doc());
  const entries = (await historyLabels()).length;
  run();
  await engineIdle();
  expect((await historyLabels()).slice(entries)).toEqual(['Convert Expression to Keyframes']);
  return async () => {
    await h.run({ type: 'undo' });
    await engineIdle();
    expect((await h.doc())).toBe(before);
  };
}

describe('the command', () => {
  test('is registered under the id the menu names', async () => {
    expect(command()).toBeDefined();
  });

  test('is disabled with no selection, and with a selection that has no expression', async () => {
    expect(command()!.enabled?.()).toBe(false);
    const h = await setupAppEngine();
    const { layer } = await h.run({ type: 'createLayer', comp: 'comp_root', kind: 'shape', name: 'L', init: [] });
    await engineIdle();
    useSelectionStore.getState().set([layer]);
    expect(command()!.enabled?.()).toBe(false);
    await h.dispose();
  });

  test('is enabled once the selected layer has an ENABLED expression', async () => {
    // The predicate reads the document mirror (B4), so the layer and its
    // expression are made through the app's engine.
    const { h, layer } = await engineLayerWith({ x: 'time * 90' });
    try {
      const mirrored = async (): Promise<void> => {
        await engineIdle();
        documentMirror().tree(layer);
        await documentMirror().whenIdle();
      };
      await mirrored();
      expect(command()!.enabled?.()).toBe(true);

      // …and goes back to disabled when the expression is switched off, which is
      // the same question `execute` asks. One question, two callers.
      const b = await trackRef(layer, 'x');
      await h.run({ type: 'setExpression', prop: { layer, path: b.path }, source: 'time * 90', enabled: false, ...(b.member !== undefined ? { member: b.member } : {}) });
      await mirrored();
      expect(command()!.enabled?.()).toBe(false);
    } finally {
      await h.dispose();
    }
  });

  test('EXECUTING it bakes — not merely "the id exists"', async () => {
    const { h, layer } = await engineLayerWith({ x: 'time * 90' });
    try {
      const undoRestores = await runAsOneEntry(h);

      expect((await docView()).isAnimated(layer, 'x')).toBe(true);
      expect((await docView()).isExpressionEnabled(layer, 'x')).toBe(false);
      expect((await docView()).getExpressionSrc(layer, 'x')).toBe('time * 90');
      // The baked keys carry the expression's values (90 × t).
      const keys = (await docView()).getTrackKeyframes(layer, 'x')!;
      expect(keys.find((k) => Math.abs(k.t - 0.5) < 1e-6)?.value).toBeCloseTo(45);

      await undoRestores();
    } finally {
      await h.dispose();
    }
  });
});

describe('the Animation menu', () => {
  /**
   * The crossing: the menu names a command by string, and both renderers grey
   * an unregistered id out rather than failing. So the id being ON the menu and
   * the command EXISTING are two separate facts, and this is the one assertion
   * that requires them to agree.
   */
  test('names the command, and that name resolves to a registered command', async () => {
    const group = APP_MENU.find((g) => g.id === 'animation');
    expect(group).toBeDefined();
    // At any depth: the entry lives under Animation ▸ Bake.
    type Item = { commandId?: string; separator?: boolean; children?: ReadonlyArray<Item> | (() => ReadonlyArray<Item>) };
    const collect = (items: ReadonlyArray<Item>): Array<string | undefined> =>
      items.flatMap((i) => {
        if (i.separator) return [];
        const kids = i.children ? collect(typeof i.children === 'function' ? i.children() : i.children) : [];
        return [i.commandId, ...kids];
      });
    const ids = collect(group!.items);
    expect(ids).toContain(COMMAND_ID);

    const registered = new Set(buildStaticCommands().map((c) => String(c.id)));
    for (const id of ids) expect(registered.has(String(id)) || id === undefined).toBe(true);
  });
});

describe('the property context menu', () => {
  /** The row menu of `prop` on `layer`, with the mirror caught up (it reads the mirror). */
  const menu = async (layer: string, prop: string) => {
    await engineIdle();
    documentMirror().tree(layer);
    await documentMirror().whenIdle();
    return engineRowMenuItems({ nodeId: layer, prop, nodeIds: [layer], time: 0, label: prop, resetValue: undefined, setValue: () => undefined });
  };

  test('offers the entry only when the property has an ENABLED expression', async () => {
    const { h, layer } = await engineLayerWith({ rotation: 'time * 45' });
    try {
      const has = async (prop: string): Promise<boolean> => (await menu(layer, prop)).some((i) => i.id === 'expr-bake');
      expect(await has('x')).toBe(false);
      expect(await has('rotation')).toBe(true);
      const b = await trackRef(layer, 'rotation');
      await h.run({ type: 'setExpression', prop: { layer, path: b.path }, source: 'time * 45', enabled: false });
      expect(await has('rotation')).toBe(false);
    } finally {
      await h.dispose();
    }
  });

  /**
   * The difference from the command, and the reason this entry is not a
   * delegation: a right-click lands on ONE row and must mean that row. Baking
   * the layer's rotation because the user asked about its x is over-reach, and
   * a one-property fixture cannot see it — both behaviours look identical when
   * only one property has an expression.
   */
  test('its onSelect bakes ONLY the property clicked, leaving the layer\'s others alone', async () => {
    const { h, layer } = await engineLayerWith({ x: 'time * 90', rotation: 'time * 45' });
    try {
      (await menu(layer, 'x')).find((i) => i.id === 'expr-bake')!.onSelect!();
      const v = await docView();
      expect(v.isAnimated(layer, 'x')).toBe(true);
      expect(v.isExpressionEnabled(layer, 'x')).toBe(false);
      // Untouched: still expression-driven, still no track.
      expect(v.isAnimated(layer, 'rotation')).toBe(false);
      expect(v.isExpressionEnabled(layer, 'rotation')).toBe(true);
    } finally {
      await h.dispose();
    }
  });

  test('the COMMAND, by contrast, bakes every eligible property', async () => {
    const { h, layer } = await engineLayerWith({ x: 'time * 90', rotation: 'time * 45' });
    try {
      const undoRestores = await runAsOneEntry(h);

      expect((await docView()).isAnimated(layer, 'x')).toBe(true);
      expect((await docView()).isAnimated(layer, 'rotation')).toBe(true);

      await undoRestores();
    } finally {
      await h.dispose();
    }
  });
});
