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
import { useAssetStore } from '@stores/assetStore';
import { Dropdown, type DropdownItem } from '@components/Dropdown';
import { listPresets, applyPresetByName } from '@core/animation/animationPresets';
import { applyTypewriter, applyBounceInWords, applySpinFadeCharacters, applyTrackingReveal } from '@core/animation/keyframeAssistants';
import { applyBounce, describeBounce, revealBounce } from '@core/animation/bounce';
import { useBounceStore, currentSquash } from '@stores/bounceStore';
import { addControl, CONTROL_COMPONENTS, type ControlKind } from '@core/animation/expressionControls';
import { asCommandId } from '@app-types/common';

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
import { cloudProjectsEnabled } from '@core/config/edition';
import { AppMenuButton } from '@layout/Menu';
import { SceneControls } from '@layout/SceneControls/SceneControls';
import { PIN_KIND_CATALOG, PUPPET_PIN_ICONS, puppetPinLabel } from './puppetPinTools';

import { useSelectionStore } from '@stores/selectionStore';
import { useSceneRevision } from '@stores/sceneStore';
import defaultSceneGraph from '@core/scene/DefaultSceneGraph';
import { isRiggableLeafNode } from '@core/scene/rigLogo';
import styles from './TopNav.module.css';
import { usePreferenceStore } from '@stores/preferenceStore';
import { usePresentationStore } from '@stores/presentationStore';
import { useCompositionStore } from '@stores/compositionStore';
import { openExportDialog } from '@layout/Export/ExportDialog';

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
  { id: 'direct-select', icon: 'direct-select', label: 'Direct Selection Tool', shortcut: 'Shift+V' },
  { id: 'rotate',        icon: 'rotate',        label: 'Rotation Tool', shortcut: 'W' },
  { id: 'pan-behind',    icon: 'pan-behind',    label: 'Pan Behind (Anchor Point) Tool', shortcut: 'Y' },
  { id: 'hand',          icon: 'hand',          label: 'Hand Tool', shortcut: 'H' },
  { id: 'zoom',          icon: 'zoom-in',       label: 'Zoom Tool', shortcut: 'Z' },
];

const PEN_TOOLS: ToolDef[] = [
  { id: 'pen',      icon: 'pen',        label: 'Pen Tool', shortcut: 'G' },
  { id: 'pencil',   icon: 'pencil',     label: 'Pencil Tool' },
  { id: 'brush',    icon: 'brush',      label: 'Brush Tool (pressure ink)' },
  // Split out of the Brush, which used to turn into this on its own whenever
  // the pointer happened to land on the selected layer.
  { id: 'paint',    icon: 'brush',      label: 'Paint Tool (paints onto the selected layer)' },
  { id: 'eraser',   icon: 'eraser',     label: 'Eraser Tool (erases paint on the selected layer)' },
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
  // Where the Pen's old implicit masking went, so nothing was lost by making
  // the plain Pen always draw a path layer.
  { id: 'mask-pen',     icon: 'mask-pen',    label: 'Pen Mask Tool' },
];

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
    { type: 'item', id: 'anim-ease-all', label: 'Easy Ease All Keyframes', icon: 'track', onSelect: () => { void getCommandSystem().execute(asCommandId('animation.easyEaseAll')); } },
    // Applies the settings the Bounce section in the Graph panel is showing —
    // the menu is a shortcut to that panel's current shape, not a second,
    // hardcoded bounce. `applyBounce` (not `bounceKeyframes`) so the item is
    // never a no-op: with nothing to rebound from it generates the fall too.
    { type: 'item', id: 'anim-bounce', label: 'Bounce', icon: 'track', onSelect: () => { const s = useBounceStore.getState(); const r = applyBounce(id, { atTime: playhead, mode: 'auto', drop: s.drop, bounce: s.bounce, squash: currentSquash() }); if (r) { revealBounce(id); notify(describeBounce(r)); } else notify('Nothing to bounce — check the layer is unlocked', 'warning'); } },
    { type: 'item', id: 'anim-reverse', label: 'Time-Reverse Keyframes', icon: 'skip-back', onSelect: () => { void getCommandSystem().execute(asCommandId('animation.timeReverseKeyframes')); } },
    // Sequence / stagger live as registered commands (Animation menu + palette);
    // TopNav reuses them so the prompt and undo path stay one.
    { type: 'item', id: 'anim-sequence-bars', label: 'Sequence Layers…', icon: 'layers', disabled: selectedIds.length < 2, onSelect: () => { void getCommandSystem().execute(asCommandId('animation.sequenceLayerBars')); } },
    { type: 'item', id: 'anim-sequence', label: 'Stagger Animations (0.3s)', icon: 'layers', disabled: selectedIds.length < 2, onSelect: () => { void getCommandSystem().execute(asCommandId('animation.sequenceLayers')); } },
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
const isElectron = typeof window !== 'undefined' && (!!window.motionEditor || !!window.electronAPI);

export function TopNav(): JSX.Element {
  const navigate = useNavigate();
  const activeTool = useUIStore((s) => s.activeTool);
  const puppetPinKind = useUIStore((s) => s.puppetPinKind);
  const setPuppetPinKind = useUIStore((s) => s.setPuppetPinKind);
  const setTool = useUIStore((s) => s.setActiveTool);
  const enterPresentation = usePresentationStore((s) => s.enter);
  const compFps = useCompositionStore((s) => s.fps);
  const compDuration = useCompositionStore((s) => s.durationSeconds);
  
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
  const [lastMaskTool, setLastMaskTool] = useState<Tool>('mask-rect');

  const isPointerActive = POINTER_TOOLS.some(t => t.id === activeTool);
  const pointerDropdownTool = POINTER_TOOLS.find(t => t.id === (isPointerActive ? activeTool : lastPointerTool)) || POINTER_TOOLS[0]!;

  const isPenActive = PEN_TOOLS.some(t => t.id === activeTool);
  const penDropdownTool = PEN_TOOLS.find(t => t.id === (isPenActive ? activeTool : lastPenTool)) || PEN_TOOLS[0]!;

  const isShapeActive = SHAPE_TOOLS.some(t => t.id === activeTool);
  const shapeDropdownTool = SHAPE_TOOLS.find(t => t.id === (isShapeActive ? activeTool : lastShapeTool)) || SHAPE_TOOLS[0]!;

  // The three mask tools were three permanent buttons while the three shape
  // tools beside them — the same kind of choice, one active at a time — were
  // one menu. Same shape of decision, same control.
  const isMaskActive = MASK_TOOLS.some(t => t.id === activeTool);
  const maskDropdownTool = MASK_TOOLS.find(t => t.id === (isMaskActive ? activeTool : lastMaskTool)) || MASK_TOOLS[0]!;

  const isPuppetActive = activeTool === 'puppet-pin';
  const armPuppet = (kind: typeof puppetPinKind): void => {
    setPuppetPinKind(kind);
    setTool('puppet-pin');
  };

  useEffect(() => {
    if (isPointerActive) setLastPointerTool(activeTool);
    if (isPenActive) setLastPenTool(activeTool);
    if (isShapeActive) setLastShapeTool(activeTool);
    if (isMaskActive) setLastMaskTool(activeTool);
  }, [activeTool, isPointerActive, isPenActive, isShapeActive, isMaskActive]);

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
        { type: 'item', id: 'cam-pan', label: 'Pan Camera', icon: 'pan-camera', onSelect: () => useGuidesStore.getState().setCameraTool('pan') },
        { type: 'item', id: 'cam-dolly', label: 'Dolly Camera', icon: 'perspective', onSelect: () => useGuidesStore.getState().setCameraTool('dolly') },
      ]
    });
    overflowItems.push({
      type: 'item',
      id: '3d-gizmos',
      label: '3D Gizmo Modes',
      icon: 'gizmo-universal',
      submenu: [
        { type: 'item', id: 'gizmo-universal', label: 'Universal Gizmo', icon: 'gizmo-universal', onSelect: () => useGuidesStore.getState().setGizmo3dState('universal') },
        { type: 'item', id: 'gizmo-position', label: 'Position Gizmo', icon: 'gizmo-position', onSelect: () => useGuidesStore.getState().setGizmo3dState('position') },
        { type: 'item', id: 'gizmo-scale', label: 'Scale Gizmo', icon: 'gizmo-scale', onSelect: () => useGuidesStore.getState().setGizmo3dState('scale') },
        { type: 'item', id: 'gizmo-rotation', label: 'Rotation Gizmo', icon: 'gizmo-rotation', onSelect: () => useGuidesStore.getState().setGizmo3dState('rotation') },
      ]
    });
    overflowItems.push({
      type: 'item',
      id: '3d-toggles',
      label: '3D Options',
      icon: 'zap',
      submenu: [
        // Workspace Free/Fixed is NOT mirrored here — ViewportTools owns it, in
        // the timeline's tool row, so a copy would be a second switch for one state.
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
      icon: 'magic-wand',
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
    overflowItems.push({
      type: 'item',
      id: 'mask-pen-item',
      label: 'Pen Mask Tool',
      icon: 'mask-pen',
      onSelect: () => setTool('mask-pen')
    });
  }

  if (hidePuppet) {
    pushSeparator();
    for (const k of PIN_KIND_CATALOG) {
      overflowItems.push({
        type: 'item',
        id: `puppet-${k.kind}`,
        label: k.label,
        icon: PUPPET_PIN_ICONS[k.kind],
        disabled: !canRig,
        onSelect: () => armPuppet(k.kind),
      });
    }
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

  return (
    <div className={styles.root} ref={containerRef}>
      <div className={styles.toolRow} role="toolbar" aria-label="Tools">
        <div className={styles.inner}>
          {/*
            Only where there IS a dashboard. `/` redirects to /dashboard in the
            server edition and to /editor in the local one — so in the local
            edition this arrow navigated the user back to the page they were
            already on. An affordance that does nothing is worse than no
            affordance: it reads as a broken button, not an absent feature.
          */}
          {cloudProjectsEnabled() && (
            <IconButton
              aria-label="Back to Dashboard"
              size="md"
              className={styles.back}
              onClick={() => navigate('/')}
            >
              <Icon name="arrow-left" size="md" />
            </IconButton>
          )}

          {/* The File menu */}
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
                  <Icon name={pointerDropdownTool.icon} size="md" />
                  <Icon name="chevron-down" size="sm" style={{ opacity: 0.6 }} />
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
                  <Icon name={penDropdownTool.icon} size="md" />
                  <Icon name="chevron-down" size="sm" style={{ opacity: 0.6 }} />
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
              <Icon name={TEXT_TOOL.icon} size="md" />
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
                  <Icon name={shapeDropdownTool.icon} size="md" />
                  <Icon name="chevron-down" size="sm" style={{ opacity: 0.6 }} />
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
                {!hideMask && (
                  <Dropdown
                    placement="bottom-start"
                    trigger={
                      <button
                        type="button"
                        className={isMaskActive ? styles.toolDropdownTriggerActive : styles.toolDropdownTrigger}
                        title={`${maskDropdownTool.label}${maskDropdownTool.shortcut ? ` (${maskDropdownTool.shortcut})` : ''}`}
                      >
                        <Icon name={maskDropdownTool.icon} size="md" />
                        <Icon name="chevron-down" size="sm" style={{ opacity: 0.6 }} />
                      </button>
                    }
                    items={MASK_TOOLS.map((t) => ({
                      type: 'item',
                      id: t.id,
                      label: t.shortcut ? `${t.label} (${t.shortcut})` : t.label,
                      icon: t.icon,
                      onSelect: () => setTool(t.id),
                    }))}
                  />
                )}

                {!hidePuppet && (
                  <>
                    <Dropdown
                      placement="bottom-start"
                      trigger={
                        <button
                          type="button"
                          className={isPuppetActive ? styles.toolDropdownTriggerActive : styles.toolDropdownTrigger}
                          title={`${puppetPinLabel(puppetPinKind)} (Ctrl+P)${rigHint}`}
                          disabled={!canRig}
                          aria-label={puppetPinLabel(puppetPinKind)}
                        >
                          <Icon name={PUPPET_PIN_ICONS[puppetPinKind]} size="md" />
                          <Icon name="chevron-down" size="sm" style={{ opacity: 0.6 }} />
                        </button>
                      }
                      items={PIN_KIND_CATALOG.map((k) => ({
                        type: 'item' as const,
                        id: `puppet-${k.kind}`,
                        label: k.label,
                        icon: PUPPET_PIN_ICONS[k.kind],
                        onSelect: () => armPuppet(k.kind),
                      }))}
                    />
                    <button
                      type="button"
                      className={activeTool === BONE_TOOL.id ? styles.toolActive : styles.tool}
                      title={`${BONE_TOOL.label} (${BONE_TOOL.shortcut})${rigHint}`}
                      disabled={!canRig}
                      onClick={() => setTool(BONE_TOOL.id)}
                    >
                      <Icon name={BONE_TOOL.icon} size="md" />
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
              noScroll
              trigger={
                <button type="button" className={styles.toolDropdownTrigger} aria-label="New layer" title="New Layer (Shape, Text, Solid, Null, Camera, Light, 3D…)">
                  <Icon name="layer-plus" size="md" />
                  <Icon name="chevron-down" size="sm" style={{ opacity: 0.6 }} />
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
                noScroll
                trigger={
                  <button
                    type="button"
                    className={styles.toolDropdownTrigger}
                    aria-label="Animate"
                    title={selectedId ? 'Animation presets & rigging (Easy Ease, Typewriter, Bounce, Rig)…' : 'Select a layer to apply animation presets'}
                    disabled={!selectedId}
                  >
                    <Icon name="magic-wand" size="md" />
                    <Icon name="chevron-down" size="sm" style={{ opacity: 0.6 }} />
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
                  title={snap ? 'Snapping ON — Magnetically snaps layers & playhead (Click to disable)' : 'Snapping OFF — Click to enable magnetic snapping'}
                  onClick={toggleSnap}
                >
                  <Icon name="magnet" size="md" />
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
                      <Icon name="more-horizontal" size="md" />
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
                  <Icon name="undo" size="md" />
                </button>
                <button
                  type="button"
                  className={styles.tool}
                  aria-label="Redo"
                  title="Redo  (Ctrl+Shift+Z)"
                  disabled={!canRedo}
                  onClick={() => performRedo()}
                >
                  <Icon name="redo" size="md" />
                </button>
              </div>
            </>
          )}

          {!isElectron && (
            <>
              <span className={styles.toolDivider} aria-hidden />
              <div className={styles.toolGroup}>
                <button
                  type="button"
                  className={styles.previewBtn}
                  title="Preview presentation (Fullscreen)"
                  onClick={() => enterPresentation()}
                >
                  <Icon name="play" size="md" weight="fill" />
                  <span>Preview</span>
                </button>
                <button
                  type="button"
                  className={styles.exportBtn}
                  title="Export composition…"
                  onClick={() => openExportDialog(compDuration, compFps)}
                >
                  <Icon name="export" size="md" weight="bold" />
                  <span>Export</span>
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
