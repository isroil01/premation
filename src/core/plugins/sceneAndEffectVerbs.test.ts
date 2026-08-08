/**
 * The verbs added so a plugin can rearrange a project rather than only add to it.
 *
 * Every one of these wraps an app function that was written for a menu, where
 * the caller can only pass something valid. Handed a string from `postMessage`
 * they behave differently, and in the same direction each time: they do nothing
 * and say nothing. So most of what is asserted here is that a bad call FAILS —
 * a plugin told "done" about work that did not happen is worse than one told no,
 * because the author has nothing to debug and the user has a project that
 * quietly did not change.
 */

import defaultSceneGraph from '@core/scene/DefaultSceneGraph';
import { seedDefaultScene } from '@core/scene/seedDefaultScene';
import { insertPrimitive } from '@core/scene/sceneInsert';
import { useSelectionStore } from '@stores/selectionStore';
import { getNodeEffects } from '@core/effects/effects';
import { setCommandSystem, CommandSystem } from '@core/commands/CommandSystem';
import { createHostApi } from './hostApi';
import type { PluginManifest } from './manifest';

const manifest = {
  id: 'studio.acme.tool',
  name: 'Tool',
  version: '1.0.0',
  description: 'A tool.',
  apiVersion: 2,
  main: 'main.js',
  permissions: [],
  activationEvents: ['onStartup'],
  contributes: { commands: [], panels: [], layerKinds: [], effects: [], net: null },
} as unknown as PluginManifest;

const api = createHostApi(manifest, {
  registerCommand: () => {},
  openPanel: () => {},
  closePanel: () => {},
  warn: () => {},
});

/** A fresh layer, returning its id. */
function newLayer(kind = 'shape'): string {
  insertPrimitive(kind as never, kind);
  return useSelectionStore.getState().ids[0]!;
}

/**
 * Every mutating verb runs inside `runDocumentEdit`, which needs a command
 * system — that is what makes a plugin's change ONE undo entry. Without it the
 * call throws before reaching the code under test, and every assertion fails on
 * a message about boot order rather than on anything these verbs do.
 */
beforeAll(() => {
  const services = {
    undo: { push: () => {}, undo: () => {}, redo: () => {}, canUndo: () => false, canRedo: () => false },
    selection: { get: () => [], set: () => {}, clear: () => {} },
    panels: { open: () => {}, close: () => {}, toggle: () => {}, isOpen: () => false },
    workspace: { setActive: () => {}, getActive: () => '' },
    get: () => undefined,
  } as never;
  setCommandSystem(new CommandSystem({ services, getState: () => ({}) }));
  seedDefaultScene();
});

describe('scene.setParent', () => {
  it('parents one layer under another', () => {
    const parent = newLayer();
    const child = newLayer();
    expect(api['scene.setParent']!(child, parent)).toBe(true);
    expect(defaultSceneGraph.getNode(child)!.parent).toBe(parent);
  });

  it('moves a layer back to the composition root with null', () => {
    const parent = newLayer();
    const child = newLayer();
    api['scene.setParent']!(child, parent);
    expect(api['scene.setParent']!(child, null)).toBe(true);
    expect(defaultSceneGraph.getNode(child)!.parent).not.toBe(parent);
  });

  it('★ refuses a cycle instead of returning false', () => {
    /*
      `reparentNode` answers `false` — it does not throw. Passing that through
      as a resolved value would let a plugin build what it believes is a
      hierarchy and never learn otherwise; the layers simply would not move.
    */
    const a = newLayer();
    const b = newLayer();
    api['scene.setParent']!(b, a);
    expect(() => api['scene.setParent']!(a, b)).toThrow(/cannot be parented there/);
  });

  it('refuses a parent that does not exist', () => {
    const child = newLayer();
    expect(() => api['scene.setParent']!(child, 'n_nope')).toThrow(/No layer with id/);
  });
});

describe('scene.setVisible / setLocked', () => {
  it('hides and shows a layer', () => {
    const id = newLayer();
    api['scene.setVisible']!(id, false);
    expect(defaultSceneGraph.getNode(id)!.visible).toBe(false);
    api['scene.setVisible']!(id, true);
    expect(defaultSceneGraph.getNode(id)!.visible).toBe(true);
  });

  it('locks and unlocks a layer', () => {
    const id = newLayer();
    api['scene.setLocked']!(id, true);
    expect(defaultSceneGraph.getNode(id)!.locked).toBe(true);
  });

  it('refuses a non-boolean rather than coercing it', () => {
    // `'false'` is truthy. Coercing would hide a layer the plugin meant to show.
    const id = newLayer();
    expect(() => api['scene.setVisible']!(id, 'false')).toThrow(/must be true or false/);
  });
});

describe('effects', () => {
  it('adds an effect and returns its id', () => {
    const id = newLayer();
    const fx = api['effects.add']!(id, 'blur') as string;
    expect(typeof fx).toBe('string');
    expect(getNodeEffects(id).map((e) => e.id)).toContain(fx);
  });

  it('★ refuses an effect type the host does not have', () => {
    /*
      The one that matters. `addEffect` opens with
      `const def = DEF.get(type); if (!def) return;` — an unknown type is a
      silent no-op returning undefined. Without this check the plugin would be
      told the effect was added, get an id back for nothing, and the only
      symptom would be an effect stack that did not grow.
    */
    const id = newLayer();
    expect(() => api['effects.add']!(id, 'studio.nobody.nothing')).toThrow(/is not an effect this editor has/);
    expect(getNodeEffects(id)).toHaveLength(0);
  });

  it('lists what is on a layer', () => {
    const id = newLayer();
    const fx = api['effects.add']!(id, 'blur') as string;
    const list = api['effects.list']!(id) as Array<{ id: string; type: string }>;
    expect(list.find((e) => e.id === fx)?.type).toBe('blur');
  });

  it('sets a parameter', () => {
    const id = newLayer();
    const fx = api['effects.add']!(id, 'blur') as string;
    api['effects.setParam']!(id, fx, 'radius', 12);
    expect(getNodeEffects(id).find((e) => e.id === fx)?.params?.radius).toBe(12);
  });

  it('removes an effect', () => {
    const id = newLayer();
    const fx = api['effects.add']!(id, 'blur') as string;
    api['effects.remove']!(id, fx);
    expect(getNodeEffects(id).map((e) => e.id)).not.toContain(fx);
  });

  it('★ refuses removing an effect that is not there', () => {
    // `removeEffect` filters, so this would otherwise succeed quietly — and a
    // plugin removing the wrong id would never find out.
    const id = newLayer();
    expect(() => api['effects.remove']!(id, 'fx_nope')).toThrow(/has no effect/);
  });

  it('★ refuses setting a parameter on an effect that is not there', () => {
    const id = newLayer();
    expect(() => api['effects.setParam']!(id, 'fx_nope', 'radius', 1)).toThrow(/has no effect/);
  });

  it('refuses a parameter value that is not a scalar', () => {
    const id = newLayer();
    const fx = api['effects.add']!(id, 'blur') as string;
    expect(() => api['effects.setParam']!(id, fx, 'radius', { a: 1 }))
      .toThrow(/number, string or boolean/);
  });
});
