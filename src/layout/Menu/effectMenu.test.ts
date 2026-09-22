/**
 * The Effect menu is generated from the effect registry.
 *
 * It was eight hand-written rows over ~200 effects. These walk the generated
 * tree so it cannot quietly fall behind the registry again.
 *
 * IF THIS FAILS you have added an effect category that `EFFECT_CATEGORY_ORDER`
 * (layout/Effects/effectCategory.ts) or `CATEGORY_LABEL_KEY` (effectMenu.ts)
 * does not know — the menu would silently drop every effect in it.
 */

import { EFFECT_DEFS, getNodeEffects } from '@core/effects/effects';
import { EFFECT_CATEGORY, EFFECT_CATEGORY_ORDER } from '@layout/Effects/effectCategory';
import SceneGraph from '@core/scene/SceneGraph';
import defaultSceneGraph from '@core/scene/DefaultSceneGraph';
import { SCENE_KIND_PROP } from '@core/scene/seedDefaultScene';
import { setCommandSystem, CommandSystem } from '@core/commands/CommandSystem';
import type { Command } from '@core/commands/Command';
import type { SceneNode } from '@core/types';
import { useSelectionStore } from '@stores/selectionStore';
import { APP_MENU, type MenuItemModel } from './menuModel';
import { buildEffectMenuCommands, buildEffectMenuItems, effectCommandId } from './effectMenu';

const kids = (it: MenuItemModel): ReadonlyArray<MenuItemModel> =>
  !it.children ? [] : typeof it.children === 'function' ? it.children() : it.children;

const folders = (): MenuItemModel[] => buildEffectMenuItems().filter((it) => !it.separator && Array.isArray(it.children));

describe('Effect menu', () => {
  it('is the Effect group of APP_MENU', () => {
    const group = APP_MENU.find((g) => g.id === 'effect');
    expect(group?.items.map((i) => i.label)).toEqual(buildEffectMenuItems().map((i) => i.label));
  });

  it('files every category the registry uses', () => {
    const used = new Set(Object.values(EFFECT_CATEGORY));
    for (const cat of used) expect(EFFECT_CATEGORY_ORDER).toContain(cat);
  });

  it('lists EVERY registered effect exactly once, under its own folder', () => {
    const listed = new Map<string, string>();
    for (const folder of folders()) {
      for (const item of kids(folder)) {
        expect(listed.has(item.commandId!)).toBe(false);
        listed.set(item.commandId!, folder.label!);
      }
    }
    expect(listed.size).toBe(EFFECT_DEFS.length);
    for (const d of EFFECT_DEFS) {
      expect(listed.get(effectCommandId(d.type))).toBe(EFFECT_CATEGORY[d.type]);
    }
  });

  it('gives every folder a translation key, in the browser’s order', () => {
    const labels = folders().map((f) => f.label);
    expect(labels).toEqual(EFFECT_CATEGORY_ORDER.filter((c) => labels.includes(c)));
    for (const f of folders()) expect(f.labelKey).toMatch(/^menu\.sub\.effect\.[a-zA-Z]+$/);
  });

  it('sorts each folder by name', () => {
    for (const f of folders()) {
      const names = kids(f).map((i) => i.label!);
      expect(names).toEqual([...names].sort((a, b) => a.localeCompare(b, 'en')));
    }
  });

  it('backs every row with a command', () => {
    const ids = new Set(buildEffectMenuCommands().map((c) => c.id as unknown as string));
    for (const f of folders()) for (const item of kids(f)) expect(ids.has(item.commandId!)).toBe(true);
  });

  it('hides the Plugins folder until a plugin ships an effect', () => {
    const plugins = buildEffectMenuItems().find((it) => it.labelKey === 'menu.sub.effect.plugins');
    expect(plugins?.visible?.()).toBe(false);
  });
});

function node(id: string): SceneNode {
  return {
    id, name: id, parent: null, children: [], visible: true, locked: false,
    transform: { position: { x: 0, y: 0 }, rotation: 0, scale: { x: 1, y: 1 } },
    components: [
      { id: `${id}_t`, type: 'Transform', props: { [SCENE_KIND_PROP]: 'shape', x: 0, y: 0 } },
      { id: `${id}_s`, type: 'Style', props: { fill: 'white', opacity: 100 } },
    ],
  };
}

describe('effect commands', () => {
  beforeAll(() => {
    // batchHistory records onto the command system — boot a minimal one.
    const dummyServices = {
      undo: { push: () => {}, undo: () => {}, redo: () => {}, canUndo: () => false, canRedo: () => false },
      selection: { get: () => [], set: () => {}, clear: () => {} },
      panels: { open: () => {}, close: () => {}, toggle: () => {}, isOpen: () => false },
      workspace: { setActive: () => {}, getActive: () => '' },
      get: () => undefined,
    } as never;
    setCommandSystem(new CommandSystem({ services: dummyServices, getState: () => ({}) }));
  });

  beforeEach(() => {
    (defaultSceneGraph as unknown as SceneGraph).clear();
    defaultSceneGraph.addNode(node('a'));
    defaultSceneGraph.addNode(node('b'));
    useSelectionStore.getState().set([]);
  });

  const glow = (): Command =>
    buildEffectMenuCommands().find((c) => (c.id as unknown as string) === effectCommandId('glow'))!;

  it('are disabled with nothing selected — the menu greys out', () => {
    for (const c of buildEffectMenuCommands()) expect(c.enabled?.()).toBe(false);
  });

  it('add the effect to every selected layer', () => {
    useSelectionStore.getState().set(['a', 'b']);
    expect(glow().enabled?.()).toBe(true);
    void glow().execute({} as never);
    expect(getNodeEffects('a').map((e) => e.type)).toEqual(['glow']);
    expect(getNodeEffects('b').map((e) => e.type)).toEqual(['glow']);
  });
});
