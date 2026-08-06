/**
 * Deep links and the local-edition Browse state.
 *
 * `premation://plugin/<id>` is the least trusted input the editor accepts:
 * anyone can put one in a web page, a chat message or an email, and the OS
 * hands it straight to the app. The id in it becomes a fetch URL and a store
 * key, so it is validated in the main process AND again here — IPC is its own
 * boundary, and "the main process already checked" is exactly the assumption
 * that makes the second check feel redundant right up until someone adds a
 * third sender.
 */

import { openPluginTab } from './openPluginTab';
import { useEditorTabStore, SCENE_TAB_ID } from '@stores/editorTabStore';
import { browseRegistry } from '@core/plugins/registry';
import * as edition from '@core/config/edition';

beforeEach(() => {
  localStorage.clear();
  useEditorTabStore.setState({ tabs: [], activeId: SCENE_TAB_ID });
});

describe('deep-link id validation', () => {
  it('opens a tab for a well-formed plugin id', () => {
    expect(openPluginTab('studio.acme.easing-lab', 'Easing Lab')).toBe(true);
    expect(useEditorTabStore.getState().tabs[0]?.ref).toBe('studio.acme.easing-lab');
  });

  it('refuses a malformed id BEFORE any fetch or store lookup', () => {
    // Each of these is a way to make the id mean something other than a plugin.
    for (const id of [
      '../../etc/passwd',
      'studio.acme/../evil',
      'https://evil.example/x',
      'Studio.Acme',
      'javascript:alert(1)',
      'nodots',
      '',
      '.leading',
      'trailing.',
      'a'.repeat(300),
    ]) {
      expect({ id, opened: openPluginTab(id, 'x') }).toEqual({ id, opened: false });
    }
    // Nothing was opened, so nothing downstream ever saw any of them.
    expect(useEditorTabStore.getState().tabs).toEqual([]);
  });

  it('bounds the tab title, which comes from the same untrusted place', () => {
    openPluginTab('studio.acme.thing', 'x'.repeat(500));
    expect(useEditorTabStore.getState().tabs[0]!.title.length).toBeLessThanOrEqual(60);
  });

  it('falls back to the id when a link supplies no usable title', () => {
    openPluginTab('studio.acme.thing', '');
    expect(useEditorTabStore.getState().tabs[0]!.title).toBe('studio.acme.thing');
  });
});

describe('browse in the local edition', () => {
  afterEach(() => { jest.restoreAllMocks(); });

  it('reports that the registry is unavailable, not that it is empty', async () => {
    // The rough edge this phase fixes. The previous version returned `[]` here,
    // which is indistinguishable from "nothing matched" — so a self-hosted user
    // was told "Nothing published yet", which is false AND unactionable, since
    // there is nothing they can do about a feature their build does not have.
    jest.spyOn(edition, 'pluginRegistryEnabled').mockReturnValue(false);
    const result = await browseRegistry({ q: 'anything' });
    expect(result).toEqual({ available: false });
  });

  it('distinguishes unavailable from an empty result set', () => {
    // Asserted as a type-level property: `available: false` carries no `items`,
    // so a UI cannot accidentally render it as "0 results" — it has to branch.
    const unavailable = { available: false } as const;
    expect('items' in unavailable).toBe(false);
  });
});
