import type { PluginInfo } from '@motion/engine-api';
import { pluginEffectPanelId, pluginPanel, pluginPanels, resetPluginContribForTest, setPluginContrib } from './pluginContrib';

function info(over: Partial<PluginInfo>): PluginInfo {
  return {
    id: 'x', name: 'X', version: '1.0.0', vendor: '', sdk: '1.2', status: 'loaded', error: '',
    effects: [], gpu: false, panel: false, commands: [], importers: [], outputModules: [], panels: [], presets: [], layerTypes: [],
    interpolators: [],
    tools: [],
    ...over,
  };
}

describe('plugin panels', () => {
  afterEach(() => resetPluginContribForTest());

  it('gives an effect plugin with a page its own panel, before its manifest panels', () => {
    setPluginContrib([
      info({ id: 'desktop.element', name: 'Element', effects: ['desktop.element'], panel: true, panels: [{ id: 'lib', name: 'Library', page: 'lib.html' }] }),
    ]);
    expect(pluginPanels().map((p) => [p.panelId, p.kind, p.panel.name])).toEqual([
      ['plugin:desktop.element', 'effect', 'Element'],
      ['plugin:desktop.element/lib', 'tool', 'Library'],
    ]);
    expect(pluginPanel(pluginEffectPanelId('desktop.element'))?.kind).toBe('effect');
  });

  it('gives no own panel without a page, without effects, or while not loaded', () => {
    setPluginContrib([
      info({ id: 'a', effects: ['a'], panel: false }),
      info({ id: 'b', effects: [], panel: true }),
      info({ id: 'c', effects: ['c'], panel: true, status: 'disabled' }),
    ]);
    expect(pluginPanels()).toEqual([]);
  });
});
