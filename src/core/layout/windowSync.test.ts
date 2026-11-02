/**
 * A pop-out follows the editor's active composition and play state. Its own
 * tabs start on the page's placeholder composition, so without this a
 * popped-out timeline drew a composition the document does not have, and its
 * Play button had no transport behind it.
 */

import { useProjectStore } from '@stores/projectStore';

const published: Array<{ type: string; payload: unknown }> = [];
const handlers = new Map<string, (payload: unknown) => void>();

jest.mock('./syncChannel', () => ({
  syncChannel: {
    publish: (type: string, payload: unknown) => { published.push({ type, payload }); },
    subscribe: (type: string, h: (payload: unknown) => void) => {
      handlers.set(type, h);
      return () => handlers.delete(type);
    },
  },
}));

import { startWindowSync } from './windowSync';

const deliver = (type: string, payload: unknown): void => handlers.get(type)?.(payload);
const activeTab = () => {
  const s = useProjectStore.getState();
  return s.tabs[s.activeTabId!]!;
};
const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

let stop: () => void = () => undefined;

beforeEach(() => {
  published.length = 0;
  handlers.clear();
  useProjectStore.getState().actions.resetTabs();
});

afterEach(() => {
  stop();
  window.location.hash = '';
});

describe('window sync: active composition and play state', () => {
  it('a pop-out asks on open and lands on the editor\'s composition', async () => {
    window.location.hash = '#/popout/timeline';
    stop = startWindowSync();
    expect(published.map((m) => m.type)).toContain('sync-hello');

    deliver('active-comp-update', { compositionId: 'comp_real', breadcrumbPath: ['comp_real'], breadcrumbVia: [], title: 'Real Comp' });
    expect(activeTab().compositionId).toBe('comp_real');
    await tick();
    // Applying a remote change does not echo it back.
    expect(published.filter((m) => m.type === 'active-comp-update')).toHaveLength(0);
  });

  it('the editor answers hello with its composition and play flag', () => {
    stop = startWindowSync();
    deliver('sync-hello', null);
    const types = published.map((m) => m.type);
    // The composition first: the selection, time and play flag land on its tab.
    expect(types[0]).toBe('active-comp-update');
    expect(types).toContain('playing-update');
  });

  it('play in one window flips the other window\'s flag (the editor\'s transport plays)', async () => {
    stop = startWindowSync();
    deliver('playing-update', true);
    expect(activeTab().playing).toBe(true);
    await tick();
    expect(published.filter((m) => m.type === 'playing-update')).toHaveLength(0);

    // A local Play is published.
    useProjectStore.getState().actions.setPlaying(false);
    expect(published).toContainEqual({ type: 'playing-update', payload: false });
  });

  it('switching composition in the editor is published', () => {
    stop = startWindowSync();
    useProjectStore.getState().actions.openTab('comp_b', ['comp_b'], 'B');
    expect(published.some((m) => m.type === 'active-comp-update' && (m.payload as { compositionId: string }).compositionId === 'comp_b')).toBe(true);
  });
});
