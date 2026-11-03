/**
 * Window ▸ Extensions (docs/mockups/plugin-docking-ae.html, frame 3): every
 * installed plugin's panel, checked while docked, then Manage Plugins….
 */

import { resetPluginContribForTest, setPluginContrib } from '@core/nativePlugins/pluginContrib';
import { useLayoutStore } from '@stores/layoutStore';
import { APP_MENU, type MenuItemModel } from './menuModel';
import { buildExtensionsMenuItems } from './extensionsMenu';

const plugin = {
  id: 'premation.deepglow', name: 'Deep Glow', version: '1.0.0', vendor: 'Premation', sdk: '1.2', status: 'loaded' as const,
  error: '', effects: ['premation.deepglow'], gpu: true, panel: true, commands: [], importers: [], outputModules: [],
  panels: [{ id: 'scene', name: 'Scene Setup', page: 'scene.html' }], presets: [], layerTypes: [],
};

const actions = (items: MenuItemModel[]): MenuItemModel[] => items.filter((i) => !i.separator && i.onSelect);

describe('Window ▸ Extensions', () => {
  const openPanel = jest.fn();
  let realOpen: (id: string) => void;
  beforeEach(() => {
    realOpen = useLayoutStore.getState().openPanel;
    useLayoutStore.setState({ openPanel });
    openPanel.mockClear();
  });
  afterEach(() => {
    useLayoutStore.setState({ openPanel: realOpen });
    resetPluginContribForTest();
  });

  it('sits in the Window menu as a submenu built per draw', () => {
    const window = APP_MENU.find((g) => g.id === 'window');
    const ext = window?.items.find((i) => i.label === 'Extensions');
    expect(ext?.labelKey).toBe('menu.sub.extensions');
    expect(typeof ext?.children).toBe('function');
  });

  it('says there are no plugin panels, and still offers Manage Plugins…', () => {
    const items = buildExtensionsMenuItems();
    const none = items.find((i) => i.label === 'No plugin panels');
    expect(none).toBeDefined();
    expect(none?.onSelect).toBeUndefined(); // drawn disabled
    const manage = items.find((i) => i.label === 'Manage Plugins…');
    manage?.onSelect?.();
    expect(openPanel).toHaveBeenCalledWith('plugins');
  });

  it('lists each plugin panel, checked while docked, and opens it', () => {
    setPluginContrib([plugin]);
    const order = useLayoutStore.getState().panelOrder;
    useLayoutStore.setState({ panelOrder: { ...order, rightInspector: [...(order.rightInspector ?? []), 'plugin:premation.deepglow'] } });
    try {
      const items = actions(buildExtensionsMenuItems());
      expect(items.map((i) => i.label)).toEqual(['Deep Glow', 'Deep Glow: Scene Setup', 'Manage Plugins…']);
      expect(items[0]?.checked?.()).toBe(true);
      expect(items[1]?.checked?.()).toBe(false);
      items[1]?.onSelect?.();
      expect(openPanel).toHaveBeenCalledWith('plugin:premation.deepglow/scene');
      expect(buildExtensionsMenuItems().some((i) => i.label === 'No plugin panels')).toBe(false);
    } finally {
      useLayoutStore.setState({ panelOrder: order });
    }
  });
});
