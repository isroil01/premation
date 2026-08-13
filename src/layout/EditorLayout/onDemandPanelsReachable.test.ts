/**
 * Every on-demand panel must have something that opens it.
 *
 * An `onDemand: true` panel is not in the dock until something calls
 * `openPanel(id)`. So registering one without also registering a command, or a
 * menu entry, produces a panel that exists, renders correctly, is covered by
 * its own tests — and that no user can reach. Nothing fails. The feature is
 * simply invisible.
 *
 * This is exactly how the Plugins panel shipped in its first form: registered
 * in `panelDefs.ts`, rendered by `getAllPanelRenderers`, fully tested, and
 * absent from the running app because no command opened it. It was found by
 * someone looking for it in the UI, which is the most expensive way to find it.
 *
 * The subjects are DERIVED from `PANEL_DEFS` rather than listed, so the next
 * on-demand panel is covered the day it is added rather than the day someone
 * remembers to add it here.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PANEL_DEFS } from './panelDefs';

const SRC = join(__dirname, '..', '..');

/** Files that can open a panel: command registrations and menu models. */
const OPENER_FILES = [
  'providers/Providers.tsx',
  'layout/Menu/menuModel.ts',
  'layout/Menu/pluginMenu.ts',
  'App.tsx',
];

const openerSource = OPENER_FILES.map((rel) => {
  try {
    return readFileSync(join(SRC, rel), 'utf8');
  } catch {
    return '';
  }
}).join('\n');

describe('on-demand panels are reachable', () => {
  const onDemand = PANEL_DEFS.filter((d) => d.onDemand);

  it('found some on-demand panels to check', () => {
    // Without this, a rename of the flag would empty the list and every
    // assertion below would pass having checked nothing.
    expect(onDemand.length).toBeGreaterThan(0);
  });

  it.each(onDemand.map((d) => [d.id, d.title] as const))(
    '%s (%s) has something that opens it',
    (id) => {
      // Either a direct `openPanel('id')`, or a command whose id names the
      // panel and which some menu references. Both are real routes in; what
      // must not exist is a panel that appears in neither.
      const opensDirectly = openerSource.includes(`openPanel('${id}')`)
        || openerSource.includes(`openPanel("${id}")`);
      const hasCommand = openerSource.includes(`view.${id}`);

      expect({ id, reachable: opensDirectly || hasCommand }).toEqual({ id, reachable: true });
    },
  );

  it('the Plugins panel is reachable from the Plugins menu specifically', () => {
    // The regression that prompted this file. The palette alone is not
    // discovery: searching for a feature requires already knowing it exists.
    const menu = readFileSync(join(SRC, 'layout/Menu/pluginMenu.ts'), 'utf8');
    expect(menu).toContain('view.marketplace');
  });
});
