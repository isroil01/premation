/**
 * The Assets panel's view verbs, as first-class COMMANDS — the same pattern
 * as `timelineFitCommands`: registered from the feature's own module, so
 * the palette, the menu bar and the panel's buttons all run one action.
 *
 * Registration is idempotent. `installOverlayCommands` (ModalHost — mounted
 * once in every editor window) installs at boot, so File ▸ Import exists
 * whether or not the Assets panel has ever been shown; the panel installs too,
 * for a host that mounts it without the editor shell (tests, a pop-out).
 */

import { asCommandId } from '@app-types/common';
import { getCommandRegistry, type Command } from '@core/commands/Command';
import { getShortcutManager } from '@core/commands/ShortcutManager';
import { useAssetsViewStore } from '@stores/assetsViewStore';
import { useLayoutStore } from '@stores/layoutStore';
import { selectedPanelAssets } from '@core/composition/assetSelection';
import { canRevealAssets, revealAsset } from './assetReveal';

export const ASSETS_TOGGLE_VIEW_COMMAND = asCommandId('assets.toggleGridView');
export const ASSETS_TOGGLE_UNUSED_COMMAND = asCommandId('assets.toggleUnusedFilter');
export const ASSETS_TOGGLE_DRAWER_COMMAND = asCommandId('assets.toggleMetadataDrawer');
export const ASSETS_REVEAL_COMMAND = asCommandId('assets.revealInFolder');
export const ASSETS_IMPORT_FILES_COMMAND = asCommandId('assets.importFiles');
export const ASSETS_IMPORT_FOLDER_COMMAND = asCommandId('assets.importFolder');

/**
 * The panel's hidden file pickers, reachable as commands.
 *
 * A picker is a DOM `<input type=file>` that lives in the panel (its change
 * handler is the one importer: it knows a `.gltf` selection is a model plus
 * sidecars, which folder is open, what to toast). The panel registers its
 * openers while mounted.
 *
 * The commands are ALWAYS enabled. They used to be enabled only while the panel
 * was mounted, so with the Assets tab behind another tab — or the sidebar
 * collapsed — File ▸ Import ▸ Files… was greyed out, in the one menu a user
 * looks for it in. Now the command reveals the panel first and opens the picker
 * as soon as the panel has mounted; that lands well inside the few seconds a
 * user gesture stays valid for `input.click()`. Import goes to the PROJECT
 * only — the panel's toast offers "Add to composition" afterwards.
 */
export interface AssetImportOpeners {
  files: () => void;
  folder: () => void;
}

let importOpeners: AssetImportOpeners | null = null;

export function setAssetImportOpeners(openers: AssetImportOpeners | null): void {
  importOpeners = openers;
  if (!openers) return;
  for (const resolve of openerWaiters.splice(0)) resolve(openers);
}

const openerWaiters: Array<(openers: AssetImportOpeners | null) => void> = [];

/** How long to wait for the revealed panel to mount before giving up quietly. */
const REVEAL_TIMEOUT_MS = 2000;

/** The panel's openers — revealing (and so mounting) the panel first if it is not up. */
export function ensureAssetImportOpeners(timeoutMs: number = REVEAL_TIMEOUT_MS): Promise<AssetImportOpeners | null> {
  if (importOpeners) return Promise.resolve(importOpeners);
  useLayoutStore.getState().openPanel('assets');
  return new Promise((resolve) => {
    const settle = (openers: AssetImportOpeners | null): void => {
      clearTimeout(timer);
      const i = openerWaiters.indexOf(settle);
      if (i !== -1) openerWaiters.splice(i, 1);
      resolve(openers);
    };
    const timer = setTimeout(() => settle(null), timeoutMs);
    openerWaiters.push(settle);
  });
}

/** The OS's own name for its file manager — what every native app's menu says. */
export function revealLabel(): string {
  const mac = typeof navigator !== 'undefined' && /mac/i.test(navigator.platform ?? '');
  return mac ? 'Reveal in Finder' : 'Reveal in Explorer';
}

export function buildAssetCommands(): ReadonlyArray<Command> {
  return [
    {
      id: ASSETS_IMPORT_FILES_COMMAND,
      label: 'Import Files…',
      description: 'Import media files into the project. They are not added to the composition.',
      icon: 'upload',
      execute: async () => { (await ensureAssetImportOpeners())?.files(); },
    },
    {
      id: ASSETS_IMPORT_FOLDER_COMMAND,
      label: 'Import Folder…',
      description: 'Import a folder of media into the project, keeping its folder structure.',
      icon: 'folder-open',
      execute: async () => { (await ensureAssetImportOpeners())?.folder(); },
    },
    {
      id: ASSETS_TOGGLE_VIEW_COMMAND,
      label: 'Assets: Toggle Grid View',
      description: 'Switch the Assets panel between the list and the thumbnail grid.',
      icon: 'grid',
      isChecked: () => useAssetsViewStore.getState().view === 'grid',
      execute: () => {
        useAssetsViewStore.getState().toggleView();
      },
    },
    {
      id: ASSETS_TOGGLE_UNUSED_COMMAND,
      label: 'Assets: Show Unused Only',
      description: 'Filter the Assets panel to footage no layer references.',
      icon: 'eye-off',
      isChecked: () => useAssetsViewStore.getState().unusedOnly,
      execute: () => {
        const s = useAssetsViewStore.getState();
        s.setUnusedOnly(!s.unusedOnly);
      },
    },
    {
      id: ASSETS_TOGGLE_DRAWER_COMMAND,
      label: 'Assets: Toggle Metadata Drawer',
      description: 'Show or hide the footage details drawer under the Assets list.',
      icon: 'info',
      isChecked: () => useAssetsViewStore.getState().drawerOpen,
      execute: () => {
        const s = useAssetsViewStore.getState();
        s.setDrawerOpen(!s.drawerOpen);
      },
    },
    {
      id: ASSETS_REVEAL_COMMAND,
      label: revealLabel(),
      description: 'Show the selected asset’s file in the OS file manager.',
      icon: 'folder-open',
      enabled: () => canRevealAssets() && selectedPanelAssets().length === 1,
      execute: async () => {
        const [asset] = selectedPanelAssets();
        if (asset) await revealAsset(asset);
      },
    },
  ];
}

let installed = false;

export function installAssetCommands(): void {
  if (installed) return;
  installed = true;
  const registry = getCommandRegistry();
  for (const command of buildAssetCommands()) registry.register(command);
  getShortcutManager().rehydrateFromRegistry();
}

/** Test seam. */
export function resetAssetCommandsForTest(): void {
  installed = false;
}
