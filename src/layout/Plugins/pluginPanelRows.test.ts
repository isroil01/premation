import type { StorePluginSummary } from '@core/api/client';
import type { PluginEffectDef } from '@core/inspector/pluginEffectDefs';
import type { PluginPanelEntry } from '@core/nativePlugins/pluginContrib';
import type { NativePlugin } from '@core/nativePlugins/nativePlugins';
import {
  buildPluginSidebar,
  formatInstalls,
  installedAction,
  pluginContents,
  rowMeta,
  visibleRows,
  type PluginSidebarInputs,
} from './pluginPanelRows';

const plugin = (id: string, extra: Partial<NativePlugin> = {}): NativePlugin => ({
  id, name: id.toUpperCase(), version: '1.0.0', vendor: 'Acme', sdk: '1.2', status: 'loaded', error: '', effects: [], gpu: false,
  panel: false, commands: [], importers: [], outputModules: [], panels: [], presets: [], layerTypes: [],
    interpolators: [],
    tools: [],
    audio: [],
    isolation: 'engine',
    isolationPin: '', ...extra,
});

const listing = (id: string, extra: Partial<StorePluginSummary> = {}): StorePluginSummary => ({
  id, name: `Store ${id}`, description: `desc ${id}`, latestVersion: '2.0.0', kind: 'native', tier: 'free', sdk: null, platforms: [],
  effects: [], installs: 0, publisherKey: 'k', sha256: 's', updatedAt: '', publisher: { namespace: 'ns', displayName: 'Maker', verified: false },
  categories: [], license: null, iconUrl: null, ...extra,
});

function inputs(extra: Partial<PluginSidebarInputs> = {}): PluginSidebarInputs {
  return {
    plugins: [plugin('a'), plugin('b', { status: 'disabled' })],
    listings: [listing('a', { installs: 1500 }), listing('c'), listing('d')],
    managed: new Set(['a']),
    updates: new Map(),
    uninstalling: new Set(),
    query: '',
    ...extra,
  };
}

describe('buildPluginSidebar', () => {
  it('lists installed plugins, and store plugins only when not installed (by the engine or by main)', () => {
    const s = buildPluginSidebar(inputs({ managed: new Set(['a', 'd']) }));
    expect(s.installed.map((r) => r.plugin.id)).toEqual(['a', 'b']);
    expect(s.installed[0]!.listing?.installs).toBe(1500);
    // d waits for a restart: installed, not offered again.
    expect(s.store.map((r) => r.listing.id)).toEqual(['c']);
  });

  it('gives each row its one action and counts updates', () => {
    const s = buildPluginSidebar(inputs({ updates: new Map([['a', '1.1.0']]) }));
    expect(s.installed.map((r) => r.action)).toEqual(['update', 'enable']);
    expect(s.installed[0]!.status.text).toBe('Update 1.1.0');
    expect(s.updateCount).toBe(1);
  });

  it('a queued removal has no button and no update', () => {
    const s = buildPluginSidebar(inputs({ updates: new Map([['a', '1.1.0']]), uninstalling: new Set(['a']) }));
    expect(s.installed[0]).toMatchObject({ action: null, update: undefined });
    expect(s.installed[0]!.status.text).toBe('Removed on restart');
    expect(s.updateCount).toBe(0);
  });

  it('filters both sections with one search (name, id, vendor, description, publisher)', () => {
    expect(buildPluginSidebar(inputs({ query: 'desc c' })).store.map((r) => r.listing.id)).toEqual(['c']);
    const byName = buildPluginSidebar(inputs({ query: 'B' }));
    expect(byName.installed.map((r) => r.plugin.id)).toEqual(['b']);
    expect(byName.store).toEqual([]);
    // The store listing's description finds the installed plugin too.
    expect(buildPluginSidebar(inputs({ query: 'desc a' })).installed.map((r) => r.plugin.id)).toEqual(['a']);
    expect(buildPluginSidebar(inputs({ query: 'maker' })).store).toHaveLength(2);
  });

  it('marks the publisher\'s own private listings', () => {
    const s = buildPluginSidebar(inputs({ owned: new Set(['d']) }));
    expect(s.store.map((r) => r.owner)).toEqual([false, true]);
  });

  it('works without the store', () => {
    const s = buildPluginSidebar(inputs({ listings: null }));
    expect(s.installed).toHaveLength(2);
    expect(s.store).toEqual([]);
  });

  it('walks only the open sections', () => {
    const s = buildPluginSidebar(inputs());
    expect(visibleRows(s, { installed: false, store: false }).map((r) => r.id)).toEqual(['installed:a', 'installed:b', 'store:c', 'store:d']);
    expect(visibleRows(s, { installed: true, store: false }).map((r) => r.id)).toEqual(['store:c', 'store:d']);
  });
});

describe('installedAction', () => {
  const base = { update: undefined, managed: true, uninstalling: false };
  it('offers Uninstall only for what main manages, nothing for locked or hand-copied plugins', () => {
    expect(installedAction(plugin('a'), base)).toBe('uninstall');
    expect(installedAction(plugin('a'), { ...base, managed: false })).toBeNull();
    expect(installedAction(plugin('a', { status: 'locked' }), base)).toBeNull();
    expect(installedAction(plugin('a', { status: 'disabled' }), { ...base, managed: false })).toBe('enable');
  });
});

describe('row meta', () => {
  it('reads vendor and installs', () => {
    const s = buildPluginSidebar(inputs());
    expect(rowMeta(s.installed[0]!)).toEqual(['Acme', '↓ 1.5K']);
    expect(rowMeta(s.store[0]!)).toEqual(['Maker']);
  });

  it('shortens installs', () => {
    expect(formatInstalls(999)).toBe('999');
    expect(formatInstalls(1000)).toBe('1K');
    expect(formatInstalls(12_480)).toBe('12.4K');
    expect(formatInstalls(2_350_000)).toBe('2.3M');
  });
});

describe('pluginContents', () => {
  it('collects one plugin\'s effects, presets (with their effect\'s name) and panels', () => {
    const effects = [
      { type: 'a.glow', label: 'Glow', provider: 'a' },
      { type: 'b.warp', label: 'Warp', provider: 'b' },
    ] as unknown as PluginEffectDef[];
    const presets = [
      { plugin: 'a', effect: 'a.glow', name: 'Neon', values: [], category: '' },
      { plugin: 'b', effect: 'b.warp', name: 'Twist', values: [], category: '' },
    ];
    const panels = [{ panelId: 'plugin:a', plugin: 'a', pluginName: 'A', panel: { id: '', name: 'A', page: 'index.html' }, kind: 'effect' }] as unknown as PluginPanelEntry[];
    const c = pluginContents('a', { effects, presets, panels });
    expect(c.effects.map((d) => d.type)).toEqual(['a.glow']);
    expect(c.presets).toEqual([{ preset: presets[0], effectLabel: 'Glow' }]);
    expect(c.panels.map((p) => p.panelId)).toEqual(['plugin:a']);
  });
});
