/**
 * TopNav — the After Effects–style top chrome: a real menu bar (File / Edit /
 * … shown directly, no dropdown kebab) over a horizontal tool bar of the
 * motion-design tools. Replaces the old floating dropdown + left tool rail.
 *
 *   ┌───────────────────────────────────────────────────────────┐
 *   │ ← │ File Edit Composition Layer Effect … ·····  ✦ AI       │  menu row
 *   ├───────────────────────────────────────────────────────────┤
 *   │ ▸ ✥ ✎ T ▣ ○ │ ⬚ mask │ + layer │ 3D │ Animate │ align      │  tool row
 *   └───────────────────────────────────────────────────────────┘
 */

import { useRef, useState, useEffect, type ChangeEvent } from 'react';
import { getCommandSystem } from '@core/commands/CommandSystem';
import { getEventBus } from '@core/events/EventBus';
import { IconButton } from '@components/IconButton';
import { Icon, type IconName } from '@components/Icon';
import { AppMenuBar } from '@layout/Menu';
import { openExportDialog } from '@layout/Export/ExportDialog';
import { openCompositionSettings } from '@layout/Composition/CompositionSettingsDialog';
import { usePresentationStore } from '@stores/presentationStore';
import { useActiveWorkspace } from '@stores/projectStore';
import { useCompositionStore } from '@stores/compositionStore';
import { insertPrimitive, insertSolid, insertCamera, insertLight, insertAdjustmentLayer, insertAudio } from '@core/scene/sceneInsert';
import { useAssetStore } from '@stores/assetStore';
import { Dropdown, type DropdownItem } from '@components/Dropdown';
import { listPresets, applyPresetByName } from '@core/animation/animationPresets';
import { timeReverseKeyframes, easyEaseAll, sequenceLayers, applyTypewriter, applyBounceInWords, applySpinFadeCharacters, applyTrackingReveal } from '@core/animation/keyframeAssistants';
import { addSliderControl } from '@core/animation/expressionControls';
import { hasTextComponent } from '@core/text/textAnimators';
import { insertNull } from '@core/scene/parenting';
import { useUIStore, type Tool } from '@stores/uiStore';
import { useLayoutStore } from '@stores/layoutStore';

import { useSelectionStore } from '@stores/selectionStore';
import { useSceneRevision } from '@stores/sceneStore';
import defaultSceneGraph from '@core/scene/DefaultSceneGraph';
import { is3DEnabled, set3DEnabled } from '@core/scene/threeD';
import { useContainerSize } from '@hooks/useContainerSize';
import styles from './TopNav.module.css';

interface ToolDef {
  id: Tool;
  icon: IconName;
  label: string;
  /** Advertised only when a real keyboard binding exists (see buildToolCommands). */
  shortcut?: string;
}

/** Tool groups, separated by hairlines (AE tool-bar grouping). Every tool maps
 *  to a real engine tool (see TOOL_MAP); tooltips advertise a shortcut only when
 *  one is actually registered. AE-exact key assignments:
 *  V=Select, A=DirectSelect, W=Rotate, Y=PanBehind, H=Hand, Z=Zoom.
 *  The Select tool handles on-canvas drag (move), resize, and rotate via its handles. */
const TOOL_GROUPS: ToolDef[][] = [
  [
    { id: 'select',        icon: 'mouse-pointer', label: 'Selection Tool (move, scale, rotate via handles)',    shortcut: 'V' },
    { id: 'direct-select', icon: 'select-all',    label: 'Direct Selection Tool (path points)',                shortcut: 'A' },
    { id: 'rotate',        icon: 'rotate',        label: 'Rotation Tool (constrained rotate)',                 shortcut: 'W' },
    { id: 'pan-behind',    icon: 'anchor',        label: 'Pan Behind / Anchor Point Tool (reposition pivot)', shortcut: 'Y' },
    { id: 'hand',          icon: 'drag',          label: 'Hand Tool (pan the view)',                          shortcut: 'H' },
    { id: 'zoom',          icon: 'zoom-in',       label: 'Zoom Tool (click / Alt-click)',                     shortcut: 'Z' },
  ],
  [
    { id: 'pen',      icon: 'pen',        label: 'Pen Tool (draw bezier paths)', shortcut: 'G' },
    { id: 'pencil',   icon: 'pencil',     label: 'Pencil Tool (freehand draw)',  shortcut: 'Shift+P' },
    { id: 'curvature',icon: 'curvature',  label: 'Curvature Pen',               shortcut: 'Alt+P' },
    { id: 'text',     icon: 'type',       label: 'Text Tool (click canvas to create)', shortcut: 'Ctrl+T' },
    { id: 'line',     icon: 'line',       label: 'Line Segment',                shortcut: 'L' },
    { id: 'shape',    icon: 'square',     label: 'Rectangle Tool (drag to draw)',shortcut: 'Q' },
    { id: 'ellipse',  icon: 'circle',     label: 'Ellipse Tool (drag to draw)', shortcut: 'Shift+Q' },
    { id: 'polygon',  icon: 'polygon',    label: 'Polygon Tool (drag to draw)' },
    { id: 'star',     icon: 'star',       label: 'Star Tool (drag to draw)' },
  ],
  [
    { id: 'mask-rect',    icon: 'mask-square', label: 'Rectangle Mask Tool (drag to draw)' },
    { id: 'mask-ellipse', icon: 'mask-circle', label: 'Ellipse Mask Tool (drag to draw)' },
  ]
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
    {
      type: 'item',
      id: 'anim-bounce-in-words',
      label: 'Bounce In Words (text)',
      icon: 'type',
      disabled: !isTextLayer,
      onSelect: () => {
        if (applyBounceInWords(id, playhead)) notify('Bounce In Words rig created');
      },
    },
    {
      type: 'item',
      id: 'anim-spin-fade-chars',
      label: 'Spin & Fade Characters (text)',
      icon: 'type',
      disabled: !isTextLayer,
      onSelect: () => {
        if (applySpinFadeCharacters(id, playhead)) notify('Spin & Fade Characters rig created');
      },
    },
    {
      type: 'item',
      id: 'anim-tracking-reveal',
      label: 'Tracking Reveal (text)',
      icon: 'type',
      disabled: !isTextLayer,
      onSelect: () => {
        if (applyTrackingReveal(id, playhead)) notify('Tracking Reveal rig created');
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
  const canBe3D = !!selectedNode && selectedNode.components.some((c) => c.type === 'Transform');
  const is3D = canBe3D ? is3DEnabled(selectedNode) : false;
  const enterPresentation = usePresentationStore((s) => s.enter);
  const [canUndo, setCanUndo] = useState(() => getCommandSystem().getHistory().canUndo());
  const [canRedo, setCanRedo] = useState(() => getCommandSystem().getHistory().canRedo());
  const leftCollapsed = useLayoutStore((s) => s.regions.leftSidebar?.collapsed);
  const bottomCollapsed = useLayoutStore((s) => s.regions.bottomTimeline?.collapsed);
  const rightCollapsed = useLayoutStore((s) => s.regions.rightInspector?.collapsed);

  useEffect(() => {
    const handleChanged = () => {
      setCanUndo(getCommandSystem().getHistory().canUndo());
      setCanRedo(getCommandSystem().getHistory().canRedo());
    };
    const sub = getEventBus().on('UndoStackChanged', handleChanged);
    return () => sub.dispose();
  }, []);
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

  const containerRef = useRef<HTMLDivElement>(null);
  const { width: containerWidth } = useContainerSize(containerRef);

  return (
    <div className={styles.root} ref={containerRef}>
      {/* Row 1 — menu bar. */}
      <div className={styles.menuRow}>
        <IconButton aria-label="Back" size="sm" className={styles.back} onClick={() => window.history.back()}>
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

        {containerWidth >= 600 && (
          <>
            <span className={styles.menuDivider} aria-hidden />
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
          </>
        )}

        {containerWidth >= 800 ? (
          <>
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
              <Icon name="download" size={14} />
            </IconButton>
          </>
        ) : (
          <>
            <span className={styles.menuDivider} aria-hidden />
            <Dropdown
              placement="bottom-end"
              trigger={
                <IconButton aria-label="More actions" size="sm" className={styles.layoutToggle}>
                  <Icon name="more-horizontal" size={14} />
                </IconButton>
              }
              items={[
                ...(containerWidth < 600 ? [
                  { type: 'item' as const, id: 'toggle-left', label: 'Toggle Left Sidebar', icon: 'panel-left' as const, onSelect: () => useLayoutStore.getState().toggleRegion('leftSidebar') },
                  { type: 'item' as const, id: 'toggle-bottom', label: 'Toggle Bottom Timeline', icon: 'panel-bottom' as const, onSelect: () => useLayoutStore.getState().toggleRegion('bottomTimeline') },
                  { type: 'item' as const, id: 'toggle-right', label: 'Toggle Right Inspector', icon: 'panel-right' as const, onSelect: () => useLayoutStore.getState().toggleRegion('rightInspector') },
                  { type: 'separator' as const },
                ] : []),
                { type: 'item' as const, id: 'preview', label: 'Preview', icon: 'eye' as const, onSelect: () => enterPresentation() },
                { type: 'item' as const, id: 'export', label: 'Export', icon: 'download' as const, onSelect: () => openExportDialog(compDuration, compFps) },
              ]}
            />
          </>
        )}
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
                  title={tool.shortcut ? `${tool.label}  (${tool.shortcut})` : tool.label}
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
            onClick={() => canUndo && getCommandSystem().getHistory().undo()}
          >
            <Icon name="undo" size={16} />
          </button>
          <button
            type="button"
            className={styles.tool}
            aria-label="Redo"
            title="Redo  (Ctrl+Shift+Z)"
            disabled={!canRedo}
            onClick={() => canRedo && getCommandSystem().getHistory().redo()}
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
              { type: 'item', id: 'new-solid', label: 'Solid…', icon: 'panel-bottom', onSelect: () => insertSolid() },
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

        {/* ── Snap ─────────────────────────────────── */}
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
        </div>

        <div className={styles.spacer} aria-hidden />
        <span className={styles.toolHint}>{activeTool}</span>
      </div>
    </div>
  );
}
