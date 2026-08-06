/**
 * Installing from this computer, wherever the package comes from.
 *
 * Three gestures reach the same place — the Add plugin menu, a file dropped on
 * the list, and a folder picked for an author's edit/run loop — and all three
 * must land on the consent screen. Writing that flow once is the only way to be
 * sure none of them grows a shortcut past it.
 *
 * The bytes are read and validated as DATA. No plugin code runs here; it runs
 * inside a Worker, after the user has granted something.
 */

import { useCallback, useState } from 'react';
import { customAlert } from '@components/Modal/Dialogs';
import { readPluginFile, readPluginFolder, type PluginPackage } from '@core/plugins/pluginPackage';
import { ConsentSheet, ConsentOverlay } from './ConsentSheet';

export interface DiskInstall {
  /** Read a dropped or picked archive, then raise consent. */
  takeFile: (file: File) => Promise<void>;
  /** Read a picked directory, then raise consent. */
  takeFolder: (files: File[]) => Promise<void>;
  /** The consent overlay, or null. Render it somewhere that is always mounted. */
  sheet: JSX.Element | null;
}

export function useDiskInstall(): DiskInstall {
  const [pending, setPending] = useState<{ pkg: PluginPackage; source: 'file' | 'folder' } | null>(null);

  const take = useCallback(
    (result: { pkg: PluginPackage | null; errors: string[] }, source: 'file' | 'folder'): void => {
      if (result.pkg) { setPending({ pkg: result.pkg, source }); return; }
      // Every reason it was rejected, not just the first. A package usually
      // fails validation for more than one reason at once, and fixing them one
      // round trip at a time is the slowest possible way to learn that.
      void customAlert(
        source === 'folder' ? 'Could not read that folder' : 'Could not read that package',
        result.errors.join('\n'),
        { isDanger: true },
      );
    },
    [],
  );

  const takeFile = useCallback(async (file: File) => { take(await readPluginFile(file), 'file'); }, [take]);
  const takeFolder = useCallback(async (files: File[]) => { take(await readPluginFolder(files), 'folder'); }, [take]);

  return {
    takeFile,
    takeFolder,
    sheet: pending
      ? (
        <ConsentOverlay>
          <ConsentSheet pkg={pending.pkg} source={pending.source} onDone={() => setPending(null)} />
        </ConsentOverlay>
      )
      : null,
  };
}
