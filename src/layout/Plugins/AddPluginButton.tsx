/**
 * Getting a plugin in, from the list you were already looking at.
 *
 * Installing from disk existed, but only inside the Plugins manager modal —
 * which you reach from a menu, which you have to know is there. So the one
 * screen that shows every plugin, and is the obvious place to add another, had
 * no way to add one. An author iterating on their own package was sent through
 * a menu to a modal to a drop zone, every time. The modal is now retired
 * entirely; this and the list's drop target are what replaced it.
 *
 * This is deliberately a menu rather than two buttons. There are three ways in
 * (a package, a folder, and "I do not have one yet"), only one of which any
 * given user wants, and a row of three buttons in a 280px column would push the
 * search field off its own line.
 */

import { useRef } from 'react';
import { Icon } from '@components/Icon';
import { Dropdown } from '@components/Dropdown';
import { cn } from '@utils/cn';
import { downloadStarterPlugin } from './starterPlugin';
import { useDiskInstall } from './useDiskInstall';
import styles from './PluginsPanel.module.css';

export function AddPluginButton({
  /** Icon only, for the sidebar's search row. Labelled for screen readers. */
  compact = false,
}: {
  compact?: boolean;
}): JSX.Element {
  const fileRef = useRef<HTMLInputElement>(null);
  const folderRef = useRef<HTMLInputElement>(null);
  const { takeFile, takeFolder, sheet } = useDiskInstall();

  return (
    <>
      <Dropdown
        placement="bottom-end"
        trigger={
          <button
            type="button"
            className={cn(styles.addBtn, compact && styles.addBtnCompact)}
            title="Add a plugin from this computer"
            aria-label="Add a plugin"
          >
            <Icon name="plus" size={13} />
            {!compact && <span>Add plugin</span>}
            <Icon name="chevron-down" size={11} />
          </button>
        }
        items={[
          {
            type: 'item',
            id: 'file',
            label: 'Install from a package…',
            icon: 'upload',
            onSelect: () => fileRef.current?.click(),
          },
          {
            type: 'item',
            id: 'folder',
            label: 'Install from a folder…',
            icon: 'folder',
            onSelect: () => folderRef.current?.click(),
          },
          { type: 'separator' },
          {
            type: 'item',
            id: 'starter',
            label: 'Download starter template',
            icon: 'download',
            onSelect: () => downloadStarterPlugin(),
          },
        ]}
      />

      <input
        ref={fileRef}
        type="file"
        accept=".zip,.mplugin,application/zip"
        className={styles.hiddenInput}
        onChange={async (e) => {
          const f = e.target.files?.[0];
          // Cleared before the await, so picking the same file twice in a row
          // still fires `change` the second time.
          e.target.value = '';
          if (f) await takeFile(f);
        }}
      />
      <input
        ref={folderRef}
        type="file"
        multiple
        // @ts-expect-error — non-standard but universally supported directory picker
        webkitdirectory=""
        className={styles.hiddenInput}
        onChange={async (e) => {
          const files = Array.from(e.target.files ?? []);
          e.target.value = '';
          if (files.length) await takeFolder(files);
        }}
      />

      {/* The same consent screen a registry install lands on, not a shorter one
          for local packages. Where a package came from changes how much you
          should trust it, not how much it is about to be allowed to do. */}
      {sheet}
    </>
  );
}
