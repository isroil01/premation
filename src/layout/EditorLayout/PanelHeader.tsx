import { useState, useRef, useEffect } from 'react';
import { useLayoutStore, type RegionId } from '@stores/layoutStore';
import { Icon } from '@components/Icon';
import styles from './PanelHeader.module.css';

interface PanelHeaderProps {
  panelId: string;
  title: string;
  icon?: string;
  closable?: boolean;
}

export function PanelHeader({ panelId, title, icon, closable = true }: PanelHeaderProps): JSX.Element {
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
  const placement = panel?.placement ?? 'docked';

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
        {/* Panel Options Menu Button */}
        {!workspaceLocked && (
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

            <div style={{ fontSize: 9, color: 'var(--color-text-tertiary)', padding: '2px 8px', textTransform: 'uppercase' }}>
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
