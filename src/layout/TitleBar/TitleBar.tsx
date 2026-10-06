import { useState } from 'react';
import { useLocation } from 'react-router-dom';
import { Logo } from '@components/Logo';
import { TITLE_BAR_ROUTE_SLOT_ID } from './routeSlot';
import { panelDef } from '@layout/EditorLayout/panelDefs';
import { AppMenuBar } from '@layout/Menu';
import { ProjectStatus } from '@layout/ProjectStatus/ProjectStatus';
import { useNativeMenuSync } from '@layout/Menu/useNativeMenuSync';
import { getUiPlatform, getWindowControls, hasDesktopChrome } from '@core/config/uiPlatform';
import { UpdateButton } from './UpdateButton';
import { EditorChromeActions } from './EditorChromeActions';
import { MacWindowControls } from './MacWindowControls';
import { useTitleBarOverlaySync } from './useTitleBarOverlaySync';
import styles from './TitleBar.module.css';

/**
 * Keeps the native (Alt) menu generated from the same model the in-app bar
 * draws. A component rather than a bare hook call so it mounts only on the
 * editor route — the groups it serialises name commands that exist there.
 */
function NativeMenuSync(): null {
  useNativeMenuSync();
  return null;
}

/**
 * Minimize / maximize / close, drawn by us. Only when the OS is not drawing its
 * own through the Window Controls Overlay: a `PREMATION_UI_PLATFORM=windows`
 * preview on a Mac, or the browser dev server. See `electron/uiPlatform.ts`.
 */
function WindowsCaptionButtons(): JSX.Element {
  const [isMaximized, setIsMaximized] = useState(false);
  const win = window.electronAPI?.window;
  return (
    <div className={styles.windowActions}>
      <button type="button" onClick={() => void win?.minimize?.()} className={styles.btn} title="Minimize">
        <svg width="10" height="10" viewBox="0 0 10 10" fill="none">
          <line x1="1" y1="5" x2="9" y2="5" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
        </svg>
      </button>
      <button
        type="button"
        onClick={() => {
          void win?.maximize?.();
          setIsMaximized(!isMaximized);
        }}
        className={styles.btn}
        title={isMaximized ? 'Restore' : 'Maximize'}
      >
        {isMaximized ? (
          <svg width="10" height="10" viewBox="0 0 10 10" fill="none">
            <rect x="3.5" y="1.5" width="5" height="5" rx="0.8" stroke="currentColor" strokeWidth="1" />
            <rect x="1.5" y="3.5" width="5" height="5" rx="0.8" fill="var(--color-titlebar, #141416)" stroke="currentColor" strokeWidth="1" />
          </svg>
        ) : (
          <svg width="10" height="10" viewBox="0 0 10 10" fill="none">
            <rect x="1.5" y="1.5" width="7" height="7" rx="1" stroke="currentColor" strokeWidth="1.2" />
          </svg>
        )}
      </button>
      <button type="button" onClick={() => void win?.close?.()} className={`${styles.btn} ${styles.btnClose}`} title="Close">
        <svg width="10" height="10" viewBox="0 0 10 10" fill="none">
          <path d="M2 2L8 8M8 2L2 8" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
        </svg>
      </button>
    </div>
  );
}

/**
 * The desktop title bar. Two designs, chosen by `getUiPlatform()`:
 *
 *  • Windows / Linux — logo and the in-app menu bar on the left, the project in
 *    the centre, the editor actions on the right, then the caption buttons (the
 *    OS's own through the Window Controls Overlay, or drawn in a preview).
 *
 *  • macOS — on the editor route there is no separate title bar: TopNav becomes
 *    the unified toolbar and carries the traffic lights, and the menus are the
 *    system menu bar's, so nothing here draws File / Edit. The menu SYNC still
 *    mounts here — on a Mac that menu is the only one. Other routes get a bare
 *    44px bar so the window has somewhere to drag and the lights sit where main
 *    placed them.
 *
 * `PREMATION_UI_PLATFORM` switches between them in development (`.env.local`).
 */
/** A pop-out window's name: the panel it holds (the title bar is its only header). */
const POPOUT_TITLES: Readonly<Record<string, string>> = { viewport: 'Composition', timeline: 'Timeline', presentation: 'Preview' };
function popoutTitle(pathname: string): string | null {
  const m = new RegExp('^/popout/([^/]+)').exec(pathname);
  if (!m) return null;
  const id = decodeURIComponent(m[1] ?? '');
  return POPOUT_TITLES[id] ?? panelDef(id)?.title ?? id;
}

export function TitleBar(): JSX.Element | null {
  const location = useLocation();
  const isEditor = location.pathname.startsWith('/editor');
  const popout = popoutTitle(location.pathname);
  useTitleBarOverlaySync();

  if (!hasDesktopChrome()) return null;
  const platform = getUiPlatform();

  if (platform === 'mac') {
    if (isEditor) return <NativeMenuSync />;
    return (
      <div className={`${styles.titleBar} ${styles.mac} ${styles.seamless}`} data-platform="mac">
        <div className={styles.dragRegion} />
        <div className={styles.left}>
          <MacWindowControls />
        </div>
        <div className={`${styles.center} ${styles.macTitle}`}>{popout ?? 'Premation'}</div>
        <div className={styles.right}>
          {/* The page's own controls (see routeSlot.ts). Never on the editor route. */}
          <div id={TITLE_BAR_ROUTE_SLOT_ID} className={styles.routeSlot} />
          <UpdateButton />
        </div>
      </div>
    );
  }

  const controls = getWindowControls();
  return (
    <div className={`${styles.titleBar} ${isEditor ? '' : styles.seamless}`} data-platform={platform} data-controls={controls}>
      <div className={styles.dragRegion} />
      <div className={styles.left}>
        <Logo variant="mark" size={18} className={styles.appIconBadge} />
        {isEditor && (
          <>
            <span className={styles.menuDivider} aria-hidden />
            <div className={styles.appMenuBarWrapper}>
              <AppMenuBar />
            </div>
          </>
        )}
      </div>
      {/* Centre: which project, whether it is saved, how long ago. The web
          build mounts the same component in TopNav's centre. */}
      {isEditor && (
        <div className={styles.center}>
          <NativeMenuSync />
          <ProjectStatus />
        </div>
      )}
      {popout && <div className={`${styles.center} ${styles.macTitle}`}>{popout}</div>}
      <div className={styles.right}>
        {/* First in the cluster, and far from Export: a pending update is the
            one thing here the user has not already gone looking for. Renders
            nothing when nothing is pending, which is almost always. */}
        {/* The page's own controls (see routeSlot.ts). Never on the editor route. */}
        {!isEditor && <div id={TITLE_BAR_ROUTE_SLOT_ID} className={styles.routeSlot} />}
        <UpdateButton />
        {isEditor && <EditorChromeActions />}
        {controls === 'drawn' && <WindowsCaptionButtons />}
      </div>
    </div>
  );
}

export default TitleBar;
