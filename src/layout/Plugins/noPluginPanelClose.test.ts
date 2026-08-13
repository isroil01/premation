/**
 * No plugin surface offers to close itself.
 *
 * The rule, in the user's words: wherever a plugin's UI lands — a rail tab, a
 * tab inside the shared host, the Plugins list itself — there is no ✕ on it.
 * Closing is not what the user means when they want a plugin gone, and a button
 * that only hides the container is a worse version of the thing they do mean.
 * Disable or uninstall it from the Plugins panel; that also stops the worker.
 *
 * Asserted rather than remembered, because the ✕ has TWO independent sources and
 * neither is where you would look for it:
 *
 *  1. `PanelDef.closable` — `DockPanel` reads it and renders the button on the
 *     dock TAB. Nothing in the panel component is involved.
 *  2. The `onClose` prop on `Panel` — drawn in the panel's own header. Currently
 *     invisible on every plugin panel because they all pass `hideHeader`, which
 *     is exactly why an `onClose` can sit there looking harmless until someone
 *     removes `hideHeader` for an unrelated reason.
 *
 * So this checks both, and checks the second by reading the source: a render
 * test can only prove the button is absent in the states it happens to set up,
 * and `hideHeader` makes every state look identical.
 */

import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { usePluginStore } from '@stores/pluginStore';
import { parseManifest } from '@core/plugins/manifest';
import { PANEL_DEFS } from '@layout/EditorLayout/panelDefs';
import { pluginPanelDefs } from './pluginPanelDefs';

/** The panels whose whole content is plugin-provided or plugin-management UI. */
const PLUGIN_PANEL_IDS = ['plugins', 'marketplace'];

describe('plugin panels are not closable', () => {
  it.each(PLUGIN_PANEL_IDS)('the %s panel registers closable: false', (id) => {
    const def = PANEL_DEFS.find((p) => p.id === id);
    expect(def).toBeDefined();
    expect(def!.closable).toBe(false);
  });

  it('a plugin panel with its own rail tab registers closable: false', () => {
    const { manifest } = parseManifest({
      id: 'com.test.dedicated',
      name: 'Dedicated',
      version: '1.0.0',
      description: 'Fixture.',
      apiVersion: 2,
      main: 'main.js',
      permissions: [],
      contributes: {
        panels: [
          { id: 'main', title: 'Studio', entry: 'panel.html', placement: 'sidebar', icon: 'layers' },
        ],
      },
    });
    usePluginStore.setState({
      plugins: [
        {
          manifest,
          files: { 'panel.html': '<p>x</p>' },
          enabled: true,
          installedAt: '2026-01-01T00:00:00.000Z',
        },
      ],
    } as never);

    const defs = pluginPanelDefs();
    expect(defs).toHaveLength(1);
    expect(defs[0]!.closable).toBe(false);

    usePluginStore.setState({ plugins: [] } as never);
  });
});

describe('no plugin panel passes onClose', () => {
  const DIR = __dirname;

  /**
   * Derived from the directory, not listed, so a new panel component added here
   * is covered the day it lands rather than the day someone remembers this file.
   * The floor assertion is what stops a rename turning the sweep into a
   * vacuously passing empty list.
   */
  const files = readdirSync(DIR).filter(
    (f) => /\.tsx$/.test(f) && !/\.test\.tsx$/.test(f),
  );

  it('sweeps a plausible number of files', () => {
    expect(files.length).toBeGreaterThanOrEqual(8);
  });

  /**
   * Every `<Panel …>` opening tag in a file.
   *
   * Scoped to `Panel` deliberately. This started as "no `onClose` anywhere in
   * this directory", which was true while the directory held only panels and
   * became wrong the moment a Modal moved in: a dialog the user opened MUST be
   * closable, and asserting otherwise would block a legitimate change to prove
   * a rule about something else. The rule is about panels — the things that get
   * a permanent home in the dock — so the check is too.
   */
  function panelTags(src: string): string[] {
    const out: string[] = [];
    for (const m of src.matchAll(/<Panel\b/g)) {
      const start = m.index!;
      // The tag ends at the first `>` seen at brace depth ZERO. Stopping at the
      // first `>` outright is wrong and quietly so: `onClick={() => …}` contains
      // one, so any prop holding an arrow function ahead of `onClose` would cut
      // the slice short and the check would pass by not looking.
      let depth = 0;
      let end = src.length;
      for (let i = start; i < src.length; i++) {
        const c = src[i];
        if (c === '{') depth++;
        else if (c === '}') depth--;
        else if (c === '>' && depth === 0 && src[i - 1] !== '=') { end = i; break; }
      }
      out.push(src.slice(start, end));
    }
    return out;
  }

  it('the tag scanner survives an arrow function before onClose', () => {
    // Proves the check can still FAIL. A guard whose parser silently truncates
    // is a guard that passes for the broken version, which is worse than none.
    const fixture = `<Panel id="x" actions={items.map((i) => <b/>)} onClose={() => hide()}>`;
    expect(panelTags(fixture)).toHaveLength(1);
    expect(panelTags(fixture)[0]).toMatch(/\bonClose\b/);
  });

  it.each(files)('%s', (file) => {
    const src = readFileSync(join(DIR, file), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '');
    for (const tag of panelTags(src)) {
      expect(tag).not.toMatch(/\bonClose\b/);
    }
  });
});
