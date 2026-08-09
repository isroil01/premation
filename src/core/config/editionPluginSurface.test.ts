/**
 * No plugin surface is reachable when `pluginsEnabled()` is false.
 *
 * ── Why this test is the fix, and the predicate is not ──────────────────────
 *
 * The same shape `aiEnabled` was in, and the same trap. A gate like this is
 * easy to add and easy to make vacuous: most of the surfaces below are built
 * from registries that are EMPTY in a build with no plugins, so a local build
 * already showed almost nothing, and flipping a predicate would have looked
 * like a fix while changing nothing. An emptiness that happens to hold is not a
 * gate — it stops holding the day something registers a layer kind for an
 * unrelated reason, and nothing tells you.
 *
 * So the assertions are on the SURFACES, and each one is checked twice: present
 * in the server edition, absent in the local one. The first half is what stops
 * this file passing vacuously if a surface is deleted.
 *
 * IF THIS FAILS, you have added a plugin entry point a local build would show.
 * Gate it by absence — not by rendering a disabled state — and list it here.
 *
 * ── What is deliberately NOT gated ──────────────────────────────────────────
 *
 * Everything that reads plugin content out of a DOCUMENT. A project containing
 * a custom layer kind, a plugin effect or a proxy subtree must open, render and
 * re-save byte-identically in a build with no plugin support — the same
 * situation as opening it after an uninstall, which the hosted build already
 * faces. `uninstalledDocumentRoundTrip.test.ts` is that property, and it is the
 * reason this file asserts absence of ENTRY POINTS rather than absence of
 * plugin code.
 */

import { setEdition, pluginsEnabled, pluginRegistryEnabled } from './edition';
import { isPanelAvailable, PANEL_AVAILABILITY } from './panelAvailability';
import { availablePanelDefs, PANEL_DEFS, panelDef } from '@layout/EditorLayout/panelDefs';
import { getWorkspaceManager } from '@core/layout/workspaceManager';
import { pluginEffectDefs } from '@core/effects/pluginEffectDefs';
import { registerEffects, resetEffectsForTests } from '@core/plugins/pluginEffects';

/**
 * Panel ids that constitute a plugin surface.
 *
 * A list rather than a substring match: `marketplace` contains no plugin
 * substring and `plugins` would match nothing else, so a regex over ids would
 * miss one and prove nothing about the other.
 */
const PLUGIN_PANEL_IDS = ['marketplace', 'plugins'] as const;

const EFFECT = {
  id: 'tint',
  label: 'Tint',
  shader: '@fragment fn fs() -> @location(0) vec4<f32> { return vec4<f32>(1.0); }',
  params: { amount: { type: 'number' as const, default: 1 } },
};

afterEach(() => {
  setEdition('server');
  resetEffectsForTests();
});

describe('the predicate', () => {
  it('is read live, never captured at module scope', () => {
    /*
      The trap `panelAvailability` documents: its table is evaluated when the
      module is first imported, which happens through the App import graph —
      BEFORE `main.tsx` calls `setEdition()`. Anything that snapshots the answer
      captures the 'server' default and never gates. Proven by flipping twice
      against the same imported table.
    */
    setEdition('server');
    expect(pluginsEnabled()).toBe(true);
    setEdition('local');
    expect(pluginsEnabled()).toBe(false);
    setEdition('server');
    expect(pluginsEnabled()).toBe(true);
  });

  it('is wider than the registry gate, and both are false locally', () => {
    // `pluginRegistryEnabled` answers "may this build make a network request";
    // `pluginsEnabled` answers "does this build have the feature". They are
    // separate because the first is asked deep inside `registry.ts`, where the
    // answer must hold whatever the UI above it did.
    setEdition('local');
    expect(pluginsEnabled()).toBe(false);
    expect(pluginRegistryEnabled()).toBe(false);
  });
});

describe('the panel registry', () => {
  it('offers both plugin panels in the server edition', () => {
    // Guards the guard: if these panels stopped existing, every assertion below
    // would pass vacuously and this file would prove nothing.
    setEdition('server');
    const ids = availablePanelDefs().map((p) => p.id);
    for (const id of PLUGIN_PANEL_IDS) expect(ids).toContain(id);
  });

  it('withholds them in the local edition', () => {
    setEdition('local');
    const ids = availablePanelDefs().map((p) => p.id);
    for (const id of PLUGIN_PANEL_IDS) expect(ids).not.toContain(id);
  });

  it('still RESOLVES them by id, so a persisted layout renders a name not an id', () => {
    // `panelDef` is deliberately unfiltered. A layout saved in a server build
    // and opened in a local one still holds the id; the dock drops it because
    // it is unregistered, but anything that does name it must not print
    // `marketplace` at the user.
    setEdition('local');
    expect(panelDef('marketplace')?.title).toBe('Plugins');
    expect(panelDef('plugins')?.title).toBe('Plugin Panels');
  });

  it('names only panels that actually exist', () => {
    // A typo'd key here would gate nothing and never be noticed, because the
    // absent-means-available rule makes an unknown id look fine.
    const known = new Set(PANEL_DEFS.map((p) => p.id));
    for (const id of Object.keys(PANEL_AVAILABILITY)) expect(known).toContain(id);
  });

  it('is a predicate in the table, not a value', () => {
    setEdition('server');
    expect(isPanelAvailable('marketplace')).toBe(true);
    setEdition('local');
    expect(isPanelAvailable('marketplace')).toBe(false);
    setEdition('server');
    expect(isPanelAvailable('marketplace')).toBe(true);
  });
});

describe('the workspace presets', () => {
  it('mention no plugin panel in the local edition', () => {
    // A preset that lists a panel the dock will refuse produces a workspace
    // that silently applies less than it says.
    setEdition('local');
    for (const ws of getWorkspaceManager().listWorkspaces()) {
      const mentioned = [
        ...Object.values(ws.panelOrder ?? {}).flat(),
        ...Object.values(ws.activePanelByRegion ?? {}),
      ];
      for (const id of PLUGIN_PANEL_IDS) expect(mentioned).not.toContain(id);
    }
  });
});

describe('the effects browser', () => {
  it('lists a registered plugin effect in the server edition', () => {
    setEdition('server');
    registerEffects('studio.acme.lab', 'Acme Lab', [EFFECT]);
    expect(pluginEffectDefs().map((d) => d.type)).toContain('studio.acme.lab.tint');
  });

  it('lists none in the local edition, even with one registered', () => {
    /*
      The case that makes this a gate rather than an observation. Nothing CAN
      register an effect in a local build, because the host never boots — so
      asserting against an empty registry would prove only that the registry is
      empty. Registering one first is what distinguishes "gated" from "happens
      to be nothing there".
    */
    registerEffects('studio.acme.lab', 'Acme Lab', [EFFECT]);
    setEdition('local');
    expect(pluginEffectDefs()).toEqual([]);
  });
});
