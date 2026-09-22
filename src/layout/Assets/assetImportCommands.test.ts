/**
 * File ▸ Import ▸ Files… / Folder… were greyed out unless the Assets panel
 * happened to be mounted — the pickers live in the panel, and `enabled` said
 * so literally. Import is never unavailable: the command reveals the panel and
 * opens the picker once it is up.
 */

import {
  ASSETS_IMPORT_FILES_COMMAND,
  ASSETS_IMPORT_FOLDER_COMMAND,
  buildAssetCommands,
  ensureAssetImportOpeners,
  setAssetImportOpeners,
} from './assetCommands';
import { useLayoutStore } from '@stores/layoutStore';

const command = (id: string) => {
  const c = buildAssetCommands().find((x) => x.id === id);
  if (!c) throw new Error(`no command ${id}`);
  return c;
};

afterEach(() => {
  setAssetImportOpeners(null);
  jest.restoreAllMocks();
});

describe('asset import commands', () => {
  it('are enabled with no Assets panel mounted', () => {
    for (const id of [ASSETS_IMPORT_FILES_COMMAND, ASSETS_IMPORT_FOLDER_COMMAND]) {
      const c = command(id);
      expect(c.enabled ? c.enabled() : true).toBe(true);
    }
  });

  it('open the picker straight away when the panel is up, without touching the layout', async () => {
    const files = jest.fn();
    const openPanel = jest.fn();
    jest.spyOn(useLayoutStore, 'getState').mockReturnValue({ ...useLayoutStore.getState(), openPanel });
    setAssetImportOpeners({ files, folder: jest.fn() });
    await command(ASSETS_IMPORT_FILES_COMMAND).execute({} as never);
    expect(files).toHaveBeenCalledTimes(1);
    expect(openPanel).not.toHaveBeenCalled();
  });

  it('reveal the Assets panel and open the picker once it has mounted', async () => {
    const folder = jest.fn();
    const openPanel = jest.fn();
    jest.spyOn(useLayoutStore, 'getState').mockReturnValue({ ...useLayoutStore.getState(), openPanel });
    const run = command(ASSETS_IMPORT_FOLDER_COMMAND).execute({} as never);
    expect(openPanel).toHaveBeenCalledWith('assets');
    expect(folder).not.toHaveBeenCalled();
    // The panel mounts and registers its pickers.
    setAssetImportOpeners({ files: jest.fn(), folder });
    await run;
    expect(folder).toHaveBeenCalledTimes(1);
  });

  it('give up quietly if the panel never mounts', async () => {
    jest.spyOn(useLayoutStore, 'getState').mockReturnValue({ ...useLayoutStore.getState(), openPanel: jest.fn() });
    await expect(ensureAssetImportOpeners(5)).resolves.toBeNull();
  });
});
