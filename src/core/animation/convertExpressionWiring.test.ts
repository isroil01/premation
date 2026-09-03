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

import { defaultAnimation } from '@motion/animation';
import { buildStaticCommands } from '@providers/Providers';
import { APP_MENU } from '@layout/Menu/menuModel';
import { buildPropertyMenu } from '@core/inspector/propertyMenu';
import { getTimelineController } from '@core/timeline/TimelineController';
import defaultSceneGraph from '@core/scene/DefaultSceneGraph';
import { SCENE_KIND_PROP } from '@core/scene/seedDefaultScene';
import { setCommandSystem, CommandSystem, getCommandSystem } from '@core/commands/CommandSystem';
import { useSelectionStore } from '@stores/selectionStore';
import type { SceneNode } from '@core/types';

const NODE = 'wire-node';
const COMMAND_ID = 'animation.convertExpressionToKeyframes';
const FPS = 30;

beforeAll(() => {
  setCommandSystem(new CommandSystem({ services: {} as never, getState: () => ({}) }));
});

function addNode(): void {
  defaultSceneGraph.addNode({
    id: NODE, name: NODE, parent: null, children: [], visible: true, locked: false,
    transform: { position: { x: 0, y: 0 }, rotation: 0, scale: { x: 1, y: 1 } },
    components: [
      { id: `${NODE}_t`, type: 'Transform', props: { [SCENE_KIND_PROP]: 'shape', x: 0, y: 0, rotation: 0, scaleX: 1, scaleY: 1, opacity: 100 } },
    ],
  } as unknown as SceneNode);
  const c = getTimelineController();
  const trackId = c.timeline.getTracks()[0]!.id;
  c.timeline.addLayer(String(trackId), {
    name: NODE, sourceId: NODE, clip: { start: 0, duration: FPS },
  });
  c.invalidateLayerIndex();
}

beforeEach(() => {
  const ids: string[] = [];
  defaultSceneGraph.traverse((n) => ids.push(n.id));
  for (const id of ids) defaultSceneGraph.removeNode(id);
  const c = getTimelineController();
  for (const track of c.timeline.getTracks()) {
    for (const layer of [...track.layers]) c.timeline.removeLayer(layer.id);
  }
  c.invalidateLayerIndex();
  defaultAnimation.clear();
  getCommandSystem().getHistory().clear();
  useSelectionStore.getState().clear();
  addNode();
});

const command = () => buildStaticCommands().find((c) => c.id === COMMAND_ID);

/**
 * The command signature takes a `CommandContext`, and this one reads nothing
 * from it — it goes to the selection store for its node, like its neighbours.
 * Passing an empty object is honest about that; a richer fake would be a claim
 * about an API the command does not use.
 */
const run = (): void => { void command()!.execute({} as never); };

describe('the command', () => {
  test('is registered under the id the menu names', () => {
    expect(command()).toBeDefined();
  });

  test('is disabled with no selection, and with a selection that has no expression', () => {
    expect(command()!.enabled?.()).toBe(false);
    useSelectionStore.getState().set([NODE]);
    expect(command()!.enabled?.()).toBe(false);
  });

  test('is enabled once the selected layer has an ENABLED expression', () => {
    defaultAnimation.setExpression(NODE, 'x', 'time * 90');
    useSelectionStore.getState().set([NODE]);
    expect(command()!.enabled?.()).toBe(true);

    // …and goes back to disabled when the expression is switched off, which is
    // the same predicate `execute` uses. One question, two callers.
    defaultAnimation.setExpressionEnabled(NODE, 'x', false);
    expect(command()!.enabled?.()).toBe(false);
  });

  test('EXECUTING it bakes — not merely "the id exists"', () => {
    defaultAnimation.setExpression(NODE, 'x', 'time * 90');
    useSelectionStore.getState().set([NODE]);

    run();

    expect(defaultAnimation.isAnimated(NODE, 'x')).toBe(true);
    expect(defaultAnimation.isExpressionEnabled(NODE, 'x')).toBe(false);
    expect(defaultAnimation.getExpressionSrc(NODE, 'x')).toBe('time * 90');
    expect(defaultAnimation.sample(NODE, 'x', 0.5)).toBeCloseTo(45);
  });
});

describe('the Animation menu', () => {
  /**
   * The crossing: the menu names a command by string, and both renderers grey
   * an unregistered id out rather than failing. So the id being ON the menu and
   * the command EXISTING are two separate facts, and this is the one assertion
   * that requires them to agree.
   */
  test('names the command, and that name resolves to a registered command', () => {
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
  const ctx = (prop: string) => ({ nodeId: NODE, prop, layerT: 0, value: 0 });

  test('offers the entry only when the property has an ENABLED expression', () => {
    const has = (prop: string): boolean =>
      buildPropertyMenu(ctx(prop)).some((i) => i.id === 'expr-bake');

    expect(has('x')).toBe(false);
    defaultAnimation.setExpression(NODE, 'x', 'time * 90');
    expect(has('x')).toBe(true);
    defaultAnimation.setExpressionEnabled(NODE, 'x', false);
    expect(has('x')).toBe(false);
  });

  test('its onSelect bakes', () => {
    defaultAnimation.setExpression(NODE, 'x', 'time * 90');
    const item = buildPropertyMenu(ctx('x')).find((i) => i.id === 'expr-bake')!;
    item.onSelect!();

    expect(defaultAnimation.isAnimated(NODE, 'x')).toBe(true);
    expect(defaultAnimation.isExpressionEnabled(NODE, 'x')).toBe(false);
  });

  /**
   * The difference from the command, and the reason this entry is not a
   * delegation: a right-click lands on ONE row and must mean that row. Baking
   * the layer's rotation because the user asked about its x is over-reach, and
   * a one-property fixture cannot see it — both behaviours look identical when
   * only one property has an expression.
   */
  test('bakes ONLY the property clicked, leaving the layer\'s others alone', () => {
    defaultAnimation.setExpression(NODE, 'x', 'time * 90');
    defaultAnimation.setExpression(NODE, 'rotation', 'time * 45');

    buildPropertyMenu(ctx('x')).find((i) => i.id === 'expr-bake')!.onSelect!();

    expect(defaultAnimation.isAnimated(NODE, 'x')).toBe(true);
    expect(defaultAnimation.isExpressionEnabled(NODE, 'x')).toBe(false);
    // Untouched: still expression-driven, still no track.
    expect(defaultAnimation.isAnimated(NODE, 'rotation')).toBe(false);
    expect(defaultAnimation.isExpressionEnabled(NODE, 'rotation')).toBe(true);
  });

  test('the COMMAND, by contrast, bakes every eligible property', () => {
    defaultAnimation.setExpression(NODE, 'x', 'time * 90');
    defaultAnimation.setExpression(NODE, 'rotation', 'time * 45');
    useSelectionStore.getState().set([NODE]);

    run();

    expect(defaultAnimation.isAnimated(NODE, 'x')).toBe(true);
    expect(defaultAnimation.isAnimated(NODE, 'rotation')).toBe(true);
  });
});
