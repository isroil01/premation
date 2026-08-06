/**
 * The host arbitrates placement; the manifest only asks.
 *
 * Every case here is one that looks fine with two plugins installed, which is
 * the number installed while the feature is being written:
 *
 *  • The rail budget only bites at the fourth plugin, so a cap that was never
 *    applied would pass any test with a realistic fixture.
 *  • Demotion has to be REPORTED, or the difference between "the author's
 *    screenshot is wrong" and "your sidebar was full" is invisible.
 *  • A plugin panel id has to be namespaced, and the collision that proves it
 *    needs a plugin cheeky enough to call its panel `scene`.
 */

import { usePluginStore } from '@stores/pluginStore';
import pluginHost from '@core/plugins/PluginHost';
import { parseManifest, type PluginManifest } from '@core/plugins/manifest';
import {
  RAIL_SLOTS,
  dedicatedPanelId,
  panelPlacements,
  parseDedicatedPanelId,
  pluginPanelDefs,
} from './pluginPanelDefs';

function manifestWith(
  id: string,
  panels: Array<{ id: string; title: string; entry: string; placement?: string; icon?: string }>,
): PluginManifest {
  const { manifest, errors } = parseManifest({
    id,
    name: id,
    version: '1.0.0',
    description: 'Fixture.',
    apiVersion: 2,
    main: 'main.js',
    permissions: [],
    contributes: { panels },
  });
  if (!manifest) throw new Error(`invalid fixture manifest: ${errors.join(' ')}`);
  return manifest;
}

/** Install `n` plugins that each ask for their own sidebar tab. */
function installSidebarPlugins(n: number, prefix = 'com.test.side'): void {
  const plugins = Array.from({ length: n }, (_, i) => ({
    manifest: manifestWith(`${prefix}${i}`, [
      { id: 'main', title: `Panel ${i}`, entry: 'panel.html', placement: 'sidebar', icon: 'layers' },
    ]),
    files: { 'panel.html': '<p>x</p>' },
    enabled: true,
    installedAt: '2026-01-01T00:00:00.000Z',
  }));
  usePluginStore.setState({ plugins } as never);
}

beforeEach(() => {
  usePluginStore.setState({ plugins: [] } as never);
  jest.restoreAllMocks();
});

describe('placement arbitration', () => {
  it('leaves an undeclared panel in the shared host and gives it no rail tab', () => {
    usePluginStore.setState({
      plugins: [
        {
          manifest: manifestWith('com.test.plain', [
            { id: 'main', title: 'Tools', entry: 'panel.html' },
          ]),
          files: { 'panel.html': '<p>x</p>' },
          enabled: true,
          installedAt: '2026-01-01T00:00:00.000Z',
        },
      ],
    } as never);

    expect(panelPlacements().map((p) => p.granted)).toEqual(['shared']);
    expect(pluginPanelDefs()).toEqual([]);
  });

  it('grants a rail tab up to the budget and DEMOTES the rest instead of dropping them', () => {
    const over = RAIL_SLOTS.sidebar + 2;
    installSidebarPlugins(over);

    const placements = panelPlacements();
    // Nothing is lost — every declared panel still resolves somewhere. A plugin
    // whose panel simply vanished would be indistinguishable from one that
    // failed to install.
    expect(placements).toHaveLength(over);
    expect(placements.filter((p) => p.granted === 'sidebar')).toHaveLength(RAIL_SLOTS.sidebar);
    expect(placements.filter((p) => p.granted === 'shared')).toHaveLength(2);
    expect(placements.filter((p) => p.demoted)).toHaveLength(2);
    expect(pluginPanelDefs()).toHaveLength(RAIL_SLOTS.sidebar);
  });

  it('budgets the two rails separately', () => {
    usePluginStore.setState({
      plugins: [
        {
          manifest: manifestWith('com.test.both', [
            { id: 'left', title: 'L', entry: 'l.html', placement: 'sidebar', icon: 'layers' },
            { id: 'right', title: 'R', entry: 'r.html', placement: 'inspector', icon: 'sliders-h' },
          ]),
          files: { 'l.html': '<p>l</p>', 'r.html': '<p>r</p>' },
          enabled: true,
          installedAt: '2026-01-01T00:00:00.000Z',
        },
      ],
    } as never);

    // A full left rail must not deny a right-inspector panel, which sharing one
    // counter would do.
    expect(pluginPanelDefs().map((d) => d.region)).toEqual(['leftSidebar', 'rightInspector']);
  });

  it('allocates slots to working plugins before broken ones', () => {
    installSidebarPlugins(RAIL_SLOTS.sidebar + 1);
    // The FIRST-installed plugin is the one that crashed. Without the error
    // ordering it would hold a slot it cannot use while a healthy plugin behind
    // it is demoted.
    jest.spyOn(pluginHost, 'info').mockImplementation(
      (id: string) =>
        ({
          status: id === 'com.test.side0' ? 'error' : 'inactive',
          commands: [],
          panelOpen: false,
        }) as never,
    );

    const granted = panelPlacements().filter((p) => p.granted === 'sidebar').map((p) => p.pluginId);
    expect(granted).not.toContain('com.test.side0');
    expect(granted).toHaveLength(RAIL_SLOTS.sidebar);
  });

  it('drops a disabled plugin entirely — that is what clears a tab off the rail', () => {
    installSidebarPlugins(1);
    usePluginStore.setState((s) => ({
      plugins: s.plugins.map((p) => ({ ...p, enabled: false })),
    }) as never);

    expect(panelPlacements()).toEqual([]);
    expect(pluginPanelDefs()).toEqual([]);
  });

  it('lists a plugin that is enabled but NOT running', () => {
    installSidebarPlugins(1);
    jest.spyOn(pluginHost, 'isRunning').mockReturnValue(false);

    // `onPanel:<id>` activation is only reachable if the tab exists before the
    // plugin starts — selecting it is the event that starts it. A tab gated on
    // `isRunning` can only ever be used by a plugin that did not need it.
    expect(pluginPanelDefs()).toHaveLength(1);
  });
});

describe('panel ids', () => {
  it('cannot collide with a built-in panel', () => {
    const id = dedicatedPanelId('com.test.rude', 'scene');
    expect(id).not.toBe('scene');
    expect(parseDedicatedPanelId(id)).toEqual({ pluginId: 'com.test.rude', panelId: 'scene' });
  });

  it('does not claim ids that are not plugin panels', () => {
    for (const id of ['scene', 'plugins', 'marketplace', 'plugin', 'plugin:incomplete']) {
      expect(parseDedicatedPanelId(id)).toBeNull();
    }
  });
});

describe('the rail tab itself', () => {
  it('is never closable — removal is the toggle in the Plugins panel', () => {
    installSidebarPlugins(2);
    // The ✕ on a dock tab comes from `PanelDef.closable`, so this is the flag
    // that decides whether the editor offers to "close" something whose only
    // route back is a menu the user would have to already know about.
    expect(pluginPanelDefs().every((d) => d.closable === false)).toBe(true);
  });

  it('sits after every built-in panel in its rail', () => {
    installSidebarPlugins(1);
    const [def] = pluginPanelDefs();
    // `project` is the lowest-weighted built-in on the left. A plugin that
    // outranked it would push the app's own panels down the rail.
    expect(def!.weight).toBeLessThan(3);
  });

  it('carries the declared glyph, because the rail shows no titles', () => {
    installSidebarPlugins(1);
    expect(pluginPanelDefs()[0]!.icon).toBe('layers');
  });
});
