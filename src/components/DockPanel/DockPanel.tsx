/**
 * DockPanel — After Effects-style region panel host with horizontal tab header & overflow menu.
 *
 * Displays primary tabs horizontally and houses additional dock panels inside
 * an authentic AE panel options / hamburger dropdown (≡), allowing instant switching.
 */

import { useMemo, useRef, useState, useEffect, type ReactNode, type DragEvent } from 'react';
import { useLayoutStore } from '@stores/layoutStore';
import type { RegionId } from '@stores/layoutStore';
import type { IconName } from '@components/Icon';
import { openContextMenu } from '@stores/contextMenuStore';
import { Icon } from '@components/Icon';
import { cn } from '@utils/cn';
import { panelDef } from '@layout/EditorLayout/panelDefs';
import styles from './DockPanel.module.css';

export interface DockPanelProps {
  region: RegionId;
  renderers: Record<string, (() => ReactNode) | (() => JSX.Element)>;
  headerExtras?: ReactNode;
  className?: string;
  isSplit?: boolean;
  splitPosition?: 'top' | 'bottom';
  onToggleSplit?: () => void;
}

interface TabDescriptor {
  id: string;
  label: string;
  icon?: IconName;
  closable: boolean;
}

const MAX_VISIBLE_TABS = 3;

export function DockPanel({
  region,
  renderers,
  headerExtras,
  className,
  isSplit = false,
  splitPosition,
  onToggleSplit,
}: DockPanelProps): JSX.Element | null {
  const panelOrder = useLayoutStore((s) => s.panelOrder[region] ?? []);
  const activeTabId = useLayoutStore((s) => s.activePanelByRegion[region]);
  const panels = useLayoutStore((s) => s.panels);
  const openPanel = useLayoutStore((s) => s.openPanel);
  const closePanel = useLayoutStore((s) => s.closePanel);
  const movePanel = useLayoutStore((s) => s.movePanel);

  const [menuOpen, setMenuOpen] = useState(false);
  const popoverRef = useRef<HTMLDivElement>(null);

  // Close popover on outside click
  useEffect(() => {
    if (!menuOpen) return;
    const handler = (e: MouseEvent) => {
      if (popoverRef.current && !popoverRef.current.contains(e.target as Node)) {
        setMenuOpen(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [menuOpen]);

  const allItems: TabDescriptor[] = useMemo(() => {
    return panelOrder
      .map((id) => panels[id])
      .filter((p): p is NonNullable<typeof p> => !!p)
      .map((p) => {
        const def = panelDef(p.id);
        return {
          id: p.id,
          label: typeof p.title === 'string' ? p.title : p.id,
          icon: p.icon as IconName | undefined,
          closable: def ? def.closable : (p.closable ?? false),
        };
      });
  }, [panelOrder, panels]);

  // Guard against a stale persisted active id that no longer has a tab
  const effectiveActiveId = allItems.some((i) => i.id === activeTabId) ? activeTabId : allItems[0]?.id;

  // Primary visible tabs in header (limits tab clutter, always includes active tab)
  const visibleItems = useMemo(() => {
    if (allItems.length <= MAX_VISIBLE_TABS) return allItems;
    const top = allItems.slice(0, MAX_VISIBLE_TABS);
    if (effectiveActiveId && !top.some((i) => i.id === effectiveActiveId)) {
      const activeItem = allItems.find((i) => i.id === effectiveActiveId);
      if (activeItem) {
        return [...top.slice(0, MAX_VISIBLE_TABS - 1), activeItem];
      }
    }
    return top;
  }, [allItems, effectiveActiveId]);

  // All hooks must run before this guard — bail out only once they have.
  if (allItems.length === 0) return null;

  const activeRenderer = effectiveActiveId ? renderers[effectiveActiveId] : undefined;

  const overflowCount = Math.max(0, allItems.length - visibleItems.length);

  // Check if this sidebar is collapsed
  const isCollapsed = className?.includes('collapsed-view') || false;

  /** Drag handlers — plain HTML5 DnD for tab reordering */
  const onDragStart = (id: string) => (e: DragEvent<HTMLDivElement>) => {
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', id);
  };

  const onDragOver = (e: DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
  };

  const onDrop = (targetId: string | null) => (e: DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.stopPropagation();
    const src = e.dataTransfer.getData('text/plain');
    if (!src || src === targetId) return;

    let targetIdx = panelOrder.length;
    if (targetId !== null) {
      targetIdx = panelOrder.indexOf(targetId);
      if (targetIdx === -1) targetIdx = panelOrder.length;
    }

    movePanel(src, region, targetIdx);
  };

  const targetPanelId = effectiveActiveId ?? allItems[0]?.id ?? null;
  const targetPanel = targetPanelId ? panels[targetPanelId] : undefined;
  const targetLabel = targetPanel?.title || 'Panel';

  const isLeft = region.startsWith('leftSidebar');
  const isTop = splitPosition ? splitPosition === 'top' : (region === 'leftSidebar' || region === 'rightInspector');

  const moveActiveTo = (dest: RegionId) => {
    if (targetPanelId) {
      const destLen = useLayoutStore.getState().panelOrder[dest]?.length ?? 0;
      movePanel(targetPanelId, dest, destLen);
    }
    setMenuOpen(false);
  };

  const popoutActivePanel = () => {
    if (targetPanelId) {
      useLayoutStore.getState().popoutPanel(targetPanelId);
      if (window.motionEditor?.popout?.spawnWindow) {
        window.motionEditor.popout.spawnWindow(targetPanelId);
      } else {
        const url = `${window.location.origin}${window.location.pathname}#/popout/${targetPanelId}`;
        window.open(url, `popout-${targetPanelId}`, 'width=900,height=650,resizable=yes');
      }
    }
    setMenuOpen(false);
  };

  return (
    <div className={cn(styles.root, className)}>
      {/* ── AE Top Tab Bar ── */}
      <div className={styles.headerBar}>
        <div className={styles.tabsScroll} role="tablist" onDragOver={onDragOver} onDrop={onDrop(null)}>
          {visibleItems.map((item) => {
            const isActive = item.id === effectiveActiveId;
            return (
              <div
                key={item.id}
                draggable
                onDragStart={onDragStart(item.id)}
                onDragOver={onDragOver}
                onDrop={onDrop(item.id)}
                className={styles.draggableTab}
                onContextMenu={(e) => {
                  e.preventDefault();
                  const otherSide: RegionId = isLeft ? 'rightInspector' : 'leftSidebar';
                  const otherSideLabel = isLeft ? 'Move to Right Inspector' : 'Move to Left Sidebar';

                  openContextMenu(e.clientX, e.clientY, [
                    ...(isSplit
                      ? isTop
                        ? [
                            {
                              id: 'move-pane-bottom',
                              label: 'Move to Bottom Pane',
                              onSelect: () => {
                                const bottomDest: RegionId = isLeft ? 'leftSidebar_bottom' : 'rightInspector_bottom';
                                movePanel(item.id, bottomDest, useLayoutStore.getState().panelOrder[bottomDest]?.length ?? 0);
                              },
                            },
                          ]
                        : [
                            {
                              id: 'move-pane-top',
                              label: 'Move to Top Pane',
                              onSelect: () => {
                                const topDest: RegionId = isLeft ? 'leftSidebar' : 'rightInspector';
                                movePanel(item.id, topDest, useLayoutStore.getState().panelOrder[topDest]?.length ?? 0);
                              },
                            },
                          ]
                      : onToggleSplit
                      ? [
                          {
                            id: 'split-view',
                            label: 'Split Sidebar (Top & Bottom)',
                            onSelect: () => onToggleSplit(),
                          },
                        ]
                      : []),
                    {
                      id: 'move-side',
                      label: otherSideLabel,
                      onSelect: () => movePanel(item.id, otherSide, useLayoutStore.getState().panelOrder[otherSide]?.length ?? 0),
                    },
                    {
                      id: 'popout',
                      label: 'Undock Panel into Window',
                      onSelect: () => {
                        useLayoutStore.getState().popoutPanel(item.id);
                        const url = `${window.location.origin}${window.location.pathname}#/popout/${item.id}`;
                        window.open(url, `popout-${item.id}`, 'width=900,height=650,resizable=yes');
                      },
                    },
                    ...(item.closable
                      ? [
                          { id: 'sep', separator: true },
                          { id: 'close', label: `Close “${item.label}”`, onSelect: () => closePanel(item.id) },
                        ]
                      : []),
                  ]);
                }}
              >
                {/* Not a <button>: the close control lives inside the tab's
                    padded box, and a button may not nest inside a button. A
                    role="tab" div with explicit keyboard handling keeps the
                    exact same layout while staying valid DOM. */}
                <div
                  role="tab"
                  tabIndex={isActive ? 0 : -1}
                  className={cn(styles.tabItem, isActive && styles.tabItemActive)}
                  onClick={() => openPanel(item.id)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault();
                      openPanel(item.id);
                    }
                  }}
                  title={item.label}
                  aria-selected={isActive}
                >
                  {item.icon && <Icon name={item.icon} size="sm" />}
                  <span className={styles.tabLabel}>{item.label}</span>
                  {item.closable && (
                    <button
                      type="button"
                      className={styles.tabCloseBtn}
                      title={`Close ${item.label}`}
                      aria-label={`Close ${item.label}`}
                      onClick={(e) => {
                        e.stopPropagation();
                        closePanel(item.id);
                      }}
                    >
                      <Icon name="close" size="sm" />
                    </button>
                  )}
                </div>
              </div>
            );
          })}
        </div>

        {/* ── Actions & Panel Hamburger / Overflow Menu ── */}
        <div className={styles.headerActions} ref={popoverRef}>
          {headerExtras}

          {/* Quick Split / Merge Toggle Button */}
          {onToggleSplit && (
            <button
              type="button"
              className={styles.actionBtn}
              title={isSplit ? 'Remove Split (Merge Panels)' : 'Split Sidebar (Top & Bottom)'}
              aria-label={isSplit ? 'Remove Split (Merge Panels)' : 'Split Sidebar (Top & Bottom)'}
              onClick={onToggleSplit}
            >
              <Icon name={isSplit ? 'minimize' : 'layers'} size="sm" />
            </button>
          )}

          <button
            type="button"
            className={cn(styles.actionBtn, menuOpen && styles.actionBtnActive)}
            title={`Dock Panels & Options (${allItems.length} panels)`}
            aria-label="Dock panels and options menu"
            onClick={() => setMenuOpen(!menuOpen)}
          >
            {overflowCount > 0 && <span className={styles.overflowBadge}>+{overflowCount}</span>}
            <Icon name="menu" size="sm" />
          </button>

          {menuOpen && (
            <ul className={styles.moveMenu} role="menu">
              <li className={styles.moveMenuLabel} role="none">Dock Panels</li>
              {allItems.map((item) => {
                const isActive = item.id === effectiveActiveId;
                return (
                  <li key={item.id} role="none">
                    <button
                      type="button"
                      role="menuitem"
                      className={cn(styles.moveMenuItem, isActive && styles.moveMenuItemActive)}
                      onClick={() => {
                        openPanel(item.id);
                        setMenuOpen(false);
                      }}
                    >
                      <span className={styles.menuItemLeft}>
                        {item.icon && <Icon name={item.icon} size="sm" />}
                        <span>{item.label}</span>
                      </span>
                      {isActive && <span className={styles.activeCheck}>✓</span>}
                    </button>
                  </li>
                );
              })}

              <li className={styles.menuSectionDivider} role="separator" />

              <li className={styles.moveMenuLabel} role="none">Panel Actions</li>
              {onToggleSplit && (
                <li role="none">
                  <button
                    type="button"
                    role="menuitem"
                    className={styles.moveMenuItem}
                    onClick={() => {
                      onToggleSplit();
                      setMenuOpen(false);
                    }}
                  >
                    <span className={styles.menuItemLeft}>
                      <Icon name={isSplit ? 'minimize' : 'layers'} size="sm" />
                      <span>{isSplit ? 'Merge into Single View' : 'Split View (Top & Bottom)'}</span>
                    </span>
                  </button>
                </li>
              )}

              {isSplit && (
                <li role="none">
                  <button
                    type="button"
                    role="menuitem"
                    className={styles.moveMenuItem}
                    onClick={() => {
                      if (isTop) {
                        const bottomDest: RegionId = isLeft ? 'leftSidebar_bottom' : 'rightInspector_bottom';
                        moveActiveTo(bottomDest);
                      } else {
                        const topDest: RegionId = isLeft ? 'leftSidebar' : 'rightInspector';
                        moveActiveTo(topDest);
                      }
                    }}
                  >
                    <span className={styles.menuItemLeft}>
                      <Icon name="layout" size="sm" />
                      <span>{isTop ? 'Move to Bottom Pane' : 'Move to Top Pane'}</span>
                    </span>
                  </button>
                </li>
              )}

              <li role="none">
                <button
                  type="button"
                  role="menuitem"
                  className={styles.moveMenuItem}
                  onClick={() => {
                    const otherSide: RegionId = isLeft ? 'rightInspector' : 'leftSidebar';
                    moveActiveTo(otherSide);
                  }}
                >
                  <span className={styles.menuItemLeft}>
                    <Icon name="layout" size="sm" />
                    <span>{isLeft ? 'Move to Right Inspector' : 'Move to Left Sidebar'}</span>
                  </span>
                </button>
              </li>

              <li role="none">
                <button
                  type="button"
                  role="menuitem"
                  className={styles.moveMenuItem}
                  onClick={popoutActivePanel}
                >
                  <span className={styles.menuItemLeft}>
                    <Icon name="export" size="sm" />
                    <span>Undock “{targetLabel}”</span>
                  </span>
                </button>
              </li>
            </ul>
          )}
        </div>
      </div>

      {/* ── Panel Content ── */}
      {!isCollapsed && (
        <div className={styles.content}>
          {activeRenderer ? activeRenderer() : null}
        </div>
      )}
    </div>
  );
}

