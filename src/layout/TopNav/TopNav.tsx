/**
 * TopNav — the After Effects–style top chrome: a real menu bar (File / Edit /
 * … shown directly, no dropdown kebab) over a horizontal tool bar of the
 * motion-design tools. Replaces the old floating dropdown + left tool rail.
 *
 * LAYOUT. Three clusters on one row: left = menu + tools + (below) the tool
 * options; centre = project status, composition chip, workspace switcher;
 * right = Preview, Export, account. In Electron the title bar above carries
 * the centre and right clusters, so this row keeps only the tools there.
 *
 * COLLAPSE. Tool groups demote into the `…` overflow menu when the BAR is
 * too narrow — measured on the bar with a ResizeObserver (`useElementWidth`),
 * with the thresholds in `toolbarCollapse.ts` — not on `window.innerWidth`,
 * which is the wrong question whenever the window and the bar differ.
 */

import { useRef, useState, useEffect, type ChangeEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { getCommandSystem } from '@core/commands/CommandSystem';
import { performUndo, performRedo } from '@stores/historyStore';
import { getEventBus } from '@core/events/EventBus';
import { Button } from '@components/Button';
import { IconButton } from '@components/IconButton';
import { Icon, type IconName } from '@components/Icon';
import { ToolOptionsBar } from './ToolOptionsBar';
import { ToolFlyout, type ToolFlyoutItem } from './ToolFlyout';
import { PluginToolsFlyout } from './PluginToolsFlyout';
import { toolShortcut, toolLabelWithShortcut } from './toolShortcuts';
import { useElementWidth } from './useElementWidth';
import { collapseFor } from './toolbarCollapse';
import { useActiveWorkspace, useProjectStore } from '@stores/projectStore';
import { insertPrimitive, insert3DPrimitive, insert3DText } from '@core/scene/sceneInsert';
import { insertMediaEdit } from '@layout/Workspace/footageEdits';
import { typewriterEdit } from '@layout/Text/textEdits';
import { TEXT_RIGS, addExpressionControlEdit, insertImageSequenceEdit, textRigEdit } from './topNavEdits';
import { openCameraDialog, openLightDialog, openPrimitiveDialog } from '@layout/Workspace/SceneInsertDialogs';
import { openSolidSettings } from '@layout/Composition/LayerSettingsDialog';
import { useGuidesStore } from '@stores/guidesStore';
import { importLottieFileEdit } from '@layout/EditorLayout/lottieInsertEdits';
import { insertBuiltLayers } from '@core/engine/offDocument';
import { activeInsertTarget } from '@layout/Scene/activeInsertTarget';
import { Dropdown, type DropdownItem } from '@components/Dropdown';
import { listPresets } from '@core/animation/animationPresets';
import { applyAnimationPresetEdit, createLayerEdit } from '@layout/Menu/appEdits';
import { describeBounce, revealBounce } from '@core/animation/bounce';
import { bounceEdit } from '@layout/Motion/bounceEdits';
import { useBounceStore, currentSquash } from '@stores/bounceStore';
import { CONTROL_COMPONENTS, type ControlKind } from '@core/animation/expressionControls';
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
import { useUIStore, type Tool } from '@stores/uiStore';
import { cloudProjectsEnabled } from '@core/config/edition';
import { AppMenuButton } from '@layout/Menu';
import { SceneControls } from '@layout/SceneControls/SceneControls';
import { PIN_KIND_CATALOG, PUPPET_PIN_ICONS, puppetPinLabel } from './puppetPinTools';

import { useSelectionStore } from '@stores/selectionStore';
import { documentMirror } from '@stores/documentMirror';
import { useActiveCompId, useActiveMirrorComp, useMirrorComp, useMirrorComps, useMirrorLayer } from '@hooks/useMirror';
import { isRiggableLayer, uiKindOf } from '@core/mirror/layerKinds';
import { settingsDurationSeconds, settingsFps } from '@core/mirror/compFacts';
import styles from './TopNav.module.css';
import { usePreferenceStore } from '@stores/preferenceStore';
import { usePresentationStore } from '@stores/presentationStore';
import { openExportDialog } from '@layout/Export/ExportDialog';
import { openCompositionSettings } from '@layout/Composition/CompositionSettingsDialog';
import { openCustomizeDialog } from '@layout/Settings/openCustomizeDialog';
import { buildWorkspaceItems } from '@layout/Workspace/workspaceMenuItems';
import { ProjectStatus } from '@layout/ProjectStatus/ProjectStatus';
import { getUiPlatform, hasDesktopChrome } from '@core/config/uiPlatform';
import { MacWindowControls } from '@layout/TitleBar/MacWindowControls';
import { EditorChromeActions } from '@layout/TitleBar/EditorChromeActions';
import { UpdateButton } from '@layout/TitleBar/UpdateButton';
import { importBrowserFilesEdit } from '@layout/Assets/assetEdits';

/**
 * A toolbar tool. NO `shortcut` field, deliberately.
 *
 * There used to be one, hand-written per entry ('V', 'Shift+V', 'Ctrl+T'…),
 * and it was a second copy of a fact the command registry owns. A copy cannot
 * follow a rebinding: Customize… and the AE preset both write
 * `shortcutOverrides`, so the moment a user moved a tool every one of these
 * strings started lying. Two were wrong before anyone touched a preference —
 * Ctrl+T and Ctrl+B were written by hand against commands declared with `meta`.
 * `toolShortcut()` reads the live binding instead; see `toolShortcuts.ts` for
 * why the registry and not `Tool.shortcut` on the engine class.
 */
interface ToolDef {
  id: Tool;
  icon: IconName;
  label: string;
}

const POINTER_TOOLS: ToolDef[] = [
  { id: 'select',        icon: 'mouse-pointer', label: 'Selection Tool' },
  { id: 'direct-select', icon: 'direct-select', label: 'Direct Selection Tool' },
  { id: 'rotate',        icon: 'rotate',        label: 'Rotation Tool' },
  { id: 'pan-behind',    icon: 'pan-behind',    label: 'Pan Behind (Anchor Point) Tool' },
  { id: 'hand',          icon: 'hand',          label: 'Hand Tool' },
  { id: 'zoom',          icon: 'zoom-in',       label: 'Zoom Tool' },
];

const PEN_TOOLS: ToolDef[] = [
  { id: 'pen',      icon: 'pen',        label: 'Pen Tool' },
  { id: 'pencil',   icon: 'pencil',     label: 'Pencil Tool' },
  { id: 'brush',    icon: 'brush',      label: 'Brush Tool (pressure ink)' },
  // Split out of the Brush, which used to turn into this on its own whenever
  // the pointer happened to land on the selected layer.
  { id: 'paint',    icon: 'brush',      label: 'Paint Tool (paints onto the selected layer)' },
  { id: 'eraser',   icon: 'eraser',     label: 'Eraser Tool (erases paint on the selected layer)' },
  { id: 'curvature',icon: 'curvature',  label: 'Curvature Pen' },
  // AE's Pen flyout. The Pen does all three on its own (over a segment it
  // adds, over a vertex it converts); these do one thing wherever they land.
  { id: 'add-vertex',     icon: 'plus',   label: 'Add Vertex Tool' },
  { id: 'delete-vertex',  icon: 'minus',  label: 'Delete Vertex Tool' },
  { id: 'convert-vertex', icon: 'ease',   label: 'Convert Vertex Tool' },
  { id: 'mask-feather',   icon: 'blur',   label: 'Mask Feather Tool (variable feather points)' },
];

/**
 * The Knife, appended to the Pen flyout — it EDITS an outline rather than
 * drawing one, which is why it sits with the pen tools and not the shapes.
 *
 * Deliberately NOT an entry in `PEN_TOOLS`. `toolCommands.test.ts` walks that
 * list and requires a matching `tool.<id>` in `buildToolCommands` — the check
 * that keeps every toolbar tool rebindable from Customize… and findable in the
 * palette — and registering `tool.knife` there is outside this change. Listing
 * the Knife separately keeps that guard TELLING THE TRUTH (it is not yet a
 * rebindable command) instead of being dodged by a rename; the entry moves into
 * `PEN_TOOLS` unchanged the moment `{ tool: 'knife', label: 'Knife Tool',
 * chord: { key: 'k' } }` lands in Providers.
 *
 * NO KEYBOARD SHORTCUT until that line lands. `KnifeTool.shortcut` is `k` and is
 * unique across the builtin set, but `ToolManager.activateByShortcut` is not the
 * app's tool-key channel — the app only ever feeds Space into the engine
 * (`useSpaceTransport`) and drives every other tool key from the command
 * registry. So this flyout item and the Pathfinder section's button are the two
 * live routes to the Knife today, and the tooltip does not promise a third.
 */
const KNIFE_FLYOUT = {
  tool: 'knife' as Tool,
  icon: 'scissors' as IconName,
  label: 'Knife Tool — drag across a shape to cut its path',
};

const SHAPE_TOOLS: ToolDef[] = [
  { id: 'shape',    icon: 'square',     label: 'Rectangle Tool' },
  { id: 'ellipse',  icon: 'circle',     label: 'Ellipse Tool' },
  { id: 'polygon',  icon: 'polygon',    label: 'Polygon Tool' },
  { id: 'star',     icon: 'star',       label: 'Star Tool' },
  { id: 'line',     icon: 'line',       label: 'Line Segment' },
];

/** AE's Type tool family: horizontal and vertical (Ctrl+T cycles them). */
const TEXT_TOOLS: ToolDef[] = [
  { id: 'text', icon: 'type', label: 'Text Tool' },
  { id: 'vertical-text', icon: 'type-vertical', label: 'Vertical Type Tool' },
];

const MASK_TOOLS: ToolDef[] = [
  { id: 'mask-rect',    icon: 'mask-square', label: 'Rectangle Mask Tool' },
  { id: 'mask-ellipse', icon: 'mask-circle', label: 'Ellipse Mask Tool' },
  // Where the Pen's old implicit masking went, so nothing was lost by making
  // the plain Pen always draw a path layer.
  { id: 'mask-pen',     icon: 'mask-pen',    label: 'Pen Mask Tool' },
];

const BONE_TOOL: ToolDef = { id: 'bone', icon: 'bone', label: 'Bone Tool' };

/** "Selection Tool (V)" — the ACCESSIBLE name, chord read live from the registry. */
const withShortcut = (t: ToolDef): string => toolLabelWithShortcut(t.label, t.id);

/**
 * A tool family as flyout entries.
 *
 * The chord goes in the menu row's SHORTCUT COLUMN rather than glued to the end
 * of the label, which is where every other menu in the app puts one and is the
 * only reason these rows used to look different from a File menu row.
 */
const flyoutItems = (tools: ReadonlyArray<ToolDef>, setTool: (t: Tool) => void): ToolFlyoutItem[] =>
  tools.map((t) => ({
    id: t.id,
    label: t.label,
    shortcut: toolShortcut(t.id),
    icon: t.icon,
    onSelect: () => setTool(t.id),
  }));

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
      // `applyPreset` through the engine (B3): one entry, refusals toasted.
      void applyAnimationPresetEdit([id], p.name, playhead).then((ok) => {
        if (ok) notify(`Applied “${p.name}”`);
      });
    },
  }));

  return [
    ...presetItems,
    { type: 'separator' },
    // Text-animator rigs: addPropertyGroup (animator + init) then the selector's options and keys, one entry.
    { type: 'item', id: 'anim-typewriter', label: 'Typewriter (text)', icon: 'type', disabled: !isTextLayer, onSelect: () => { void typewriterEdit(id, playhead).then((ok) => { if (ok) notify('Typewriter rig created'); }); } },
    { type: 'item', id: 'anim-bounce-in-words', label: 'Bounce In Words (text)', icon: 'type', disabled: !isTextLayer, onSelect: () => { void textRigEdit(id, TEXT_RIGS.bounceInWords, playhead).then((ok) => { if (ok) notify('Bounce In Words rig created'); }); } },
    { type: 'item', id: 'anim-spin-fade-chars', label: 'Spin & Fade Characters (text)', icon: 'type', disabled: !isTextLayer, onSelect: () => { void textRigEdit(id, TEXT_RIGS.spinFadeCharacters, playhead).then((ok) => { if (ok) notify('Spin & Fade Characters rig created'); }); } },
    { type: 'item', id: 'anim-tracking-reveal', label: 'Tracking Reveal (text)', icon: 'type', disabled: !isTextLayer, onSelect: () => { void textRigEdit(id, TEXT_RIGS.trackingReveal, playhead).then((ok) => { if (ok) notify('Tracking Reveal rig created'); }); } },
    { type: 'separator' },
    { type: 'item', id: 'anim-ease-all', label: 'Easy Ease All Keyframes', icon: 'track', onSelect: () => { void getCommandSystem().execute(asCommandId('animation.easyEaseAll')); } },
    // Applies the settings the Bounce section in the Graph panel is showing —
    // the menu is a shortcut to that panel's current shape, not a second,
    // hardcoded bounce. `applyBounce` (not `bounceKeyframes`) so the item is
    // never a no-op: with nothing to rebound from it generates the fall too.
    // Off-document, sent as setKeyframes (layout/Motion/bounceEdits.ts): one entry.
    { type: 'item', id: 'anim-bounce', label: 'Bounce', icon: 'track', onSelect: () => { const s = useBounceStore.getState(); void bounceEdit(id, { atTime: playhead, mode: 'auto', drop: s.drop, bounce: s.bounce, squash: currentSquash() }).then((r) => { if (r) { revealBounce(id); notify(describeBounce(r)); } else notify('Nothing to bounce — check the layer is unlocked', 'warning'); }); } },
    { type: 'item', id: 'anim-reverse', label: 'Time-Reverse Keyframes', icon: 'skip-back', onSelect: () => { void getCommandSystem().execute(asCommandId('animation.timeReverseKeyframes')); } },
    // Sequence / stagger live as registered commands (Animation menu + palette);
    // TopNav reuses them so the prompt and undo path stay one.
    { type: 'item', id: 'anim-sequence-bars', label: 'Sequence Layers…', icon: 'layers', disabled: selectedIds.length < 2, onSelect: () => { void getCommandSystem().execute(asCommandId('animation.sequenceLayerBars')); } },
    { type: 'item', id: 'anim-stagger-layers', label: 'Stagger Layers…', icon: 'layers', disabled: selectedIds.length < 2, onSelect: () => { void getCommandSystem().execute(asCommandId('animation.staggerLayers')); } },
    { type: 'item', id: 'anim-sequence', label: 'Stagger Animations…', icon: 'layers', disabled: selectedIds.length < 2, onSelect: () => { void getCommandSystem().execute(asCommandId('animation.sequenceLayers')); } },
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
          // One `addPropertyGroup` on `effects` (the control is `effects/ctrl_<name>`).
          void addExpressionControlEdit(id, k.kind).then((name) => {
            if (!name) return;
            // Multi-component kinds expose several names, so tell the user what
            // to actually type — `ctrl('Point 1')` alone would resolve to 0.
            const parts = CONTROL_COMPONENTS[k.kind];
            const refs = parts.map((suffix) => `ctrl('${name}${suffix}')`).join(' / ');
            notify(`Added “${name}” — reference it with ${refs}`);
          });
        },
      })),
    },
  ];
}

/**
 * How much of the macOS unified toolbar is NOT tools: the traffic-light inset,
 * the project in the centre and the actions on the right. Taken off the bar's
 * width before the collapse thresholds, which were tuned for a row of tools
 * alone — the Windows / Linux row.
 */
const MAC_CHROME_RESERVE = 520;

/**
 * Undo / Redo chords as the real keyboard spells them. Deliberately not the
 * chrome platform: a Mac-looking preview on Windows still answers to Ctrl.
 */
const MAC_KEYBOARD = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform);
const UNDO_CHORD = MAC_KEYBOARD ? '⌘Z' : 'Ctrl+Z';
const REDO_CHORD = MAC_KEYBOARD ? '⇧⌘Z' : 'Ctrl+Shift+Z';

/**
 * The composition chip in the web build's centre cluster: name, size, fps.
 * Click opens Composition Settings. (Electron shows the comp in the status
 * bar's centre and the project in the title bar; the web build has no title
 * bar, so both live here.)
 */
function CompChip(): JSX.Element {
  const settings = useActiveMirrorComp()?.settings;
  const name = settings?.name ?? '';
  const width = settings?.width ?? 1920;
  const height = settings?.height ?? 1080;
  const fps = settingsFps(settings);
  const activePristine = useMirrorComp(useActiveCompId())?.settings.pristine === true;
  const label = activePristine ? 'No composition' : name || 'Untitled';
  return (
    <button type="button" className={styles.comp} title="Composition settings" onClick={() => openCompositionSettings()}>
      <Icon name="layers" size="sm" className={styles.compIcon} />
      <span className={styles.compName}>{label}</span>
      <span className={styles.compMeta}>{width}×{height} · {fps}fps</span>
    </button>
  );
}

export function TopNav(): JSX.Element {
  const navigate = useNavigate();
  const activeTool = useUIStore((s) => s.activeTool);
  const puppetPinKind = useUIStore((s) => s.puppetPinKind);
  const setPuppetPinKind = useUIStore((s) => s.setPuppetPinKind);
  const setTool = useUIStore((s) => s.setActiveTool);
  const enterPresentation = usePresentationStore((s) => s.enter);
  const compSettings = useActiveMirrorComp()?.settings;
  const compFps = settingsFps(compSettings);
  const compDuration = settingsDurationSeconds(compSettings);

  const selectedIds = useSelectionStore((s) => s.ids);
  const selectedId = selectedIds[0];

  const mirrorComps = useMirrorComps();
  const activeCompId = useProjectStore((s) => s.tabs[s.activeTabId ?? '']?.compositionId);
  // Scene ROOTS only: a group opened in its own tab has a settings record but
  // is a layer, and placing it as a comp instance would reference a subtree
  // of some other comp.
  const insertableComps = [...mirrorComps.values()]
    .filter((c) => c.id !== activeCompId && !documentMirror().hasLayer(c.id))
    .map((c) => ({ id: c.id, name: c.settings.name }));
  const selectedLayer = useMirrorLayer(selectedId);
  const isTextLayer = uiKindOf(selectedLayer) === 'text';
  const canRig = selectedIds.length === 1 && isRiggableLayer(selectedLayer);
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
  const deviceWireframesAll = usePreferenceStore((s) => s.deviceWireframesAll);

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

  const audioInputRef = useRef<HTMLInputElement | null>(null);
  const onPickAudio = async (e: ChangeEvent<HTMLInputElement>): Promise<void> => {
    const file = e.target.files?.[0];
    if (!file) return;
    // The audio picker hands a browser `File` (no path): imported from its bytes.
    const { imported: [asset] } = await importBrowserFilesEdit([{ file }]);
    if (!asset) return;
    // The layer through the media insert router: one pasteLayers, one entry.
    await insertMediaEdit([asset]);
  };
  const seqInputRef = useRef<HTMLInputElement | null>(null);
  const onPickSequence = async (e: ChangeEvent<HTMLInputElement>): Promise<void> => {
    const files = Array.from(e.target.files ?? []);
    e.target.value = ''; // allow re-picking the same set
    if (files.length < 2) return;
    // Frames are object URLs on the layer (no import): built off-document, one pasteLayers.
    await insertImageSequenceEdit(files);
  };
  const lottieInputRef = useRef<HTMLInputElement | null>(null);
  const onPickLottie = async (e: ChangeEvent<HTMLInputElement>): Promise<void> => {
    const file = e.target.files?.[0];
    e.target.value = ''; // allow re-picking the same file
    if (!file) return;
    // The importer's layer tree lands as ONE pasteLayers entry (lottieInsertEdits.ts).
    await importLottieFileEdit(file);
  };

  const containerRef = useRef<HTMLDivElement>(null);
  const barRef = useRef<HTMLDivElement>(null);

  const [lastPointerTool, setLastPointerTool] = useState<Tool>('select');
  const [lastPenTool, setLastPenTool] = useState<Tool>('pen');
  const [lastShapeTool, setLastShapeTool] = useState<Tool>('shape');
  const [lastMaskTool, setLastMaskTool] = useState<Tool>('mask-rect');

  const isPointerActive = POINTER_TOOLS.some(t => t.id === activeTool);
  const pointerDropdownTool = POINTER_TOOLS.find(t => t.id === (isPointerActive ? activeTool : lastPointerTool)) || POINTER_TOOLS[0]!;

  // The Knife lights the same trigger as the pen tools it shares a flyout with,
  // or picking it would leave the toolbar showing no active tool at all.
  const isKnifeActive = activeTool === KNIFE_FLYOUT.tool;
  const isPenActive = PEN_TOOLS.some(t => t.id === activeTool) || isKnifeActive;
  const penDropdownTool: ToolDef = isKnifeActive
    ? { id: KNIFE_FLYOUT.tool, icon: KNIFE_FLYOUT.icon, label: KNIFE_FLYOUT.label }
    : PEN_TOOLS.find(t => t.id === (isPenActive ? activeTool : lastPenTool)) || PEN_TOOLS[0]!;

  const isTextActive = TEXT_TOOLS.some(t => t.id === activeTool);
  const textDropdownTool = TEXT_TOOLS.find(t => t.id === activeTool) || TEXT_TOOLS[0]!;

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

  // Which chrome this row belongs to: the web build's own bar, the tool row
  // under the Windows / Linux title bar, or the macOS unified toolbar.
  const desktop = hasDesktopChrome();
  const mac = desktop && getUiPlatform() === 'mac';

  // The bar's OWN width drives the collapse — see the module note.
  const barWidth = useElementWidth(barRef);
  const collapse = collapseFor(mac ? barWidth - MAC_CHROME_RESERVE : barWidth);
  const { hidePuppet, hideMask, hideSnap, hideAnimate, hideSceneControls } = collapse;
  // On a Mac Undo / Redo belong to the Edit menu (⌘Z): no buttons, no overflow rows.
  const hideUndoRedo = mac || collapse.hideUndoRedo;

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
        // The view lock (Free/Fixed) is NOT mirrored here — the Composition
        // tab strip owns it (`EditorTabs.tsx`, the lock button in its panel
        // actions), so a copy would be a second switch for one state.
        { type: 'checkbox', id: 'draft-3d', label: 'Draft 3D — fast preview, skips lights, shadows & DOF', checked: draft3d, onChange: () => useGuidesStore.getState().toggleDraft3d() },
        { type: 'checkbox', id: 'ground-grid', label: '3D Ground Plane', checked: groundGridVisible, onChange: () => useGuidesStore.getState().toggleGroundGridVisible() },
        { type: 'checkbox', id: 'layer-boxes', label: 'Layer Bounding Boxes', checked: layerBoxesVisible, onChange: () => usePreferenceStore.getState().set('showLayerBounds', !usePreferenceStore.getState().showLayerBounds) },
        { type: 'checkbox', id: 'device-wireframes', label: 'Camera & Light Wireframes for Unselected Layers', checked: deviceWireframesAll, onChange: () => usePreferenceStore.getState().set('deviceWireframesAll', !usePreferenceStore.getState().deviceWireframesAll) },
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
    for (const t of MASK_TOOLS) {
      overflowItems.push({ type: 'item', id: `${t.id}-item`, label: t.label, icon: t.icon, onSelect: () => setTool(t.id) });
    }
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

  if (collapse.hideUndoRedo && !mac) {
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

  const penItems: ToolFlyoutItem[] = [
    ...flyoutItems(PEN_TOOLS, setTool),
    {
      id: KNIFE_FLYOUT.tool,
      label: KNIFE_FLYOUT.label,
      // The Knife's "(K)" used to be typed into its label alongside a comment
      // saying it had no shortcut. It does: Providers binds `tool.knife` to K.
      // Read live like every other row, so the row and the binding cannot drift
      // again in either direction.
      shortcut: toolShortcut(KNIFE_FLYOUT.tool),
      icon: KNIFE_FLYOUT.icon,
      onSelect: () => setTool(KNIFE_FLYOUT.tool),
      separatorBefore: true,
    },
  ];

  return (
    <div className={styles.root} ref={containerRef}>
      <div
        className={mac ? `${styles.toolRow} ${styles.macUnified}` : styles.toolRow}
        role="toolbar"
        aria-label="Tools"
        data-platform={desktop ? getUiPlatform() : 'web'}
        ref={barRef}
      >
        <div className={styles.inner}>
          <div className={styles.left}>
            {/* macOS: this row is the title bar, so it holds the traffic lights. */}
            {mac && <MacWindowControls />}
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

            {/* The File menu — the title bar's on Windows / Linux, the system
                menu bar's on a Mac. Only the web build draws it here. */}
            {!desktop && <AppMenuButton />}
            {!mac && <span className={styles.toolDivider} aria-hidden />}

            {/* Cluster 1: Edit & Drawing Tools */}
            <div className={styles.toolGroup}>
              <ToolFlyout
                icon={pointerDropdownTool.icon}
                label={withShortcut(pointerDropdownTool)}
                shortcut={toolShortcut(pointerDropdownTool.id)}
                active={isPointerActive}
                items={flyoutItems(POINTER_TOOLS, setTool)}
              />
              <ToolFlyout
                icon={penDropdownTool.icon}
                label={withShortcut(penDropdownTool)}
                shortcut={toolShortcut(penDropdownTool.id)}
                active={isPenActive}
                items={penItems}
                data-tour="pen-tool"
              />
              {/* The Type tools share a flyout, like AE's long-press group. */}
              <ToolFlyout
                icon={textDropdownTool.icon}
                label={withShortcut(textDropdownTool)}
                shortcut={toolShortcut(textDropdownTool.id)}
                active={isTextActive}
                items={flyoutItems(TEXT_TOOLS, setTool)}
              />
              <ToolFlyout
                icon={shapeDropdownTool.icon}
                label={withShortcut(shapeDropdownTool)}
                shortcut={toolShortcut(shapeDropdownTool.id)}
                active={isShapeActive}
                items={flyoutItems(SHAPE_TOOLS, setTool)}
                data-tour="shape-tool"
              />
              {/* Tools plugins contribute — one flyout for all of them, and
                  nothing at all when none are installed. */}
              <PluginToolsFlyout />
            </div>

            {/* Cluster 2: Mask & Puppet Tools (conditionally rendered) */}
            {(!hideMask || !hidePuppet) && (
              <>
                <span className={styles.toolDivider} aria-hidden />
                <div className={styles.toolGroup}>
                  {!hideMask && (
                    <ToolFlyout
                      icon={maskDropdownTool.icon}
                      label={withShortcut(maskDropdownTool)}
                      shortcut={toolShortcut(maskDropdownTool.id)}
                      active={isMaskActive}
                      items={flyoutItems(MASK_TOOLS, setTool)}
                    />
                  )}

                  {!hidePuppet && (
                    <>
                      <ToolFlyout
                        icon={PUPPET_PIN_ICONS[puppetPinKind]}
                        label={toolLabelWithShortcut(puppetPinLabel(puppetPinKind), 'puppet-pin')}
                        title={`${puppetPinLabel(puppetPinKind)}${rigHint}`}
                        shortcut={toolShortcut('puppet-pin')}
                        active={isPuppetActive}
                        disabled={!canRig}
                        items={PIN_KIND_CATALOG.map((k) => ({
                          id: `puppet-${k.kind}`,
                          label: k.label,
                          icon: PUPPET_PIN_ICONS[k.kind],
                          onSelect: () => armPuppet(k.kind),
                        }))}
                      />
                      {/*
                        Keeps the native `title` rather than a <Tooltip>: this
                        button is DISABLED whenever the selection cannot be
                        rigged, and `rigHint` is the text that says why. Radix
                        tooltips never open on a disabled trigger (it fires no
                        pointer events), so the one state where the explanation
                        matters most is the one state a Tooltip would go silent.
                      */}
                      <button
                        type="button"
                        className={activeTool === BONE_TOOL.id ? styles.toolActive : styles.tool}
                        title={`${withShortcut(BONE_TOOL)}${rigHint}`}
                        aria-label={withShortcut(BONE_TOOL)}
                        aria-pressed={activeTool === BONE_TOOL.id}
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
                  <button type="button" className={styles.toolDropdownTrigger} aria-label="New layer" aria-haspopup="menu" title="New Layer (Shape, Text, Solid, Null, Camera, Light, 3D…)">
                    <Icon name="layer-plus" size="md" />
                    <Icon name="chevron-down" size="sm" className={styles.chevron} />
                  </button>
                }
                items={[
                  // The shape / text inserts (pointer placement, comp-scaled size) run off-document → ONE pasteLayers entry.
                  { type: 'item', id: 'new-shape', label: 'Shape Layer', icon: 'shape', onSelect: () => { const t = activeInsertTarget(); if (t) void insertBuiltLayers('New Shape Layer', t.comp, () => insertPrimitive('shape', 'Shape')); } },
                  { type: 'item', id: 'new-text', label: 'Text Layer', icon: 'type', onSelect: () => { const t = activeInsertTarget(); if (t) void insertBuiltLayers('New Text Layer', t.comp, () => insertPrimitive('text', 'Text')); } },
                  { type: 'item', id: 'new-solid', label: 'Solid…', icon: 'solid', onSelect: () => openSolidSettings({ mode: 'new' }) },
                  { type: 'separator' },
                  { type: 'item', id: 'new-group', label: 'Group', icon: 'layers', onSelect: () => { void createLayerEdit('group', { name: 'Group', label: 'New Group' }); } },
                  { type: 'item', id: 'new-null', label: 'Null Object', icon: 'crosshair', onSelect: () => { void createLayerEdit('null', { name: 'Null', label: 'New Null Object' }); } },
                  { type: 'item', id: 'new-adjustment', label: 'Adjustment Layer', icon: 'adjustment', onSelect: () => { void createLayerEdit('adjustment', { name: 'Adjustment Layer 1', label: 'New Adjustment Layer' }); } },
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
                          onSelect: () => { void createLayerEdit('precomp', { source: c.id, label: 'Add Composition' }); },
                        })),
                      }] satisfies DropdownItem[])
                    : []),
                  { type: 'separator' },
                  // The AE-style options dialogs. These existed, fully built, with
                  // no importer — so both menu items silently inserted a hardcoded
                  // seed and every camera and light in the app was identical.
                  { type: 'item', id: 'new-camera', label: 'Camera…', icon: 'camera', onSelect: () => openCameraDialog() },
                  { type: 'item', id: 'new-light', label: 'Light…', icon: 'light', onSelect: () => openLightDialog() },
                  { type: 'item', id: 'new-particle', label: 'Particle System', icon: 'sparkles', onSelect: () => { void createLayerEdit('particle', { name: 'Particles 1', label: 'New Particle System' }); } },
                  { type: 'separator' },
                  { type: 'item', id: 'new-3d-text', label: '3D Extruded Text', icon: 'text-3d', onSelect: () => insert3DText('3D TEXT') },
                  { type: 'item', id: 'new-3d-cube', label: '3D Cube', icon: 'cube', onSelect: () => insert3DPrimitive('cube') },
                  { type: 'item', id: 'new-3d-sphere', label: '3D Sphere', icon: 'sphere', onSelect: () => insert3DPrimitive('sphere') },
                  { type: 'item', id: 'new-3d-cylinder', label: '3D Cylinder', icon: 'cylinder', onSelect: () => insert3DPrimitive('cylinder') },
                  // The parametrised route to the same family, plus the shapes a
                  // fixed default cannot express (a torus IS its ring/tube ratio).
                  { type: 'item', id: 'new-3d-primitive', label: '3D Primitive…', icon: 'sphere', onSelect: () => openPrimitiveDialog() },
                  { type: 'separator' },
                  { type: 'item', id: 'new-audio', label: 'Audio…', icon: 'audio', onSelect: () => audioInputRef.current?.click() },
                  { type: 'item', id: 'new-image-sequence', label: 'Image Sequence…', icon: 'media', onSelect: () => seqInputRef.current?.click() },
                  { type: 'item', id: 'import-lottie', label: 'Import .lottie / .json Animation…', icon: 'upload', onSelect: () => lottieInputRef.current?.click() },
                ]}
              />
              <input ref={audioInputRef} type="file" accept="audio/*" hidden onChange={onPickAudio} />
              <input ref={seqInputRef} type="file" accept="image/*" multiple hidden onChange={onPickSequence} />
              <input ref={lottieInputRef} type="file" accept=".json,.lottie,application/json,application/x-lottie" hidden onChange={onPickLottie} />

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
                      aria-haspopup="menu"
                      title={selectedId ? 'Animation presets & rigging (Easy Ease, Typewriter, Bounce, Rig)…' : 'Select a layer to apply animation presets'}
                      disabled={!selectedId}
                    >
                      <Icon name="magic-wand" size="md" />
                      <Icon name="chevron-down" size="sm" className={styles.chevron} />
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
                      <button type="button" className={styles.tool} aria-label="More tools" aria-haspopup="menu" title="More tools">
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
                    title={`Undo  (${UNDO_CHORD})`}
                    disabled={!canUndo}
                    onClick={() => performUndo()}
                  >
                    <Icon name="undo" size="md" />
                  </button>
                  <button
                    type="button"
                    className={styles.tool}
                    aria-label="Redo"
                    title={`Redo  (${REDO_CHORD})`}
                    disabled={!canRedo}
                    onClick={() => performRedo()}
                  >
                    <Icon name="redo" size="md" />
                  </button>
                </div>
              </>
            )}
          </div>

          {/* Centre: project / comp / workspace. On Windows / Linux the title
              bar carries these; the macOS toolbar and the web build have
              nowhere else to put them. */}
          <div className={styles.center}>
            {mac && <ProjectStatus />}
            {!desktop && (
              <>
                <ProjectStatus compact />
                <CompChip />
                <Dropdown
                  placement="bottom-end"
                  trigger={
                    <IconButton aria-label="Workspaces" size="sm" title="Workspaces & Layout Presets">
                      <Icon name="layout" size="md" />
                    </IconButton>
                  }
                  items={buildWorkspaceItems()}
                />
                <IconButton
                  aria-label="Customize"
                  size="sm"
                  title="Customize (Shortcuts, Workspaces, Appearance)"
                  onClick={() => openCustomizeDialog()}
                >
                  <Icon name="settings" size="md" />
                </IconButton>
              </>
            )}
          </div>

          <div className={styles.right}>
            {!mac && <span className={styles.toolHint}>{activeTool}</span>}
            {/* macOS: the actions the Windows / Linux title bar holds, in the
                same order. No gear — Settings… is in the app menu (⌘,). */}
            {mac && (
              <>
                <UpdateButton />
                <EditorChromeActions showCustomize={false} />
              </>
            )}
            {!desktop && (
              <>
                <span className={styles.toolDivider} aria-hidden />
                <div className={styles.toolGroup}>
                  <Button
                    size="sm"
                    variant="secondary"
                    leftIcon={<Icon name="play" size="sm" weight="fill" />}
                    title="Preview presentation (Fullscreen)"
                    onClick={() => enterPresentation()}
                  >
                    Preview
                  </Button>
                  <Button
                    size="sm"
                    variant="primary"
                    leftIcon={<Icon name="export" size="sm" weight="bold" />}
                    title="Export composition…"
                    data-tour="export"
                    onClick={() => openExportDialog(compDuration, compFps)}
                  >
                    Export
                  </Button>
                </div>
              </>
            )}
          </div>
        </div>
      </div>
      <ToolOptionsBar />
    </div>
  );
}
