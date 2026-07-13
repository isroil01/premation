import { useState } from 'react';
import { Icon } from '@components/Icon';
import styles from './TitleBar.module.css';

export function TitleBar(): JSX.Element | null {
  const [isMaximized, setIsMaximized] = useState(false);
  const isElectron = typeof window !== 'undefined' && (!!window.motionEditor || !!window.electronAPI);

  if (!isElectron) return null;

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
        <span className={styles.projectName}>New Project.motion</span>
        <span className={styles.dirtyDot} />
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
