/**
 * ProjectPanel — After Effects' Project panel: the list of compositions in the
 * project, and the place you create, open, rename, duplicate and delete them.
 *
 * Compositions became a real, insertable entity (see core/composition/
 * compositionOps) but had no surface: you could only reach one through a tab,
 * and only ever the one the project was seeded with. This is that surface.
 *
 * It deliberately owns no composition logic of its own — every mutation goes
 * through compositionOps, which keeps the settings entry, the scene root and
 * the tab in step. One home per action.
 */

import { useState, useMemo } from 'react';
import { Icon } from '@components/Icon';
import { Input } from '@components/Input';
import { EmptyState } from '@components/EmptyState';
import { cn } from '@utils/cn';
import { useProjectStore } from '@stores/projectStore';
import { useSceneRevision } from '@stores/sceneStore';
import { openContextMenu } from '@stores/contextMenuStore';
import { customConfirm } from '@components/Modal';
import defaultSceneGraph from '@core/scene/DefaultSceneGraph';
import { flattenComposition } from '@core/scene/sceneDerive';
import { deleteComposition, duplicateComposition, renameComposition } from '@core/composition/compositionOps';
import { openNewCompositionDialog } from '@layout/Composition/NewCompositionDialog';
import { openCompositionSettings } from '@layout/Composition/CompositionSettingsDialog';
import styles from './ProjectPanel.module.css';

/** Layers in a comp = its subtree minus the root itself. */
function layerCount(compId: string): number {
  return Math.max(0, flattenComposition(defaultSceneGraph, compId).length - 1);
}

function formatDuration(seconds: number): string {
  const s = Math.max(0, seconds);
  const m = Math.floor(s / 60);
  const rem = s - m * 60;
  return m > 0 ? `${m}:${rem.toFixed(0).padStart(2, '0')}` : `${rem.toFixed(1)}s`;
}

export function ProjectPanel(): JSX.Element {
  const comps = useProjectStore((s) => s.comps);
  const tabs = useProjectStore((s) => s.tabs);
  const activeTabId = useProjectStore((s) => s.activeTabId);
  const openTab = useProjectStore((s) => s.actions.openTab);
  // Layer counts come from the scene graph, which isn't part of the store.
  const rev = useSceneRevision((s) => s.rev);

  const [query, setQuery] = useState('');
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [draft, setDraft] = useState('');

  const activeCompId = activeTabId ? tabs[activeTabId]?.compositionId : undefined;
  const onlyOne = Object.keys(comps).length <= 1;

  const rows = useMemo(() => {
    const q = query.trim().toLowerCase();
    return Object.values(comps)
      .filter((c) => !q || c.name.toLowerCase().includes(q))
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((c) => ({ ...c, layers: layerCount(c.id) }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [comps, query, rev]);

  const commitRename = (id: string): void => {
    const name = draft.trim();
    if (name) renameComposition(id, name);
    setRenamingId(null);
  };

  const openMenu = (id: string, e: React.MouseEvent): void => {
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
        // Settings edit the ACTIVE comp, so open it first.
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
        // A project with no composition has nowhere to put a layer.
        disabled: onlyOne,
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

  return (
    <div className={styles.root}>
      <div className={styles.header}>
        <span className={styles.title}>Compositions</span>
        <button
          type="button"
          className={styles.newBtn}
          title="New composition"
          aria-label="New composition"
          onClick={() => openNewCompositionDialog()}
        >
          <Icon name="plus" size="sm" />
        </button>
      </div>

      <div className={styles.search}>
        <Input
          value={query}
          placeholder="Search compositions…"
          size="sm"
          fullWidth
          leftIcon="search"
          onChange={(e) => setQuery(e.currentTarget.value)}
        />
      </div>

      {rows.length === 0 ? (
        <EmptyState
          icon="layers"
          message={query ? `No compositions match “${query}”.` : 'No compositions yet.'}
        />
      ) : (
        <div className={styles.list} role="listbox" aria-label="Compositions">
          {rows.map((c) => {
            const isActive = c.id === activeCompId;
            return (
              <div
                key={c.id}
                role="option"
                aria-selected={isActive}
                tabIndex={0}
                className={cn(styles.row, isActive && styles.rowActive)}
                onClick={() => openTab(c.id, [c.id], c.name)}
                onContextMenu={(e) => openMenu(c.id, e)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    openTab(c.id, [c.id], c.name);
                  }
                }}
              >
                <Icon name="layers" size="sm" className={styles.rowIcon} />
                <div className={styles.rowBody}>
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
                  <span className={styles.rowMeta}>
                    {c.width}×{c.height} · {c.fps} fps · {formatDuration(c.durationSeconds)} ·{' '}
                    {c.layers} layer{c.layers === 1 ? '' : 's'}
                  </span>
                </div>
                <button
                  type="button"
                  className={styles.rowAction}
                  aria-label={`Options for ${c.name}`}
                  onClick={(e) => openMenu(c.id, e)}
                >
                  <Icon name="menu" size="sm" />
                </button>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

export default ProjectPanel;
