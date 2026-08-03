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
  const {
    panels,
    workspaceLocked,
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
        {icon && <Icon name={icon as any} size={14} />}
        <span className={styles.title}>{title}</span>
      </div>

      <div className={styles.rightGroup} style={{ position: 'relative' }}>
        {/* In a pop-out window every menu item below is either self-referential
            ("Pop Out" from an already-popped-out window) or a guaranteed no-op
            (the three "Dock …" items act on a store with no registered panels),
            so the whole menu goes away and the header becomes title-only.
            Closing the window is the OS/window control's job. */}
        {!workspaceLocked && !isPopout && (
          <button
            type="button"
            className={styles.actionBtn}
            onClick={() => setMenuOpen(!menuOpen)}
            title="Panel Options"
          >
            <Icon name="more-horizontal" size={14} />
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
            <Icon name="close" size={14} />
          </button>
        )}

        {/* Dropdown Menu */}
        {menuOpen && (
          <div ref={menuRef} className={styles.menuDropdown}>
            {placement !== 'external' && (
              <button type="button" className={styles.menuItem} onClick={handlePopout}>
                <Icon name="export" size={12} /> Pop Out into Window
              </button>
            )}

            <div className={styles.menuSeparator} />

            <div style={{ fontSize: 10, color: 'var(--color-text-tertiary)', padding: '2px 8px', textTransform: 'uppercase' }}>
              Dock Position
            </div>

            <button type="button" className={styles.menuItem} onClick={() => handleDock('leftSidebar')}>
              <Icon name="panel-left" size={12} /> Dock Left Sidebar
            </button>
            <button type="button" className={styles.menuItem} onClick={() => handleDock('rightInspector')}>
              <Icon name="sliders-h" size={12} /> Dock Right Inspector
            </button>
            <button type="button" className={styles.menuItem} onClick={() => handleDock('bottomTimeline')}>
              <Icon name="video" size={12} /> Dock Bottom Timeline
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
