/**
 * ProjectPanel — After Effects' Project panel:
 * Shows the list of compositions and imported footage / assets in the project,
 * with search bar, column headers (Name, Type, Size, In Point), and bottom toolbar.
 */

import { useState, useMemo, useRef } from 'react';
import { Icon } from '@components/Icon';
import { Input } from '@components/Input';
import { EmptyState } from '@components/EmptyState';
import { cn } from '@utils/cn';
import { useProjectStore } from '@stores/projectStore';
import { useAssetStore, type ImportedAsset } from '@stores/assetStore';
import { useSceneRevision } from '@stores/sceneStore';
import { openContextMenu } from '@stores/contextMenuStore';
import { customConfirm } from '@components/Modal';
import defaultSceneGraph from '@core/scene/DefaultSceneGraph';
import { flattenComposition } from '@core/scene/sceneDerive';
import { deleteComposition, duplicateComposition, renameComposition, createCompositionFromFootage } from '@core/composition/compositionOps';
import { openNewCompositionDialog } from '@layout/Composition/NewCompositionDialog';
import { openCompositionSettings } from '@layout/Composition/CompositionSettingsDialog';
import { insertMedia } from '@core/scene/sceneInsert';
import styles from './ProjectPanel.module.css';

/** Layers in a comp = its subtree minus the root itself. */
function layerCount(compId: string): number {
  return Math.max(0, flattenComposition(defaultSceneGraph, compId).length - 1);
}

function formatBytes(bytes: number): string {
  if (!bytes || bytes <= 0) return '—';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function ProjectPanel(): JSX.Element {
  const comps = useProjectStore((s) => s.comps);
  const tabs = useProjectStore((s) => s.tabs);
  const activeTabId = useProjectStore((s) => s.activeTabId);
  const openTab = useProjectStore((s) => s.actions.openTab);
  const rev = useSceneRevision((s) => s.rev);

  const assets = useAssetStore((s) => s.assets);
  const removeAsset = useAssetStore((s) => s.removeAsset);
  const addAsset = useAssetStore((s) => s.addAsset);

  const [query, setQuery] = useState('');
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const fileInputRef = useRef<HTMLInputElement>(null);

  const activeCompId = activeTabId ? tabs[activeTabId]?.compositionId : undefined;
  const onlyOneComp = Object.keys(comps).length <= 1;

  const filteredComps = useMemo(() => {
    const q = query.trim().toLowerCase();
    return Object.values(comps)
      // The auto-minted pristine comp is engine scaffolding, not a project
      // item: AE's fresh project lists NO compositions, and showing a
      // "Composition 1" the user never made is what made project-vs-comp read
      // as complicated. It appears here the moment it is adopted (first New
      // Composition / From Footage) or the user draws into it.
      .filter((c) => !(c.pristine && layerCount(c.id) === 0))
      .filter((c) => !q || c.name.toLowerCase().includes(q))
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((c) => ({ ...c, layers: layerCount(c.id) }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [comps, query, rev]);

  const filteredAssets = useMemo(() => {
    const q = query.trim().toLowerCase();
    return assets
      .filter((a) => !q || a.name.toLowerCase().includes(q))
      .sort((a, b) => a.name.localeCompare(b.name));
  }, [assets, query]);

  const commitRename = (id: string): void => {
    const name = draft.trim();
    if (name) renameComposition(id, name);
    setRenamingId(null);
  };

  const openCompMenu = (id: string, e: React.MouseEvent): void => {
    e.preventDefault();
    e.stopPropagation();
    openContextMenu(e.clientX, e.clientY, [
      { id: 'open', label: 'Open', icon: 'play', onSelect: () => openTab(id, [id], comps[id]?.name) },
      {
        id: 'rename',
        label: 'Rename…',
        icon: 'type',
        onSelect: () => {
          setDraft(comps[id]?.name ?? '');
          setRenamingId(id);
        },
      },
      { id: 'duplicate', label: 'Duplicate', icon: 'copy', onSelect: () => duplicateComposition(id) },
      {
        id: 'settings',
        label: 'Composition Settings…',
        icon: 'settings',
        onSelect: () => {
          openTab(id, [id], comps[id]?.name);
          openCompositionSettings();
        },
      },
      { id: 'sep', separator: true },
      {
        id: 'delete',
        label: 'Delete',
        icon: 'trash',
        danger: true,
        disabled: onlyOneComp,
        onSelect: async () => {
          const c = comps[id];
          const layers = layerCount(id);
          const warn = layers > 0
            ? `Delete “${c?.name}” and its ${layers} layer${layers === 1 ? '' : 's'}?`
            : `Delete “${c?.name}”?`;
          if (await customConfirm('Delete Composition', warn, { isDanger: true, confirmLabel: 'Delete' })) {
            deleteComposition(id);
          }
        },
      },
    ]);
  };

  const openAssetMenu = (asset: ImportedAsset, e: React.MouseEvent): void => {
    e.preventDefault();
    e.stopPropagation();
    openContextMenu(e.clientX, e.clientY, [
      { id: 'insert', label: 'Add to Scene', icon: 'plus', onSelect: () => void insertMedia(asset) },
      { id: 'newComp', label: 'New Comp from Selection', icon: 'shape', onSelect: () => void createCompositionFromFootage(asset) },
      { id: 'sep', separator: true },
      {
        id: 'delete',
        label: 'Delete Asset',
        icon: 'trash',
        danger: true,
        onSelect: () => removeAsset(asset.id),
      },
    ]);
  };

  const handleImportFiles = async (e: React.ChangeEvent<HTMLInputElement>): Promise<void> => {
    const files = e.target.files;
    if (!files || files.length === 0) return;
    for (let i = 0; i < files.length; i++) {
      const f = files[i];
      if (f) await addAsset(f);
    }
  };

  const isEmpty = filteredComps.length === 0 && filteredAssets.length === 0;

  return (
    <div className={styles.root}>
      <input
        ref={fileInputRef}
        type="file"
        multiple
        accept="video/*,image/*,audio/*,.mp4,.mov,.webm,.m4v,.png,.jpg,.jpeg,.gif,.svg,.mp3,.wav"
        style={{ display: 'none' }}
        onChange={(e) => void handleImportFiles(e)}
      />

      {/* Search Input */}
      <div className={styles.searchBar}>
        <Input
          value={query}
          placeholder="Search project items…"
          size="sm"
          fullWidth
          leftIcon="search"
          onChange={(e) => setQuery(e.currentTarget.value)}
        />
      </div>

      {/* AE Column Headers */}
      <div className={styles.columnsHeader}>
        <span className={styles.colName}>Name</span>
        <span className={styles.colType}>Type</span>
        <span className={styles.colSize}>Size</span>
        <span className={styles.colInPoint}>In Point</span>
      </div>

      {/* Items List */}
      {isEmpty ? (
        <div className={styles.list}>
          <EmptyState
            icon="folder-open"
            message={query ? `No items match “${query}”.` : 'No compositions or footage.'}
          />
        </div>
      ) : (
        <div className={styles.list} role="listbox" aria-label="Project items">
          {/* Compositions */}
          {filteredComps.map((c) => {
            const isActive = c.id === activeCompId;
            return (
              <div
                key={c.id}
                role="option"
                aria-selected={isActive}
                tabIndex={0}
                className={cn(styles.row, isActive && styles.rowActive)}
                onClick={() => openTab(c.id, [c.id], c.name)}
                onContextMenu={(e) => openCompMenu(c.id, e)}
              >
                <div className={styles.nameCell}>
                  <Icon name="shape" size="sm" className={styles.rowIcon} />
                  {renamingId === c.id ? (
                    <input
                      className={styles.renameInput}
                      value={draft}
                      autoFocus
                      spellCheck={false}
                      onClick={(e) => e.stopPropagation()}
                      onChange={(e) => setDraft(e.currentTarget.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') commitRename(c.id);
                        else if (e.key === 'Escape') setRenamingId(null);
                      }}
                      onBlur={() => commitRename(c.id)}
                    />
                  ) : (
                    <span
                      className={styles.rowName}
                      onDoubleClick={(e) => {
                        e.stopPropagation();
                        setDraft(c.name);
                        setRenamingId(c.id);
                      }}
                    >
                      {c.name}
                    </span>
                  )}
                </div>
                <span className={styles.typeCell}>Composition</span>
                <span className={styles.sizeCell}>{c.width}×{c.height}</span>
                <span className={styles.inPointCell}>0:00:00:00</span>
              </div>
            );
          })}

          {/* Footage & Assets */}
          {filteredAssets.map((a) => (
            <div
              key={a.id}
              role="option"
              aria-selected={false}
              tabIndex={0}
              className={styles.row}
              onClick={() => void insertMedia(a)}
              onContextMenu={(e) => openAssetMenu(a, e)}
            >
              <div className={styles.nameCell}>
                <Icon
                  name={a.type === 'video' ? 'video' : a.type === 'image' ? 'image' : 'audio'}
                  size="sm"
                  className={styles.rowIcon}
                />
                <span className={styles.rowName}>{a.name}</span>
              </div>
              <span className={styles.typeCell}>{a.type.toUpperCase()} file</span>
              <span className={styles.sizeCell}>{formatBytes(a.size)}</span>
              <span className={styles.inPointCell}>0:00:00:00</span>
            </div>
          ))}
        </div>
      )}

      {/* AE Bottom Toolbar */}
      <div className={styles.bottomToolbar}>
        <button
          type="button"
          className={styles.bpcButton}
          title="Color Depth (8 bits per channel)"
        >
          8 bpc
        </button>

        <div className={styles.toolActions}>
          <button
            type="button"
            className={styles.toolBtn}
            title="Import Footage"
            onClick={() => fileInputRef.current?.click()}
          >
            <Icon name="upload" size="sm" />
          </button>
          <button
            type="button"
            className={styles.toolBtn}
            title="New Composition"
            onClick={() => openNewCompositionDialog()}
          >
            <Icon name="plus" size="sm" />
          </button>
          <button
            type="button"
            className={styles.toolBtn}
            title="New Folder"
            onClick={() => {}}
          >
            <Icon name="folder" size="sm" />
          </button>
        </div>
      </div>
    </div>
  );
}

export default ProjectPanel;
