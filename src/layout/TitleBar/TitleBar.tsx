import { useEffect, useState } from 'react';
import { Icon } from '@components/Icon';
import { getProjectManager } from '@core/services/coreServices';
import { useProjectStore } from '@stores/projectStore';
import styles from './TitleBar.module.css';

export function TitleBar(): JSX.Element | null {
  const [isMaximized, setIsMaximized] = useState(false);
  const isElectron = typeof window !== 'undefined' && (!!window.motionEditor || !!window.electronAPI);

  // Live project ref + dirty flag — the title bar must reflect the real
  // document, not a hardcoded placeholder.
  const [project, setProject] = useState(() => (isElectron ? getProjectManager().getState() : null));
  useEffect(() => {
    if (!isElectron) return undefined;
    return getProjectManager().subscribe(setProject);
  }, [isElectron]);
  const tabDirty = useProjectStore((s) =>
    s.activeTabId ? s.tabs?.[s.activeTabId]?.dirty === true : false,
  );
  const compName = useProjectStore((s) => {
    const tab = s.activeTabId ? s.tabs?.[s.activeTabId] : null;
    return tab ? s.comps?.[tab.compositionId]?.name ?? tab.title : null;
  });

  if (!isElectron) return null;

  const projectName = project?.current?.name ?? compName ?? 'Untitled';
  const dirty = (project?.dirty ?? false) || tabDirty;

  const handleMinimize = () => {
    window.electronAPI?.window?.minimize?.();
  };

  const handleMaximize = () => {
    window.electronAPI?.window?.maximize?.();
    setIsMaximized(!isMaximized);
  };

  const handleClose = () => {
    window.electronAPI?.window?.close?.();
  };

  return (
    <div className={styles.titleBar}>
      <div className={styles.dragRegion} />
      <div className={styles.left}>
        <span className={styles.appIcon}>
          <Icon name="shape" size={14} style={{ color: '#38bdf8' }} />
        </span>
        <span className={styles.appName}>Motion Editor</span>
      </div>
      <div className={styles.center}>
        <span className={styles.projectName} title={projectName}>{projectName}</span>
        {dirty && <span className={styles.dirtyDot} title="Unsaved changes" />}
      </div>
      <div className={styles.right}>
        <button type="button" onClick={handleMinimize} className={styles.btn} title="Minimize">
          <svg width="10" height="1" viewBox="0 0 10 1"><rect width="10" height="1" fill="currentColor" /></svg>
        </button>
        <button type="button" onClick={handleMaximize} className={styles.btn} title={isMaximized ? 'Restore' : 'Maximize'}>
          {isMaximized ? (
            <svg width="10" height="10" viewBox="0 0 10 10">
              <path d="M2,1 L8,1 A1,1 0 0,1 9,2 L9,8 A1,1 0 0,1 8,9 L2,9 A1,1 0 0,1 1,8 L1,2 A1,1 0 0,1 2,1 z" fill="none" stroke="currentColor" strokeWidth="1" />
              <path d="M3,3 L7,3 L7,7 L3,7 z" fill="none" stroke="currentColor" strokeWidth="1" />
            </svg>
          ) : (
            <svg width="10" height="10" viewBox="0 0 10 10"><rect width="8" height="8" x="1" y="1" fill="none" stroke="currentColor" strokeWidth="1" /></svg>
          )}
        </button>
        <button type="button" onClick={handleClose} className={`${styles.btn} ${styles.btnClose}`} title="Close">
          <svg width="10" height="10" viewBox="0 0 10 10"><path d="M1,1 L9,9 M9,1 L1,9" stroke="currentColor" strokeWidth="1.2" /></svg>
        </button>
      </div>
    </div>
  );
}

export default TitleBar;
