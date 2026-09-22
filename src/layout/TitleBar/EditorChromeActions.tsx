import { Icon } from '@components/Icon';
import { Button } from '@components/Button';
import { IconButton } from '@components/IconButton';
import { Dropdown } from '@components/Dropdown';
import { openCustomizeDialog } from '@layout/Settings/openCustomizeDialog';
import { buildWorkspaceItems } from '@layout/Workspace/workspaceMenuItems';
import { useLayoutStore } from '@stores/layoutStore';
import { usePresentationStore } from '@stores/presentationStore';
import { useCompositionStore } from '@stores/compositionStore';
import { openExportDialog } from '@layout/Export/ExportDialog';
import styles from './TitleBar.module.css';

/**
 * The right-hand cluster of the desktop editor chrome: panel toggles, workspace
 * presets, Customize, Preview and Export.
 *
 * One component because two bars draw it — the Windows / Linux title bar and
 * the macOS unified toolbar (TopNav) — and Export in the same place with the
 * same tour target on both is the point of a shared layout.
 *
 * `showCustomize` is off on macOS, where Settings… lives in the app menu (⌘,).
 */
export function EditorChromeActions({ showCustomize = true }: { showCustomize?: boolean }): JSX.Element {
  const leftCollapsed = useLayoutStore((s) => s.regions.leftSidebar?.collapsed);
  const bottomCollapsed = useLayoutStore((s) => s.regions.bottomTimeline?.collapsed);
  const rightCollapsed = useLayoutStore((s) => s.regions.rightInspector?.collapsed);
  const enterPresentation = usePresentationStore((s) => s.enter);
  const compFps = useCompositionStore((s) => s.fps);
  const compDuration = useCompositionStore((s) => s.durationSeconds);

  return (
    <div className={styles.editorControls}>
      <IconButton
        aria-label="Toggle Left Sidebar"
        size="sm"
        className={styles.layoutToggle}
        active={!leftCollapsed}
        title="Toggle Left Sidebar"
        onClick={() => useLayoutStore.getState().toggleRegion('leftSidebar')}
      >
        <Icon name="panel-left" size="md" />
      </IconButton>
      <IconButton
        aria-label="Toggle Bottom Timeline"
        size="sm"
        className={styles.layoutToggle}
        active={!bottomCollapsed}
        title="Toggle Bottom Timeline"
        onClick={() => useLayoutStore.getState().toggleRegion('bottomTimeline')}
      >
        <Icon name="panel-bottom" size="md" />
      </IconButton>
      <IconButton
        aria-label="Toggle Right Inspector"
        size="sm"
        className={styles.layoutToggle}
        active={!rightCollapsed}
        title="Toggle Right Inspector"
        onClick={() => useLayoutStore.getState().toggleRegion('rightInspector')}
      >
        <Icon name="panel-right" size="md" />
      </IconButton>
      <span className={styles.menuDivider} aria-hidden />
      <Dropdown
        placement="bottom-end"
        trigger={
          <IconButton
            aria-label="Workspaces"
            size="sm"
            className={styles.layoutToggle}
            title="Workspaces & Layout Presets"
          >
            <Icon name="layout" size="md" />
          </IconButton>
        }
        items={buildWorkspaceItems()}
      />
      {showCustomize && (
        <IconButton
          aria-label="Customize"
          size="sm"
          className={styles.layoutToggle}
          title="Customize (Shortcuts, Workspaces, Appearance)"
          onClick={() => openCustomizeDialog()}
        >
          <Icon name="settings" size="md" />
        </IconButton>
      )}
      <span className={styles.menuDivider} aria-hidden />
      <Button
        size="sm"
        variant="secondary"
        className={styles.titleBarBtn}
        leftIcon={<Icon name="play" size="sm" weight="fill" />}
        title="Preview presentation (Fullscreen)"
        onClick={() => enterPresentation()}
      >
        Preview
      </Button>
      <Button
        size="sm"
        variant="primary"
        className={styles.titleBarBtn}
        leftIcon={<Icon name="export" size="sm" weight="bold" />}
        title="Export composition…"
        data-tour="export"
        onClick={() => openExportDialog(compDuration, compFps)}
      >
        Export
      </Button>
    </div>
  );
}

export default EditorChromeActions;
