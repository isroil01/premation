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
import { useActiveWorkspace, useProjectStore } from '@stores/projectStore';
import { insertPrimitive, insertSolid, insertAdjustmentLayer, insertAudio, insertParticle, insertImageSequence, insertCompInstance, insert3DPrimitive, insert3DText } from '@core/scene/sceneInsert';
import { openCameraDialog, openLightDialog } from '@layout/Workspace/SceneInsertDialogs';
import { useGuidesStore } from '@stores/guidesStore';
import { importLottieFile } from '@core/library/lottieLibrary';
import { reportLottieImport, reportLottieImportFailure } from '@core/lottie/lottieImportReport';
import { getTimelineController } from '@core/timeline/TimelineController';
import { useAssetStore } from '@stores/assetStore';
import { Dropdown, type DropdownItem } from '@components/Dropdown';
import { listPresets, applyPresetByName } from '@core/animation/animationPresets';
import { timeReverseKeyframes, easyEaseAll, sequenceLayers, applyTypewriter, applyBounceInWords, applySpinFadeCharacters, applyTrackingReveal } from '@core/animation/keyframeAssistants';
import { addControl, CONTROL_COMPONENTS, type ControlKind } from '@core/animation/expressionControls';

/** The control kinds offered in the rig menu, in the order AE lists them. */
const CONTROL_KINDS: ReadonlyArray<{ kind: ControlKind; label: string }> = [
  { kind: 'slider', label: 'Slider Control' },
  { kind: 'angle', label: 'Angle Control' },
  { kind: 'point', label: 'Point Control' },
  { kind: 'color', label: 'Color Control' },
  { kind: 'checkbox', label: 'Checkbox Control' },
  { kind: 'dropdown', label: 'Dropdown Control' },
  { kind: 'layer', label: 'Layer Control' },
];
import { hasTextComponent } from '@core/text/textAnimators';
import { insertNull } from '@core/scene/parenting';
import { useUIStore, type Tool } from '@stores/uiStore';
import { openCustomizeDialog } from '@layout/Settings/CustomizeDialog';
import { customPrompt } from '@components/Modal/Dialogs';
import { AppMenuButton } from '@layout/Menu';
import { SceneControls } from '@layout/SceneControls/SceneControls';

import { useSelectionStore } from '@stores/selectionStore';
import { useSceneRevision } from '@stores/sceneStore';
import defaultSceneGraph from '@core/scene/DefaultSceneGraph';
import { isRiggableLeafNode } from '@core/scene/rigLogo';
import { getWorkspaceManager } from '@core/layout/workspaceManager';
import { useLayoutStore } from '@stores/layoutStore';
import styles from './TopNav.module.css';
import { usePreferenceStore } from '@stores/preferenceStore';

interface ToolDef {
  id: Tool;
  icon: IconName;
  label: string;
  shortcut?: string;
}

const POINTER_TOOLS: ToolDef[] = [
  { id: 'select',        icon: 'mouse-pointer', label: 'Selection Tool', shortcut: 'V' },
  // Shift+V, not A: the AE preset rebinds tool.direct-select (shortcutOverrides),
  // and bare `a` falls through to the anchor-point property reveal.
  { id: 'direct-select', icon: 'select-all',    label: 'Direct Selection Tool', shortcut: 'Shift+V' },
  { id: 'rotate',        icon: 'rotate',        label: 'Rotation Tool', shortcut: 'W' },
  { id: 'pan-behind',    icon: 'anchor',        label: 'Pan Behind Tool', shortcut: 'Y' },
  { id: 'hand',          icon: 'hand',          label: 'Hand Tool', shortcut: 'H' },
  { id: 'zoom',          icon: 'zoom-in',       label: 'Zoom Tool', shortcut: 'Z' },
];

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
    {
      type: 'item',
      id: 'anim-control',
      label: 'Add Expression Control (rig)',
      icon: 'settings',
      // A submenu rather than seven flat entries: every kind resolves through
      // the same `ctrl(name)` accessor, so they belong together as one action
      // with a type, not as seven unrelated commands.
      submenu: CONTROL_KINDS.map((k) => ({
        type: 'item' as const,
        id: `anim-control-${k.kind}`,
        label: k.label,
        onSelect: () => {
          const name = addControl(id, k.kind);
          if (!name) return;
          // Multi-component kinds expose several names, so tell the user what
          // to actually type — `ctrl('Point 1')` alone would resolve to 0.
          const parts = CONTROL_COMPONENTS[k.kind];
          const refs = parts.map((suffix) => `ctrl('${name}${suffix}')`).join(' / ');
          notify(`Added “${name}” — reference it with ${refs}`);
        },
      })),
    },
  ];
}

/** Glyphs for the built-in layout presets, keyed by their registry id. */
const WORKSPACE_ICONS: Record<string, IconName> = {
  default: 'layout',
  'motion-design': 'motion-blur',
  'ai-focus': 'ai',
  animation: 'keyframe',
  'color-grading': 'brush',
  'dual-monitor-studio': 'tv',
  presentation: 'play',
  minimal: 'fit',
};

/**
 * The Workspaces menu, built from the WORKSPACE REGISTRY rather than a hardcoded
 * list.
 *
 * "Save Current Workspace…" persisted a layout that no UI could ever offer back:
 * the menu listed only the eight builtins, and `listWorkspaces` had no caller
 * outside the manager itself. Reading the registry makes saved layouts appear
 * (and deletable), which is the difference between the command doing something
 * and quietly writing to a store nobody reads.
 */
function buildWorkspaceItems(): DropdownItem[] {
  const manager = getWorkspaceManager();
  const all = manager.listWorkspaces();
  const builtins = all.filter((w) => w.builtin);
  const custom = all.filter((w) => !w.builtin);

  const items: DropdownItem[] = builtins.map((w) => ({
    type: 'item',
    id: `ws-${w.id}`,
    label: w.name,
    icon: WORKSPACE_ICONS[w.id] ?? 'layout',
    onSelect: () => manager.applyWorkspace(w.id),
  }));

  if (custom.length > 0) {
    items.push({ type: 'separator' });
    for (const w of custom) {
      items.push({
        type: 'item',
        id: `ws-${w.id}`,
        label: w.name,
        icon: 'layout',
        submenu: [
          { type: 'item', id: `ws-apply-${w.id}`, label: 'Apply', icon: 'check', onSelect: () => manager.applyWorkspace(w.id) },
          { type: 'item', id: `ws-del-${w.id}`, label: 'Delete', icon: 'trash', onSelect: () => manager.deleteWorkspace(w.id) },
        ],
      });
    }
  }

  items.push({ type: 'separator' });
  items.push({
    type: 'item',
    id: 'ws-save',
    label: 'Save Current Workspace…',
    icon: 'download',
    onSelect: () => {
      void (async () => {
        const name = await customPrompt(
          'Save Workspace',
          'Name this layout. It will appear in this menu and in Customize ▸ Workspaces.',
          '',
          { placeholder: 'My layout', confirmLabel: 'Save' },
        );
        if (!name?.trim()) return;
        getWorkspaceManager().saveCurrentWorkspace(name.trim());
        useUIStore.getState().notify({ level: 'success', message: `Saved workspace “${name.trim()}”`, durationMs: 2600 });
      })();
    },
  });
  items.push({
    type: 'item',
    id: 'ws-reset',
    label: 'Reset Layout to Default',
    icon: 'undo',
    onSelect: () => useLayoutStore.getState().resetLayout(),
  });
  return items;
}

const isElectron = typeof window !== 'undefined' && (!!window.motionEditor || !!window.electronAPI);

export function TopNav(): JSX.Element {
  const navigate = useNavigate();
  const activeTool = useUIStore((s) => s.activeTool);
  const setTool = useUIStore((s) => s.setActiveTool);
  
  useSceneRevision((s) => s.rev);
  const selectedIds = useSelectionStore((s) => s.ids);
  const selectedId = selectedIds[0];

  const projComps = useProjectStore((s) => s.comps);
  const activeCompId = useProjectStore((s) => s.tabs[s.activeTabId ?? '']?.compositionId);
  const insertableComps = Object.values(projComps).filter(
    (c) => c.id !== activeCompId && defaultSceneGraph.getNode(c.id),
  );
  const selectedNode = selectedId ? defaultSceneGraph.getNode(selectedId) : undefined;
  const isTextLayer = !!selectedNode && hasTextComponent(selectedNode);
  const canRig = selectedIds.length === 1 && isRiggableLeafNode(selectedNode);
  const rigHint = canRig ? '' : ' — select a shape or image layer (use Rig Logo for a group)';
  
  const playhead = useActiveWorkspace()?.time ?? 0;
  const snap = useUIStore((s) => s.snap);
  const toggleSnap = useUIStore((s) => s.toggleSnap);
  // Mirrored into the narrow-screen overflow menu, so subscribe rather than
  // reading getState at render time (a getState read never re-renders, so
  // the overflow checkmarks would go stale the moment the value changed).
  const draft3d = useGuidesStore((s) => s.draft3d);
  const groundGridVisible = useGuidesStore((s) => s.groundGridVisible);
  const layerBoxesVisible = usePreferenceStore((s) => s.showLayerBounds);

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
    try {
      reportLottieImport(file.name, await importLottieFile(file));
    } catch (err) {
      reportLottieImportFailure(file.name, err);
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

  // Screen width monitoring hook for responsive collapse
  const [width, setWidth] = useState(typeof window !== 'undefined' ? window.innerWidth : 1000);
  useEffect(() => {
    const handleResize = () => setWidth(window.innerWidth);
    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
  }, []);

  const hidePuppet = width < 1200;
  const hideMask = width < 1050;
  const hideSnap = width < 950;
  const hideCustomize = width < 950;
  const hideAnimate = width < 850;
  const hideUndoRedo = width < 850;
  const hideSceneControls = width < 750;

  const overflowItems: DropdownItem[] = [];

  const pushSeparator = () => {
    const lastItem = overflowItems[overflowItems.length - 1];
    if (lastItem && lastItem.type !== 'separator') {
      overflowItems.push({ type: 'separator' });
    }
  };

  if (hideSceneControls) {
    overflowItems.push({
      type: 'item',
      id: 'camera-tools',
      label: 'Camera Navigation',
      icon: 'camera',
      submenu: [
        { type: 'item', id: 'cam-orbit', label: 'Orbit Camera', icon: 'orbit', onSelect: () => useGuidesStore.getState().setCameraTool('orbit') },
        { type: 'item', id: 'cam-pan', label: 'Pan Camera', icon: 'hand-grab', onSelect: () => useGuidesStore.getState().setCameraTool('pan') },
        { type: 'item', id: 'cam-dolly', label: 'Dolly Camera', icon: 'perspective', onSelect: () => useGuidesStore.getState().setCameraTool('dolly') },
      ]
    });
    overflowItems.push({
      type: 'item',
      id: '3d-gizmos',
      label: '3D Gizmo Modes',
      icon: 'axis-3d',
      submenu: [
        { type: 'item', id: 'gizmo-universal', label: 'Universal Gizmo', icon: 'axis-3d', onSelect: () => useGuidesStore.getState().setGizmo3dState('universal') },
        { type: 'item', id: 'gizmo-position', label: 'Position Gizmo', icon: 'move', onSelect: () => useGuidesStore.getState().setGizmo3dState('position') },
        { type: 'item', id: 'gizmo-scale', label: 'Scale Gizmo', icon: 'scale', onSelect: () => useGuidesStore.getState().setGizmo3dState('scale') },
        { type: 'item', id: 'gizmo-rotation', label: 'Rotation Gizmo', icon: 'rotate-cw', onSelect: () => useGuidesStore.getState().setGizmo3dState('rotation') },
      ]
    });
    overflowItems.push({
      type: 'item',
      id: '3d-toggles',
      label: '3D Options',
      icon: 'zap',
      submenu: [
        // Workspace Free/Fixed is NOT mirrored here — ViewportHeader owns it and
        // is always visible, so a copy would be a second switch for one state.
        { type: 'checkbox', id: 'draft-3d', label: 'Draft 3D', checked: draft3d, onChange: () => useGuidesStore.getState().toggleDraft3d() },
        { type: 'checkbox', id: 'ground-grid', label: '3D Ground Plane', checked: groundGridVisible, onChange: () => useGuidesStore.getState().toggleGroundGridVisible() },
        { type: 'checkbox', id: 'layer-boxes', label: 'Layer Bounding Boxes', checked: layerBoxesVisible, onChange: () => usePreferenceStore.getState().set('showLayerBounds', !usePreferenceStore.getState().showLayerBounds) },
      ]
    });
    // "Insert 3D Object" is NOT mirrored here: the New-layer dropdown that owns
    // every insertion is never collapsed, so this submenu was a pure duplicate.
  }

  if (hideAnimate && selectedId) {
    pushSeparator();
    overflowItems.push({
      type: 'item',
      id: 'animate-layer',
      label: 'Animate Layer',
      icon: 'keyframe',
      submenu: buildAnimateItems(selectedIds, isTextLayer, playhead)
    });
  }

  if (hideMask) {
    pushSeparator();
    overflowItems.push({
      type: 'item',
      id: 'mask-rect-item',
      label: 'Rectangle Mask Tool',
      icon: 'mask-square',
      onSelect: () => setTool('mask-rect')
    });
    overflowItems.push({
      type: 'item',
      id: 'mask-ellipse-item',
      label: 'Ellipse Mask Tool',
      icon: 'mask-circle',
      onSelect: () => setTool('mask-ellipse')
    });
  }

  if (hidePuppet) {
    pushSeparator();
    overflowItems.push({
      type: 'item',
      id: 'puppet-pin-item',
      label: 'Puppet Position Pin Tool',
      icon: 'puppet-pin',
      disabled: !canRig,
      onSelect: () => setTool('puppet-pin')
    });
    overflowItems.push({
      type: 'item',
      id: 'bone-item',
      label: 'Bone Tool',
      icon: 'bone',
      disabled: !canRig,
      onSelect: () => setTool('bone')
    });
  }

  if (hideSnap) {
    pushSeparator();
    overflowItems.push({
      type: 'checkbox',
      id: 'snap-item',
      label: 'Toggle Snapping',
      checked: snap,
      onChange: toggleSnap
    });
  }

  if (hideUndoRedo) {
    pushSeparator();
    overflowItems.push({
      type: 'item',
      id: 'undo-item',
      label: 'Undo',
      icon: 'undo',
      disabled: !canUndo,
      onSelect: () => performUndo()
    });
    overflowItems.push({
      type: 'item',
      id: 'redo-item',
      label: 'Redo',
      icon: 'redo',
      disabled: !canRedo,
      onSelect: () => performRedo()
    });
  }

  if (hideCustomize) {
    pushSeparator();
    // The Workspaces dropdown lives in the same collapsed block as Customize, and
    // only Customize was mirrored here — so below 950px the layout presets, "Save
    // Current Workspace" and "Reset Layout" became completely unreachable. Every
    // other collapsed control (camera tools, gizmos, masks, puppet, snap,
    // undo/redo) is mirrored; this one was simply missed.
    overflowItems.push({
      type: 'item',
      id: 'workspaces-item',
      label: 'Workspaces & Layout',
      icon: 'layout',
      submenu: buildWorkspaceItems(),
    });
    overflowItems.push({
      type: 'item',
      id: 'customize-item',
      label: 'Customize settings',
      icon: 'settings',
      onSelect: () => openCustomizeDialog()
    });
  }

  return (
    <div className={styles.root} ref={containerRef}>
      <div className={styles.toolRow} role="toolbar" aria-label="Tools">
        <div className={styles.inner}>
          <IconButton
            aria-label="Back to Dashboard"
            size="md"
            className={styles.back}
            onClick={() => navigate('/')}
          >
            <Icon name="arrow-left" size={18} />
          </IconButton>

          {!isElectron && <AppMenuButton />}
          <span className={styles.toolDivider} aria-hidden />

          {/* Cluster 1: Edit & Drawing Tools */}
          <div className={styles.toolGroup}>
            {/* Pointer Tools Dropdown */}
            <Dropdown
              placement="bottom-start"
              trigger={
                <button
                  type="button"
                  className={isPointerActive ? styles.toolDropdownTriggerActive : styles.toolDropdownTrigger}
                  title={`${pointerDropdownTool.label}${pointerDropdownTool.shortcut ? ` (${pointerDropdownTool.shortcut})` : ''}`}
                >
                  <Icon name={pointerDropdownTool.icon} size={18} />
                  <Icon name="chevron-down" size={12} style={{ opacity: 0.6 }} />
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

            {/* Pen Tools Dropdown */}
            <Dropdown
              placement="bottom-start"
              trigger={
                <button
                  type="button"
                  className={isPenActive ? styles.toolDropdownTriggerActive : styles.toolDropdownTrigger}
                  title={`${penDropdownTool.label}${penDropdownTool.shortcut ? ` (${penDropdownTool.shortcut})` : ''}`}
                >
                  <Icon name={penDropdownTool.icon} size={18} />
                  <Icon name="chevron-down" size={12} style={{ opacity: 0.6 }} />
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

            {/* Text Tool */}
            <button
              type="button"
              className={activeTool === TEXT_TOOL.id ? styles.toolActive : styles.tool}
              title={`${TEXT_TOOL.label} (${TEXT_TOOL.shortcut})`}
              onClick={() => setTool(TEXT_TOOL.id)}
            >
              <Icon name={TEXT_TOOL.icon} size={18} />
            </button>

            {/* Shape Tools Dropdown */}
            <Dropdown
              placement="bottom-start"
              trigger={
                <button
                  type="button"
                  className={isShapeActive ? styles.toolDropdownTriggerActive : styles.toolDropdownTrigger}
                  title={`${shapeDropdownTool.label}${shapeDropdownTool.shortcut ? ` (${shapeDropdownTool.shortcut})` : ''}`}
                >
                  <Icon name={shapeDropdownTool.icon} size={18} />
                  <Icon name="chevron-down" size={12} style={{ opacity: 0.6 }} />
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

          {/* Cluster 2: Mask & Puppet Tools (conditionally rendered) */}
          {(!hideMask || !hidePuppet) && (
            <>
              <span className={styles.toolDivider} aria-hidden />
              <div className={styles.toolGroup}>
                {!hideMask && MASK_TOOLS.map((tool) => {
                  const active = activeTool === tool.id;
                  return (
                    <button
                      key={tool.id}
                      type="button"
                      className={active ? styles.toolActive : styles.tool}
                      title={tool.shortcut ? `${tool.label} (${tool.shortcut})` : tool.label}
                      onClick={() => setTool(tool.id)}
                    >
                      <Icon name={tool.icon} size={18} />
                    </button>
                  );
                })}

                {!hidePuppet && (
                  <>
                    <button
                      type="button"
                      className={activeTool === PUPPET_TOOL.id ? styles.toolActive : styles.tool}
                      title={`${PUPPET_TOOL.label} (${PUPPET_TOOL.shortcut})${rigHint}`}
                      disabled={!canRig}
                      onClick={() => setTool(PUPPET_TOOL.id)}
                    >
                      <Icon name={PUPPET_TOOL.icon} size={18} />
                    </button>
                    <button
                      type="button"
                      className={activeTool === BONE_TOOL.id ? styles.toolActive : styles.tool}
                      title={`${BONE_TOOL.label} (${BONE_TOOL.shortcut})${rigHint}`}
                      disabled={!canRig}
                      onClick={() => setTool(BONE_TOOL.id)}
                    >
                      <Icon name={BONE_TOOL.icon} size={18} />
                    </button>
                  </>
                )}
              </div>
            </>
          )}

          {/* Cluster 3: Layer Creation & Animation Tools */}
          <span className={styles.toolDivider} aria-hidden />
          <div className={styles.toolGroup}>
            {/* New layer dropdown */}
            <Dropdown
              placement="bottom-start"
              trigger={
                <button type="button" className={styles.toolDropdownTrigger} aria-label="New layer" title="New layer…">
                  <Icon name="plus" size={18} />
                  <Icon name="chevron-down" size={12} style={{ opacity: 0.6 }} />
                </button>
              }
              items={[
                { type: 'item', id: 'new-shape', label: 'Shape Layer', icon: 'shape', onSelect: () => insertPrimitive('shape', 'Shape') },
                { type: 'item', id: 'new-text', label: 'Text Layer', icon: 'type', onSelect: () => insertPrimitive('text', 'Text') },
                { type: 'item', id: 'new-solid', label: 'Solid…', icon: 'solid', onSelect: () => insertSolid() },
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
                // The AE-style options dialogs. These existed, fully built, with
                // no importer — so both menu items silently inserted a hardcoded
                // seed and every camera and light in the app was identical.
                { type: 'item', id: 'new-camera', label: 'Camera…', icon: 'camera', onSelect: () => openCameraDialog() },
                { type: 'item', id: 'new-light', label: 'Light…', icon: 'light', onSelect: () => openLightDialog() },
                { type: 'item', id: 'new-particle', label: 'Particle System', icon: 'sparkles', onSelect: () => insertParticle() },
                { type: 'separator' },
                { type: 'item', id: 'new-3d-text', label: '3D Extruded Text', icon: 'text-3d', onSelect: () => insert3DText('3D TEXT') },
                { type: 'item', id: 'new-3d-cube', label: '3D Cube', icon: 'cube', onSelect: () => insert3DPrimitive('cube') },
                { type: 'item', id: 'new-3d-sphere', label: '3D Sphere', icon: 'sphere', onSelect: () => insert3DPrimitive('sphere') },
                { type: 'item', id: 'new-3d-cylinder', label: '3D Cylinder', icon: 'cylinder', onSelect: () => insert3DPrimitive('cylinder') },
                { type: 'separator' },
                { type: 'item', id: 'new-audio', label: 'Audio…', icon: 'audio', onSelect: () => audioInputRef.current?.click() },
                { type: 'item', id: 'new-image-sequence', label: 'Image Sequence…', icon: 'media', onSelect: () => seqInputRef.current?.click() },
                { type: 'item', id: 'import-lottie', label: 'Import .lottie / .json Animation…', icon: 'upload', onSelect: () => lottieInputRef.current?.click() },
              ]}
            />
            <input ref={audioInputRef} type="file" accept="audio/*" style={{ display: 'none' }} onChange={onPickAudio} />
            <input ref={seqInputRef} type="file" accept="image/*" multiple style={{ display: 'none' }} onChange={onPickSequence} />
            <input ref={lottieInputRef} type="file" accept=".json,.lottie,application/json,application/x-lottie" style={{ display: 'none' }} onChange={onPickLottie} />

            {/* Animate dropdown */}
            {!hideAnimate && (
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
                    <Icon name="keyframe" size={18} />
                    <Icon name="chevron-down" size={12} style={{ opacity: 0.6 }} />
                  </button>
                }
                items={buildAnimateItems(selectedIds, isTextLayer, playhead)}
              />
            )}
          </div>

          {/* Cluster 4: Snapping */}
          {!hideSnap && (
            <>
              <span className={styles.toolDivider} aria-hidden />
              <div className={styles.toolGroup}>
                <button
                  type="button"
                  className={snap ? styles.toolActive : styles.tool}
                  aria-label="Toggle snapping"
                  aria-pressed={snap}
                  title={snap ? 'Snapping ON — click to disable' : 'Snapping OFF — click to enable'}
                  onClick={toggleSnap}
                >
                  <Icon name="magnet" size={18} />
                </button>
              </div>
            </>
          )}

          {/* Cluster 5: Scene Controls (moved sequentially right next to other tool groups) */}
          {!hideSceneControls && (
            <>
              <span className={styles.toolDivider} aria-hidden />
              <div className={styles.toolGroup}>
                <SceneControls />
              </div>
            </>
          )}

          {/* Overflow dropdown for smaller screens */}
          {overflowItems.length > 0 && (
            <>
              <span className={styles.toolDivider} aria-hidden />
              <div className={styles.toolGroup}>
                <Dropdown
                  placement="bottom-end"
                  trigger={
                    <button type="button" className={styles.tool} aria-label="More tools" title="More tools">
                      <Icon name="more-horizontal" size={18} />
                    </button>
                  }
                  items={overflowItems}
                />
              </div>
            </>
          )}

          {/* Undo / Redo */}
          {!hideUndoRedo && (
            <>
              <span className={styles.toolDivider} aria-hidden />
              <div className={styles.toolGroup}>
                <button
                  type="button"
                  className={styles.tool}
                  aria-label="Undo"
                  title="Undo  (Ctrl+Z)"
                  disabled={!canUndo}
                  onClick={() => performUndo()}
                >
                  <Icon name="undo" size={18} />
                </button>
                <button
                  type="button"
                  className={styles.tool}
                  aria-label="Redo"
                  title="Redo  (Ctrl+Shift+Z)"
                  disabled={!canRedo}
                  onClick={() => performRedo()}
                >
                  <Icon name="redo" size={18} />
                </button>
              </div>
            </>
          )}

          {/* Customize / Settings & Workspaces */}
          {!hideCustomize && (
            <>
              <span className={styles.toolDivider} aria-hidden />
              <div className={styles.toolGroup}>
                <Dropdown
                  placement="bottom-end"
                  trigger={
                    <button
                      type="button"
                      className={styles.toolDropdownTrigger}
                      aria-label="Workspaces"
                      title="Workspaces & Layout Presets"
                    >
                      <Icon name="layout" size={18} />
                      <Icon name="chevron-down" size={12} style={{ opacity: 0.6 }} />
                    </button>
                  }
                  items={buildWorkspaceItems()}
                />
                <button
                  type="button"
                  className={styles.tool}
                  aria-label="Customize"
                  title="Customize (Shortcuts, Workspaces, Appearance)"
                  onClick={() => openCustomizeDialog()}
                >
                  <Icon name="settings" size={18} />
                </button>
              </div>
            </>
          )}

          <div className={styles.spacer} aria-hidden />
          <span className={styles.toolHint}>{activeTool}</span>
        </div>
      </div>
      <ToolOptionsBar />
    </div>
  );
}
