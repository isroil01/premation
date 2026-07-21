import { useEffect, useState } from 'react';
import { useLocation } from 'react-router-dom';
import { Icon } from '@components/Icon';
import { onCoreServicesReady } from '@core/services/coreServices';
import { useProjectStore } from '@stores/projectStore';
import { AppMenuBar } from '@layout/Menu';
import { IconButton } from '@components/IconButton';
import { useLayoutStore } from '@stores/layoutStore';
import { usePresentationStore } from '@stores/presentationStore';
import { useCompositionStore } from '@stores/compositionStore';
import { openExportDialog } from '@layout/Export/ExportDialog';
import styles from './TitleBar.module.css';

export function TitleBar(): JSX.Element | null {
  const [isMaximized, setIsMaximized] = useState(false);
  const location = useLocation();
  const isEditor = location.pathname.startsWith('/editor');
  const isElectron = typeof window !== 'undefined' && (!!window.motionEditor || !!window.electronAPI);

  const leftCollapsed = useLayoutStore((s) => s.regions.leftSidebar?.collapsed);
  const bottomCollapsed = useLayoutStore((s) => s.regions.bottomTimeline?.collapsed);
  const rightCollapsed = useLayoutStore((s) => s.regions.rightInspector?.collapsed);
  const enterPresentation = usePresentationStore((s) => s.enter);
  const compFps = useCompositionStore((s) => s.fps);
  const compDuration = useCompositionStore((s) => s.durationSeconds);

  // Live project ref + dirty flag — the title bar must reflect the real
  // document, not a hardcoded placeholder.
  const [project, setProject] = useState<any>(null);
  useEffect(() => {
    if (!isElectron) return undefined;
    let unsubProject: (() => void) | undefined;
    const unsubReady = onCoreServicesReady((core) => {
      setProject(core.project.getState());
      unsubProject = core.project.subscribe(setProject);
    });
    return () => {
      unsubReady();
      unsubProject?.();
    };
  }, [isElectron]);

  const tabDirty = useProjectStore((s) =>
    s.activeTabId ? s.tabs?.[s.activeTabId]?.dirty === true : false,
  );


  if (!isElectron) return null;
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
        {isEditor && (
          <>
            <span className={styles.menuDivider} aria-hidden />
            <div className={styles.appMenuBarWrapper}>
              <AppMenuBar />
            </div>
          </>
        )}
      </div>
      <div className={styles.center}>
        <span className={styles.appName}>Motion Editor</span>
        {dirty && <span className={styles.dirtyDot} title="Unsaved changes" />}
      </div>
      <div className={styles.right}>
        {isEditor && (
          <div className={styles.editorControls}>
            <IconButton
              aria-label="Toggle Left Sidebar"
              size="sm"
              className={styles.layoutToggle}
              active={!leftCollapsed}
              title="Toggle Left Sidebar"
              onClick={() => useLayoutStore.getState().toggleRegion('leftSidebar')}
            >
              <Icon name="panel-left" size={14} />
            </IconButton>
            <IconButton
              aria-label="Toggle Bottom Timeline"
              size="sm"
              className={styles.layoutToggle}
              active={!bottomCollapsed}
              title="Toggle Bottom Timeline"
              onClick={() => useLayoutStore.getState().toggleRegion('bottomTimeline')}
            >
              <Icon name="panel-bottom" size={14} />
            </IconButton>
            <IconButton
              aria-label="Toggle Right Inspector"
              size="sm"
              className={styles.layoutToggle}
              active={!rightCollapsed}
              title="Toggle Right Inspector"
              onClick={() => useLayoutStore.getState().toggleRegion('rightInspector')}
            >
              <Icon name="panel-right" size={14} />
            </IconButton>
            <span className={styles.menuDivider} aria-hidden />
            <IconButton
              aria-label="Preview"
              size="sm"
              className={styles.layoutToggle}
              title="Preview"
              onClick={() => enterPresentation()}
            >
              <Icon name="eye" size={14} />
            </IconButton>
            <IconButton
              aria-label="Export"
              size="sm"
              className={styles.layoutToggle}
              title="Export"
              onClick={() => openExportDialog(compDuration, compFps)}
            >
              <Icon name="export" size={14} />
            </IconButton>
          </div>
        )}
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
          <Icon name="close" size={10} />
        </button>
      </div>
    </div>
  );
}

export default TitleBar;
