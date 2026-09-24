/**
 * CompositionList — the project's compositions, as a compact list with open,
 * rename, settings, duplicate and delete.
 *
 * Extracted from the top of the Layers panel (2026-09-15) when that panel went
 * on demand: the list is the document's STRUCTURE, which is the Project panel's
 * job, so it now renders there as a collapsible group above the media. One
 * component, so a second home can never disagree with the first.
 */

import { useMemo, useState } from 'react';
import { Icon } from '@components/Icon';
import { customConfirm, customPrompt } from '@components/Modal';
import { useProjectStore, type TabInfo } from '@stores/projectStore';
import { openContextMenu } from '@stores/contextMenuStore';
import { documentMirror, type MirrorComp } from '@stores/documentMirror';
import { useMirrorKeys } from '@hooks/useMirror';
import { settingsFps } from '@core/mirror/compFacts';
import { liveComps } from '@core/mirror/compNames';
import {
  deleteCompositionWarning,
  deleteCompositionEdit,
  duplicateCompositionEdit,
  renameCompositionEdit,
} from './sceneEdits';
import { openCompositionSettings } from '@layout/Composition/CompositionSettingsDialog';
import { openNewCompositionDialog } from '@layout/Composition/NewCompositionDialog';
import styles from '@layout/EditorLayout/panels.module.css';

/** What a row of the list shows of one composition. */
export interface ListedComposition {
  id: string;
  name: string;
  width: number;
  height: number;
  fps: number;
  pristine?: boolean;
}

/** A mirror composition as a list row (B4: the document mirror's records). */
function listedOf(c: MirrorComp): ListedComposition {
  const s = c.settings;
  return { id: c.id, name: s.name, width: s.width, height: s.height, fps: settingsFps(s), ...(s.pristine ? { pristine: true } : {}) };
}

/** Whether `compId` is a composition of the document (not a group opened in its own tab). */
function isMirrorComposition(compId: string): boolean {
  const m = documentMirror();
  return m.comp(compId) !== undefined && m.item(compId) !== undefined;
}

/**
 * Which compositions the list shows.
 *
 * A `pristine` comp is the placeholder a fresh project boots with, hidden so a
 * project the user never touched does not list a comp they did not make. But
 * the filter used to be ALL it checked — so with the default "Main Comp" open
 * in the tab strip and the timeline, the list beside them said "None yet —
 * create one to start". A comp that is on screen is not a placeholder: any comp
 * an open tab points at is listed, pristine or not.
 *
 * `isReal` excludes groups opened in their own tab — they carry a settings
 * record too, but they are not compositions. Injected so this stays pure.
 */
export function listedCompositions<C extends ListedComposition>(
  comps: Readonly<Record<string, C>>,
  tabs: Readonly<Record<string, TabInfo>>,
  isReal: (compId: string) => boolean = isMirrorComposition,
): C[] {
  const onScreen = new Set(Object.values(tabs).map((t) => t.compositionId));
  return Object.values(comps).filter((c) => isReal(c.id) && (!c.pristine || onScreen.has(c.id)));
}

export interface CompositionListProps {
  /** Draw the heading as a disclosure button (the Project panel does). */
  collapsible?: boolean;
}

export function CompositionList({ collapsible = false }: CompositionListProps): JSX.Element {
  // B4: the compositions from the document mirror.
  const compsVersion = useMirrorKeys(['comps', 'items']);
  const comps = useMemo(() => {
    void compsVersion; // recomputed when the compositions or items change
    const out: Record<string, ListedComposition> = {};
    for (const c of liveComps(documentMirror())) out[c.id] = listedOf(c);
    return out;
  }, [compsVersion]);
  const projectTabs = useProjectStore((s) => s.tabs);
  const activeTabId = useProjectStore((s) => s.activeTabId);
  const openTab = useProjectStore((s) => s.actions.openTab);
  const setActiveTab = useProjectStore((s) => s.actions.setActiveTab);
  const [open, setOpen] = useState(true);

  const listed = useMemo(() => listedCompositions(comps, projectTabs), [comps, projectTabs]);
  const activeCompId = activeTabId ? projectTabs[activeTabId]?.compositionId : undefined;

  const openComposition = (compId: string): void => {
    const existing = Object.values(projectTabs).find((t) => t.compositionId === compId);
    if (existing) {
      setActiveTab(existing.id);
      return;
    }
    openTab(compId, [compId], comps[compId]?.name ?? compId);
  };

  const confirmDeleteComp = async (compId: string): Promise<void> => {
    const comp = comps[compId];
    if (!comp || comp.pristine) return;
    if (await customConfirm('Delete Composition', deleteCompositionWarning(comp.name, compId), { isDanger: true, confirmLabel: 'Delete' })) {
      await deleteCompositionEdit(compId);
    }
  };

  const promptRename = async (compId: string): Promise<void> => {
    const current = comps[compId]?.name ?? '';
    const next = await customPrompt('Rename Composition', 'Composition name', current, { confirmLabel: 'Rename' });
    if (next !== null && next.trim() && next.trim() !== current) await renameCompositionEdit(compId, next);
  };

  const openCompMenu = (compId: string, e: React.MouseEvent): void => {
    e.preventDefault();
    e.stopPropagation();
    const comp = comps[compId];
    const name = comp?.name ?? compId;
    openContextMenu(e.clientX, e.clientY, [
      { id: 'open', label: 'Open Composition', onSelect: () => openComposition(compId) },
      { id: 'rename', label: 'Rename…', onSelect: () => { void promptRename(compId); } },
      {
        id: 'settings',
        label: 'Composition Settings…',
        onSelect: () => {
          openComposition(compId);
          openCompositionSettings();
        },
      },
      { id: 'duplicate', label: 'Duplicate', onSelect: () => { void duplicateCompositionEdit(compId); } },
      // The placeholder comp cannot be deleted (`confirmDeleteComp` refuses),
      // so it is not offered rather than offered and ignored.
      ...(comp?.pristine
        ? []
        : [
            { id: 'sep', separator: true },
            { id: 'delete', label: `Delete “${name}”`, danger: true, onSelect: () => { void confirmDeleteComp(compId); } },
          ]),
    ]);
  };

  const label = <span className={styles.compSectionLabel}>Compositions</span>;

  return (
    <div className={styles.compSection}>
      <div className={styles.compSectionHead}>
        {collapsible ? (
          <button
            type="button"
            className={styles.compSectionToggle}
            aria-expanded={open}
            onClick={() => setOpen((v) => !v)}
          >
            <Icon name={open ? 'chevron-down' : 'chevron-right'} size="sm" />
            {label}
            <span className={styles.compMeta}>{listed.length}</span>
          </button>
        ) : label}
        <button
          type="button"
          className={styles.compAddBtn}
          title="New Composition…"
          aria-label="New Composition"
          onClick={() => openNewCompositionDialog()}
        >
          <Icon name="plus" size="sm" />
        </button>
      </div>
      {open && (listed.length === 0 ? (
        <div className={styles.compEmpty}>None yet — create one to start</div>
      ) : (
        <div className={styles.compList} role="list" aria-label="Compositions">
          {listed.map((c) => {
            const active = c.id === activeCompId;
            return (
              <div
                key={c.id}
                role="listitem"
                aria-current={active || undefined}
                className={`${styles.compRow}${active ? ` ${styles.compRowActive}` : ''}`}
                title={`${c.name} · ${c.width}×${c.height} · ${c.fps} fps`}
                onClick={() => openComposition(c.id)}
                onDoubleClick={() => { void promptRename(c.id); }}
                onContextMenu={(e) => openCompMenu(c.id, e)}
              >
                <Icon name="component" size="sm" className={styles.compGlyph} />
                <span className={styles.compName}>{c.name}</span>
                <span className={styles.compMeta}>{c.width}×{c.height}</span>
                {!c.pristine && (
                  <button
                    type="button"
                    className={styles.compDeleteBtn}
                    title={`Delete “${c.name}”`}
                    aria-label={`Delete ${c.name}`}
                    onClick={(e) => {
                      e.stopPropagation();
                      void confirmDeleteComp(c.id);
                    }}
                  >
                    <Icon name="trash" size="sm" />
                  </button>
                )}
              </div>
            );
          })}
        </div>
      ))}
    </div>
  );
}
