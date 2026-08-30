/**
 * DockPanel — After Effects-style region panel host with horizontal tab header & overflow menu.
 *
 * Displays primary tabs horizontally and houses additional dock panels inside
 * an authentic AE panel options / hamburger dropdown (≡), allowing instant switching.
 */

import { useMemo, type ReactNode, type DragEvent } from 'react';
import { useLayoutStore } from '@stores/layoutStore';
import type { RegionId } from '@stores/layoutStore';
import type { IconName } from '@components/Icon';
import { openContextMenu } from '@stores/contextMenuStore';
import { Icon } from '@components/Icon';
import { Dropdown, type DropdownItem } from '@components/Dropdown';
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
  const isLeft = region.startsWith('leftSidebar');
  const isTop = splitPosition ? splitPosition === 'top' : (region === 'leftSidebar' || region === 'rightInspector');
  const regionKey = isLeft ? 'leftSidebar' : 'rightInspector';

  const panelOrder = useLayoutStore((s) => s.panelOrder[region] ?? []);
  const activeTabId = useLayoutStore((s) => s.activePanelByRegion[region]);
  const panels = useLayoutStore((s) => s.panels);
  const isRegionCollapsed = useLayoutStore((s) => s.regions[regionKey]?.collapsed ?? false);
  const openPanel = useLayoutStore((s) => s.openPanel);
  const closePanel = useLayoutStore((s) => s.closePanel);
  const movePanel = useLayoutStore((s) => s.movePanel);

  const isCollapsed = isRegionCollapsed || className?.includes('collapsed-view') || false;

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

  const targetPanelId = effectiveActiveId ?? allItems[0]?.id ?? null;
  const targetPanel = targetPanelId ? panels[targetPanelId] : undefined;
  const targetLabel = targetPanel?.title || 'Panel';

  const moveActiveTo = (dest: RegionId) => {
    if (targetPanelId) {
      const destLen = useLayoutStore.getState().panelOrder[dest]?.length ?? 0;
      movePanel(targetPanelId, dest, destLen);
    }
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
  };

  const menuItems: DropdownItem[] = useMemo(() => {
    const items: DropdownItem[] = [
      { type: 'label', label: 'Dock Panels' },
      ...allItems.map((item) => ({
        type: 'item' as const,
        id: `panel-${item.id}`,
        label: item.label,
        icon: item.id === effectiveActiveId ? ('check' as IconName) : (item.icon ?? undefined),
        onSelect: () => openPanel(item.id),
      })),
      { type: 'separator' },
      { type: 'label', label: 'Panel Actions' },
      {
        type: 'item' as const,
        id: 'toggle-collapse',
        label: isRegionCollapsed ? 'Expand Sidebar' : 'Collapse Sidebar',
        icon: (isLeft
          ? isRegionCollapsed ? 'chevron-right' : 'chevron-left'
          : isRegionCollapsed ? 'chevron-left' : 'chevron-right') as IconName,
        onSelect: () => {
          useLayoutStore.getState().setCollapsed(regionKey, !isRegionCollapsed);
        },
      },
      ...(onToggleSplit
        ? [
            {
              type: 'item' as const,
              id: 'split-view',
              label: isSplit ? 'Merge into Single View' : 'Split View (Top & Bottom)',
              icon: (isSplit ? 'minimize' : 'layers') as IconName,
              onSelect: onToggleSplit,
            },
          ]
        : []),
      ...(isSplit
        ? [
            {
              type: 'item' as const,
              id: 'move-pane',
              label: isTop ? 'Move to Bottom Pane' : 'Move to Top Pane',
              icon: 'layout' as IconName,
              onSelect: () => {
                if (isTop) {
                  const bottomDest: RegionId = isLeft ? 'leftSidebar_bottom' : 'rightInspector_bottom';
                  moveActiveTo(bottomDest);
                } else {
                  const topDest: RegionId = isLeft ? 'leftSidebar' : 'rightInspector';
                  moveActiveTo(topDest);
                }
              },
            },
          ]
        : []),
      {
        type: 'item' as const,
        id: 'move-side',
        label: isLeft ? 'Move to Right Inspector' : 'Move to Left Sidebar',
        icon: 'layout' as IconName,
        onSelect: () => {
          const otherSide: RegionId = isLeft ? 'rightInspector' : 'leftSidebar';
          moveActiveTo(otherSide);
        },
      },
      {
        type: 'item' as const,
        id: 'popout',
        label: `Undock “${targetLabel}”`,
        icon: 'export' as IconName,
        onSelect: popoutActivePanel,
      },
    ];
    return items;
  }, [allItems, effectiveActiveId, onToggleSplit, isSplit, isTop, isLeft, targetLabel, targetPanelId, isRegionCollapsed, regionKey]);

  // All hooks must run before this guard — bail out only once they have.
  if (allItems.length === 0) return null;

  const activeRenderer = effectiveActiveId ? renderers[effectiveActiveId] : undefined;

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

  if (isCollapsed) {
    return (
      <div className={cn(styles.root, styles.collapsedRoot, className)}>
        <div className={styles.collapsedHeaderBar}>
          <Dropdown
            placement={isLeft ? 'right-start' : 'left-start'}
            offset={{ x: 6, y: 0 }}
            noScroll
            trigger={
              <button
                type="button"
                className={styles.collapsedMenuBtn}
                title="Dock Panels & Options"
                aria-label="Dock panels and options menu"
              >
                <Icon name="menu" size="sm" />
              </button>
            }
            items={menuItems}
          />
        </div>

        <div className={styles.collapsedIconsRail}>
          {allItems.map((item) => {
            const isActive = item.id === effectiveActiveId;
            return (
              <button
                key={item.id}
                type="button"
                className={cn(styles.collapsedIconBtn, isActive && styles.collapsedIconBtnActive)}
                title={`${item.label} (Click to expand)`}
                aria-label={item.label}
                onClick={() => {
                  openPanel(item.id);
                  useLayoutStore.getState().setCollapsed(regionKey, false);
                }}
              >
                {item.icon ? <Icon name={item.icon} size="sm" /> : <Icon name="layers" size="sm" />}
              </button>
            );
          })}
        </div>
      </div>
    );
  }

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
        <div className={styles.headerActions}>
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

          <Dropdown
            placement="bottom-end"
            offset={{ x: -8, y: 4 }}
            noScroll
            trigger={
              <button
                type="button"
                className={styles.actionBtn}
                title="Dock Panels & Options"
                aria-label="Dock panels and options menu"
              >
                <Icon name="menu" size="sm" />
              </button>
            }
            items={menuItems}
          />
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

