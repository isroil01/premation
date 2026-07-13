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

import { useRef, type ChangeEvent } from 'react';
import { IconButton } from '@components/IconButton';
import { Button } from '@components/Button';
import { Icon, type IconName } from '@components/Icon';
import { AppMenuBar } from '@layout/Menu';
import { AiSparkleButton } from '@layout/TopToolbar/AiSparkleButton';
import { openExportDialog } from '@layout/Export/ExportDialog';
import { openCompositionSettings } from '@layout/Composition/CompositionSettingsDialog';
import { usePresentationStore } from '@stores/presentationStore';
import { useActiveWorkspace } from '@stores/projectStore';
import { useCompositionStore } from '@stores/compositionStore';
import { insertPrimitive, insertSolid, insertCamera, insertLight, insertAdjustmentLayer, insertAudio } from '@core/scene/sceneInsert';
import { useAssetStore } from '@stores/assetStore';
import { useHistoryStore } from '@stores/historyStore';
import { Dropdown, type DropdownItem } from '@components/Dropdown';
import { listPresets, applyPresetByName } from '@core/animation/animationPresets';
import { timeReverseKeyframes, easyEaseAll, sequenceLayers, applyTypewriter } from '@core/animation/keyframeAssistants';
import { addSliderControl } from '@core/animation/expressionControls';
import { hasTextComponent } from '@core/text/textAnimators';
import { insertNull } from '@core/scene/parenting';
import { useUIStore, type Tool } from '@stores/uiStore';
import { useGuidesStore } from '@stores/guidesStore';
import { alignNodes, type AlignMode } from '@core/scene/alignNodes';
import { useSelectionStore } from '@stores/selectionStore';
import { useSceneRevision } from '@stores/sceneStore';
import defaultSceneGraph from '@core/scene/DefaultSceneGraph';
import { is3DEnabled, set3DEnabled } from '@core/scene/threeD';
import styles from './TopNav.module.css';

interface ToolDef {
  id: Tool;
  icon: IconName;
  label: string;
  shortcut: string;
}

/** Tool groups, separated by hairlines (AE tool-bar grouping). Every tool has
 *  a DISTINCT icon and maps to a real engine tool (see TOOL_MAP). */
const TOOL_GROUPS: ToolDef[][] = [
  [
    { id: 'select', icon: 'mouse-pointer', label: 'Select', shortcut: 'V' },
    { id: 'direct-select', icon: 'select-all', label: 'Direct Selection (path points)', shortcut: 'A' },
    { id: 'hand', icon: 'drag', label: 'Hand (pan the view)', shortcut: 'H' },
    { id: 'zoom', icon: 'zoom-in', label: 'Zoom (click / Alt-click)', shortcut: 'Z' },
  ],
  [
    { id: 'move', icon: 'move', label: 'Move', shortcut: 'W' },
    { id: 'rotate', icon: 'rotate-cw', label: 'Rotate', shortcut: 'R' },
    { id: 'scale', icon: 'maximize', label: 'Scale', shortcut: 'S' },
  ],
  [
    { id: 'pen', icon: 'pen', label: 'Pen (draw bezier paths)', shortcut: 'P' },
    { id: 'text', icon: 'type', label: 'Text (click canvas to create)', shortcut: 'T' },
    { id: 'shape', icon: 'square', label: 'Rectangle (drag to draw)', shortcut: 'U' },
    { id: 'ellipse', icon: 'circle', label: 'Ellipse (drag to draw)', shortcut: 'E' },
  ],
];

const ALIGN_ACTIONS: { id: AlignMode; icon: IconName; label: string }[] = [
  { id: 'left',          icon: 'align-left',           label: 'Align Left' },
  { id: 'center-h',     icon: 'align-center',          label: 'Align Centers (H)' },
  { id: 'right',        icon: 'align-right',           label: 'Align Right' },
  { id: 'top',          icon: 'align-top',             label: 'Align Top' },
  { id: 'middle-v',     icon: 'align-middle',          label: 'Align Middles (V)' },
  { id: 'bottom',       icon: 'align-bottom',          label: 'Align Bottom' },
  { id: 'distribute-h', icon: 'distribute-horizontal', label: 'Distribute Horizontally' },
  { id: 'distribute-v', icon: 'distribute-vertical',   label: 'Distribute Vertically' },
];

/**
 * The Animate menu — AE-style one-click animation actions, keyframe
 * assistants, and rig-building controls. Everything applies through the
 * command path, so every action is a single undoable step.
 */
function buildAnimateItems(
  selectedIds: readonly string[],
  isTextLayer: boolean,
  playhead: number,
): DropdownItem[] {
  const id = selectedIds[0];
  if (!id) return [];
  const notify = (message: string, level: 'success' | 'warning' = 'success'): void => {
    useUIStore.getState().notify({ level, message, durationMs: 2600 });
  };

  const presetItems: DropdownItem[] = listPresets().map((p) => ({
    type: 'item',
    id: `anim-${p.name}`,
    label: p.name,
    icon: 'play' as const,
    onSelect: () => {
      applyPresetByName(id, p.name, playhead);
      notify(`Applied “${p.name}”`);
    },
  }));

  return [
    ...presetItems,
    { type: 'separator' },
    {
      type: 'item',
      id: 'anim-typewriter',
      label: 'Typewriter (text)',
      icon: 'type',
      disabled: !isTextLayer,
      onSelect: () => {
        if (applyTypewriter(id, playhead)) notify('Typewriter rig created');
      },
    },
    { type: 'separator' },
    {
      type: 'item',
      id: 'anim-ease-all',
      label: 'Easy Ease All Keyframes',
      icon: 'track',
      onSelect: () => {
        if (easyEaseAll(id)) notify('Eased all keyframes');
        else notify('Layer has no keyframes yet', 'warning');
      },
    },
    {
      type: 'item',
      id: 'anim-reverse',
      label: 'Time-Reverse Keyframes',
      icon: 'skip-back',
      onSelect: () => {
        if (timeReverseKeyframes(id)) notify('Keyframes reversed');
        else notify('Layer has no keyframes yet', 'warning');
      },
    },
    {
      type: 'item',
      id: 'anim-sequence',
      label: 'Sequence Layers (stagger 0.3s)',
      icon: 'layers',
      disabled: selectedIds.length < 2,
      onSelect: () => {
        if (sequenceLayers(selectedIds, 0.3)) notify('Layers sequenced');
        else notify('Select 2+ animated layers first', 'warning');
      },
    },
    { type: 'separator' },
    {
      type: 'item',
      id: 'anim-slider',
      label: 'Add Slider Control (rig)',
      icon: 'settings',
      onSelect: () => {
        const name = addSliderControl(id);
        if (name) notify(`Added “${name}” — reference it anywhere with ctrl('${name}')`);
      },
    },
  ];
}

export function TopNav(): JSX.Element {
  const activeTool = useUIStore((s) => s.activeTool);
  const setTool = useUIStore((s) => s.setActiveTool);
  // Selected layer's 3D state, for the top-bar 3D toggle.
  useSceneRevision((s) => s.rev);
  const selectedIds = useSelectionStore((s) => s.ids);
  const selectedId = selectedIds[0];
  const selectedNode = selectedId ? defaultSceneGraph.getNode(selectedId) : undefined;
  const isTextLayer = !!selectedNode && hasTextComponent(selectedNode);
  const playhead = useActiveWorkspace()?.time ?? 0;
  const snap = useUIStore((s) => s.snap);
  const toggleSnap = useUIStore((s) => s.toggleSnap);
  const showGrid = useGuidesStore((s) => s.grid);
  const toggleGrid = useGuidesStore((s) => s.toggleGrid);
  const showRulers = useGuidesStore((s) => s.rulers);
  const toggleRulers = useGuidesStore((s) => s.toggleRulers);
  const canBe3D = !!selectedNode && selectedNode.components.some((c) => c.type === 'Transform');
  const is3D = canBe3D ? is3DEnabled(selectedNode) : false;
  const enterPresentation = usePresentationStore((s) => s.enter);
  const history = useHistoryStore();
  const canUndo = history.index > 0;
  const canRedo = history.index < history.entries.length - 1;
  const addAsset = useAssetStore((s) => s.addAsset);
  const audioInputRef = useRef<HTMLInputElement | null>(null);
  const onPickAudio = async (e: ChangeEvent<HTMLInputElement>): Promise<void> => {
    const file = e.target.files?.[0];
    e.target.value = ''; // allow re-picking the same file
    if (!file) return;
    const asset = await addAsset(file);
    insertAudio(asset);
  };
  const wsTitle = useActiveWorkspace()?.title;
  const compName = useCompositionStore((s) => s.name);
  const compWidth = useCompositionStore((s) => s.width);
  const compHeight = useCompositionStore((s) => s.height);
  const compFps = useCompositionStore((s) => s.fps);
  const compDuration = useCompositionStore((s) => s.durationSeconds);
  const title = wsTitle ?? compName ?? 'Untitled';

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
        {/* Composition context — click to open Composition Settings. */}
        <button
          type="button"
          className={styles.comp}
          title="Composition settings"
          onClick={() => openCompositionSettings()}
        >
          <Icon name="layers" size={12} className={styles.compIcon} />
          <span className={styles.compName}>{title}</span>
          <span className={styles.compMeta}>{compWidth}×{compHeight} · {compFps}fps</span>
        </button>
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
          onClick={() => openExportDialog(compDuration, compFps)}
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

        {/* Undo / Redo — always visible, AE-style. */}
        <div className={styles.toolGroup}>
          <span className={styles.toolDivider} aria-hidden />
          <button
            type="button"
            className={styles.tool}
            aria-label="Undo"
            title="Undo  (Ctrl+Z)"
            disabled={!canUndo}
            onClick={() => canUndo && history.jumpTo(history.index - 1)}
          >
            <Icon name="undo" size={16} />
          </button>
          <button
            type="button"
            className={styles.tool}
            aria-label="Redo"
            title="Redo  (Ctrl+Shift+Z)"
            disabled={!canRedo}
            onClick={() => canRedo && history.jumpTo(history.index + 1)}
          >
            <Icon name="redo" size={16} />
          </button>
        </div>

        {/* New layer — ONE consolidated dropdown (AE "Layer ▸ New"), replacing
            the old row of nine same-icon insert buttons. */}
        <div className={styles.toolGroup}>
          <span className={styles.toolDivider} aria-hidden />
          <Dropdown
            placement="bottom-start"
            trigger={
              <button type="button" className={styles.tool} aria-label="New layer" title="New layer…">
                <Icon name="plus" size={16} />
                <Icon name="chevron-down" size={10} />
              </button>
            }
            items={[
              { type: 'item', id: 'new-shape', label: 'Shape Layer', icon: 'shape', onSelect: () => insertPrimitive('shape', 'Shape') },
              { type: 'item', id: 'new-text', label: 'Text Layer', icon: 'type', onSelect: () => insertPrimitive('text', 'Text') },
              { type: 'item', id: 'new-solid', label: 'Solid…', icon: 'square', onSelect: () => insertSolid() },
              { type: 'separator' },
              { type: 'item', id: 'new-group', label: 'Group', icon: 'folder', onSelect: () => insertPrimitive('group', 'Group') },
              { type: 'item', id: 'new-null', label: 'Null Object', icon: 'crosshair', onSelect: () => insertNull() },
              { type: 'item', id: 'new-adjustment', label: 'Adjustment Layer', icon: 'adjustment', onSelect: () => insertAdjustmentLayer() },
              { type: 'separator' },
              { type: 'item', id: 'new-camera', label: 'Camera', icon: 'camera', onSelect: () => insertCamera() },
              { type: 'item', id: 'new-light', label: 'Light', icon: 'light', onSelect: () => insertLight() },
              { type: 'separator' },
              { type: 'item', id: 'new-audio', label: 'Audio…', icon: 'audio', onSelect: () => audioInputRef.current?.click() },
            ]}
          />
          <input
            ref={audioInputRef}
            type="file"
            accept="audio/*"
            style={{ display: 'none' }}
            onChange={onPickAudio}
          />
          <button
            type="button"
            className={styles.tool}
            data-active={is3D || undefined}
            aria-label="Toggle 3D layer"
            aria-pressed={is3D}
            title={canBe3D ? (is3D ? 'Disable 3D on the selected layer' : 'Enable 3D on the selected layer') : 'Select a layer to enable 3D'}
            disabled={!canBe3D}
            onClick={() => selectedId && set3DEnabled(selectedId, !is3D)}
          >
            <Icon name="3d" size={16} />
          </button>
        </div>

        {/* Animate — one-click animations, keyframe assistants, rig controls. */}
        <div className={styles.toolGroup}>
          <span className={styles.toolDivider} aria-hidden />
          <Dropdown
            placement="bottom-start"
            trigger={
              <button
                type="button"
                className={styles.tool}
                aria-label="Animate"
                title={selectedId ? 'Animate the selected layer…' : 'Select a layer to animate'}
                disabled={!selectedId}
              >
                <Icon name="keyframe" size={16} />
                <Icon name="chevron-down" size={10} />
              </button>
            }
            items={buildAnimateItems(selectedIds, isTextLayer, playhead)}
          />
        </div>

        {/* ── Alignment tools ─────────────────────────────────────── */}
        <div className={styles.toolGroup}>
          <span className={styles.toolDivider} aria-hidden />
          {ALIGN_ACTIONS.map((a) => (
            <button
              key={a.id}
              type="button"
              className={styles.tool}
              aria-label={a.label}
              title={`${a.label}${selectedIds.length < 2 && !a.id.startsWith('distribute') ? ' (select 2+ layers)' : ''}`}
              disabled={selectedIds.length < 2}
              onClick={() => alignNodes([...selectedIds], a.id)}
            >
              <Icon name={a.icon} size={14} />
            </button>
          ))}
        </div>

        {/* ── Snap / Grid / Rulers ─────────────────────────────────── */}
        <div className={styles.toolGroup}>
          <span className={styles.toolDivider} aria-hidden />
          <button
            type="button"
            className={snap ? styles.toolActive : styles.tool}
            aria-label="Toggle snapping"
            aria-pressed={snap}
            title={snap ? 'Snapping ON — click to disable' : 'Snapping OFF — click to enable'}
            onClick={toggleSnap}
          >
            <Icon name="magnet" size={16} />
          </button>
          <button
            type="button"
            className={showGrid ? styles.toolActive : styles.tool}
            aria-label="Toggle grid"
            aria-pressed={showGrid}
            title={showGrid ? 'Hide grid' : 'Show grid'}
            onClick={toggleGrid}
          >
            <Icon name="grid" size={16} />
          </button>
          <button
            type="button"
            className={showRulers ? styles.toolActive : styles.tool}
            aria-label="Toggle rulers"
            aria-pressed={showRulers}
            title={showRulers ? 'Hide rulers' : 'Show rulers'}
            onClick={toggleRulers}
          >
            <Icon name="ruler" size={16} />
          </button>
        </div>

        <div className={styles.spacer} aria-hidden />
        <span className={styles.toolHint}>{activeTool}</span>
      </div>
    </div>
  );
}
