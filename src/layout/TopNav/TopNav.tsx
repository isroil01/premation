/**
 * TopNav — the After Effects–style top chrome: a real menu bar (File / Edit /
 * … shown directly, no dropdown kebab) over a horizontal tool bar of the
 * motion-design tools. Replaces the old floating dropdown + left tool rail.
 *
 *   ┌───────────────────────────────────────────────────────────┐
 *   │ ← │ File  Edit  View  Help          ·············  ✦ AI    │  menu row
 *   ├───────────────────────────────────────────────────────────┤
 *   │ ▸ ✥ ↻ ⤢ │ ✎ T ▣ │ 3D                                       │  tool row
 *   └───────────────────────────────────────────────────────────┘
 */

import { IconButton } from '@components/IconButton';
import { Button } from '@components/Button';
import { Icon, type IconName } from '@components/Icon';
import { AppMenuBar } from '@layout/Menu';
import { AiSparkleButton } from '@layout/TopToolbar/AiSparkleButton';
import { openExportDialog } from '@layout/Export/ExportDialog';
import { usePresentationStore } from '@stores/presentationStore';
import { useActiveWorkspace } from '@stores/workspaceStore';
import { insertPrimitive } from '@core/scene/sceneInsert';
import type { SceneKind } from '@core/scene/seedDefaultScene';
import { useUIStore, type Tool } from '@stores/uiStore';
import styles from './TopNav.module.css';

/** Composition length + frame rate used by the export/preview. */
const EXPORT_DURATION = 10;
const EXPORT_FPS = 30;

interface ToolDef {
  id: Tool;
  icon: IconName;
  label: string;
  shortcut: string;
}

/** Tool groups, separated by hairlines (AE tool-bar grouping). */
const TOOL_GROUPS: ToolDef[][] = [
  [
    { id: 'select', icon: 'mouse-pointer', label: 'Select', shortcut: 'V' },
    { id: 'move', icon: 'move', label: 'Move', shortcut: 'W' },
    { id: 'rotate', icon: 'rotate-cw', label: 'Rotate', shortcut: 'R' },
    { id: 'scale', icon: 'maximize', label: 'Scale', shortcut: 'S' },
  ],
  [
    { id: 'pen', icon: 'pen', label: 'Pen', shortcut: 'P' },
    { id: 'text', icon: 'type', label: 'Text', shortcut: 'T' },
    { id: 'shape', icon: 'shape', label: 'Shape', shortcut: 'U' },
  ],
];

/** Insert / add-layer controls (moved here from the Scene panel). */
const INSERT: { kind: SceneKind; name: string; icon: IconName; label: string }[] = [
  { kind: 'shape', name: 'Shape', icon: 'plus', label: 'Add shape' },
  { kind: 'text', name: 'Text', icon: 'type', label: 'Add text' },
  { kind: 'group', name: 'Group', icon: 'folder', label: 'Add group' },
];

export function TopNav(): JSX.Element {
  const activeTool = useUIStore((s) => s.activeTool);
  const setTool = useUIStore((s) => s.setActiveTool);
  const enterPresentation = usePresentationStore((s) => s.enter);
  const title = useActiveWorkspace()?.title ?? 'Untitled';

  return (
    <div className={styles.root}>
      {/* Row 1 — menu bar. */}
      <div className={styles.menuRow}>
        <IconButton aria-label="Back" size="sm" className={styles.back}>
          <Icon name="arrow-left" size={15} />
        </IconButton>
        <span className={styles.wordmark}>Motion&nbsp;Editor</span>
        <span className={styles.menuDivider} aria-hidden />
        <AppMenuBar />
        <div className={styles.spacer} aria-hidden />
        {/* Composition context — fills the menu row and gives it presence. */}
        <span className={styles.comp} title={title}>
          <Icon name="layers" size={12} className={styles.compIcon} />
          <span className={styles.compName}>{title}</span>
          <span className={styles.compMeta}>1920×1080 · 30fps</span>
        </span>
        <div className={styles.spacer} aria-hidden />
        <AiSparkleButton />
        <span className={styles.menuDivider} aria-hidden />
        <Button
          variant="secondary"
          size="sm"
          className={styles.action}
          leftIcon={<Icon name="eye" size={14} />}
          onClick={() => enterPresentation()}
        >
          Preview
        </Button>
        <Button
          variant="primary"
          size="sm"
          className={styles.action}
          leftIcon={<Icon name="arrow-up" size={14} />}
          onClick={() => openExportDialog(EXPORT_DURATION, EXPORT_FPS)}
        >
          Export
        </Button>
      </div>

      {/* Row 2 — tool bar. */}
      <div className={styles.toolRow} role="toolbar" aria-label="Tools">
        {TOOL_GROUPS.map((group, gi) => (
          <div key={gi} className={styles.toolGroup}>
            {gi > 0 ? <span className={styles.toolDivider} aria-hidden /> : null}
            {group.map((tool) => {
              const active = activeTool === tool.id;
              return (
                <button
                  key={tool.id}
                  type="button"
                  className={active ? styles.toolActive : styles.tool}
                  aria-label={tool.label}
                  aria-pressed={active}
                  title={`${tool.label}  (${tool.shortcut})`}
                  onClick={() => setTool(tool.id)}
                >
                  <Icon name={tool.icon} size={16} />
                </button>
              );
            })}
          </div>
        ))}

        {/* Insert / add-layer controls (moved out of the Scene panel). */}
        <div className={styles.toolGroup}>
          <span className={styles.toolDivider} aria-hidden />
          {INSERT.map((it) => (
            <button
              key={it.kind}
              type="button"
              className={styles.tool}
              aria-label={it.label}
              title={it.label}
              onClick={() => insertPrimitive(it.kind, it.name)}
            >
              <Icon name={it.icon} size={16} />
            </button>
          ))}
        </div>

        <div className={styles.spacer} aria-hidden />
        <span className={styles.toolHint}>{activeTool}</span>
      </div>
    </div>
  );
}
