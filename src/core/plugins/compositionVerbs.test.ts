/**
 * Composition management — the verbs that change the SET of compositions.
 *
 * `composition.get` has always answered "what am I drawing into". These answer
 * "what else is here" and "make me another one", which is what a plugin that
 * builds a sequence — one comp per scene, a title copied into each — actually
 * needs. Before them a generator could fill the comp it happened to be opened
 * in and nothing else.
 *
 * The interesting cases are the bounds. Every argument here crossed
 * `postMessage`, so "the dialog would never send that" is not an argument that
 * applies: a comp 900 000 px wide is an allocation failure with a plugin's name
 * on it, and `NaN` slips through a range check written as two comparisons.
 */

import { seedDefaultScene } from '@core/scene/seedDefaultScene';
import { setCommandSystem, CommandSystem } from '@core/commands/CommandSystem';
import { createHostApi } from './hostApi';
import { METHOD_PERMISSIONS } from './protocol';
import type { PluginManifest } from './manifest';

const manifest = {
  id: 'studio.acme.seq',
  name: 'Sequencer',
  version: '1.0.0',
  description: 'Builds sequences.',
  apiVersion: 2,
  main: 'main.js',
  permissions: ['composition:write'],
  activationEvents: ['onStartup'],
  contributes: { commands: [], panels: [], layerKinds: [], effects: [], net: null },
} as unknown as PluginManifest;

const api = createHostApi(manifest, {
  registerCommand: () => {},
  openPanel: () => {},
  closePanel: () => {},
  warn: () => {},
  granted: () => new Set(['composition:write', 'scene:read']) as never,
});

const create = (s?: unknown): string => api['composition.create']!(s) as string;
const list = (): Array<Record<string, unknown>> =>
  api['composition.list']!() as Array<Record<string, unknown>>;

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

describe('reading the project', () => {
  it('lists the compositions that exist', () => {
    const before = list().length;
    create({ name: 'Scene 2' });
    const after = list();
    expect(after.length).toBe(before + 1);
    expect(after.some((c) => c.name === 'Scene 2')).toBe(true);
  });

  it('★ marks which one is active, rather than leaving it to be inferred', () => {
    // Comparing against `composition.get().name` is the obvious workaround and
    // it is wrong: names are not unique, so two comps called "Scene" make the
    // comparison pick whichever comes first.
    const id = create({ name: 'Duplicate' });
    create({ name: 'Duplicate' });
    const actives = list().filter((c) => c.active === true);
    expect(actives).toHaveLength(1);
    expect(actives[0]!.id).not.toBe(id); // the second one is open
  });

  it('reports each composition’s own settings', () => {
    const id = create({ name: 'Reel', width: 1080, height: 1920, fps: 60 });
    const c = list().find((x) => x.id === id)!;
    expect(c).toMatchObject({ width: 1080, height: 1920, fps: 60 });
  });
});

describe('creating', () => {
  it('returns the new id and opens it', () => {
    const id = create({ name: 'Opened' });
    expect(typeof id).toBe('string');
    expect(list().find((c) => c.id === id)!.active).toBe(true);
  });

  it('accepts no settings at all', () => {
    expect(typeof create()).toBe('string');
  });

  it('★ refuses a size that is an allocation failure, not a composition', () => {
    // These become a render target. The numbers crossed `postMessage`.
    expect(() => create({ width: 900_000 })).toThrow(/between 1 and 16384/);
    expect(() => create({ height: 0 })).toThrow(/between 1 and 16384/);
  });

  it('refuses a nonsense frame rate or duration', () => {
    expect(() => create({ fps: 0 })).toThrow(/between 1 and 240/);
    expect(() => create({ fps: 100_000 })).toThrow(/between 1 and 240/);
    expect(() => create({ durationSeconds: 0 })).toThrow(/between 0.1 and 36000/);
  });

  it('refuses NaN, which passes a naive range check', () => {
    // `NaN < 1` and `NaN > 16384` are both false, so a bounds test written as
    // two comparisons lets it straight through.
    expect(() => create({ width: Number.NaN })).toThrow(/between 1 and 16384/);
  });

  it('bounds the name rather than storing an essay', () => {
    const id = create({ name: 'x'.repeat(500) });
    expect((list().find((c) => c.id === id)!.name as string).length).toBeLessThanOrEqual(120);
  });
});

describe('renaming, opening, deleting', () => {
  it('renames', () => {
    const id = create({ name: 'Before' });
    expect(api['composition.rename']!(id, 'After')).toBe(true);
    expect(list().find((c) => c.id === id)!.name).toBe('After');
  });

  it('refuses an empty name instead of leaving a nameless comp', () => {
    const id = create({ name: 'Named' });
    expect(() => api['composition.rename']!(id, '   ')).toThrow(/cannot be empty/);
    expect(list().find((c) => c.id === id)!.name).toBe('Named');
  });

  it('opens an existing composition', () => {
    const first = create({ name: 'First' });
    create({ name: 'Second' });
    expect(api['composition.open']!(first)).toBe(true);
    expect(list().find((c) => c.id === first)!.active).toBe(true);
  });

  it('★ names the id it could not find, for all three verbs', () => {
    // A plugin holding a stale id gets a message it can act on rather than a
    // silent no-op that looks like the call worked.
    for (const verb of ['composition.open', 'composition.rename', 'composition.delete'] as const) {
      expect(() => api[verb]!('comp_gone', 'x')).toThrow(/No composition "comp_gone"/);
    }
  });

  it('deletes', () => {
    const id = create({ name: 'Doomed' });
    create({ name: 'Survivor' });
    expect(api['composition.delete']!(id)).toBe(true);
    expect(list().some((c) => c.id === id)).toBe(false);
  });

  it('★ deleting the LAST composition replaces it rather than emptying the project', () => {
    // A project with no composition has nowhere to draw, so the host mints a
    // fresh pristine one. Worth pinning because it is the surprising half: the
    // call reports `true` (the named comp really is gone) and the project is
    // still usable — a plugin cannot leave the editor with nothing open.
    const ids = list().map((c) => c.id as string);
    for (const id of ids.slice(1)) api['composition.delete']!(id);
    expect(list()).toHaveLength(1);

    const last = list()[0]!.id as string;
    expect(api['composition.delete']!(last)).toBe(true);
    expect(list()).toHaveLength(1);
    expect(list()[0]!.id).not.toBe(last);
  });
});

describe('the permission it rides on', () => {
  it('★ does not fold into scene:write', () => {
    /*
      "Modify your layers" is a statement about the composition the user is
      looking at. Adding and removing compositions restructures the project
      around them. Folding these into `scene:write` would make an existing
      grant silently mean more than it did when the user gave it.
    */
    for (const verb of ['composition.create', 'composition.open', 'composition.rename', 'composition.delete'] as const) {
      expect(METHOD_PERMISSIONS[verb]).toBe('composition:write');
    }
  });

  it('reading the list is scene:read, like reading layer names', () => {
    expect(METHOD_PERMISSIONS['composition.list']).toBe('scene:read');
  });

  it('reading the ACTIVE composition still needs nothing', () => {
    // Unchanged: `composition.get` is settings for the comp you were opened
    // in, and gating it would break every plugin that sizes its output.
    expect(METHOD_PERMISSIONS['composition.get']).toBeNull();
  });
});
