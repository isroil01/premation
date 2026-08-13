import { useState, useRef, useEffect } from 'react';
import { useLayoutStore, type RegionId } from '@stores/layoutStore';
import { Icon } from '@components/Icon';
import styles from './PanelHeader.module.css';

interface PanelHeaderProps {
  panelId: string;
  title: string;
  icon?: string;
  closable?: boolean;
  /**
   * True when this header renders inside a DETACHED pop-out window.
   *
   * It cannot be inferred. `placement` is read from the layout store, but
   * `registerPanel` is only ever called by EditorShellInner — and a pop-out
   * window renders PopoutRoute, never EditorShell. So in that window
   * `panels[panelId]` is `undefined`, `placement` fell back to `'docked'`, and
   * the header cheerfully offered "Pop Out into Window" (in a window that is
   * already popped out) plus three "Dock …" items that all hit
   * `if (!panel) return` and did nothing at all.
   */
  isPopout?: boolean;
}

export function PanelHeader({ panelId, title, icon, closable = true, isPopout = false }: PanelHeaderProps): JSX.Element {
  // `workspaceLocked` used to gate the options button. It was read here and
  // nowhere else, and `setWorkspaceLocked` had no caller at all — no menu item,
  // no command, no button — so the flag was permanently false and this was a
  // gate on a switch that did not exist. Both are removed.
  const {
    panels,
    closePanel,
    dockPanel,
    popoutPanel,
  } = useLayoutStore();

  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement | null>(null);

  const panel = panels[panelId];
  const placement = isPopout ? 'external' : (panel?.placement ?? 'docked');

  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setMenuOpen(false);
      }
    };
    if (menuOpen) {
      document.addEventListener('mousedown', handleClickOutside);
    }
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [menuOpen]);

  const handleDock = (region: RegionId) => {
    dockPanel(panelId, region);
    setMenuOpen(false);
  };

  const handlePopout = () => {
    popoutPanel(panelId);
    setMenuOpen(false);
    if (window.motionEditor?.popout?.spawnWindow) {
      window.motionEditor.popout.spawnWindow(panelId);
    } else {
      const url = `${window.location.origin}${window.location.pathname}#/popout/${panelId}`;
      window.open(url, `popout-${panelId}`, 'width=900,height=650,resizable=yes');
    }
  };

  return (
    <div className={styles.header}>
      <div className={styles.leftGroup}>
        {icon && <Icon name={icon as any} size="md" />}
        <span className={styles.title}>{title}</span>
      </div>

      <div className={styles.rightGroup} style={{ position: 'relative' }}>
        {/* In a pop-out window every menu item below is either self-referential
            ("Pop Out" from an already-popped-out window) or a guaranteed no-op
            (the three "Dock …" items act on a store with no registered panels),
            so the whole menu goes away and the header becomes title-only.
            Closing the window is the OS/window control's job. */}
        {!isPopout && (
          <button
            type="button"
            className={styles.actionBtn}
            onClick={() => setMenuOpen(!menuOpen)}
            title="Panel Options"
          >
            <Icon name="more-horizontal" size="md" />
          </button>
        )}

        {/* Close Button */}
        {closable && (
          <button
            type="button"
            className={styles.actionBtn}
            onClick={() => closePanel(panelId)}
            title="Close Panel"
          >
            <Icon name="close" size="md" />
          </button>
        )}

        {/* Dropdown Menu */}
        {menuOpen && (
          <div ref={menuRef} className={styles.menuDropdown}>
            {placement !== 'external' && (
              <button type="button" className={styles.menuItem} onClick={handlePopout}>
                <Icon name="export" size="sm" /> Pop Out into Window
              </button>
            )}

            <div className={styles.menuSeparator} />

            <div style={{ fontSize: 'var(--font-size-micro)', color: 'var(--color-text-tertiary)', padding: '2px 8px', textTransform: 'uppercase' }}>
              Dock Position
            </div>

            {/*
              Only the two regions that actually RENDER docked panels.

              "Dock Bottom Timeline" used to be here, and it made the panel
              disappear: `dockPanel` happily set `region: 'bottomTimeline'` and
              pushed the id into that region's panelOrder, but EditorLayout
              renders the timeline element in the bottom pane — `DockPanel` is
              only mounted for leftSidebar and rightInspector. The panel went
              away, and its header, the one route back, went with it. Recovery
              was Reset Layout.

              Both sidebars receive the full renderer map, so left↔right docking
              genuinely works; there is no third destination to offer.
            */}
            <button type="button" className={styles.menuItem} onClick={() => handleDock('leftSidebar')}>
              <Icon name="panel-left" size="sm" /> Dock Left Sidebar
            </button>
            <button type="button" className={styles.menuItem} onClick={() => handleDock('rightInspector')}>
              <Icon name="sliders-h" size="sm" /> Dock Right Inspector
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
