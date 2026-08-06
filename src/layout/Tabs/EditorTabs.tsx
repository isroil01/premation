/**
 * The main body's tab strip, and the body it controls.
 *
 * THE RULE THIS FILE EXISTS TO ENFORCE: Scene is always mounted.
 *
 * Scene owns a WebGL/WebGPU context, the playback position and the viewport
 * transform. Rendering it conditionally — `{active === 'scene' && <Scene/>}`,
 * which is the obvious way to write a tab switcher — destroys all three every
 * time the user opens a plugin page, and re-acquiring a GPU context is both
 * visibly slow and, on some drivers, not guaranteed to succeed. So Scene is
 * rendered unconditionally and hidden with CSS, and the other tabs are drawn
 * over it.
 *
 * `visibility: hidden`, not `display: none`: `display: none` collapses the
 * box, the canvas inside resizes to zero, and returning to Scene gives a black
 * stage until something forces a resize. This editor has had that bug before.
 */

import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { Icon } from '@components/Icon';
import { cn } from '@utils/cn';
import { SCENE_TAB_ID, useEditorTabStore, type EditorTab } from '@stores/editorTabStore';
import { useCompositionStore } from '@stores/compositionStore';
import styles from './EditorTabs.module.css';

export interface EditorTabsProps {
  /** The viewport. Rendered once, always, and never unmounted by this component. */
  scene: ReactNode;
  /** Draw the body of a non-Scene tab. */
  renderTab: (tab: EditorTab) => ReactNode;
}

export function EditorTabs({ scene, renderTab }: EditorTabsProps): JSX.Element {
  const tabs = useEditorTabStore((s) => s.tabs);
  const activeId = useEditorTabStore((s) => s.activeId);
  const activate = useEditorTabStore((s) => s.activate);
  const close = useEditorTabStore((s) => s.close);
  const pin = useEditorTabStore((s) => s.pin);
  const focusRelative = useEditorTabStore((s) => s.focusRelative);

  const [overflowOpen, setOverflowOpen] = useState(false);
  const stripRef = useRef<HTMLDivElement>(null);

  const activeTab = tabs.find((t) => t.id === activeId);
  const sceneActive = activeId === SCENE_TAB_ID;
  const compName = useCompositionStore((s) => s.name);

  /**
   * Ctrl/Cmd+W closes the active tab — and never Scene.
   *
   * Scene is not closeable, so with Scene focused this must do NOTHING rather
   * than fall through to the next handler or, worse, to the browser/Electron
   * default of closing the window. Someone reaching for "close this tab" with
   * the viewport focused must not lose their session.
   */
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent): void => {
      const mod = e.metaKey || e.ctrlKey;
      if (mod && e.key.toLowerCase() === 'w') {
        e.preventDefault();
        const current = useEditorTabStore.getState().activeId;
        if (current !== SCENE_TAB_ID) close(current);
        return;
      }
      // Arrow navigation only while the strip itself has focus, or every left
      // arrow on the canvas would move a tab.
      if (!stripRef.current?.contains(document.activeElement)) return;
      if (e.key === 'ArrowRight') { e.preventDefault(); focusRelative(1); }
      if (e.key === 'ArrowLeft') { e.preventDefault(); focusRelative(-1); }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [close, focusRelative]);

  /** Middle click closes, the way it does in every other tab strip. */
  const onAuxClick = useCallback((e: React.MouseEvent, id: string) => {
    if (e.button === 1) { e.preventDefault(); close(id); }
  }, [close]);

  return (
    <div className={styles.root}>
      <div className={styles.strip} role="tablist" aria-label="Editor tabs" ref={stripRef}>
        {/*
          Scene's tab, labelled with the COMPOSITION's name rather than the word
          "Scene". The composition name used to live in a bar of its own above
          the canvas; naming the tab after what it contains says the same thing
          in a row that already exists, and "Scene" said nothing a user could not
          see. It is purely a tab — clicking it comes back to the canvas and
          nothing else. Composition Settings opens from its own button in the
          status bar, so this does not have to be two controls wearing one hat.

          No close button, ever — it is the background, not a document, and a
          strip with nothing in it is not a valid state.
        */}
        <button
          type="button"
          role="tab"
          aria-selected={sceneActive}
          className={cn(styles.tab, sceneActive && styles.tabActive)}
          title={compName}
          onClick={() => activate(SCENE_TAB_ID)}
        >
          <Icon name="frame" size="sm" />
          <span className={styles.tabLabel}>{compName}</span>
        </button>

        {tabs.map((tab) => (
          <button
            key={tab.id}
            type="button"
            role="tab"
            aria-selected={tab.id === activeId}
            className={cn(
              styles.tab,
              tab.id === activeId && styles.tabActive,
              tab.preview && styles.tabPreview,
            )}
            title={tab.title}
            onClick={() => activate(tab.id)}
            onDoubleClick={() => pin(tab.id)}
            onAuxClick={(e) => onAuxClick(e, tab.id)}
          >
            <Icon name="plugin" size="sm" />
            <span className={styles.tabLabel}>{tab.title}</span>
            <span
              // A span, not a nested <button>: a button inside a button is
              // invalid markup and browsers resolve it inconsistently.
              role="button"
              tabIndex={-1}
              aria-label={`Close ${tab.title}`}
              className={styles.close}
              onClick={(e) => { e.stopPropagation(); close(tab.id); }}
            >
              <Icon name="close" size="sm" />
            </span>
          </button>
        ))}

        {tabs.length > 0 && (
          <button
            type="button"
            className={styles.overflow}
            aria-haspopup="menu"
            aria-expanded={overflowOpen}
            onClick={() => setOverflowOpen((v) => !v)}
            title="All open tabs"
          >
            <Icon name="chevron-down" size="sm" />
          </button>
        )}
      </div>

      {overflowOpen && (
        <div className={styles.overflowMenu} role="menu">
          {tabs.map((tab) => (
            <button
              key={tab.id}
              type="button"
              role="menuitem"
              className={styles.overflowItem}
              onClick={() => { activate(tab.id); setOverflowOpen(false); }}
            >
              {tab.title}
            </button>
          ))}
          <button
            type="button"
            role="menuitem"
            className={styles.overflowItem}
            onClick={() => { useEditorTabStore.getState().closeAll(); setOverflowOpen(false); }}
          >
            Close all tabs
          </button>
        </div>
      )}

      <div className={styles.body}>
        {/*
          UNCONDITIONAL. Do not wrap this in `{sceneActive && …}`.
          The GPU context, playback state and viewport transform live in here,
          and all three are lost the moment it leaves the tree.
        */}
        <div
          className={cn(styles.scenePane, !sceneActive && styles.sceneHidden)}
          aria-hidden={!sceneActive}
          data-testid="scene-pane"
        >
          {scene}
        </div>

        {activeTab && (
          <div className={styles.tabPane} role="tabpanel" data-testid="tab-pane">
            {renderTab(activeTab)}
          </div>
        )}
      </div>
    </div>
  );
}
