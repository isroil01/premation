/**
 * Two properties that are easy to lose and expensive to lose quietly.
 *
 * 1. **A registry install still hits the consent screen.** There are now four
 *    places a user can press Install — the sidebar row, the detail tab, the
 *    manager, and a `premation://` link — and a "trusted source" shortcut on
 *    any one of them would make the permission model optional without anyone
 *    noticing, because the plugin would simply work.
 *
 * 2. **Tab state never reaches the saved document.** A `.premation` file that
 *    opened plugin tabs on a collaborator's machine, for plugins they do not
 *    have, is a bug that takes a week to find: the symptom appears on a machine
 *    that never opened those tabs, and the cause is inside a file nobody
 *    suspects.
 */

import { installFromRegistry, setConsentHost } from './installFromRegistry';
import type { PluginPackage } from '@core/plugins/pluginPackage';
import { useEditorTabStore, SCENE_TAB_ID, TAB_PERSIST_KEY } from '@stores/editorTabStore';
import { captureDocument } from '@core/api/cloudDocument';
import { seedDefaultScene } from '@core/scene/seedDefaultScene';

// The network half is mocked; the SUBJECT is what happens after the bytes
// arrive, and a real fetch would only add a way for this to fail for reasons
// that have nothing to do with consent.
jest.mock('@core/plugins/registry', () => ({
  fetchRegistryPackage: jest.fn(),
}));
jest.mock('@components/Modal/Dialogs', () => ({
  customAlert: jest.fn(),
  customConfirm: jest.fn(),
}));

const registry = require('@core/plugins/registry') as {
  fetchRegistryPackage: jest.Mock;
};

/** A package the reader will accept, built the way a real one arrives. */
function packageBytes(): Uint8Array {
  const { zipSync, strToU8 } = require('fflate') as typeof import('fflate');
  return zipSync({
    'plugin.json': strToU8(JSON.stringify({
      id: 'studio.acme.thing',
      name: 'Thing',
      version: '1.0.0',
      description: 'A plugin from the registry.',
      apiVersion: 2,
      main: 'main.js',
      permissions: ['scene:write', 'assets:read'],
    })),
    'main.js': strToU8('export function activate() {}'),
  });
}

describe('installing from the registry', () => {
  afterEach(() => {
    setConsentHost(null);
    jest.clearAllMocks();
  });

  it('routes the package to the consent screen instead of installing it', async () => {
    registry.fetchRegistryPackage.mockResolvedValue({
      bytes: packageBytes(),
      publisherKey: 'KEY',
    });

    let shown: { pkg: PluginPackage; publisherKey: string } | null = null;
    setConsentHost((pkg, publisherKey) => { shown = { pkg, publisherKey }; });

    const ok = await installFromRegistry('studio.acme.thing', '1.0.0', 'KEY');

    expect(ok).toBe(true);
    // The consent screen got the package, with the permissions it will ask
    // about — nothing was installed on the way past.
    expect(shown).not.toBeNull();
    expect(shown!.pkg.manifest.permissions).toEqual(['scene:write', 'assets:read']);
    expect(shown!.publisherKey).toBe('KEY');
  });

  it('verifies against the PINNED key, not one the response supplied', async () => {
    registry.fetchRegistryPackage.mockResolvedValue({
      bytes: packageBytes(),
      publisherKey: 'KEY',
    });
    setConsentHost(() => {});

    await installFromRegistry('studio.acme.thing', '1.0.0', 'PINNED-KEY');

    // The key is an ARGUMENT to the fetch, so the signature is checked against
    // what the caller pinned. A key read out of the response would verify every
    // package against whatever signed it, which verifies nothing.
    expect(registry.fetchRegistryPackage).toHaveBeenCalledWith(
      'studio.acme.thing', '1.0.0', 'PINNED-KEY',
    );
  });

  it('refuses rather than installing when no consent screen is mounted', async () => {
    registry.fetchRegistryPackage.mockResolvedValue({
      bytes: packageBytes(),
      publisherKey: 'KEY',
    });
    setConsentHost(null);

    // Fails CLOSED. If the host is somehow absent, the install must not proceed
    // silently — that is precisely the path that would skip the grant.
    expect(await installFromRegistry('studio.acme.thing', '1.0.0', 'KEY')).toBe(false);
  });

  it('stops at the package reader when the bytes do not parse', async () => {
    registry.fetchRegistryPackage.mockResolvedValue({
      bytes: new Uint8Array([1, 2, 3, 4]),
      publisherKey: 'KEY',
    });
    let shown = false;
    setConsentHost(() => { shown = true; });

    // The same reader a picked file goes through. A registry package gets no
    // shortcut past zip limits, traversal checks or manifest validation —
    // "we served it" is not a property of the bytes.
    expect(await installFromRegistry('studio.acme.thing', '1.0.0', 'KEY')).toBe(false);
    expect(shown).toBe(false);
  });
});

describe('tab state is not document state', () => {
  beforeAll(() => { seedDefaultScene(); });
  beforeEach(() => {
    localStorage.clear();
    useEditorTabStore.setState({ tabs: [], activeId: SCENE_TAB_ID });
  });

  it('never appears in the saved document', () => {
    useEditorTabStore.getState().open({
      id: 'plugin:studio.acme.thing',
      kind: 'plugin',
      title: 'Thing',
      ref: 'studio.acme.thing',
    });

    const serialised = JSON.stringify(captureDocument());

    // Asserted on the SERIALISED document, not on its top-level keys: tab state
    // reaching a nested subsystem's snapshot would be just as wrong and would
    // pass a shallow check.
    expect(serialised).not.toContain('plugin:studio.acme.thing');
    expect(serialised).not.toContain('studio.acme.thing');
    expect(serialised.toLowerCase()).not.toContain('activetabid');
  });

  it('lives in workspace storage instead', () => {
    // The positive half. Without it, a document that simply lost the tabs
    // entirely would also pass the test above.
    useEditorTabStore.getState().open({
      id: 'plugin:studio.acme.thing',
      kind: 'plugin',
      title: 'Thing',
      ref: 'studio.acme.thing',
    });
    expect(localStorage.getItem(TAB_PERSIST_KEY)).toContain('studio.acme.thing');
  });
});
