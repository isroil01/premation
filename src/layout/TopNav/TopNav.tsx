/**
 * TopNav — the After Effects–style top chrome: a real menu bar (File / Edit /
 * … shown directly, no dropdown kebab) over a horizontal tool bar of the
 * motion-design tools. Replaces the old floating dropdown + left tool rail.
 */

import { useRef, useState, useEffect, type ChangeEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { getCommandSystem } from '@core/commands/CommandSystem';
import { performUndo, performRedo } from '@stores/historyStore';
import { getEventBus } from '@core/events/EventBus';
import { IconButton } from '@components/IconButton';
import { Icon, type IconName } from '@components/Icon';
import { ToolOptionsBar } from './ToolOptionsBar';
import { openCompositionSettings } from '@layout/Composition/CompositionSettingsDialog';
import { useActiveWorkspace, useProjectStore } from '@stores/projectStore';
import { useCompositionStore } from '@stores/compositionStore';
import { insertPrimitive, insertSolid, insertCamera, insertLight, insertAdjustmentLayer, insertAudio, insertParticle, insertImageSequence, insertCompInstance } from '@core/scene/sceneInsert';
import { planLottieImport, type LottieJson } from '@core/lottie/lottieImport';
import { applyImportPlan } from '@core/lottie/lottieImportApply';
import { createToolContext } from '@core/ai/toolContext';
import { getTimelineController } from '@core/timeline/TimelineController';
import { useAssetStore } from '@stores/assetStore';
import { Dropdown, type DropdownItem } from '@components/Dropdown';
import { listPresets, applyPresetByName } from '@core/animation/animationPresets';
import { timeReverseKeyframes, easyEaseAll, sequenceLayers, applyTypewriter, applyBounceInWords, applySpinFadeCharacters, applyTrackingReveal } from '@core/animation/keyframeAssistants';
import { addSliderControl } from '@core/animation/expressionControls';
import { hasTextComponent } from '@core/text/textAnimators';
import { insertNull } from '@core/scene/parenting';
import { useUIStore, type Tool } from '@stores/uiStore';
import { openCustomizeDialog } from '@layout/Settings/CustomizeDialog';
import { AppMenuButton } from '@layout/Menu';

import { useSelectionStore } from '@stores/selectionStore';
import { useSceneRevision } from '@stores/sceneStore';
import defaultSceneGraph from '@core/scene/DefaultSceneGraph';
import { isRiggableLeafNode } from '@core/scene/rigLogo';
import { is3DEnabled, set3DEnabled } from '@core/scene/threeD';
import styles from './TopNav.module.css';

interface ToolDef {
  id: Tool;
  icon: IconName;
  label: string;
  shortcut?: string;
}

const POINTER_TOOLS: ToolDef[] = [
  { id: 'select',        icon: 'mouse-pointer', label: 'Selection Tool', shortcut: 'V' },
  { id: 'direct-select', icon: 'select-all',    label: 'Direct Selection Tool', shortcut: 'A' },
  { id: 'rotate',        icon: 'rotate',        label: 'Rotation Tool', shortcut: 'W' },
  { id: 'pan-behind',    icon: 'anchor',        label: 'Pan Behind Tool', shortcut: 'Y' },
  { id: 'hand',          icon: 'hand',          label: 'Hand Tool', shortcut: 'H' },
  { id: 'zoom',          icon: 'zoom-in',       label: 'Zoom Tool', shortcut: 'Z' },
];

// Only advertise a shortcut a tool actually has (see buildToolCommands):
// pencil/curvature/polygon/star/line have no binding, so they show none.
const PEN_TOOLS: ToolDef[] = [
  { id: 'pen',      icon: 'pen',        label: 'Pen Tool', shortcut: 'G' },
  { id: 'pencil',   icon: 'pencil',     label: 'Pencil Tool' },
  { id: 'brush',    icon: 'brush',      label: 'Brush Tool (pressure ink)' },
  { id: 'curvature',icon: 'curvature',  label: 'Curvature Pen' },
];

const SHAPE_TOOLS: ToolDef[] = [
  { id: 'shape',    icon: 'square',     label: 'Rectangle Tool', shortcut: 'Q' },
  { id: 'ellipse',  icon: 'circle',     label: 'Ellipse Tool', shortcut: 'Shift+Q' },
  { id: 'polygon',  icon: 'polygon',    label: 'Polygon Tool' },
  { id: 'star',     icon: 'star',       label: 'Star Tool' },
  { id: 'line',     icon: 'line',       label: 'Line Segment' },
];

const TEXT_TOOL: ToolDef = { id: 'text', icon: 'type', label: 'Text Tool', shortcut: 'Ctrl+T' };

const MASK_TOOLS: ToolDef[] = [
  { id: 'mask-rect',    icon: 'mask-square', label: 'Rectangle Mask Tool' },
  { id: 'mask-ellipse', icon: 'mask-circle', label: 'Ellipse Mask Tool' },
];

const PUPPET_TOOL: ToolDef = { id: 'puppet-pin', icon: 'puppet-pin', label: 'Puppet Position Pin Tool', shortcut: 'Ctrl+P' };
const BONE_TOOL: ToolDef = { id: 'bone', icon: 'bone', label: 'Bone Tool', shortcut: 'Ctrl+B' };

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
    { type: 'item', id: 'anim-typewriter', label: 'Typewriter (text)', icon: 'type', disabled: !isTextLayer, onSelect: () => { if (applyTypewriter(id, playhead)) notify('Typewriter rig created'); } },
    { type: 'item', id: 'anim-bounce-in-words', label: 'Bounce In Words (text)', icon: 'type', disabled: !isTextLayer, onSelect: () => { if (applyBounceInWords(id, playhead)) notify('Bounce In Words rig created'); } },
    { type: 'item', id: 'anim-spin-fade-chars', label: 'Spin & Fade Characters (text)', icon: 'type', disabled: !isTextLayer, onSelect: () => { if (applySpinFadeCharacters(id, playhead)) notify('Spin & Fade Characters rig created'); } },
    { type: 'item', id: 'anim-tracking-reveal', label: 'Tracking Reveal (text)', icon: 'type', disabled: !isTextLayer, onSelect: () => { if (applyTrackingReveal(id, playhead)) notify('Tracking Reveal rig created'); } },
    { type: 'separator' },
    { type: 'item', id: 'anim-ease-all', label: 'Easy Ease All Keyframes', icon: 'track', onSelect: () => { if (easyEaseAll(id)) notify('Eased all keyframes'); else notify('Layer has no keyframes yet', 'warning'); } },
    { type: 'item', id: 'anim-reverse', label: 'Time-Reverse Keyframes', icon: 'skip-back', onSelect: () => { if (timeReverseKeyframes(id)) notify('Keyframes reversed'); else notify('Layer has no keyframes yet', 'warning'); } },
    { type: 'item', id: 'anim-sequence-bars', label: 'Sequence Layers (bars, end-to-end)', icon: 'layers', disabled: selectedIds.length < 2, onSelect: () => { if (getTimelineController().sequenceLayerBars(selectedIds, 0)) notify('Layers sequenced end-to-end'); else notify('Select 2+ layers with timeline bars', 'warning'); } },
    { type: 'item', id: 'anim-sequence', label: 'Stagger Animations (0.3s)', icon: 'layers', disabled: selectedIds.length < 2, onSelect: () => { if (sequenceLayers(selectedIds, 0.3)) notify('Animations staggered'); else notify('Select 2+ animated layers first', 'warning'); } },
    { type: 'separator' },
    { type: 'item', id: 'anim-slider', label: 'Add Slider Control (rig)', icon: 'settings', onSelect: () => { const name = addSliderControl(id); if (name) notify(`Added “${name}” — reference it anywhere with ctrl('${name}')`); } },
  ];
}

const isElectron = typeof window !== 'undefined' && (!!window.motionEditor || !!window.electronAPI);

export function TopNav(): JSX.Element {
  const navigate = useNavigate();
  const activeTool = useUIStore((s) => s.activeTool);
  const setTool = useUIStore((s) => s.setActiveTool);
  
  useSceneRevision((s) => s.rev);
  const selectedIds = useSelectionStore((s) => s.ids);
  const selectedId = selectedIds[0];
  // Other compositions insertable as layers (comp instances). Excludes the
  // active comp itself; the insert helper refuses deeper reference cycles.
  const projComps = useProjectStore((s) => s.comps);
  const activeCompId = useProjectStore((s) => s.tabs[s.activeTabId ?? '']?.compositionId);
  const insertableComps = Object.values(projComps).filter(
    (c) => c.id !== activeCompId && defaultSceneGraph.getNode(c.id),
  );
  const selectedNode = selectedId ? defaultSceneGraph.getNode(selectedId) : undefined;
  const isTextLayer = !!selectedNode && hasTextComponent(selectedNode);
  // Rig tools need ONE riggable leaf (shape/image/text). No selection, a
  // multi-selection, or a group/precomp can't be rigged directly — the user
  // should run "Rig Logo for Animation" (rasterize) instead.
  const canRig = selectedIds.length === 1 && isRiggableLeafNode(selectedNode);
  const rigHint = canRig ? '' : ' — select a shape or image layer (use Rig Logo for a group)';
  
  const compName = useCompositionStore((s) => s.name);
  const compWidth = useCompositionStore((s) => s.width);
  const compHeight = useCompositionStore((s) => s.height);
  const compFps = useCompositionStore((s) => s.fps);
  const wsTitle = useActiveWorkspace()?.title;
  const title = wsTitle ?? compName ?? 'Untitled';
  
  const playhead = useActiveWorkspace()?.time ?? 0;
  const snap = useUIStore((s) => s.snap);
  const toggleSnap = useUIStore((s) => s.toggleSnap);
  const canBe3D = !!selectedNode && selectedNode.components.some((c) => c.type === 'Transform');
  const is3D = canBe3D ? is3DEnabled(selectedNode) : false;
  
  const [canUndo, setCanUndo] = useState(() => getCommandSystem().getHistory().canUndo());
  const [canRedo, setCanRedo] = useState(() => getCommandSystem().getHistory().canRedo());

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
    if (!file) return;
    const asset = await addAsset(file);
    insertAudio(asset);
  };
  const seqInputRef = useRef<HTMLInputElement | null>(null);
  const onPickSequence = async (e: ChangeEvent<HTMLInputElement>): Promise<void> => {
    const files = Array.from(e.target.files ?? []);
    e.target.value = ''; // allow re-picking the same set
    if (files.length < 2) return;
    await insertImageSequence(files);
  };
  const lottieInputRef = useRef<HTMLInputElement | null>(null);
  const onPickLottie = async (e: ChangeEvent<HTMLInputElement>): Promise<void> => {
    const file = e.target.files?.[0];
    e.target.value = ''; // allow re-picking the same file
    if (!file) return;
    const toast = (message: string, level: 'success' | 'warning'): void => {
      useUIStore.getState().notify({ level, message, durationMs: 3200 });
    };
    try {
      const json = JSON.parse(await file.text()) as LottieJson;
      const plan = planLottieImport(json);
      const { nodeIds, warnings } = applyImportPlan(plan, createToolContext(new AbortController().signal));
      if (nodeIds.length === 0) {
        toast('Lottie import: no layers could be created', 'warning');
      } else {
        const n = nodeIds.length;
        const suffix = warnings.length ? ` (${warnings.length} warning${warnings.length > 1 ? 's' : ''})` : '';
        toast(`Imported ${n} layer${n > 1 ? 's' : ''}${suffix}`, warnings.length ? 'warning' : 'success');
      }
    } catch {
      toast('Lottie import failed: not valid JSON', 'warning');
    }
  };
  
  const containerRef = useRef<HTMLDivElement>(null);
  
  const [lastPointerTool, setLastPointerTool] = useState<Tool>('select');
  const [lastPenTool, setLastPenTool] = useState<Tool>('pen');
  const [lastShapeTool, setLastShapeTool] = useState<Tool>('shape');

  const isPointerActive = POINTER_TOOLS.some(t => t.id === activeTool);
  const pointerDropdownTool = POINTER_TOOLS.find(t => t.id === (isPointerActive ? activeTool : lastPointerTool)) || POINTER_TOOLS[0]!;

  const isPenActive = PEN_TOOLS.some(t => t.id === activeTool);
  const penDropdownTool = PEN_TOOLS.find(t => t.id === (isPenActive ? activeTool : lastPenTool)) || PEN_TOOLS[0]!;

  const isShapeActive = SHAPE_TOOLS.some(t => t.id === activeTool);
  const shapeDropdownTool = SHAPE_TOOLS.find(t => t.id === (isShapeActive ? activeTool : lastShapeTool)) || SHAPE_TOOLS[0]!;

  useEffect(() => {
    if (isPointerActive) setLastPointerTool(activeTool);
    if (isPenActive) setLastPenTool(activeTool);
    if (isShapeActive) setLastShapeTool(activeTool);
  }, [activeTool, isPointerActive, isPenActive, isShapeActive]);

  return (
    <div className={styles.root} ref={containerRef}>
      <div className={styles.toolRow} role="toolbar" aria-label="Tools">
        <div className={styles.inner}>
          <IconButton
            aria-label="Back to Dashboard"
            size="sm"
            className={styles.back}
            style={{ marginRight: 8, marginLeft: -4 }}
            onClick={() => navigate('/')}
          >
            <Icon name="arrow-left" size={15} />
          </IconButton>

          {!isElectron && (
            <>
              <AppMenuButton />
              <span className={styles.toolDivider} aria-hidden />
            </>
          )}

          <span className={styles.toolDivider} aria-hidden />

          {/* Pointer Tools Dropdown */}
          <div className={styles.toolGroup}>
            <Dropdown
              placement="bottom-start"
              trigger={
                <button
                  type="button"
                  className={isPointerActive ? styles.toolDropdownTriggerActive : styles.toolDropdownTrigger}
                  title={`${pointerDropdownTool.label}${pointerDropdownTool.shortcut ? ` (${pointerDropdownTool.shortcut})` : ''}`}
                >
                  <Icon name={pointerDropdownTool.icon} size={16} />
                  <Icon name="chevron-down" size={10} style={{ opacity: 0.6 }} />
                </button>
              }
              items={POINTER_TOOLS.map((t) => ({
                type: 'item',
                id: t.id,
                label: t.shortcut ? `${t.label} (${t.shortcut})` : t.label,
                icon: t.icon,
                onSelect: () => setTool(t.id),
              }))}
            />
          </div>

          <span className={styles.toolDivider} aria-hidden />

          {/* Pen Tools Dropdown */}
          <div className={styles.toolGroup}>
            <Dropdown
              placement="bottom-start"
              trigger={
                <button
                  type="button"
                  className={isPenActive ? styles.toolDropdownTriggerActive : styles.toolDropdownTrigger}
                  title={`${penDropdownTool.label}${penDropdownTool.shortcut ? ` (${penDropdownTool.shortcut})` : ''}`}
                >
                  <Icon name={penDropdownTool.icon} size={16} />
                  <Icon name="chevron-down" size={10} style={{ opacity: 0.6 }} />
                </button>
              }
              items={PEN_TOOLS.map((t) => ({
                type: 'item',
                id: t.id,
                label: t.shortcut ? `${t.label} (${t.shortcut})` : t.label,
                icon: t.icon,
                onSelect: () => setTool(t.id),
              }))}
            />
          </div>

          {/* Text Tool */}
          <div className={styles.toolGroup}>
            <button
              type="button"
              className={activeTool === TEXT_TOOL.id ? styles.toolActive : styles.tool}
              title={`${TEXT_TOOL.label} (${TEXT_TOOL.shortcut})`}
              onClick={() => setTool(TEXT_TOOL.id)}
            >
              <Icon name={TEXT_TOOL.icon} size={16} />
            </button>
          </div>

          {/* Shape Tools Dropdown */}
          <div className={styles.toolGroup}>
            <Dropdown
              placement="bottom-start"
              trigger={
                <button
                  type="button"
                  className={isShapeActive ? styles.toolDropdownTriggerActive : styles.toolDropdownTrigger}
                  title={`${shapeDropdownTool.label}${shapeDropdownTool.shortcut ? ` (${shapeDropdownTool.shortcut})` : ''}`}
                >
                  <Icon name={shapeDropdownTool.icon} size={16} />
                  <Icon name="chevron-down" size={10} style={{ opacity: 0.6 }} />
                </button>
              }
              items={SHAPE_TOOLS.map((t) => ({
                type: 'item',
                id: t.id,
                label: t.shortcut ? `${t.label} (${t.shortcut})` : t.label,
                icon: t.icon,
                onSelect: () => setTool(t.id),
              }))}
            />
          </div>

          <span className={styles.toolDivider} aria-hidden />

          {/* Mask Tools */}
          <div className={styles.toolGroup}>
            {MASK_TOOLS.map((tool) => {
              const active = activeTool === tool.id;
              return (
                <button
                  key={tool.id}
                  type="button"
                  className={active ? styles.toolActive : styles.tool}
                  title={tool.shortcut ? `${tool.label} (${tool.shortcut})` : tool.label}
                  onClick={() => setTool(tool.id)}
                >
                  <Icon name={tool.icon} size={16} />
                </button>
              );
            })}
          </div>

          {/* Puppet Pin & Bone Tools */}
          <div className={styles.toolGroup}>
            <button
              type="button"
              className={activeTool === PUPPET_TOOL.id ? styles.toolActive : styles.tool}
              title={`${PUPPET_TOOL.label} (${PUPPET_TOOL.shortcut})${rigHint}`}
              disabled={!canRig}
              onClick={() => setTool(PUPPET_TOOL.id)}
            >
              <Icon name={PUPPET_TOOL.icon} size={16} />
            </button>
            <button
              type="button"
              className={activeTool === BONE_TOOL.id ? styles.toolActive : styles.tool}
              title={`${BONE_TOOL.label} (${BONE_TOOL.shortcut})${rigHint}`}
              disabled={!canRig}
              onClick={() => setTool(BONE_TOOL.id)}
            >
              <Icon name={BONE_TOOL.icon} size={16} />
            </button>
          </div>

          {/* New layer */}
          <div className={styles.toolGroup}>
            <span className={styles.toolDivider} aria-hidden />
            <Dropdown
              placement="bottom-start"
              trigger={
                <button type="button" className={styles.toolDropdownTrigger} aria-label="New layer" title="New layer…">
                  <Icon name="plus" size={16} />
                  <Icon name="chevron-down" size={10} style={{ opacity: 0.6 }} />
                </button>
              }
              items={[
                { type: 'item', id: 'new-shape', label: 'Shape Layer', icon: 'shape', onSelect: () => insertPrimitive('shape', 'Shape') },
                { type: 'item', id: 'new-text', label: 'Text Layer', icon: 'type', onSelect: () => insertPrimitive('text', 'Text') },
                { type: 'item', id: 'new-solid', label: 'Solid…', icon: 'panel-bottom', onSelect: () => insertSolid() },
                { type: 'separator' },
                { type: 'item', id: 'new-group', label: 'Group', icon: 'layers', onSelect: () => insertPrimitive('group', 'Group') },
                { type: 'item', id: 'new-null', label: 'Null Object', icon: 'crosshair', onSelect: () => insertNull() },
                { type: 'item', id: 'new-adjustment', label: 'Adjustment Layer', icon: 'adjustment', onSelect: () => insertAdjustmentLayer() },
                ...(insertableComps.length > 0
                  ? ([{
                      type: 'item' as const,
                      id: 'new-comp-instance',
                      label: 'Composition',
                      icon: 'component' as const,
                      submenu: insertableComps.map((c) => ({
                        type: 'item' as const,
                        id: `new-ci-${c.id}`,
                        label: c.name,
                        icon: 'component' as const,
                        onSelect: () => insertCompInstance(c.id),
                      })),
                    }] satisfies DropdownItem[])
                  : []),
                { type: 'separator' },
                { type: 'item', id: 'new-camera', label: 'Camera', icon: 'camera', onSelect: () => insertCamera() },
                { type: 'item', id: 'new-light', label: 'Light', icon: 'light', onSelect: () => insertLight() },
                { type: 'item', id: 'new-particle', label: 'Particle System', icon: 'sparkles', onSelect: () => insertParticle() },
                { type: 'separator' },
                { type: 'item', id: 'new-audio', label: 'Audio…', icon: 'audio', onSelect: () => audioInputRef.current?.click() },
                { type: 'item', id: 'new-image-sequence', label: 'Image Sequence…', icon: 'image', onSelect: () => seqInputRef.current?.click() },
                { type: 'item', id: 'import-lottie', label: 'Lottie / Bodymovin JSON…', icon: 'image', onSelect: () => lottieInputRef.current?.click() },
              ]}
            />
            <input ref={audioInputRef} type="file" accept="audio/*" style={{ display: 'none' }} onChange={onPickAudio} />
            <input ref={seqInputRef} type="file" accept="image/*" multiple style={{ display: 'none' }} onChange={onPickSequence} />
            <input ref={lottieInputRef} type="file" accept=".json,application/json" style={{ display: 'none' }} onChange={onPickLottie} />
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

          {/* Animate */}
          <div className={styles.toolGroup}>
            <span className={styles.toolDivider} aria-hidden />
            <Dropdown
              placement="bottom-start"
              trigger={
                <button
                  type="button"
                  className={styles.toolDropdownTrigger}
                  aria-label="Animate"
                  title={selectedId ? 'Animate the selected layer…' : 'Select a layer to animate'}
                  disabled={!selectedId}
                >
                  <Icon name="keyframe" size={16} />
                  <Icon name="chevron-down" size={10} style={{ opacity: 0.6 }} />
                </button>
              }
              items={buildAnimateItems(selectedIds, isTextLayer, playhead)}
            />
          </div>

          {/* Snap */}
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

          {/* Composition context */}
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

          {/* Zoom + view options moved to the composition's own header bar
              (ViewportHeader), which sits directly above the canvas they act
              on — the viewport controls now have a single home. */}

          {/* Undo / Redo */}
          <div className={styles.toolGroup}>
            <button
              type="button"
              className={styles.tool}
              aria-label="Undo"
              title="Undo  (Ctrl+Z)"
              disabled={!canUndo}
              onClick={() => performUndo()}
            >
              <Icon name="undo" size={16} />
            </button>
            <button
              type="button"
              className={styles.tool}
              aria-label="Redo"
              title="Redo  (Ctrl+Shift+Z)"
              disabled={!canRedo}
              onClick={() => performRedo()}
            >
              <Icon name="redo" size={16} />
            </button>
          </div>

          {/* Customize / Settings */}
          <div className={styles.toolGroup}>
            <button
              type="button"
              className={styles.tool}
              aria-label="Customize"
              title="Customize (Shortcuts, Workspaces, Appearance)"
              onClick={() => openCustomizeDialog()}
            >
              <Icon name="settings" size={16} />
            </button>
          </div>

          <span className={styles.toolHint}>{activeTool}</span>
        </div>
      </div>
      <ToolOptionsBar />
    </div>
  );
}
