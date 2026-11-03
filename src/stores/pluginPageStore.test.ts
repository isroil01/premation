import { useFootageViewerStore } from './footageViewerStore';
import { useLayerViewerStore } from './layerViewerStore';
import { usePluginPageStore } from './pluginPageStore';

const pages = () => usePluginPageStore.getState();

beforeEach(() => {
  usePluginPageStore.setState({ pages: [], active: null });
  useLayerViewerStore.getState().close();
  useFootageViewerStore.getState().close();
});

describe('plugin pages', () => {
  it('opens one tab per plugin and reuses it', () => {
    pages().open({ id: 'a', name: 'A' });
    pages().open({ id: 'b', name: 'B' });
    pages().open({ id: 'a', name: 'A' });
    expect(pages().pages.map((p) => p.id)).toEqual(['a', 'b']);
    expect(pages().active).toBe('a');
  });

  it('a reopened tab takes the latest name', () => {
    pages().open({ id: 'a', name: 'A' });
    pages().open({ id: 'a', name: 'Renamed' });
    expect(pages().pages).toEqual([{ id: 'a', name: 'Renamed' }]);
  });

  it('closing the page in front brings its neighbour forward, then gives the body back', () => {
    pages().open({ id: 'a', name: 'A' });
    pages().open({ id: 'b', name: 'B' });
    pages().open({ id: 'c', name: 'C' });
    pages().activate('b');
    pages().close('b');
    expect(pages().active).toBe('c');
    pages().close('c');
    expect(pages().active).toBe('a');
    pages().close('a');
    expect(pages()).toMatchObject({ pages: [], active: null });
  });

  it('closing a page behind leaves the one in front', () => {
    pages().open({ id: 'a', name: 'A' });
    pages().open({ id: 'b', name: 'B' });
    pages().close('a');
    expect(pages().active).toBe('b');
  });

  it('activate(null) shows the viewers; an unknown id is ignored', () => {
    pages().open({ id: 'a', name: 'A' });
    pages().activate(null);
    expect(pages().active).toBeNull();
    pages().activate('nope');
    expect(pages().active).toBeNull();
    expect(pages().pages).toHaveLength(1);
  });

  it('opening the Layer or Footage viewer brings it in front of a plugin page', () => {
    pages().open({ id: 'a', name: 'A' });
    useLayerViewerStore.setState({ nodeId: 'layer-1' } as never);
    expect(pages().active).toBeNull();
    pages().activate('a');
    useFootageViewerStore.getState().show();
    expect(pages().active).toBeNull();
    expect(pages().pages).toHaveLength(1);
  });
});
