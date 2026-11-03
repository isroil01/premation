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
import { performUndo, performRedo, historyView, subscribeHistory } from '@stores/historyStore';
import { Button } from '@components/Button';
import { IconButton } from '@components/IconButton';
import { Icon, type IconName } from '@components/Icon';
import { ToolOptionsBar } from './ToolOptionsBar';
import { ToolFlyout, type ToolFlyoutItem } from './ToolFlyout';
import { toolShortcut, toolLabelWithShortcut } from './toolShortcuts';
import { useElementWidth } from './useElementWidth';
import { collapseFor } from './toolbarCollapse';
import { useActiveWorkspace, useProjectStore } from '@stores/projectStore';
import { insertPrimitiveEdit, insert3DPrimitiveEdit, insert3DTextEdit } from '@/engine-client/insertEdits';
import { insertMediaEdit } from '@layout/Workspace/footageEdits';
import { typewriterEdit } from '@layout/Text/textEdits';
import { TEXT_RIGS, addExpressionControlEdit, insertImageSequenceEdit, textRigEdit } from './topNavEdits';
import { openCameraDialog, openLightDialog, openPrimitiveDialog } from '@layout/Workspace/SceneInsertDialogs';
import { openSolidSettings } from '@layout/Composition/LayerSettingsDialog';
import { useGuidesStore } from '@stores/guidesStore';
import { importLottieFileEdit } from '@layout/EditorLayout/lottieInsertEdits';
import { activeInsertTarget } from '@layout/Scene/activeInsertTarget';
import { Dropdown, type DropdownItem } from '@components/Dropdown';
import { listPresets } from '@core/animation/animationPresets';
import { applyAnimationPresetEdit, createLayerEdit } from '@layout/Menu/appEdits';
import { describeBounce, revealBounce } from '@core/animation/bounce';
import { bounceEdit } from '@layout/Motion/bounceEdits';
import { useBounceStore, currentSquash } from '@stores/bounceStore';
import { CONTROL_COMPONENTS, type ControlKind } from '@core/animation/expressionControls';
import { asCommandId } from '@app-types/common';
import { t } from '@core/i18n';

/** The control kinds offered in the rig menu, in the order AE lists them. */
function controlKinds(): ReadonlyArray<{ kind: ControlKind; label: string }> {
  return [
    { kind: 'slider', label: t('topNav.animate.sliderControl', 'Slider Control') },
    { kind: 'angle', label: t('topNav.animate.angleControl', 'Angle Control') },
    { kind: 'point', label: t('topNav.animate.pointControl', 'Point Control') },
    { kind: 'color', label: t('topNav.animate.colorControl', 'Color Control') },
    { kind: 'checkbox', label: t('topNav.animate.checkboxControl', 'Checkbox Control') },
    { kind: 'dropdown', label: t('topNav.animate.dropdownControl', 'Dropdown Control') },
    { kind: 'layer', label: t('topNav.animate.layerControl', 'Layer Control') },
  ];
}
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
import { pluginLayerTypes } from '@core/nativePlugins/pluginContrib';
import { usePluginContrib } from '@hooks/usePluginContrib';
import { newPluginLayerFromEditor } from '@layout/Menu/pluginMenu';

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
  /** What the tool does, shown on hover — the menu row itself stays a short name. */
  hint?: string;
}

/** Tool families are functions: `t()` must run at render time, never at module scope. */
const pointerTools = (): ToolDef[] => [
  { id: 'select',        icon: 'mouse-pointer', label: t('topNav.tools.select', 'Selection Tool') },
  { id: 'direct-select', icon: 'direct-select', label: t('topNav.tools.directSelect', 'Direct Selection Tool') },
  { id: 'rotate',        icon: 'rotate',        label: t('topNav.tools.rotate', 'Rotation Tool') },
  { id: 'pan-behind',    icon: 'pan-behind',    label: t('topNav.tools.panBehind', 'Pan Behind (Anchor Point) Tool') },
  { id: 'hand',          icon: 'hand',          label: t('topNav.tools.hand', 'Hand Tool') },
  { id: 'zoom',          icon: 'zoom-in',       label: t('topNav.tools.zoom', 'Zoom Tool') },
];

const penTools = (): ToolDef[] => [
  { id: 'pen',      icon: 'pen',        label: t('topNav.tools.pen', 'Pen'),       hint: t('topNav.tools.penHint', 'Click for corners, drag for curves') },
  { id: 'curvature',icon: 'curvature',  label: t('topNav.tools.curvature', 'Curvature'), hint: t('topNav.tools.curvatureHint', 'Every click makes a smooth curve') },
  { id: 'pencil',   icon: 'pencil',     label: t('topNav.tools.pencil', 'Pencil'),    hint: t('topNav.tools.pencilHint', 'Freehand line of even width') },
  { id: 'brush',    icon: 'brush',      label: t('topNav.tools.brush', 'Brush'),     hint: t('topNav.tools.brushHint', 'Filled ink stroke; width follows pen pressure') },
  // Split out of the Brush, which used to turn into this on its own whenever
  // the pointer happened to land on the selected layer.
  { id: 'paint',    icon: 'paint',      label: t('topNav.tools.paint', 'Paint'),     hint: t('topNav.tools.paintHint', 'Paint onto the selected layer') },
  { id: 'eraser',   icon: 'eraser',     label: t('topNav.tools.eraser', 'Eraser'),    hint: t('topNav.tools.eraserHint', 'Erase paint on the selected layer') },
  // AE's Pen flyout. The Pen does all three on its own (over a segment it
  // adds, over a vertex it converts); these do one thing wherever they land.
  { id: 'add-vertex',     icon: 'add-vertex',     label: t('topNav.tools.addPoint', 'Add Point'),     hint: t('topNav.tools.addPointHint', 'Click a path to add a point') },
  { id: 'delete-vertex',  icon: 'delete-vertex',  label: t('topNav.tools.deletePoint', 'Delete Point'),  hint: t('topNav.tools.deletePointHint', 'Click a point to remove it') },
  { id: 'convert-vertex', icon: 'convert-vertex', label: t('topNav.tools.convertPoint', 'Convert Point'), hint: t('topNav.tools.convertPointHint', 'Toggle a point between corner and smooth') },
  { id: 'mask-feather',   icon: 'mask-feather',   label: t('topNav.tools.maskFeather', 'Mask Feather'),  hint: t('topNav.tools.maskFeatherHint', 'Add variable feather points to a mask') },
];

/**
 * The Knife, appended to the Pen flyout — it EDITS an outline rather than
 * drawing one, which is why it sits with the pen tools and not the shapes.
 *
 * Its key is Shift+K (`tool.knife` in Providers' tool commands), so it is
 * rebindable and in the palette like every other tool; it stays out of
 * `PEN_TOOLS` only because the Pen flyout lists the pen family proper.
 */
const KNIFE_FLYOUT = {
  tool: 'knife' as Tool,
  icon: 'knife' as IconName,
  label: (): string => t('topNav.tools.knife', 'Knife'),
  hint: (): string => t('topNav.tools.knifeHint', 'Drag across a shape to cut its path'),
};

const shapeTools = (): ToolDef[] => [
  { id: 'shape',    icon: 'square',     label: t('topNav.tools.rectangle', 'Rectangle Tool') },
  { id: 'ellipse',  icon: 'circle',     label: t('topNav.tools.ellipse', 'Ellipse Tool') },
  { id: 'polygon',  icon: 'polygon',    label: t('topNav.tools.polygon', 'Polygon Tool') },
  { id: 'star',     icon: 'star',       label: t('topNav.tools.star', 'Star Tool') },
  { id: 'line',     icon: 'line',       label: t('topNav.tools.line', 'Line Segment') },
];

/** AE's Type tool family: horizontal and vertical (Ctrl+T cycles them). */
const textTools = (): ToolDef[] => [
  { id: 'text', icon: 'type', label: t('topNav.tools.text', 'Text Tool') },
  { id: 'vertical-text', icon: 'type-vertical', label: t('topNav.tools.verticalText', 'Vertical Type Tool') },
];

const maskTools = (): ToolDef[] => [
  { id: 'mask-rect',    icon: 'mask-square', label: t('topNav.tools.maskRect', 'Rectangle Mask Tool') },
  { id: 'mask-ellipse', icon: 'mask-circle', label: t('topNav.tools.maskEllipse', 'Ellipse Mask Tool') },
  // Where the Pen's old implicit masking went, so nothing was lost by making
  // the plain Pen always draw a path layer.
  { id: 'mask-pen',     icon: 'mask-pen',    label: t('topNav.tools.maskPen', 'Pen Mask Tool') },
];

const boneTool = (): ToolDef => ({ id: 'bone', icon: 'bone', label: t('topNav.tools.bone', 'Bone Tool') });

/**
 * AE 26.2's Object Matte group, one toolbar slot: Object Matte (hover, click,
 * propagate), Quick Selection (the Roto Brush: strokes that snap to the
 * subject's edges), Selection Brush (paints the selection exactly) and Refine
 * Edge (paint over hair). Alt+W cycles them.
 */
const rotoTools = (): ToolDef[] => [
  { id: 'object-matte', icon: 'object-matte', label: t('topNav.tools.objectMatte', 'Object Matte Tool'), hint: t('topNav.tools.objectMatteHint', 'Hover a subject to preview its matte, click to select it') },
  { id: 'roto', icon: 'magic-wand', label: t('topNav.tools.quickSelection', 'Quick Selection Tool'), hint: t('topNav.tools.quickSelectionHint', 'Paint over the subject and the selection snaps to its edges; Alt-paint takes away') },
  { id: 'selection-brush', icon: 'brush', label: t('topNav.tools.selectionBrush', 'Selection Brush Tool'), hint: t('topNav.tools.selectionBrushHint', 'Paint the selection exactly where you brush; Alt-paint erases it') },
  { id: 'refine-edge', icon: 'mask-feather', label: t('topNav.tools.refineEdge', 'Refine Edge Tool'), hint: t('topNav.tools.refineEdgeHint', 'Paint over hair and fur so the edge is refined there') },
];

/** "Selection Tool (V)" — the ACCESSIBLE name, chord read live from the registry. */
const withShortcut = (tool: ToolDef): string => toolLabelWithShortcut(tool.label, tool.id);

/**
 * A tool family as flyout entries.
 *
 * The chord goes in the menu row's SHORTCUT COLUMN rather than glued to the end
 * of the label, which is where every other menu in the app puts one and is the
 * only reason these rows used to look different from a File menu row.
 */
const flyoutItems = (tools: ReadonlyArray<ToolDef>, setTool: (t: Tool) => void): ToolFlyoutItem[] =>
  tools.map((tool) => ({
    id: tool.id,
    label: tool.label,
    hint: tool.hint,
    shortcut: toolShortcut(tool.id),
    icon: tool.icon,
    onSelect: () => setTool(tool.id),
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
        if (ok) notify(t('topNav.animate.applied', 'Applied “{name}”', { name: p.name }));
      });
    },
  }));

  return [
    ...presetItems,
    { type: 'separator' },
    // Text-animator rigs: addPropertyGroup (animator + init) then the selector's options and keys, one entry.
    { type: 'item', id: 'anim-typewriter', label: t('topNav.animate.typewriter', 'Typewriter (text)'), icon: 'type', disabled: !isTextLayer, onSelect: () => { void typewriterEdit(id, playhead).then((ok) => { if (ok) notify(t('topNav.animate.typewriterCreated', 'Typewriter rig created')); }); } },
    { type: 'item', id: 'anim-bounce-in-words', label: t('topNav.animate.bounceInWords', 'Bounce In Words (text)'), icon: 'type', disabled: !isTextLayer, onSelect: () => { void textRigEdit(id, TEXT_RIGS.bounceInWords, playhead).then((ok) => { if (ok) notify(t('topNav.animate.bounceInWordsCreated', 'Bounce In Words rig created')); }); } },
    { type: 'item', id: 'anim-spin-fade-chars', label: t('topNav.animate.spinFadeChars', 'Spin & Fade Characters (text)'), icon: 'type', disabled: !isTextLayer, onSelect: () => { void textRigEdit(id, TEXT_RIGS.spinFadeCharacters, playhead).then((ok) => { if (ok) notify(t('topNav.animate.spinFadeCharsCreated', 'Spin & Fade Characters rig created')); }); } },
    { type: 'item', id: 'anim-tracking-reveal', label: t('topNav.animate.trackingReveal', 'Tracking Reveal (text)'), icon: 'type', disabled: !isTextLayer, onSelect: () => { void textRigEdit(id, TEXT_RIGS.trackingReveal, playhead).then((ok) => { if (ok) notify(t('topNav.animate.trackingRevealCreated', 'Tracking Reveal rig created')); }); } },
    { type: 'separator' },
    { type: 'item', id: 'anim-ease-all', label: t('topNav.animate.easeAll', 'Easy Ease All Keyframes'), icon: 'track', onSelect: () => { void getCommandSystem().execute(asCommandId('animation.easyEaseAll')); } },
    // Applies the settings the Bounce section in the Graph panel is showing —
    // the menu is a shortcut to that panel's current shape, not a second,
    // hardcoded bounce. `applyBounce` (not `bounceKeyframes`) so the item is
    // never a no-op: with nothing to rebound from it generates the fall too.
    // Off-document, sent as setKeyframes (layout/Motion/bounceEdits.ts): one entry.
    { type: 'item', id: 'anim-bounce', label: t('topNav.animate.bounce', 'Bounce'), icon: 'track', onSelect: () => { const s = useBounceStore.getState(); void bounceEdit(id, { atTime: playhead, mode: 'auto', drop: s.drop, bounce: s.bounce, squash: currentSquash() }).then((r) => { if (r) { revealBounce(id); notify(describeBounce(r)); } else notify(t('topNav.animate.nothingToBounce', 'Nothing to bounce — check the layer is unlocked'), 'warning'); }); } },
    { type: 'item', id: 'anim-reverse', label: t('topNav.animate.timeReverse', 'Time-Reverse Keyframes'), icon: 'skip-back', onSelect: () => { void getCommandSystem().execute(asCommandId('animation.timeReverseKeyframes')); } },
    // Sequence / stagger live as registered commands (Animation menu + palette);
    // TopNav reuses them so the prompt and undo path stay one.
    { type: 'item', id: 'anim-sequence-bars', label: t('topNav.animate.sequenceLayers', 'Sequence Layers…'), icon: 'layers', disabled: selectedIds.length < 2, onSelect: () => { void getCommandSystem().execute(asCommandId('animation.sequenceLayerBars')); } },
    { type: 'item', id: 'anim-stagger-layers', label: t('topNav.animate.staggerLayers', 'Stagger Layers…'), icon: 'layers', disabled: selectedIds.length < 2, onSelect: () => { void getCommandSystem().execute(asCommandId('animation.staggerLayers')); } },
    { type: 'item', id: 'anim-sequence', label: t('topNav.animate.staggerAnimations', 'Stagger Animations…'), icon: 'layers', disabled: selectedIds.length < 2, onSelect: () => { void getCommandSystem().execute(asCommandId('animation.sequenceLayers')); } },
    { type: 'separator' },
    {
      type: 'item',
      id: 'anim-control',
      label: t('topNav.animate.addControl', 'Add Expression Control (rig)'),
      icon: 'settings',
      // A submenu rather than seven flat entries: every kind resolves through
      // the same `ctrl(name)` accessor, so they belong together as one action
      // with a type, not as seven unrelated commands.
      submenu: controlKinds().map((k) => ({
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
            notify(t('topNav.animate.controlAdded', 'Added “{name}” — reference it with {refs}', { name, refs }));
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
  const label = activePristine ? t('topNav.comp.none', 'No composition') : name || t('topNav.comp.untitled', 'Untitled');
  return (
    <button type="button" className={styles.comp} title={t('topNav.comp.settings', 'Composition settings')} onClick={() => openCompositionSettings()}>
      <Icon name="layers" size="sm" className={styles.compIcon} />
      <span className={styles.compName}>{label}</span>
      <span className={styles.compMeta}>{width}×{height} · {fps}fps</span>
    </button>
  );
}

export function TopNav(): JSX.Element {
  const navigate = useNavigate();
  // SDK 1.4: re-render when plugins load, reload or go (their layer types are in the New Layer menu).
  usePluginContrib();
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
  const POINTER_TOOLS = pointerTools();
  const PEN_TOOLS = penTools();
  const SHAPE_TOOLS = shapeTools();
  const TEXT_TOOLS = textTools();
  const MASK_TOOLS = maskTools();
  const BONE_TOOL = boneTool();
  const ROTO_TOOLS = rotoTools();

  const playhead = useActiveWorkspace()?.time ?? 0;
  const snap = useUIStore((s) => s.snap);
  const toggleSnap = useUIStore((s) => s.toggleSnap);
  // Mirrored into the narrow-screen overflow menu, so subscribe rather than
  // reading getState at render time (a getState read never re-renders, so
  // the overflow checkmarks would go stale the moment the value changed).
  const draft3d = useGuidesStore((s) => s.draft3d);
  const groundGridVisible = useGuidesStore((s) => s.groundGridVisible);
  const extendedViewer = useGuidesStore((s) => s.extendedViewer);
  const layerBoxesVisible = usePreferenceStore((s) => s.showLayerBounds);
  const deviceWireframesAll = usePreferenceStore((s) => s.deviceWireframesAll);

  const [canUndo, setCanUndo] = useState(() => historyView().canUndo);
  const [canRedo, setCanRedo] = useState(() => historyView().canRedo);

  useEffect(() => subscribeHistory(() => {
    const h = historyView();
    setCanUndo(h.canUndo);
    setCanRedo(h.canRedo);
  }), []);

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
    ? { id: KNIFE_FLYOUT.tool, icon: KNIFE_FLYOUT.icon, label: KNIFE_FLYOUT.label() }
    : PEN_TOOLS.find(t => t.id === (isPenActive ? activeTool : lastPenTool)) || PEN_TOOLS[0]!;

  const isTextActive = TEXT_TOOLS.some(t => t.id === activeTool);
  const textDropdownTool = TEXT_TOOLS.find(t => t.id === activeTool) || TEXT_TOOLS[0]!;

  const isShapeActive = SHAPE_TOOLS.some(t => t.id === activeTool);
  const shapeDropdownTool = SHAPE_TOOLS.find(t => t.id === (isShapeActive ? activeTool : lastShapeTool)) || SHAPE_TOOLS[0]!;

  // The three mask tools were three permanent buttons while the three shape
  // tools beside them — the same kind of choice, one active at a time — were
  // one menu. Same shape of decision, same control.
  const isMaskFamilyActive = MASK_TOOLS.some(t => t.id === activeTool);
  // The Roto Brush shares the mask flyout (2026-10-19: it was a permanent
  // button beside it; one flyout per family, like AE's long-press groups), and
  // lights the same trigger — picking it must not leave the row with no armed tool.
  const isMaskActive = isMaskFamilyActive;
  const maskDropdownTool: ToolDef =
    MASK_TOOLS.find(t => t.id === (isMaskFamilyActive ? activeTool : lastMaskTool)) || MASK_TOOLS[0]!;
  const isRotoActive = ROTO_TOOLS.some(t => t.id === activeTool);
  const rotoDropdownTool: ToolDef = ROTO_TOOLS.find(t => t.id === activeTool) || ROTO_TOOLS[0]!;

  const isPuppetActive = activeTool === 'puppet-pin';
  // The Bone tool shares the puppet flyout the same way.
  const isBoneActive = activeTool === BONE_TOOL.id;
  const armPuppet = (kind: typeof puppetPinKind): void => {
    setPuppetPinKind(kind);
    setTool('puppet-pin');
  };

  useEffect(() => {
    if (isPointerActive) setLastPointerTool(activeTool);
    if (isPenActive) setLastPenTool(activeTool);
    if (isShapeActive) setLastShapeTool(activeTool);
    if (isMaskFamilyActive) setLastMaskTool(activeTool);
  }, [activeTool, isPointerActive, isPenActive, isShapeActive, isMaskFamilyActive]);

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
      label: t('topNav.overflow.cameraNav', 'Camera Navigation'),
      icon: 'camera',
      submenu: [
        { type: 'item', id: 'cam-orbit', label: t('topNav.overflow.orbitCamera', 'Orbit Camera'), icon: 'orbit', onSelect: () => useGuidesStore.getState().setCameraTool('orbit') },
        { type: 'item', id: 'cam-pan', label: t('topNav.overflow.panCamera', 'Pan Camera'), icon: 'pan-camera', onSelect: () => useGuidesStore.getState().setCameraTool('pan') },
        { type: 'item', id: 'cam-dolly', label: t('topNav.overflow.dollyCamera', 'Dolly Camera'), icon: 'perspective', onSelect: () => useGuidesStore.getState().setCameraTool('dolly') },
      ]
    });
    overflowItems.push({
      type: 'item',
      id: '3d-gizmos',
      label: t('topNav.overflow.gizmoModes', '3D Gizmo Modes'),
      icon: 'gizmo-universal',
      submenu: [
        { type: 'item', id: 'gizmo-universal', label: t('topNav.overflow.gizmoUniversal', 'Universal Gizmo'), icon: 'gizmo-universal', onSelect: () => useGuidesStore.getState().setGizmo3dState('universal') },
        { type: 'item', id: 'gizmo-position', label: t('topNav.overflow.gizmoPosition', 'Position Gizmo'), icon: 'gizmo-position', onSelect: () => useGuidesStore.getState().setGizmo3dState('position') },
        { type: 'item', id: 'gizmo-scale', label: t('topNav.overflow.gizmoScale', 'Scale Gizmo'), icon: 'gizmo-scale', onSelect: () => useGuidesStore.getState().setGizmo3dState('scale') },
        { type: 'item', id: 'gizmo-rotation', label: t('topNav.overflow.gizmoRotation', 'Rotation Gizmo'), icon: 'gizmo-rotation', onSelect: () => useGuidesStore.getState().setGizmo3dState('rotation') },
      ]
    });
    overflowItems.push({
      type: 'item',
      id: '3d-toggles',
      label: t('topNav.overflow.options3d', '3D Options'),
      icon: 'zap',
      submenu: [
        // The view lock (Free/Fixed) is NOT mirrored here — the Composition
        // tab strip owns it (`EditorTabs.tsx`, the lock button in its panel
        // actions), so a copy would be a second switch for one state.
        { type: 'checkbox', id: 'draft-3d', label: t('topNav.overflow.draft3d', 'Draft 3D — ambient + key light only; no shadows, SSAO, DOF or reflections'), checked: draft3d, onChange: () => useGuidesStore.getState().toggleDraft3d() },
        { type: 'checkbox', id: 'ground-grid', label: t('topNav.overflow.groundPlane', '3D Ground Plane'), checked: groundGridVisible, onChange: () => useGuidesStore.getState().toggleGroundGridVisible() },
        { type: 'checkbox', id: 'extended-viewer', label: t('topNav.overflow.extendedViewer', 'Extended Viewer — Draw Layers Outside the Comp Frame'), checked: extendedViewer, onChange: () => useGuidesStore.getState().toggleExtendedViewer() },
        { type: 'checkbox', id: 'layer-boxes', label: t('topNav.overflow.layerBoxes', 'Layer Bounding Boxes'), checked: layerBoxesVisible, onChange: () => usePreferenceStore.getState().set('showLayerBounds', !usePreferenceStore.getState().showLayerBounds) },
        { type: 'checkbox', id: 'device-wireframes', label: t('topNav.overflow.deviceWireframes', 'Camera & Light Wireframes for Unselected Layers'), checked: deviceWireframesAll, onChange: () => usePreferenceStore.getState().set('deviceWireframesAll', !usePreferenceStore.getState().deviceWireframesAll) },
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
      label: t('topNav.overflow.animateLayer', 'Animate Layer'),
      icon: 'magic-wand',
      submenu: buildAnimateItems(selectedIds, isTextLayer, playhead)
    });
  }

  if (hideMask) {
    pushSeparator();
    for (const tool of [...MASK_TOOLS, ...ROTO_TOOLS]) {
      overflowItems.push({ type: 'item', id: `${tool.id}-item`, label: tool.label, icon: tool.icon, onSelect: () => setTool(tool.id) });
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
      label: BONE_TOOL.label,
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
      label: t('topNav.overflow.toggleSnapping', 'Toggle Snapping'),
      checked: snap,
      onChange: toggleSnap
    });
  }

  if (collapse.hideUndoRedo && !mac) {
    pushSeparator();
    overflowItems.push({
      type: 'item',
      id: 'undo-item',
      label: t('topNav.undo', 'Undo'),
      icon: 'undo',
      disabled: !canUndo,
      onSelect: () => performUndo()
    });
    overflowItems.push({
      type: 'item',
      id: 'redo-item',
      label: t('topNav.redo', 'Redo'),
      icon: 'redo',
      disabled: !canRedo,
      onSelect: () => performRedo()
    });
  }

  const penItems: ToolFlyoutItem[] = [
    ...flyoutItems(PEN_TOOLS, setTool),
    {
      id: KNIFE_FLYOUT.tool,
      label: KNIFE_FLYOUT.label(),
      hint: KNIFE_FLYOUT.hint(),
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
        aria-label={t('topNav.toolbar', 'Tools')}
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
                aria-label={t('topNav.backToDashboard', 'Back to Dashboard')}
                size="sm"
                className={styles.back}
                onClick={() => navigate('/')}
              >
                <Icon name="arrow-left" size="sm" />
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
            </div>

            {/* Cluster 2: Mask & Puppet Tools (conditionally rendered) */}
            {(!hideMask || !hidePuppet) && (
              <>
                <span className={styles.toolDivider} aria-hidden />
                <div className={styles.toolGroup}>
                  {!hideMask && (
                    /* The three mask tools: one flyout. */
                    <ToolFlyout
                      icon={maskDropdownTool.icon}
                      label={withShortcut(maskDropdownTool)}
                      shortcut={toolShortcut(maskDropdownTool.id)}
                      active={isMaskActive}
                      items={flyoutItems(MASK_TOOLS, setTool)}
                    />
                  )}
                  {!hideMask && (
                    /* AE 26.2: Object Matte has its own slot, the Roto Brush in its flyout. */
                    <ToolFlyout
                      icon={rotoDropdownTool.icon}
                      label={withShortcut(rotoDropdownTool)}
                      shortcut={toolShortcut(rotoDropdownTool.id)}
                      active={isRotoActive}
                      items={flyoutItems(ROTO_TOOLS, setTool)}
                      data-tour="object-matte-tool"
                    />
                  )}

                  {!hidePuppet && (
                    /*
                      The puppet pins and the Bone tool: one flyout. The trigger
                      keeps a native `title` carrying `rigHint` — it is DISABLED
                      whenever the selection cannot be rigged, and the title is
                      where the reason shows (a Radix tooltip never opens on a
                      disabled trigger).
                    */
                    <ToolFlyout
                      icon={isBoneActive ? BONE_TOOL.icon : PUPPET_PIN_ICONS[puppetPinKind]}
                      label={isBoneActive ? withShortcut(BONE_TOOL) : toolLabelWithShortcut(puppetPinLabel(puppetPinKind), 'puppet-pin')}
                      title={canRig
                        ? (isBoneActive ? BONE_TOOL.label : puppetPinLabel(puppetPinKind))
                        : t('topNav.puppet.titleWithHint', '{tool} — select a shape or image layer (use Rig Logo for a group)', {
                            tool: isBoneActive ? BONE_TOOL.label : puppetPinLabel(puppetPinKind),
                          })}
                      shortcut={toolShortcut(isBoneActive ? BONE_TOOL.id : 'puppet-pin')}
                      active={isPuppetActive || isBoneActive}
                      disabled={!canRig}
                      items={[
                        ...PIN_KIND_CATALOG.map((k) => ({
                          id: `puppet-${k.kind}`,
                          label: k.label,
                          icon: PUPPET_PIN_ICONS[k.kind],
                          onSelect: () => armPuppet(k.kind),
                        })),
                        {
                          id: BONE_TOOL.id,
                          label: BONE_TOOL.label,
                          icon: BONE_TOOL.icon,
                          shortcut: toolShortcut(BONE_TOOL.id),
                          separatorBefore: true,
                          onSelect: () => setTool(BONE_TOOL.id),
                        },
                      ]}
                    />
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
                  <button type="button" className={styles.toolDropdownTrigger} aria-label={t('topNav.newLayer.aria', 'New layer')} aria-haspopup="menu" title={t('topNav.newLayer.title', 'New Layer (Shape, Text, Solid, Null, Camera, Light, 3D…)')}>
                    <Icon name="layer-plus" size="lg" />
                    <span className={styles.flyoutMark} aria-hidden />
                  </button>
                }
                items={[
                  // The shape / text inserts (pointer placement, comp-scaled size) run off-document → ONE pasteLayers entry.
                  { type: 'item', id: 'new-shape', label: t('topNav.newLayer.shape', 'Shape Layer'), icon: 'shape', onSelect: () => { const target = activeInsertTarget(); if (target) void insertPrimitiveEdit('shape', 'Shape', 'New Shape Layer', { comp: target.comp }); } },
                  { type: 'item', id: 'new-text', label: t('topNav.newLayer.text', 'Text Layer'), icon: 'type', onSelect: () => { const target = activeInsertTarget(); if (target) void insertPrimitiveEdit('text', 'Text', 'New Text Layer', { comp: target.comp }); } },
                  { type: 'item', id: 'new-solid', label: t('topNav.newLayer.solid', 'Solid…'), icon: 'solid', onSelect: () => openSolidSettings({ mode: 'new' }) },
                  { type: 'separator' },
                  { type: 'item', id: 'new-group', label: t('topNav.newLayer.group', 'Group'), icon: 'layers', onSelect: () => { void createLayerEdit('group', { name: 'Group', label: 'New Group' }); } },
                  { type: 'item', id: 'new-null', label: t('topNav.newLayer.null', 'Null Object'), icon: 'crosshair', onSelect: () => { void createLayerEdit('null', { name: 'Null', label: 'New Null Object' }); } },
                  { type: 'item', id: 'new-adjustment', label: t('topNav.newLayer.adjustment', 'Adjustment Layer'), icon: 'adjustment', onSelect: () => { void createLayerEdit('adjustment', { name: 'Adjustment Layer 1', label: 'New Adjustment Layer' }); } },
                  ...(insertableComps.length > 0
                    ? ([{
                        type: 'item' as const,
                        id: 'new-comp-instance',
                        label: t('topNav.newLayer.composition', 'Composition'),
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
                  { type: 'item', id: 'new-camera', label: t('topNav.newLayer.camera', 'Camera…'), icon: 'camera', onSelect: () => openCameraDialog() },
                  { type: 'item', id: 'new-light', label: t('topNav.newLayer.light', 'Light…'), icon: 'light', onSelect: () => openLightDialog() },
                  { type: 'item', id: 'new-particle', label: t('topNav.newLayer.particle', 'Particle System'), icon: 'sparkles', onSelect: () => { void createLayerEdit('particle', { name: 'Particles 1', label: 'New Particle System' }); } },
                  // SDK 1.4: the layer types of the loaded native plugins (Layer ▸ New lists them too).
                  ...pluginLayerTypes().map((lt) => ({ type: 'item' as const, id: `new-plugin-${lt.type}`, label: lt.name, icon: 'plugin' as const, onSelect: () => { void newPluginLayerFromEditor(lt.type, lt.name); } })),
                  { type: 'separator' },
                  // Built off-document and inserted as ONE pasteLayers entry (like insertShape).
                  { type: 'item', id: 'new-3d-text', label: t('topNav.newLayer.text3d', '3D Extruded Text'), icon: 'text-3d', onSelect: () => { const target = activeInsertTarget(); if (target) void insert3DTextEdit('3D TEXT', 'New 3D Text', { comp: target.comp }); } },
                  { type: 'item', id: 'new-3d-cube', label: t('topNav.newLayer.cube', '3D Cube'), icon: 'cube', onSelect: () => { const target = activeInsertTarget(); if (target) void insert3DPrimitiveEdit('cube', undefined, 'New 3D Cube', { comp: target.comp }); } },
                  { type: 'item', id: 'new-3d-sphere', label: t('topNav.newLayer.sphere', '3D Sphere'), icon: 'sphere', onSelect: () => { const target = activeInsertTarget(); if (target) void insert3DPrimitiveEdit('sphere', undefined, 'New 3D Sphere', { comp: target.comp }); } },
                  { type: 'item', id: 'new-3d-cylinder', label: t('topNav.newLayer.cylinder', '3D Cylinder'), icon: 'cylinder', onSelect: () => { const target = activeInsertTarget(); if (target) void insert3DPrimitiveEdit('cylinder', undefined, 'New 3D Cylinder', { comp: target.comp }); } },
                  // The parametrised route to the same family, plus the shapes a
                  // fixed default cannot express (a torus IS its ring/tube ratio).
                  { type: 'item', id: 'new-3d-primitive', label: t('topNav.newLayer.primitive', '3D Primitive…'), icon: 'sphere', onSelect: () => openPrimitiveDialog() },
                  { type: 'separator' },
                  { type: 'item', id: 'new-audio', label: t('topNav.newLayer.audio', 'Audio…'), icon: 'audio', onSelect: () => audioInputRef.current?.click() },
                  { type: 'item', id: 'new-image-sequence', label: t('topNav.newLayer.imageSequence', 'Image Sequence…'), icon: 'media', onSelect: () => seqInputRef.current?.click() },
                  { type: 'item', id: 'import-lottie', label: t('topNav.newLayer.lottie', 'Import .lottie / .json Animation…'), icon: 'upload', onSelect: () => lottieInputRef.current?.click() },
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
                      aria-label={t('topNav.animate.aria', 'Animate')}
                      aria-haspopup="menu"
                      title={selectedId ? t('topNav.animate.title', 'Animation presets & rigging (Easy Ease, Typewriter, Bounce, Rig)…') : t('topNav.animate.titleNoSelection', 'Select a layer to apply animation presets')}
                      disabled={!selectedId}
                    >
                      <Icon name="magic-wand" size="lg" />
                      <span className={styles.flyoutMark} aria-hidden />
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
                    aria-label={t('topNav.snap.aria', 'Toggle snapping')}
                    aria-pressed={snap}
                    title={snap ? t('topNav.snap.on', 'Snapping ON — Magnetically snaps layers & playhead (Click to disable)') : t('topNav.snap.off', 'Snapping OFF — Click to enable magnetic snapping')}
                    onClick={toggleSnap}
                  >
                    <Icon name="magnet" size="lg" />
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
                      <button type="button" className={styles.tool} aria-label={t('topNav.moreTools', 'More tools')} aria-haspopup="menu" title={t('topNav.moreTools', 'More tools')}>
                        <Icon name="more-horizontal" size="lg" />
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
                    aria-label={t('topNav.undo', 'Undo')}
                    title={t('topNav.undoTitle', 'Undo  ({chord})', { chord: UNDO_CHORD })}
                    disabled={!canUndo}
                    onClick={() => performUndo()}
                  >
                    <Icon name="undo" size="lg" />
                  </button>
                  <button
                    type="button"
                    className={styles.tool}
                    aria-label={t('topNav.redo', 'Redo')}
                    title={t('topNav.redoTitle', 'Redo  ({chord})', { chord: REDO_CHORD })}
                    disabled={!canRedo}
                    onClick={() => performRedo()}
                  >
                    <Icon name="redo" size="lg" />
                  </button>
                </div>
              </>
            )}
          </div>

          {/*
            The active tool's options, in the tool row itself — where After
            Effects puts them. They used to be a second row under this one that
            was kept (empty) even for a tool with no options, so the viewport
            would not jump when a tool with options was picked; that reserved a
            blank band across the whole window most of the time. Inline, there
            is no second row to reserve and nothing below moves.
          */}
          <ToolOptionsBar inline />

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
                    <IconButton aria-label={t('topNav.workspaces.aria', 'Workspaces')} size="sm" title={t('topNav.workspaces.title', 'Workspaces & Layout Presets')}>
                      <Icon name="layout" size="sm" />
                    </IconButton>
                  }
                  items={buildWorkspaceItems()}
                />
                <IconButton
                  aria-label={t('topNav.customize.aria', 'Customize')}
                  size="sm"
                  title={t('topNav.customize.title', 'Customize (Shortcuts, Workspaces, Appearance)')}
                  onClick={() => openCustomizeDialog()}
                >
                  <Icon name="settings" size="sm" />
                </IconButton>
              </>
            )}
          </div>

          <div className={styles.right}>
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
                    title={t('topNav.preview.title', 'Preview presentation (Fullscreen)')}
                    onClick={() => enterPresentation()}
                  >
                    {t('topNav.preview.label', 'Preview')}
                  </Button>
                  <Button
                    size="sm"
                    variant="primary"
                    leftIcon={<Icon name="export" size="sm" weight="bold" />}
                    title={t('topNav.export.title', 'Export composition…')}
                    data-tour="export"
                    onClick={() => openExportDialog(compDuration, compFps)}
                  >
                    {t('topNav.export.label', 'Export')}
                  </Button>
                </div>
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
