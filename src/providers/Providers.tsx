/**
 * UI Provider — application-level wrapper that:
 *   1. Applies persisted preferences to the document.
 *   2. Boots the Application core (services DI, EventBus, CommandSystem, ShortcutManager).
 *   3. Registers built-in + project commands and default panels.
 *   4. Wires the ThemeManager and ProjectManager into the UI.
 *   5. Mounts the global overlay hosts (modals, context menus, notifications).
 */

import { useEffect, useState, type ReactNode } from 'react';
import { openStaggerDialog } from '@layout/Motion/StaggerDialog';
import { Application } from '@core/application/Application';
import { getWorkspaceController } from '@core/workspace/WorkspaceController';
import {
  applyPreferencesToDocument,
  usePreferenceStore,
} from '@stores/preferenceStore';
import { allLayerKinds } from '@core/plugins/layerKindRegistry';
import { buildCustomLayerInto, customLayerLabel, wakeCustomLayerKind } from '@core/plugins/createCustomLayerFromMenu';
import { insertBuiltLayers } from '@core/engine/offDocument';
import { graph as docGraph, isLayer } from '@core/engine/doc';
import { useLayoutStore } from '@stores/layoutStore';
import { useSelectionStore } from '@stores/selectionStore';
import { isPickArmed } from '@stores/trackerStore';
import { pruneKeyframeSelectionToNodes, useKeyframeSelectionStore } from '@stores/keyframeSelectionStore';
import { prunePropertySelectionToNodes } from '@stores/propertySelectionStore';
import { useCompositionStore } from '@stores/compositionStore';
import { copyEdit, cutEdit, pasteEdit } from './clipboardEdits';
import { audioSliderNullEdit, expressionBakeEdit, exponentialScaleEdit } from './menuCommandEdits';
import { getTimelineController } from '@core/timeline/TimelineController';
import { goToMarkerIndex, isTransportPlaying, pauseTransport, playTransport, seekPlayhead } from '@core/timeline/timelineView';
import { documentMirror } from '@stores/documentMirror';
import { activeCompIdNow } from '@hooks/useMirror';
import { useProjectStore } from '@stores/projectStore';
import { getTime } from '@stores/playbackClockStore';
import { useUIStore } from '@stores/uiStore';
import { bumpScene } from '@stores/sceneStore';
import { isMediaDecodeRepaint } from '@core/rendering/mediaRepaint';
import { openProjectPath } from '@core/project/openProjectPath';
import { openLocalMotionFile, saveToComputer } from '@core/project/localProjectIO';
import { offerRelink } from '@layout/Project/RelinkAssetsDialog';
import { clearLastFootagePreview } from '@layout/Assets/FootagePreviewDialog';
import {
  runNewCompFromClips,
  runAssembleFromFootage,
  selectedVideoLayerId,
  type AssembleTarget,
} from '@layout/Assets/footageAssembly';
import { selectedPanelAssets, selectedPanelFootage } from '@core/composition/assetSelection';
import { openModal } from '@stores/modalStore';
import { customConfirm, customPrompt } from '@components/Modal';
import { baselineHistoryEdit } from '@core/engine/historyBaseline';
import { attachHistoryRecording, performUndo, performRedo } from '@stores/historyStore';
import { attachRenderBackendEvents } from '@stores/renderBackendStore';
import { Button } from '@components/Button';
import { openAbout } from '@layout/Help/AboutDialog';
import { dismissStartScreen } from '@layout/Start/useStartScreenVisible';
import { getAutosaveController } from '@core/persistence/AutosaveController';
import { readRecovery, clearRecovery, restoreRecovery } from '@core/persistence/recovery';
import pluginHost from '@core/plugins/PluginHost';
import { usePluginStore } from '@stores/pluginStore';
import { reconcileInstalledSet, installInstalledSyncSink } from '@core/plugins/installedSync';
import { showPluginPanel, hidePluginPanel } from '@layout/Plugins/PluginPanel';
import { activatePluginTool, installPluginToolBridge } from '@core/workspace/pluginToolBridge';
import { openExportDialog } from '@layout/Export/ExportDialog';
import { usePresentationStore } from '@stores/presentationStore';
import { useGuidesStore } from '@stores/guidesStore';
import { getCommandRegistry, BuiltinCommands, type Command } from '@core/commands/Command';
import { getCommandSystem } from '@core/commands/CommandSystem';
import { getShortcutManager } from '@core/commands/ShortcutManager';
import { getEventBus } from '@core/events/EventBus';
import { getThemeManager, getProjectManager, getLoadingManager, getSettingsManager, getFileManager } from '@core/services/coreServices';
import { bootEngine, shutdownEngine } from '@core/engine/engineInstance';
import { engineOwnsDocumentNow, setEngineOwnsDocument } from '@core/engine/engineOwnership';
import { processEngineOwnsDocument } from '@core/engine/process/processEngine';
import { installEngineOwnedSession } from './engineOwnedSession';
import { commandLogRecordingEnabled } from '@core/automation/commandLog';
import { installAutomationDevApi } from '@core/automation/devApi';
import { createAppEnginePorts } from '@core/engine/appPorts';
import { LoadingScreen } from '@components/LoadingScreen';
import { isLocalFirst } from '@core/config/flags';
import { cloudProjectsEnabled, pluginRegistryEnabled, pluginsEnabled } from '@core/config/edition';
import { chooseBundleDir, bundleDirPickerAvailable } from '@core/project/bundle/bundleProjectIO';
import { OnboardingOverlay } from '@layout/Onboarding/OnboardingOverlay';
import { useOnboardingStore } from '@stores/onboardingStore';
import { projectDocumentIO } from '@core/project/projectDocumentIO';
import { incrementName } from '@core/project/incrementName';
import { confirmDiscardChanges } from '@core/project/confirmDiscard';
import {
  afterProjectSaved,
  afterProjectLoaded,
  baselineProjectHistory,
  resetProjectWorkspace,
} from '@core/project/projectSession';
import type { SaveOutcome } from '@core/project/ProjectManager';
import { canSyncCurrentProject, syncCurrentProject } from '@core/sync/syncCurrentProject';
import { renderStillFrame } from '@core/export/offlineRenderer';
import { asThemeId, asCommandId, type KeyChord } from '@app-types/common';
import { buildCaptionCommands } from '@core/captions/captionCommands';
import { buildChoreographyCommands } from '@core/animation/choreographyCommands';
import { buildBeatCommands } from '@core/audio/beatCommands';
import { buildSpeedRampCommands } from '@core/animation/speedRampCommands';
import { buildLayerTimeCommands } from '@core/animation/layerTimeCommands';
import { buildExpressionCommands } from '@core/animation/expressionCommands';
import { buildLayerTransformCommands } from '@core/scene/layerTransformCommands';
import { openTimeStretchDialog } from '@layout/Composition/TimeStretchDialog';
import { openAutoOrientDialog } from '@layout/Composition/AutoOrientDialog';
import { buildCameraCommands } from '@core/scene/cameraCommands';
import {
  buildSmartAnimateCommands,
  installSmartAnimateCommandSync,
} from '@core/animation/smartAnimateCommands';
import { buildReframeCommands } from '@core/reframe/reframeCommands';
import { buildIk3DCommands } from '@core/scene/ikCommands';
import { buildBakeCommands } from '@core/simulation/bakeCommands';
import { buildAudioCommands } from '@core/audio/audioCommands';
import { type EasingPreset } from '@core/animation/keyframeAssistants';
import { easingTargetKeyframes } from '@core/animation/easingSelection';
import { useAssetStore } from '@stores/assetStore';
import { openCustomizeDialog } from '@layout/Settings/openCustomizeDialog';
import { openVersionHistory } from '@layout/History/VersionHistoryPanel';
import { useCloudProjectStore } from '@stores/cloudProjectStore';
import { registerDefaultEditors } from '@components/Inspector/DefaultEditors';
import { seedDefaultScene } from '@core/scene/seedDefaultScene';
import { loadBlockTower } from '@core/scene/seedBlockTower';
import { isPopoutWindow, startWindowSync } from '@core/layout/windowSync';
import { defaultAnimation } from '@motion/animation';
import defaultSceneGraph from '@core/scene/DefaultSceneGraph';
import { RIG_PRESETS, RIG_PRESET_LABELS, type RigPresetId } from '@core/rig/rigPresets';
import { applyRigPresetEdit } from '@core/engine/rigPaths';
import { readGeometry } from '@core/workspace/geometry';
import { eligibleScaleTracks, REFUSAL_TEXT } from '@core/animation/exponentialScale';
import {
  eligibleExpressionProps,
  BAKE_REFUSAL_TEXT,
} from '@core/animation/convertExpressionToKeyframes';
import {
  timeReverseKeyframes,
  easyEaseAll,
} from '@core/animation/keyframeAssistants';
import { openSmootherDialog, smootherTracks } from '@layout/Motion/SmootherDialog';
import { openWigglerDialog, wigglerTracks } from '@layout/Motion/WigglerDialog';
import { armMotionSketch, finishMotionSketch, cancelMotionSketch } from '@core/animation/motionSketch';
import { readNodeKind } from '@core/scene/sceneDerive';
import { AudioPlaybackBridge } from '@hooks/useAudioPlayback';
import { installExpressionProviders } from '@core/engine/expressionProviders';
import { ProjectCommands } from '@layout/Menu';
import { CommandPalette } from '@layout/CommandPalette';
import { PresentationMode } from '@layout/Presentation/PresentationMode';
import { openPalette } from '@stores/commandPaletteStore';
import { focusNavigationClaimedNow } from '@core/commands/focusContext';
import { isNativeMenuActionId } from '@layout/Menu/nativeMenuTemplate';
import { insertPrimitive, insert3DPrimitive } from '@core/scene/sceneInsert';
import { openPrecomposeDialog } from '@layout/Composition/PrecomposeDialog';
import { openSolidSettings } from '@layout/Composition/LayerSettingsDialog';
import { openCameraDialog, openLightDialog } from '@layout/Workspace/SceneInsertDialogs';
import { runSceneEditDetection, type SceneEditMode } from '@core/tracking/sceneEditCommand';
import { getWorkspaceManager } from '@core/layout/workspaceManager';
import { findNavTarget } from '@core/workspace/cameraNav';
import { pathVertices } from '@core/scene/nullsFromPaths';
import { nullsFromPathEdit, shapesFromTextEdit } from '@layout/Scene/layerCreateEdits';
import { buildPathCommands } from '@core/workspace/pathCommands';
import { canCreateShapesFromText } from '@core/scene/shapesFromText';
import { autoTraceLayer } from '@core/effects/autoTrace';
import { centreAnchorInContent, centreInFrame } from '@core/source/fitCommands';
import { uiKindOf } from '@core/mirror/layerKinds';
import { settingsDurationSeconds, settingsFps } from '@core/mirror/compFacts';
import { rigLogoForAnimation } from '@core/scene/rigLogo';
import { addEffectEdit } from '@layout/Effects/effectEdits';
import { easePresetOnKeys } from '@layout/Timeline/keyframeEdits';
import { setLayersSwitch } from '@layout/Inspector/inspectorEdits';
import {
  arrangeLayersEdit,
  bakeMergePathsEdit,
  deleteSelectedLayersEdit,
  duplicateSelectedLayersEdit,
} from '@layout/Workspace/layerMenuEdits';
import {
  centreAnchorEdit,
  centreInCompEdit,
  createLayerEdit,
  easyEaseAllEdit,
  fitLayersEdit,
  sequenceLayerBarsEdit,
  staggerAnimationsEdit,
  timeReverseKeyframesEdit,
} from '@layout/Menu/appEdits';
import { openCompositionSettings } from '@layout/Composition/CompositionSettingsDialog';
import { openNewCompositionDialog } from '@layout/Composition/NewCompositionDialog';
import { deleteCompositionEdit, deleteCompositionWarning } from '@layout/Scene/sceneEdits';
import { canOpenPreviousComposition, openPreviousComposition } from '@core/composition/compNavigation';
import { useMiniFlowchartStore } from '@stores/miniFlowchartStore';

interface ProvidersProps {
  children: ReactNode;
}

function notify(message: string, level: 'info' | 'success' | 'warning' | 'error' = 'info'): void {
  useUIStore.getState().notify({ level, message, durationMs: 2600 });
}

/**
 * Pixel size of the composition the active tab edits — the FRAME a fit command
 * fits into (the mirror twin of `activeComp.activeCompSize`); 1920×1080 when the
 * tab names no composition the document has.
 */
function activeTabCompSize(): { width: number; height: number } {
  const st = useProjectStore.getState();
  const id = st.tabs[st.activeTabId ?? '']?.compositionId;
  const s = id ? documentMirror().comp(id)?.settings : undefined;
  return s ? { width: s.width, height: s.height } : { width: 1920, height: 1080 };
}

/**
 * Save As, in a browser that cannot show a save dialog.
 *
 * `BrowserFileAdapter.chooseSavePath` has no picker outside Chromium, and used
 * to answer with the suggested filename anyway — so Save As wrote into the
 * localStorage virtual FS, under a destination the user never chose, with no
 * window of any kind. That is the "Save As does nothing" report.
 *
 * `saveToComputer` always reaches somewhere real (File System Access picker →
 * Electron dialog → download) and writes the portable `.motion` package rather
 * than a bare serialized blob, so it is also the better artifact.
 */
async function saveAsPortableFile(name: string): Promise<boolean> {
  const result = await saveToComputer(name);
  if (result.status === 'cancelled') {
    notify('Save cancelled', 'info');
    return false;
  }
  if (result.status === 'failed') {
    notify(result.error ?? 'Could not save the project', 'error');
    return false;
  }
  // The document is now on disk, so the unsaved indicator must clear exactly as
  // it does for the other save paths.
  afterProjectSaved();
  notify(`Saved “${name}.motion” to your computer`, 'success');
  return true;
}

/**
 * True when plain `Save` has nowhere to route a never-saved document.
 *
 * `pm.save()` with no path delegates to `pm.saveAs()`, which asks the adapter
 * for a destination. In a browser with no File System Access API that request
 * now answers `null` (it used to invent a filename), so Ctrl+S on a scratch
 * document would report "cancelled" and write nothing.
 *
 * Deliberately NOT `!== 'electron'`: the cloud adapter does have a destination
 * for a pathless document — it creates a backend project — and in the cloud
 * editor that is what Ctrl+S should do. Only the browser is stuck.
 */
function needsPortableSaveFallback(): boolean {
  return getFileManager().environment === 'browser';
}

/**
 * The one place a save outcome is turned into UI, shared by Save, Save As and
 * Increment and Save.
 *
 * Three commands used to each do their own thing with a bare boolean, and only
 * one of them cleared the unsaved indicator. Worse, `false` collapsed "no
 * project open", "you cancelled" and "the write threw" into a SUCCESS toast
 * reading "Saved" — and then cleared the dirty flag and deleted the crash
 * recovery snapshot, so the user was told their work was safe at the exact
 * moment it stopped being anywhere.
 *
 * `afterProjectSaved` runs on the SAVED branch only, which is the whole point.
 *
 * Cloud note: `chooseSavePath` there is not a dialog — it CREATES a new backend
 * project and hands back its id. So a Save As forks the document, and unless
 * the route follows, the editor keeps autosaving to the project the URL still
 * names while Save writes to the new one. `navigateTo` is how the caller
 * follows.
 */
function reportSave(outcome: SaveOutcome, opts?: { forkedFrom?: string | null }): boolean {
  if (outcome.status === 'saved') {
    afterProjectSaved();
    notify(`Saved “${outcome.ref.name}”`, 'success');
    // A cloud Save As created a SEPARATE project; the route must follow it or
    // Save and autosave end up writing to two different documents.
    const forked =
      getFileManager().environment === 'api' &&
      opts?.forkedFrom !== undefined &&
      outcome.ref.path != null &&
      outcome.ref.path !== opts.forkedFrom;
    if (forked) window.location.hash = `#/editor/${outcome.ref.path}`;
    return true;
  }
  if (outcome.status === 'cancelled') {
    notify('Save cancelled', 'info');
    return false;
  }
  // A failed write leaves the document unsaved and the recovery snapshot in
  // place, deliberately: it is the copy that still exists.
  notify(
    outcome.error instanceof Error
      ? `Could not save: ${outcome.error.message}`
      : 'Could not save the project',
    'error',
  );
  return false;
}

/**
 * `file.openAfterEffects` — open an After Effects project.
 *
 * Deliberately its own verb rather than a filter on Open Project. Opening a
 * `.aep` is a CONVERSION: it reads someone else's document, rebuilds it here,
 * and can only ever be an approximation of it — so it starts a new untitled
 * project rather than adopting the AE file's path, which is what stops a later
 * Save silently writing over a file After Effects still needs to open.
 *
 * The picker is a plain file input for the same reason every other importer
 * uses one: it works identically in the desktop and browser builds, and the
 * bytes arrive without a round trip through the main process.
 */
async function pickAndOpenAfterEffectsProject(): Promise<void> {
  const file = await new Promise<File | null>((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.aep,.aepx';
    input.addEventListener('change', () => resolve(input.files?.[0] ?? null));
    // Chromium fires this on dismissal; without it the promise never settles
    // and the command looks like it hung.
    input.addEventListener('cancel', () => resolve(null));
    input.click();
  });
  if (!file) return;

  const { confirmDiscardChanges } = await import('@core/project/confirmDiscard');
  if (!await confirmDiscardChanges('Open an After Effects project')) return;

  const { importAepFile } = await import('@core/aep/aepImport');
  const { reportAepImport, reportAepImportFailure } = await import('@core/aep/aepImportReport');

  // A blank document first: the import ADDS compositions, and adding four of
  // someone else's on top of the user's own would produce a project belonging
  // to neither. `newProject` also clears the path, so Save asks where to go.
  noteNextProjectSource('aep');
  getProjectManager().newProject(file.name.replace(/\.aepx?$/i, ''));
  resetProjectWorkspace();

  notify(`Opening “${file.name}”…`, 'info');
  let result: Awaited<ReturnType<typeof importAepFile>>;
  try {
    result = await importAepFile(file);
  } catch (err) {
    reportAepImportFailure(file.name, err instanceof Error ? err.message : 'the file could not be read');
    return;
  }
  if (!result.ok) {
    reportAepImportFailure(file.name, result.message);
    return;
  }
  // The same document transition Open and New make, and it needs the same
  // undo re-baseline: one Ctrl+Z after an import must not reach back into
  // whatever was open before it.
  baselineProjectHistory('Open After Effects Project');
  bumpScene();
  afterProjectLoaded();
  reportAepImport(file.name, result);
}

/**
 * `file.import3DModel` — the picker half of the glTF importer.
 *
 * A first-class verb rather than "drop it in the Assets panel and hope": a
 * model is not a library asset, it becomes a LAYER TREE, and — the part the
 * asset door cannot express — a `.gltf` needs its `.bin` and its textures
 * selected WITH it. The picker is multi-select and accepts those sidecar types
 * for exactly that reason; `importModelFiles` works out which of the chosen
 * files is the model and resolves the rest against it.
 */
async function pickAndImport3DModel(): Promise<void> {
  const files = await new Promise<File[]>((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.multiple = true;
    // .bin and the image types are the sidecars a .gltf points at; a user who
    // selects only the .gltf still gets a named, actionable error rather than
    // a silent half-import.
    input.accept = '.glb,.gltf,.bin,image/png,image/jpeg,image/webp,model/gltf+json,model/gltf-binary';
    input.addEventListener('change', () => resolve(Array.from(input.files ?? [])));
    // Chromium fires this on dismissal; without it the promise never settles
    // and the command looks like it hung.
    input.addEventListener('cancel', () => resolve([]));
    input.click();
  });
  if (files.length === 0) return;
  const { importModelFiles, MODEL_FILE_PATTERN } = await import('@core/scene/modelImport');
  if (!files.some((f) => MODEL_FILE_PATTERN.test(f.name))) {
    notify('Select a .glb or .gltf file (with its .bin and textures, if it has them).', 'warning');
    return;
  }
  try {
    const result = importModelFiles(
      await Promise.all(files.map(async (f) => ({
        name: f.name,
        // Present when the selection came from a folder drop; it is what lets
        // `textures/albedo.png` resolve as the path it actually is.
        ...((f as File & { webkitRelativePath?: string }).webkitRelativePath
          ? { path: (f as File & { webkitRelativePath?: string }).webkitRelativePath }
          : {}),
        bytes: await f.arrayBuffer(),
      }))),
    );
    const clip = result.clip
      ? ` · clip “${result.clip.name}” baked as keyframes (${result.clip.duration.toFixed(1)}s)`
      : '';
    notify(
      result.warning ?? `Imported ${result.layerCount} layer${result.layerCount === 1 ? '' : 's'}${clip}`,
      result.warning ? 'warning' : 'success',
    );
  } catch (err) {
    notify(`3D import failed: ${err instanceof Error ? err.message : String(err)}`, 'error');
  }
}

/** Tool-switching commands — single-key AE shortcuts (V/A/H/Z/W/R/S/P/T/U/E).
 *  Going through the CommandSystem makes them remappable in Customize…. The
 *  ShortcutManager already ignores keys typed into inputs/textareas. */
function buildToolCommands(): ReadonlyArray<Command> {
  // `chord` is the default; AE_PRESET in shortcutOverrides may rebind it.
  // Move has none — AE has no Move tool (Select drags), and W is Rotation.
  //
  // These follow After Effects exactly, which also resolves a set of collisions:
  // Pen was on P and Text on T, shadowing the P/T property-reveal shortcuts
  // (ShortcutManager captures and stops propagation, so the reveal listener
  // never ran); Rectangle was on U, shadowed in turn by `timeline.revealAnimated`.
  // AE puts them on G / Ctrl+T / Q — which is what the toolbar tooltips have
  // been advertising all along — leaving P, T and U free to reveal.
  const tools: Array<{ tool: import('@stores/uiStore').Tool; label: string; chord?: KeyChord }> = [
    { tool: 'select', label: 'Select Tool', chord: { key: 'v' } },
    { tool: 'direct-select', label: 'Direct Selection Tool', chord: { key: 'a' } },
    { tool: 'hand', label: 'Hand Tool', chord: { key: 'h' } },
    { tool: 'zoom', label: 'Zoom Tool', chord: { key: 'z' } },
    { tool: 'move', label: 'Move Tool' },
    { tool: 'rotate', label: 'Rotate Tool', chord: { key: 'w' } },
    { tool: 'pan-behind', label: 'Pan Behind (Anchor Point) Tool', chord: { key: 'y' } },
    { tool: 'pen', label: 'Pen Tool', chord: { key: 'g' } },
    // Shift+K, not K: bare K is the J-K-L transport's stop / hold-to-step key
    // (AE), and sharing it left the app's resting state unable to frame-step.
    { tool: 'knife', label: 'Knife Tool', chord: { key: 'k', shift: true } },
    { tool: 'brush', label: 'Brush Tool' },
    { tool: 'text', label: 'Text Tool', chord: { key: 't', meta: true } },
    // No chord of its own: AE reaches it by pressing Ctrl+T again, which the
    // Text Tool command below does (it cycles horizontal ⇄ vertical).
    { tool: 'vertical-text', label: 'Vertical Type Tool' },
    { tool: 'shape', label: 'Rectangle Tool', chord: { key: 'q' } },
    { tool: 'ellipse', label: 'Ellipse Tool', chord: { key: 'q', shift: true } },
    { tool: 'puppet-pin', label: 'Puppet Position Pin Tool', chord: { key: 'p', meta: true } },
    { tool: 'bone', label: 'Bone Tool', chord: { key: 'b', meta: true } },
    // These seven had a toolbar button and NO command, so they were absent from
    // the Command Palette and — the part that actually bit — could not be given
    // a shortcut in Customize…, while their siblings above could. No default
    // chords: every sensible key is taken by the tools above or by a property
    // reveal, and inventing collisions is worse than leaving them unbound. The
    // point is that they are now bindable at all.
    { tool: 'pencil', label: 'Pencil Tool' },
    { tool: 'curvature', label: 'Curvature Pen Tool' },
    { tool: 'line', label: 'Line Segment Tool' },
    { tool: 'polygon', label: 'Polygon Tool' },
    { tool: 'star', label: 'Star Tool' },
    { tool: 'mask-rect', label: 'Rectangle Mask Tool' },
    { tool: 'mask-ellipse', label: 'Ellipse Mask Tool' },
    // Split out of tools that used to switch into them implicitly: `paint` was
    // the Brush whenever the cursor happened to be over the selected layer, and
    // `mask-pen` was the Pen whenever exactly one layer was selected. Both are
    // chosen deliberately now, so both must be reachable and bindable like every
    // other tool — which is what `toolCommands.test.ts` enforces.
    { tool: 'paint', label: 'Paint Tool' },
    { tool: 'eraser', label: 'Eraser Tool' },
    { tool: 'mask-pen', label: 'Pen Mask Tool' },
    // AE's Pen flyout. No chords of their own: AE reaches them from the Pen
    // (hover a segment / a vertex, or hold Alt), and G cycles Pen ⇄ Mask
    // Feather — see `tool.pen` below.
    { tool: 'add-vertex', label: 'Add Vertex Tool' },
    { tool: 'delete-vertex', label: 'Delete Vertex Tool' },
    { tool: 'convert-vertex', label: 'Convert Vertex Tool' },
    { tool: 'mask-feather', label: 'Mask Feather Tool' },
  ];
  // Every tool used 'crosshair', so the palette/menus showed eleven identical
  // icons — give each tool its actual glyph.
  const TOOL_ICONS: Record<string, import('@components/Icon').IconName> = {
    select: 'select-arrow',
    'direct-select': 'mouse-pointer',
    hand: 'hand',
    zoom: 'zoom-in',
    move: 'move',
    rotate: 'rotate-cw',
    'pan-behind': 'anchor',
    pen: 'pen',
    brush: 'brush',
    text: 'type',
    'vertical-text': 'type-vertical',
    shape: 'square',
    ellipse: 'circle',
    'puppet-pin': 'puppet-pin',
    bone: 'bone',
    // Match the toolbar glyphs (see TopNav's PEN_TOOLS / SHAPE_TOOLS /
    // MASK_TOOLS) so a tool looks the same wherever it is offered.
    pencil: 'pencil',
    curvature: 'curvature',
    line: 'line',
    polygon: 'polygon',
    star: 'star',
    'mask-rect': 'mask-square',
    'mask-ellipse': 'mask-circle',
    'add-vertex': 'plus',
    'delete-vertex': 'minus',
    'convert-vertex': 'ease',
    'mask-feather': 'blur',
  };
  return tools.map(({ tool, label, chord }) => ({
    id: asCommandId(`tool.${tool}`),
    label,
    icon: TOOL_ICONS[tool] ?? ('crosshair' as const),
    ...(chord ? { shortcut: chord } : {}),
    enabled: () => true,
    execute: () => {
      const ui = useUIStore.getState();
      // Ctrl+B belongs to the paint tools while one is up (AE's Brush / Clone
      // Stamp / Eraser cycle, `layout/Paint/paintTool.ts`), not to Bone.
      if (tool === 'bone' && (ui.activeTool === 'paint' || ui.activeTool === 'eraser')) return;
      // AE: with a Type tool already active, Ctrl+T switches to the other one.
      if (tool === 'text' && (ui.activeTool === 'text' || ui.activeTool === 'vertical-text')) {
        ui.setActiveTool(ui.activeTool === 'text' ? 'vertical-text' : 'text');
        return;
      }
      // AE: G with the Pen (or Mask Feather) already active cycles the two.
      if (tool === 'pen' && (ui.activeTool === 'pen' || ui.activeTool === 'mask-feather')) {
        ui.setActiveTool(ui.activeTool === 'pen' ? 'mask-feather' : 'pen');
        return;
      }
      ui.setActiveTool(tool);
    },
  }));
}

/**
 * C — AE's camera tool: each press cycles the LEFT-drag mode
 * orbit → pan → dolly (no Alt needed). Esc or picking any tool (V) exits.
 * Live only when camera navigation is possible (a Camera layer + a 3D layer),
 * so the bare key falls through harmlessly in flat comps.
 */
function buildCameraToolCommands(): ReadonlyArray<Command> {
  return [
    {
      id: asCommandId('tool.cameraCycle'),
      label: 'Camera Tool (Unified / Orbit / Pan / Dolly)',
      icon: 'camera',
      shortcut: { key: 'c' },
      enabled: () => findNavTarget() !== null,
      execute: () => {
        useGuidesStore.getState().cycleCameraTool();
        const mode = useGuidesStore.getState().cameraTool;
        notify(
          `Camera tool: ${
            mode === 'unified' ? 'Unified (left orbit · middle pan · right dolly)'
            : mode === 'pan' ? 'Pan (Track XY)'
            : mode === 'dolly' ? 'Dolly'
            : 'Orbit'
          } — Esc to exit`,
          'info',
        );
      },
    },
    {
      // The Unified Camera directly (AE's first camera tool), bindable in
      // Customize… like every other tool. No default chord: C already cycles
      // into it first, and every sensible bare key is taken.
      id: asCommandId('tool.cameraUnified'),
      label: 'Unified Camera Tool',
      icon: 'camera',
      enabled: () => findNavTarget() !== null,
      execute: () => {
        useGuidesStore.getState().setCameraTool('unified');
        notify('Unified Camera: left-drag orbits, middle-drag pans, right-drag dollies — Esc to exit', 'info');
      },
    },
    {
      // Registered AFTER the builtin Deselect (same Escape chord): the
      // ShortcutManager checks most-recently-added first, so while the camera
      // tool is active Esc exits it; otherwise this is disabled and the chord
      // falls through to Deselect as before.
      id: asCommandId('tool.cameraExit'),
      label: 'Exit Camera Tool',
      icon: 'camera',
      shortcut: { key: 'Escape' },
      enabled: () => useGuidesStore.getState().cameraTool !== 'none',
      execute: () => useGuidesStore.getState().setCameraTool('none'),
    },
  ];
}

/**
 * Fast 3D-view switching (AE parity): `1` returns to Active Camera, `2` jumps
 * to the LAST custom view used (Custom View 1 until one is picked). Bare
 * digit keys are unclaimed in the shortcut registry (checked: no `1`/`2`
 * chords anywhere), and the ShortcutManager already ignores typing in inputs.
 */
function buildViewSwitchCommands(): ReadonlyArray<Command> {
  return [
    {
      id: asCommandId('view.activeCamera'),
      label: '3D View: Active Camera',
      icon: 'camera',
      shortcut: { key: '1' },
      enabled: () => true,
      execute: () => useGuidesStore.getState().setCamera3dMode('active'),
    },
    {
      id: asCommandId('view.lastCustom'),
      label: '3D View: Last Custom View',
      icon: 'camera',
      shortcut: { key: '2' },
      enabled: () => true,
      execute: () => {
        const s = useGuidesStore.getState();
        s.setCamera3dMode(s.lastCustomView);
      },
    },
  ];
}

/**
 * Jump to comp marker 1–9 — the beat-work shortcut.
 *
 * ## Why Shift+digit and not a bare digit (AE's chord)
 *
 * After Effects puts "go to comp marker N" on the BARE main-keyboard digits.
 * That is not available here: `1` and `2` are already registered above for 3D
 * view switching, and they shipped first. Binding markers to bare `3`–`9` while
 * `1`–`2` needed a modifier would be a keymap nobody can hold in their head, so
 * all nine take one consistent chord instead.
 *
 * Shift+digit is AE's OTHER marker chord (it places a numbered comp marker), so
 * the digit-means-marker association survives even though the modifier moved.
 *
 * NOTE: this chord did not work at all until `chordFromEvent` learned to resolve
 * the digit row from `e.code` — `e.key` for Shift+1 is `'!'`, so a
 * `{ key: '1', shift: true }` binding could never match. Registering these
 * before that fix would have produced nine commands that appear in the palette,
 * appear in Customize, and silently never fire from the keyboard.
 *
 * Generated from a range rather than written out nine times: the shortcut, the
 * label and the index cannot drift apart, and a tenth is one number.
 */
function buildMarkerCommands(): ReadonlyArray<Command> {
  return Array.from({ length: 9 }, (_, i) => i + 1).map((n) => ({
    id: asCommandId(`timeline.goToMarker${n}`),
    label: `Go to Comp Marker ${n}`,
    icon: 'marker' as const,
    shortcut: { key: String(n), shift: true },
    // Honest disable: with fewer than N markers the key does nothing, and a
    // command that reports itself enabled while doing nothing is the dead-control
    // shape this codebase keeps finding.
    // B4-gap: comp markers — a marker the legacy M key adds reaches the mirror a
    // microtask later, and a Shift+digit in the same tick must already see it.
    enabled: () => getTimelineController().compMarkerCount() >= n,
    execute: () => {
      if (!goToMarkerIndex(n)) {
        notify(`No comp marker ${n}`, 'info');
      }
    },
  }));
}

/**
 * Keyframe-assistant commands (AE's F9 family + interpolation).
 *
 * These already existed and worked, but had NO menu home — the audit's "F9
 * commands exist with no menu home". They live in the Animation menu now (see
 * menuModel), so they're discoverable rather than shortcut-only.
 */
import { liveMergeSelectedPaths, type MergeOp } from '@core/scene/mergePaths';
import { compSizeOf } from '@core/composition/compSizes';
import { installProductAnalytics, noteNextProjectSource } from '@core/analytics/productEvents';

/** The four boolean operators, in the order every other surface lists them. */
const MERGE_OPS: ReadonlyArray<{ op: MergeOp; label: string; bakeId: string }> = [
  // `bakeId` is the ORIGINAL command id for each bake. The ids are keys into
  // the user's persisted shortcut overrides, so renaming them for symmetry
  // with the new live ones would silently orphan any remap.
  { op: 'union', label: 'Union (Add)', bakeId: 'shape.mergeUnion' },
  { op: 'subtract', label: 'Subtract', bakeId: 'shape.mergeSubtract' },
  { op: 'intersect', label: 'Intersect', bakeId: 'shape.mergeIntersect' },
  { op: 'exclude', label: 'Exclude (XOR)', bakeId: 'shape.mergeExclude' },
];

/**
 * Boolean path operations — LIVE and BAKED.
 *
 * Both engines shipped complete and were reachable from exactly one place: a
 * "Merge Paths" submenu inside the Scene panel's node kebab, which you only
 * find by right-clicking two selected layers. The palette had the bakes only,
 * so the live boolean — the one that keeps operands animatable, which is the
 * whole reason to prefer it — had no route at all outside that kebab.
 *
 * The DemoPanels kebab keeps its own entries verbatim; these call the same two
 * functions, so there is one implementation and two doors, not two features.
 */
function buildMergePathCommands(): ReadonlyArray<Command> {
  const enabled = (): boolean => useSelectionStore.getState().ids.length >= 2;
  const live: Command[] = MERGE_OPS.map(({ op, label }) => ({
    id: asCommandId(`shape.boolean.${op}`),
    label: `Path Operation: ${label}`,
    icon: 'layers' as const,
    enabled,
    execute: () => {
      const ids = liveMergeSelectedPaths(op);
      if (ids.length > 0) notify(`Live boolean (${op}) — operands stay editable`, 'success');
      else notify('Select at least two shape layers with closed paths', 'warning');
    },
  }));
  const baked: Command[] = MERGE_OPS.map(({ op, label, bakeId }) => ({
    id: asCommandId(bakeId),
    label: `Merge Paths (Bake): ${label}`,
    icon: 'layers' as const,
    enabled,
    execute: () => {
      // The boolean runs off-document; `deleteLayers` + `pasteLayers`, one entry (layerMenuEdits).
      void bakeMergePathsEdit(op).then((ids) => {
        if (ids.length > 0) notify(`Merged paths (${op})`, 'success');
        else notify('Select at least two shape layers to merge', 'warning');
      });
    },
  }));
  return [...live, ...baked];
}

/**
 * Layer ▸ New 3D Primitive. The inserts existed only in the TopNav "+" menu,
 * which is a place you browse, not a place you search — so a user who knows
 * the app has 3D primitives had no way to type "cube" and get one.
 */
function buildPrimitive3DCommands(): ReadonlyArray<Command> {
  // Mirrors `insert3DPrimitive`'s own parameter union rather than importing a
  // type it does not export — a mismatch is a compile error at the call below.
  type Kind = 'cube' | 'sphere' | 'plane' | 'cylinder' | 'cone' | 'torus' | 'capsule' | 'box';
  const kinds: ReadonlyArray<{ id: Kind; label: string; icon: string }> = [
    { id: 'cube', label: '3D Cube', icon: 'cube' },
    { id: 'sphere', label: '3D Sphere', icon: 'sphere' },
    { id: 'cylinder', label: '3D Cylinder', icon: 'cylinder' },
    { id: 'plane', label: '3D Plane', icon: 'square' },
    // Real curved meshes (primitiveMesh.ts); `box` is the mesh cube, distinct
    // from `cube`, which stays the bevel-capable extruded rect.
    { id: 'cone', label: '3D Cone', icon: 'cylinder' },
    { id: 'torus', label: '3D Torus', icon: 'sphere' },
    { id: 'capsule', label: '3D Capsule', icon: 'cylinder' },
    { id: 'box', label: '3D Box (mesh)', icon: 'cube' },
  ];
  return kinds.map(({ id, label, icon }) => ({
    id: asCommandId(`layer.new3d.${id}`),
    label: `New ${label}`,
    icon,
    // Inserting needs somewhere to insert INTO. Every other New-layer command
    // is unconditional for the same reason: `insert3DPrimitive` resolves the
    // active comp root itself.
    enabled: () => true,
    execute: () => {
      insert3DPrimitive(id);
      notify(`${label} added`, 'success');
    },
  }));
}

/**
 * The first selected layer whose source is a VIDEO asset — Scene Edit
 * Detection's only valid subject. A still has no cuts, and an audio layer has
 * no frames to compare.
 *
 * Now shared with Assemble from Footage, which subjects the same layer to the
 * same detector; it lives beside that flow so the two cannot drift into
 * disagreeing about what a video layer is.
 */
const selectedVideoNodeId = selectedVideoLayerId;

/**
 * What Assemble from Footage would act on: a selected video LAYER first, and
 * otherwise a video item selected in the Assets panel.
 *
 * Layer first because a layer is a stronger statement of intent — the user is
 * looking at the comp, pointing at the clip in it. The panel selection is the
 * fallback that makes the command work from the Assets context menu, where
 * right-clicking a row has already made that row the selection.
 */
function assembleTarget(): AssembleTarget | null {
  const nodeId = selectedVideoLayerId();
  if (nodeId) return { kind: 'layer', nodeId };
  const asset = selectedPanelAssets().find((a) => a.type === 'video');
  return asset ? { kind: 'asset', asset } : null;
}

/**
 * AE's Layer ▸ Scene Edit Detection, as commands.
 *
 * The detector and both appliers shipped reachable ONLY from the timeline
 * clip's right-click menu — and only on a clip whose asset the menu had
 * already resolved. Same entry point (`runSceneEditDetection`), so the confirm,
 * the progress notification and the +1µs frame mapping are shared verbatim.
 */
function buildSceneEditCommands(): ReadonlyArray<Command> {
  const modes: ReadonlyArray<{ mode: SceneEditMode; label: string }> = [
    { mode: 'markers', label: 'Scene Edit Detection → Markers' },
    { mode: 'split', label: 'Scene Edit Detection → Split Clips' },
  ];
  return modes.map(({ mode, label }) => ({
    id: asCommandId(`layer.sceneEditDetect.${mode}`),
    label,
    icon: 'scissors' as const,
    enabled: () => selectedVideoNodeId() !== null,
    execute: () => {
      const nodeId = selectedVideoNodeId();
      if (!nodeId) {
        notify('Select a video layer first', 'warning');
        return;
      }
      void runSceneEditDetection(nodeId, mode);
    },
  }));
}

/**
 * Window ▸ Workspace — saving and resetting the dock layout.
 *
 * Applying a preset is NOT here: the presets are partly user data (saved
 * layouts come and go while the app runs), so they are built per render in
 * `workspaceMenu.ts` rather than frozen into the registry at boot. What is
 * fixed — save-as and reset — is a command, so it is searchable.
 */
function buildWorkspaceCommands(): ReadonlyArray<Command> {
  return [
    {
      id: asCommandId('workspace.saveAs'),
      label: 'Save Layout as Workspace…',
      icon: 'layout',
      enabled: () => true,
      execute: async () => {
        const name = await customPrompt(
          'Save Workspace',
          'Save the current panel arrangement as a workspace you can switch back to from Window ▸ Workspace.',
          '',
          { placeholder: 'e.g. Rough Cut', confirmLabel: 'Save' },
        );
        const trimmed = name?.trim();
        if (!trimmed) return;
        getWorkspaceManager().saveCurrentWorkspace(trimmed);
        notify(`Workspace “${trimmed}” saved`, 'success');
      },
    },
  ];
}

function buildEasingCommands(): ReadonlyArray<Command> {
  const presets: Array<{ id: string; label: string; preset: EasingPreset; shortcut?: KeyChord }> = [
    { id: 'anim.easyEase', label: 'Easy Ease', preset: 'Ease', shortcut: { key: 'F9' } },
    { id: 'anim.easyEaseIn', label: 'Easy Ease In', preset: 'EaseIn', shortcut: { key: 'F9', shift: true } },
    { id: 'anim.easyEaseOut', label: 'Easy Ease Out', preset: 'EaseOut', shortcut: { key: 'F9', meta: true, shift: true } },
    // Interpolation types — AE's Keyframe Interpolation submenu. No shortcuts,
    // to avoid colliding with the tool/reveal keymap.
    { id: 'anim.interpLinear', label: 'Keyframe Interpolation: Linear', preset: 'Linear' },
    { id: 'anim.interpHold', label: 'Keyframe Interpolation: Hold', preset: 'Hold' },
  ];
  return presets.map(({ id, label, preset, shortcut }) => ({
    id: asCommandId(id),
    label,
    icon: 'ease' as const,
    ...(shortcut ? { shortcut } : {}),
    // Keep the chord live only when it can act, so it falls through otherwise.
    enabled: () => easingTargetKeyframes().length > 0,
    // `updateKeyframes` through the engine (B3); easePresetOnKeys keeps the
    // preset writer for a key the API cannot address alone.
    execute: () => {
      const kfIds = easingTargetKeyframes();
      if (kfIds.length === 0) return;
      void easePresetOnKeys(kfIds, preset).then(() => notify(`${label} applied`, 'success'));
    },
  }));
}

/** The playhead in comp seconds — where the registry's transform commands read and key. */
const playheadSeconds = (): number => getTime();

function buildBuiltinCommands(): ReadonlyArray<Command> {
  return [
    {
      // The palette owns Cmd/Ctrl+Shift+P via its own listener (so it fires even
      // while a field is focused); this command is for menus/discoverability. No
      // shortcut here on purpose — binding it would double-fire with the
      // palette's own listener and the two toggles would cancel out.
      id: asCommandId('view.commandPalette'),
      label: 'Command Palette',
      icon: 'search',
      enabled: () => true,
      execute: () => openPalette(),
    },
    {
      id: BuiltinCommands.ToggleLeftSidebar,
      label: 'Toggle Left Sidebar',
      icon: 'panel-left',
      enabled: () => true,
      execute: () => useLayoutStore.getState().toggleRegion('leftSidebar'),
    },
    {
      id: BuiltinCommands.ToggleRightInspector,
      label: 'Toggle Inspector',
      icon: 'panel-right',
      enabled: () => true,
      execute: () => useLayoutStore.getState().toggleRegion('rightInspector'),
    },
    {
      id: BuiltinCommands.ToggleTimeline,
      label: 'Toggle Timeline',
      icon: 'panel-bottom',
      enabled: () => true,
      execute: () => useLayoutStore.getState().toggleRegion('bottomTimeline'),
    },
    {
      id: BuiltinCommands.FocusWorkspace,
      label: 'Focus Workspace',
      icon: 'crosshair',
      // No default key: ` is the focus-mode chord now (below). It moved there
      // from Tab when Tab became AE's Composition Mini-Flowchart, and ` is the
      // key AE itself uses to maximize a panel. Rebindable in Customize.
      enabled: () => true,
      execute: () => {
        document.querySelector<HTMLElement>('[data-workspace-viewport]')?.focus();
      },
    },
    {
      /**
       * One-key focus modes. `` ` `` folds the UI down to viewport + timeline,
       * `` Shift+` `` to the viewport alone; the same key again puts the panels
       * back exactly as they were (`layoutStore.setFocusMode`). ` is AE's own
       * maximize-panel key; these lived on Tab until Tab became AE's
       * Composition Mini-Flowchart (`comp.miniFlowchart`).
       *
       * `enabled` is the whole safety story: a text field, a dialog and a menu
       * keep their keys, and the global dispatcher wins every race with a
       * panel listener (repo rule). A DISABLED command falls through, so
       * reporting false here is what hands the key back there.
       */
      id: asCommandId('view.focusMode.viewportTimeline'),
      label: 'Focus: Viewport + Timeline',
      description: 'Collapse both sidebars; press again to restore',
      icon: 'panel-bottom',
      shortcut: { key: '`' },
      enabled: () => !focusNavigationClaimedNow(),
      isChecked: () => useLayoutStore.getState().focusMode === 'viewport-timeline',
      execute: () => useLayoutStore.getState().setFocusMode('viewport-timeline'),
    },
    {
      id: asCommandId('view.focusMode.viewport'),
      label: 'Focus: Viewport Only',
      description: 'Collapse sidebars and timeline; press again to restore',
      icon: 'maximize',
      shortcut: { key: '`', shift: true },
      enabled: () => !focusNavigationClaimedNow(),
      isChecked: () => useLayoutStore.getState().focusMode === 'viewport',
      execute: () => useLayoutStore.getState().setFocusMode('viewport'),
    },
    {
      // The palette's `?` mode as a menu entry, so the docs are findable from
      // Help by someone who has never typed a prefix.
      id: asCommandId('help.searchDocs'),
      label: 'Search Documentation…',
      icon: 'info',
      enabled: () => true,
      execute: () => openPalette('?'),
    },
    {
      /**
       * Guide layers — visible while you work, absent from the deliverable.
       *
       * Multi-select capable, because marking a batch of reference layers at
       * once is the normal use (a folder of design comps, a set of safe-area
       * overlays). The toggle follows the FIRST selected layer so a mixed
       * selection resolves to one state, rather than flipping each layer
       * independently and leaving the batch as mixed as it started.
       */
      id: asCommandId('layer.toggleGuide'),
      label: 'Guide Layer (omit from export)',
      icon: 'eye-off',
      enabled: () => useSelectionStore.getState().ids.length > 0,
      execute: () => {
        const ids = useSelectionStore.getState().ids;
        if (ids.length === 0) return;
        const next = !documentMirror().layer(ids[0]!)?.switches.guide;
        // `setLayerSwitches{guide}` through the engine (B3): the whole selection, one entry.
        void setLayersSwitch(ids, { guide: next }, next ? 'Enable Guide Layer' : 'Disable Guide Layer');
        const plural = ids.length > 1;
        notify(
          next
            ? plural
              ? 'Guide layers — visible while editing, omitted from export'
              : 'Guide layer — visible while editing, omitted from export'
            : plural
              ? 'No longer guide layers'
              : 'No longer a guide layer',
          'success',
        );
      },
    },
    {
      /**
       * Motion Sketch — arm, then draw the layer's path while the comp plays.
       *
       * Arming rather than acting immediately is AE's shape and the only one
       * available: the gesture IS the input, so a command can only set up for
       * it. Recording ends on the first pointer release, which is the end of
       * the drag the user just made — a release with no drag records nothing
       * and says so, rather than leaving a session armed indefinitely.
       *
       * Playback starts with the arming, because a sketch against a stopped
       * playhead puts every sample at one instant; `dedupeByTime` collapses
       * that to a single keyframe, which is correct and also useless.
       */
      id: asCommandId('animation.motionSketch'),
      label: 'Motion Sketch (Record Position)',
      icon: 'pencil-line',
      enabled: () => useSelectionStore.getState().ids.length === 1,
      execute: () => {
        const nodeId = useSelectionStore.getState().ids[0];
        if (!nodeId) return;
        armMotionSketch(nodeId);
        if (!isTransportPlaying()) playTransport();
        notify('Motion Sketch armed — drag to record, Esc to cancel', 'info');

        /*
          Two ways out, not one.

          The pointer-up path FINISHES: it writes whatever was sampled, which
          for someone who armed the command and thought better of it is a set of
          keyframes they did not ask for and now have to undo. Escape is the
          other answer — `cancelMotionSketch` drops the session without writing.
          It had no caller at all until this, which is precisely why arming was a
          one-way door.

          Both paths tear down BOTH listeners. `{ once: true }` removes only the
          handler it is attached to, so without an explicit teardown an Escape
          would leave a live pointer-up handler waiting to finish a session that
          no longer exists.
        */
        const cleanup = (): void => {
          window.removeEventListener('pointerup', onUp);
          window.removeEventListener('keydown', onKey);
        };
        const onUp = (): void => {
          cleanup();
          const n = finishMotionSketch();
          if (isTransportPlaying()) pauseTransport();
          notify(
            n > 0 ? `Motion Sketch — ${n} keyframes recorded` : 'Motion Sketch — nothing recorded',
            n > 0 ? 'success' : 'warning',
          );
        };
        const onKey = (ev: KeyboardEvent): void => {
          if (ev.key !== 'Escape') return;
          cleanup();
          cancelMotionSketch();
          if (isTransportPlaying()) pauseTransport();
          notify('Motion Sketch cancelled', 'info');
        };
        window.addEventListener('pointerup', onUp);
        window.addEventListener('keydown', onKey);
      },
    },
    {
      /**
       * Exponential Scale — AE's other keyframe assistant.
       *
       * `enabled` and `execute` both go through `eligibleScaleTracks`, so the
       * command cannot grey itself out for a layer it would have handled, or
       * offer itself for one it would refuse. One predicate, two callers.
       */
      id: asCommandId('animation.exponentialScale'),
      label: 'Exponential Scale',
      icon: 'trending-up',
      enabled: () => {
        const ids = useSelectionStore.getState().ids;
        return ids.length === 1 && eligibleScaleTracks(ids[0]!).length > 0;
      },
      execute: () => {
        const nodeId = useSelectionStore.getState().ids[0];
        if (!nodeId) return;
        // A client macro: the geometric ramp planned here, ONE `setKeyframes` on Scale.
        void exponentialScaleEdit(nodeId).then(({ written, refusal }) => {
          if (refusal) { notify(REFUSAL_TEXT[refusal], 'warning'); return; }
          if (written.size === 0) return;
          const total = [...written.values()].reduce((a, b) => a + b, 0);
          notify(`Exponential scale — ${total} keyframes across ${written.size} tracks`, 'success');
        });
      },
    },
    {
      /**
       * AE Animation ▸ Keyframe Assistant ▸ Time-Reverse Keyframes. No default
       * chord, as in AE: Ctrl/Cmd+Alt+R is AE's Time-Reverse LAYER, and now
       * sits on `time.reverseLayer` (layerTimeCommands.ts).
       */
      id: asCommandId('animation.timeReverseKeyframes'),
      label: 'Time-Reverse Keyframes',
      icon: 'skip-back',
      enabled: () => {
        const id = useSelectionStore.getState().ids[0];
        return !!id && defaultAnimation.animatedProps(id).length > 0;
      },
      execute: () => {
        const id = useSelectionStore.getState().ids[0];
        if (!id) return;
        void timeReverseKeyframesEdit(id).then((done) => {
          if (done === 'none') { notify('Layer has no keyframes yet', 'warning'); return; }
          // B3-legacy: engine gap — `reverseKeyframes` mirrors each property within its OWN span; the assistant mirrors the layer's overall span (they differ when properties span different times).
          if (!done && !timeReverseKeyframes(id)) { notify('Layer has no keyframes yet', 'warning'); return; }
          notify('Keyframes reversed', 'success');
        });
      },
    },
    {
      /** Easy-ease every keyframe on the selected layer (not just the selection set). */
      id: asCommandId('animation.easyEaseAll'),
      label: 'Easy Ease All Keyframes',
      icon: 'track',
      enabled: () => {
        const id = useSelectionStore.getState().ids[0];
        return !!id && defaultAnimation.animatedProps(id).length > 0;
      },
      execute: () => {
        const id = useSelectionStore.getState().ids[0];
        if (!id) return;
        void easyEaseAllEdit(id).then((done) => {
          if (done === 'none') { notify('Layer has no keyframes yet', 'warning'); return; }
          // B3-legacy: engine gap — an animated property outside the API catalog.
          if (!done && !easyEaseAll(id)) { notify('Layer has no keyframes yet', 'warning'); return; }
          notify('Eased all keyframes', 'success');
        });
      },
    },
    {
      /**
       * AE Animation ▸ Keyframe Assistant ▸ The Smoother. Aimed at baked
       * tracks (motion sketch, tracking, audio keyframes, expression bakes):
       * keeps the fewest keyframes that stay within the tolerance and smooths
       * their tangents.
       */
      id: asCommandId('animation.smoother'),
      label: 'The Smoother…',
      icon: 'track',
      // Same predicate the dialog uses to build its track list, so the menu
      // entry cannot be enabled on a layer the dialog would open empty.
      enabled: () => {
        const id = useSelectionStore.getState().ids[0];
        return !!id && smootherTracks(id).length > 0;
      },
      execute: async () => {
        const id = useSelectionStore.getState().ids[0];
        if (!id) return;
        // A real dialog rather than `customPrompt`: tolerance is a look-at-it
        // control, and the prompt could not express WHICH tracks to touch at
        // all. The dialog previews live and commits as one undo entry.
        if (smootherTracks(id).length === 0) {
          notify('Needs a track with 3+ keyframes', 'warning');
          return;
        }
        const summary = await openSmootherDialog(id);
        if (summary) notify(summary, 'success');
      },
    },
    {
      /**
       * AE Animation ▸ Keyframe Assistant ▸ The Wiggler, baked as editable
       * keyframes on position (x/y get independent seeds so the wobble is 2D).
       * The `wiggle()` expression stays the live alternative; this one leaves
       * keys you can drag.
       */
      id: asCommandId('animation.wiggler'),
      label: 'The Wiggler…',
      icon: 'track',
      enabled: () => {
        const id = useSelectionStore.getState().ids[0];
        return !!id && wigglerTracks(id).length > 0;
      },
      execute: async () => {
        const id = useSelectionStore.getState().ids[0];
        if (!id) return;
        // Was a prompt that parsed "5, 25" out of a string — two numbers with
        // different units, unlabelled, and rejected wholesale on a typo.
        if (wigglerTracks(id).length === 0) {
          notify('Animate position first (2+ keyframes on x or y)', 'warning');
          return;
        }
        const summary = await openWigglerDialog(id);
        if (summary) notify(summary, 'success');
      },
    },
    {
      /**
       * Sequence Layers — lay selected clip bars end-to-end (AE-style). Overlap
       * is prompted; a positive overlap also cross-dissolves opacity.
       */
      id: asCommandId('animation.sequenceLayerBars'),
      label: 'Sequence Layers…',
      icon: 'layers',
      enabled: () => useSelectionStore.getState().ids.length >= 2,
      execute: async () => {
        const selectedIds = useSelectionStore.getState().ids;
        if (selectedIds.length < 2) return;
        const raw = await customPrompt(
          'Sequence Layers',
          'Lay the selected layers’ bars end-to-end, in selection order. Overlap in seconds — 0 butts them together; above 0 overlaps the bars by that much and cross-dissolves opacity across the overlap.',
          '0',
          { placeholder: 'e.g. 0.5', confirmLabel: 'Sequence' },
        );
        if (raw === null) return;
        const overlap = Number(raw);
        if (!Number.isFinite(overlap) || overlap < 0) {
          notify('Overlap must be a number of seconds, 0 or more', 'warning');
          return;
        }
        // `sequenceLayers` through the engine (B3): bars and cross-dissolves, ONE
        // entry — one command per composition when the selection spans several (B3z).
        const ok = (await sequenceLayerBarsEdit(selectedIds, overlap, overlap > 0)) === true;
        if (!ok) {
          notify('Select 2+ layers with timeline bars', 'warning');
          return;
        }
        notify(
          overlap > 0
            ? `Layers sequenced with a ${overlap}s cross-dissolve`
            : 'Layers sequenced end-to-end',
          'success',
        );
      },
    },
    {
      /**
       * Stagger Layers — offset the selection in time in a pattern (cascade,
       * zigzag, from the centre, a wave, a seeded scatter), applied either to
       * the clip BARS or to each layer's keyframes.
       *
       * Distinct from Sequence Layers next door, which butts bars end-to-end
       * and so cannot express a fixed trail or keep existing spacing.
       */
      id: asCommandId('animation.staggerLayers'),
      label: 'Stagger Layers…',
      icon: 'layers',
      enabled: () => useSelectionStore.getState().ids.length >= 2,
      execute: async () => {
        const ids = useSelectionStore.getState().ids;
        if (ids.length < 2) return;
        const summary = await openStaggerDialog(ids);
        if (summary) notify(summary, 'success');
      },
    },
    {
      /**
       * Stagger keyframe timing across selected animated layers (does not move
       * bars). Kept beside the dialog as the no-questions version: a 0.3s
       * cascade is the shape people want most of the time, and going through a
       * modal for it is friction. The dialog is where the other patterns and an
       * exact amount live.
       */
      id: asCommandId('animation.sequenceLayers'),
      label: 'Stagger Animations',
      icon: 'layers',
      enabled: () => useSelectionStore.getState().ids.length >= 2,
      execute: () => {
        const ids = useSelectionStore.getState().ids;
        void staggerAnimationsEdit(ids, 0.3).then((done) => {
          if (done === true) notify('Animations staggered', 'success');
          else notify('Select 2+ animated layers first', 'warning');
        });
      },
    },
    {
      /**
       * AE's keyframe assistant, in the place people look for it. The
       * conversion itself already existed but was reachable only from the
       * audio layer's inspector panel — so anyone who knew the AE command by
       * name and searched for it found nothing, and the feature read as
       * missing rather than as hidden.
       */
      id: asCommandId('animation.convertAudioToKeyframes'),
      label: 'Convert Audio to Keyframes',
      icon: 'audio-lines',
      enabled: () => {
        const ids = useSelectionStore.getState().ids;
        if (ids.length !== 1) return false;
        return uiKindOf(documentMirror().layer(ids[0]!)) === 'audio';
      },
      execute: () => {
        const nodeId = useSelectionStore.getState().ids[0];
        if (!nodeId) return;
        // The null (sliders and keys included) is built off-document and pasted: one entry.
        void audioSliderNullEdit(nodeId).then(({ nodeId: nullId, written }) => {
          if (!nullId) {
            notify('That layer has no decodable audio.', 'warning');
            return;
          }
          const total = [...written.values()].reduce((a, b) => a + b, 0);
          notify(`Audio → ${total} keyframes across ${written.size} sliders`, 'success');
        });
      },
    },
    {
      /**
       * Convert Expression to Keyframes — AE's keyframe assistant.
       *
       * `enabled` and `execute` both go through `eligibleExpressionProps`, so
       * the command cannot offer itself for a layer it would refuse (§2·0).
       *
       * The count is worth reporting rather than a bare "done": a bake writes
       * one keyframe per frame, so a two-second layer produces sixty, and a
       * user who does not expect that should learn it from the toast rather
       * than from the timeline.
       */
      id: asCommandId('animation.convertExpressionToKeyframes'),
      label: 'Convert Expression to Keyframes',
      icon: 'keyframe',
      enabled: () => {
        const ids = useSelectionStore.getState().ids;
        return ids.length === 1 && eligibleExpressionProps(ids[0]!).length > 0;
      },
      execute: () => {
        const nodeId = useSelectionStore.getState().ids[0];
        if (!nodeId) return;
        // `convertExpressionToKeyframes` per property: every frame over in → out, expression disabled.
        void expressionBakeEdit(nodeId).then(({ written, refusal }) => {
          if (refusal) { notify(BAKE_REFUSAL_TEXT[refusal], 'warning'); return; }
          if (written.size === 0) return;
          const total = [...written.values()].reduce((a, b) => a + b, 0);
          notify(
            `Expression baked — ${total} keyframes across ${written.size} ` +
              `${written.size === 1 ? 'property' : 'properties'}. The expression is disabled, not deleted.`,
            'success',
          );
        });
      },
    },
    {
      id: BuiltinCommands.ResetLayout,
      label: 'Reset Layout',
      icon: 'layout',
      enabled: () => true,
      execute: () => useLayoutStore.getState().resetLayout(),
    },
    {
      id: BuiltinCommands.SwitchTheme,
      label: 'Switch Theme',
      icon: 'theme',
      shortcut: { key: 'k', meta: true, shift: true },
      enabled: () => true,
      execute: () => getThemeManager().toggle(),
    },
    {
      id: BuiltinCommands.SelectAll,
      label: 'Select All',
      icon: 'select-all',
      shortcut: { key: 'a', meta: true },
      enabled: () => true,
      execute: () => {
        const ids: string[] = [];
        defaultSceneGraph.traverse((n) => ids.push(n.id));
        useSelectionStore.getState().set(ids);
      },
    },
    {
      id: BuiltinCommands.Deselect,
      label: 'Deselect',
      icon: 'deselect',
      shortcut: { key: 'Escape' },
      // Not while the tracker is waiting for its target click. Escape has to
      // cancel that pick, and deselecting instead unmounts the very panel that
      // armed it — using the ShortcutManager's documented fallthrough (a
      // DISABLED command lets the chord reach other handlers) rather than a
      // race between two window listeners, which the tracker loses because it
      // mounts second.
      enabled: () => useSelectionStore.getState().count() > 0 && !isPickArmed(),
      execute: () => useSelectionStore.getState().clear(),
    },
    {
      id: BuiltinCommands.DeleteSelected,
      label: 'Delete Selected',
      icon: 'trash',
      shortcut: { key: 'Backspace' },
      enabled: () => useSelectionStore.getState().count() > 0,
      execute: () => {
        void deleteSelectedLayersEdit();
        notify('Deleted selected layers', 'info');
      },
    },
    {
      id: asCommandId('edit.deleteSelected.del'),
      label: 'Delete Selected (Del key)',
      shortcut: { key: 'Delete' },
      enabled: () => useSelectionStore.getState().count() > 0,
      execute: () => {
        void deleteSelectedLayersEdit();
        notify('Deleted selected layers', 'info');
      },
    },
    {
      id: BuiltinCommands.DuplicateSelected,
      label: 'Duplicate Selected',
      icon: 'copy',
      shortcut: { key: 'd', meta: true },
      enabled: () => useSelectionStore.getState().count() > 0,
      execute: () => {
        void duplicateSelectedLayersEdit().then((copies) => {
          if (copies.length > 0) notify('Duplicated layers', 'success');
        });
      },
    },
    // Cut/Copy/Paste were in the Edit menu but never registered, so all three
    // rendered enabled and did nothing — while a working clipboard module sat
    // uncalled in core/commands.
    {
      id: BuiltinCommands.Cut,
      label: 'Cut',
      shortcut: { key: 'x', meta: true },
      enabled: () => hasCutCopyTarget(),
      execute: () => {
        void cutEdit().then((kind) => { if (kind) notify('Cut', 'info'); });
      },
    },
    {
      id: BuiltinCommands.Copy,
      label: 'Copy',
      shortcut: { key: 'c', meta: true },
      enabled: () => hasCutCopyTarget(),
      execute: () => {
        void copyEdit().then((kind) => { if (kind && kind !== 'path') notify('Copied', 'info'); });
      },
    },
    {
      id: BuiltinCommands.Paste,
      label: 'Paste',
      shortcut: { key: 'v', meta: true },
      // Always enabled: internal clipboard OR OS SVG (AE 26.3). OS content is
      // checked async on execute — we cannot sync-probe the system clipboard.
      enabled: () => true,
      execute: () => {
        // Keyframes: `pasteKeyframes`; layers: the `copyLayers` fragment as one `pasteLayers` (clipboardEdits).
        void pasteEdit().then((kind) => {
          if (kind === 'svg') notify('Pasted SVG', 'success');
          else if (kind) notify('Pasted', 'success');
          else notify('Nothing to paste', 'info');
        });
      },
    },
  ];
}

/** Cut/Copy act on selected keyframes if any, else on selected layers. */
function hasCutCopyTarget(): boolean {
  return useKeyframeSelectionStore.getState().ids.size > 0 || useSelectionStore.getState().count() > 0;
}

/**
 * The Examples menu. Both builders exist and are tested; the commands behind
 * the menu items were simply never registered, so both items rendered enabled
 * and did nothing.
 *
 * Each REPLACES the current scene (they call defaultSceneGraph.clear), so
 * they confirm first — silently discarding the user's work would be worse than
 * the no-op they replace.
 */
/**
 * Every statically-defined command, in one list.
 *
 * WHY IT EXISTS. Boot used to spell out seven `for (const cmd of buildX())`
 * loops, so "what commands does this app have" had no answer short of reading
 * the boot sequence — and a menu entry names its command by STRING id, which
 * both renderers grey out rather than fail on when it is missing. "The menu
 * lists it" and "the command exists" were therefore two claims with nothing
 * requiring them to meet, which is the seam rule 4c is about.
 *
 * One exported list gives the boot sequence and the guard the same answer.
 * Example scenes stay out deliberately: they are registered separately because
 * they REPLACE the scene, and the menu does not reference them.
 */
/**
 * One palette entry per auto-rig preset, DERIVED from the registry.
 *
 * Mapping `RIG_PRESETS` rather than listing the presets means a new one is
 * reachable from the palette the moment it is registered. Writing them out would
 * be the F25 shape again: the entry for whatever preset existed on the day, and
 * a silent gap afterwards — which is exactly how the inspector's `<select>` is
 * already built, so this matches it rather than inventing a second source.
 *
 * Applying a preset REPLACES the rig, and that is stated in the label rather
 * than behind a confirm: merging two skeletons produces duplicate bone ids, and
 * a duplicate id silently couples two bones onto one animation track.
 */
function buildRigPresetCommands(): ReadonlyArray<Command> {
  return (Object.keys(RIG_PRESETS) as RigPresetId[]).map((id) => ({
    id: asCommandId(`rig.preset.${id}`),
    label: `Auto-Rig: ${RIG_PRESET_LABELS[id]}`,
    icon: 'bone' as const,
    enabled: () => useSelectionStore.getState().count() > 0,
    execute: async () => {
      const nodeId = useSelectionStore.getState().ids[0];
      if (!nodeId) return;
      const node = defaultSceneGraph.getNode(nodeId);
      if (!node) return;
      // Sized from the layer's own box, so the rig fits the artwork. `readGeometry`
      // reports the UNSCALED size, which is what keeps a scaled layer from getting
      // a differently-proportioned skeleton.
      const geom = readGeometry(node);
      // One entry: a whole-rig `layer/skeleton` write (ENGINE_API.md §15.9).
      const problems = await applyRigPresetEdit(
        nodeId,
        RIG_PRESETS[id]({ width: geom?.width ?? 200, height: geom?.height ?? 200 }),
        `Auto-Rig ${RIG_PRESET_LABELS[id]}`,
      );
      // Never silently: a refused rig with no message reads as a dead command,
      // which is worse than the error.
      if (problems.length > 0) {
        notify(`Auto-rig refused: ${problems.map((p) => p.kind).join(', ')}`, 'warning');
        return;
      }
      notify(`${RIG_PRESET_LABELS[id]} rig applied`, 'success');
    },
  }));
}

export function buildStaticCommands(): ReadonlyArray<Command> {
  return [
    ...buildBuiltinCommands(),
    ...buildToolCommands(),
    ...buildPathCommands(),
    ...buildCameraToolCommands(),
    ...buildViewSwitchCommands(),
    ...buildMarkerCommands(),
    ...buildEasingCommands(),
    ...buildMergePathCommands(),
    ...buildPrimitive3DCommands(),
    ...buildSceneEditCommands(),
    ...buildWorkspaceCommands(),
    ...buildProjectCommands(),
    ...buildRigPresetCommands(),
    ...buildCaptionCommands(),
    ...buildChoreographyCommands(),
    ...buildBeatCommands(),
    ...buildSpeedRampCommands(),
    ...buildLayerTimeCommands({ openTimeStretch: openTimeStretchDialog }),
    ...buildExpressionCommands(),
    ...buildLayerTransformCommands({ openAutoOrient: openAutoOrientDialog }),
    ...buildCameraCommands(),
    ...buildSmartAnimateCommands(),
    ...buildReframeCommands(),
    ...buildIk3DCommands(),
    ...buildBakeCommands(),
    ...buildAudioCommands(),
  ];
}

function buildProjectCommands(): ReadonlyArray<Command> {
  return [
    // "New Composition…" was removed — compositions are created from the
    // dashboard (one project per composition), so there's no in-editor add path.
    {
      // The Composition menu had no "New Composition…" while the dialog was
      // live in the Project panel — a working feature with no menu home. This
      // is that home; the Project panel's button calls the same dialog.
      id: asCommandId('comp.new'),
      label: 'New Composition…',
      icon: 'component',
      enabled: () => true,
      execute: () => openNewCompositionDialog(),
    },
    {
      id: asCommandId('comp.multicam'),
      label: 'New Multicam from Library…',
      icon: 'layers',
      enabled: () => useAssetStore.getState().assets.filter((a) => a.type === 'video' || a.type === 'image').length >= 2,
      execute: async () => {
        const vids = useAssetStore.getState().assets.filter((a) => a.type === 'video' || a.type === 'image');
        if (vids.length < 2) return;
        const { createMulticamComposition } = await import('@core/composition/multicam');
        try {
          await createMulticamComposition(vids.slice(0, Math.min(8, vids.length)));
        } catch (e) {
          console.error(e);
        }
      },
    },
    {
      /**
       * The rough-cut gesture: pick takes in the bin, get a timeline of them.
       *
       * Everything under it already shipped — `createCompositionFromFootage`
       * for the comp, `sequenceLayerBars` for the layout, `writeCrossfades` for
       * the dissolve — and doing it by hand was six gestures and six undo
       * entries, half of which land every clip stacked at frame 0.
       */
      id: asCommandId('comp.newFromSelectedClips'),
      label: 'New Composition from Selected Clips…',
      icon: 'component',
      enabled: () => selectedPanelFootage().length > 0,
      execute: () => {
        const assets = selectedPanelFootage();
        if (assets.length === 0) {
          notify('Select footage in the Assets panel first', 'warning');
          return;
        }
        void runNewCompFromClips(assets);
      },
    },
    {
      /**
       * Scene Edit Detection, the splits, the culling and the sequencing as one
       * act — see `@core/composition/assembleFromFootage`. Acts on a selected
       * video layer, or on a video item selected in the Assets panel.
       */
      id: asCommandId('comp.assembleFromFootage'),
      label: 'Assemble from Footage…',
      icon: 'scissors',
      enabled: () => assembleTarget() !== null,
      execute: () => {
        const target = assembleTarget();
        if (!target) {
          notify('Select a video layer, or a video item in the Assets panel', 'warning');
          return;
        }
        void runAssembleFromFootage(target);
      },
    },
    ...([1, 2, 3, 4, 5, 6, 7, 8, 9] as const).map((n) => ({
      id: asCommandId(`comp.multicamAngle${n}`),
      label: `Multicam Cut → Angle ${n}`,
      shortcut: { key: String(n), alt: true },
      enabled: () => true,
      execute: async () => {
        const { switchMulticamAngle } = await import('@core/composition/multicam');
        switchMulticamAngle(n);
      },
    })),
    {
      id: asCommandId('comp.multicamViewer'),
      label: 'Multicam Viewer…',
      icon: 'layers',
      enabled: () => true,
      execute: async () => {
        const { openMulticamViewer } = await import('@layout/Multicam/MulticamViewer');
        openMulticamViewer();
      },
    },
    {
      id: asCommandId('comp.multicamSync'),
      label: 'Sync Multicam by Audio',
      icon: 'audio',
      enabled: () => true,
      execute: async () => {
        const { alignMulticamByAudio } = await import('@core/composition/multicam');
        const report = await alignMulticamByAudio();
        useUIStore.getState().notify({
          level: report.shifted > 0 ? 'success' : 'info',
          message: report.note,
          durationMs: 5000,
        });
      },
    },
    {
      id: asCommandId('comp.settings'),
      label: 'Composition Settings…',
      shortcut: { key: 'k', meta: true },
      enabled: () => true,
      execute: () => {
        openCompositionSettings();
      },
    },
    {
      // AE's Shift+Esc: "open the most recently active composition in the same
      // composition network" — back out of a precomp you double-clicked into,
      // and back in again. Disabled (so the chord falls through) when there is
      // nowhere to go.
      id: asCommandId('comp.openPrevious'),
      label: 'Open Previous Composition',
      icon: 'arrow-left',
      shortcut: { key: 'Escape', shift: true },
      enabled: () => canOpenPreviousComposition(),
      execute: () => { openPreviousComposition(); },
    },
    {
      // AE's Tab: the Composition Mini-Flowchart — the comps just upstream and
      // downstream of this one, to jump between. Yields Tab to text fields,
      // dialogs and menus (a disabled command falls through); while it is
      // open the popup claims Tab itself, so Tab again closes it.
      id: asCommandId('comp.miniFlowchart'),
      label: 'Composition Mini-Flowchart',
      icon: 'layers',
      shortcut: { key: 'Tab' },
      enabled: () => !focusNavigationClaimedNow(),
      execute: () => useMiniFlowchartStore.getState().toggle(),
    },
    {
      // AE: select a composition in the Project panel and press Delete.
      // Menu home for the same op when the Assets bin isn't focused.
      id: asCommandId('comp.delete'),
      label: 'Delete Composition',
      icon: 'trash',
      enabled: () => {
        const st = useProjectStore.getState();
        const tabId = st.activeTabId;
        if (!tabId) return false;
        const compId = st.tabs[tabId]?.compositionId;
        if (!compId) return false;
        const comp = st.comps[compId];
        return Boolean(comp && !comp.pristine);
      },
      execute: async () => {
        const st = useProjectStore.getState();
        const tabId = st.activeTabId;
        if (!tabId) return;
        const compId = st.tabs[tabId]?.compositionId;
        if (!compId) return;
        const comp = st.comps[compId];
        if (!comp || comp.pristine) return;
        const warn = deleteCompositionWarning(comp.name, compId);
        if (await customConfirm('Delete Composition', warn, { isDanger: true, confirmLabel: 'Delete' })) {
          // `removeItems` with the layers that place it; the tabs close (sceneEdits).
          await deleteCompositionEdit(compId);
        }
      },
    },
    {
      id: asCommandId('scene.loadBlockTower'),
      label: 'Load: Block Tower',
      description: 'Shapes hop, stack into a tower, then burst into pieces.',
      icon: 'component',
      enabled: () => true,
      execute: async () => {
        if (await loadBlockTower()) notify('Loaded Block Tower', 'success');
      },
    },
    {
      id: asCommandId('layer.newText'),
      label: 'Text',
      shortcut: { key: 't', meta: true, alt: true, shift: true },
      enabled: () => true,
      // The insert (pointer placement, comp-scaled size) runs off-document → ONE pasteLayers entry.
      execute: () => { void insertBuiltLayers('New Text Layer', (activeCompIdNow() ?? 'comp_root'), () => insertPrimitive('text', 'Text')); },
    },
    {
      id: asCommandId('layer.newSolid'),
      label: 'Solid…',
      shortcut: { key: 'y', meta: true },
      enabled: () => true,
      // AE: Layer ▸ New ▸ Solid opens Solid Settings before inserting.
      execute: () => openSolidSettings({ mode: 'new' }),
    },
    {
      // The AE-style options dialog, not a bare insert. This called
      // `insertCamera()` directly, so the menu path and the TopNav "+" path
      // disagreed: one silently dropped a default camera, the other asked for
      // name / lens / two-node. The dialog is the one that teaches what a
      // camera IS, so both entry points get it. Shortcut is AE's.
      id: asCommandId('layer.newCamera'),
      label: 'Camera…',
      shortcut: { key: 'c', meta: true, alt: true, shift: true },
      enabled: () => true,
      execute: () => openCameraDialog(),
    },
    {
      // Same story as the camera: the dialog (type / colour / intensity), not
      // a silent default point light.
      id: asCommandId('layer.newLight'),
      label: 'Light…',
      shortcut: { key: 'l', meta: true, alt: true, shift: true },
      enabled: () => true,
      execute: () => openLightDialog(),
    },
    {
      id: asCommandId('layer.newNull'),
      label: 'Null Object',
      shortcut: { key: 'y', meta: true, alt: true, shift: true },
      enabled: () => true,
      execute: () => { void createLayerEdit('null', { name: 'Null', label: 'New Null Object' }); },
    },
    {
      // AE's "Create Nulls From Paths" script: a handle on every vertex of the
      // selected shape, parented to it. Enabled only for a single shape layer
      // with a drawn outline — a rectangle primitive has no vertices to rig.
      id: asCommandId('layer.nullsFromPath'),
      label: 'Create Nulls From Path Points',
      enabled: () => {
        const ids = useSelectionStore.getState().ids;
        if (ids.length !== 1) return false;
        const n = docGraph.getNode(ids[0]!);
        return !!n && readNodeKind(n) === 'shape' && pathVertices(n, playheadSeconds()).length > 0;
      },
      execute: () => {
        const id = useSelectionStore.getState().ids[0];
        if (!id) return;
        // The nulls, built off-document INTO the shape: one pasteLayers, one entry.
        void nullsFromPathEdit(id, playheadSeconds()).then((made) => {
          notify(made.length ? `Created ${made.length} null${made.length === 1 ? '' : 's'} on the path` : 'No path points to create nulls from', made.length ? 'success' : 'warning');
        });
      },
    },
    {
      // The live direction: every vertex follows its null from now on.
      id: asCommandId('layer.nullsFromPathLive'),
      label: 'Create Nulls From Path Points (Points Follow Nulls)',
      enabled: () => {
        const ids = useSelectionStore.getState().ids;
        if (ids.length !== 1) return false;
        const n = docGraph.getNode(ids[0]!);
        return !!n && readNodeKind(n) === 'shape' && pathVertices(n, playheadSeconds()).length > 0;
      },
      execute: () => {
        const id = useSelectionStore.getState().ids[0];
        if (!id) return;
        // The nulls and the vertex → null bindings (`layer/pointBindings`): one engine gesture.
        void nullsFromPathEdit(id, playheadSeconds(), { pointsFollowNulls: true }).then((made) => {
          notify(made.length ? `${made.length} null${made.length === 1 ? '' : 's'} now drive the path — move one and the outline follows` : 'No path points to create nulls from', made.length ? 'success' : 'warning');
        });
      },
    },
    {
      // AE's Layer ▸ Create Shapes from Text. The outlines are TRACED from a
      // supersampled raster of the glyphs (see shapesFromText.ts), and the
      // source text layer is hidden, not deleted.
      id: asCommandId('layer.shapesFromText'),
      label: 'Create Shapes From Text',
      enabled: () => {
        const ids = useSelectionStore.getState().ids;
        return ids.length === 1 && canCreateShapesFromText(ids[0]!);
      },
      execute: async () => {
        const id = useSelectionStore.getState().ids[0];
        if (!id) return;
        // A client macro: outlines in the editor, the shape built off-document + the text hidden, one entry.
        const made = await shapesFromTextEdit(id, playheadSeconds());
        notify(
          !made
            ? 'Could not outline this text — is it empty?'
            : made.source === 'outlines'
              ? 'Created a shape layer from the font’s own outlines'
              : 'Created a shape layer from traced outlines (the font file could not be read — allow local fonts for exact curves)',
          made ? 'success' : 'warning',
        );
      },
    },
    {
      // AE's Layer ▸ Auto-trace: the layer's alpha as mask paths — one frame,
      // or every frame of the work area as mask keyframes.
      id: asCommandId('layer.autoTrace'),
      label: 'Auto-trace…',
      enabled: () => useSelectionStore.getState().ids.length === 1,
      execute: async () => {
        const id = useSelectionStore.getState().ids[0];
        if (!id) return;
        const c = getTimelineController();
        const now = c.currentSeconds;
        const wa = c.timeline.getRanges().workArea;
        const fps = c.timeline.getFrameRate().fps;
        const choice = await customPrompt(
          'Auto-trace',
          'Trace the current frame, or every frame of the work area? Type "frame" or "range". Optional threshold 0–255 after a space (default 128).',
          'frame 128',
        );
        if (choice === null) return;
        const [modeRaw, thrRaw] = choice.trim().split(/\s+/);
        const range = (modeRaw ?? '').toLowerCase().startsWith('r');
        const threshold = Math.max(0, Math.min(255, Number(thrRaw) || 128));
        const startSec = range && wa ? wa.start / fps : now;
        const endSec = range && wa ? (wa.start + wa.duration - 1) / fps : undefined;
        const noteId = useUIStore.getState().notify({ level: 'info', message: 'Auto-trace: rendering…', durationMs: 0 });
        try {
          const r = await autoTraceLayer({
            nodeId: id, startSec, endSec, threshold,
            onProgress: (f) => {
              useUIStore.getState().notify({ level: 'info', message: `Auto-trace: ${Math.round(f * 100)}%`, durationMs: 600 });
            },
          });
          useUIStore.getState().dismissNotification(noteId);
          notify(
            r.pathsAdded === 0
              ? 'Auto-trace found nothing above the threshold'
              : `Auto-trace: ${r.pathsAdded} mask path${r.pathsAdded === 1 ? '' : 's'}${r.keyframes ? `, ${r.keyframes} keyframes` : ''}`,
            r.pathsAdded === 0 ? 'warning' : 'success',
          );
        } catch (err) {
          useUIStore.getState().dismissNotification(noteId);
          notify(`Auto-trace failed: ${err instanceof Error ? err.message : String(err)}`, 'error');
        }
      },
    },
    {
      id: asCommandId('layer.newAdjustment'),
      label: 'Adjustment Layer',
      shortcut: { key: 'y', meta: true, alt: true },
      enabled: () => true,
      execute: () => { void createLayerEdit('adjustment', { name: 'Adjustment Layer 1', label: 'New Adjustment Layer' }); },
    },
    {
      id: asCommandId('layer.precompose'),
      label: 'Pre-compose…',
      shortcut: { key: 'c', meta: true, shift: true },
      enabled: () => useSelectionStore.getState().count() > 0,
      // AE's dialog: name, Leave / Move all attributes, trim to span, open.
      execute: () => openPrecomposeDialog(),
    },
    // ── Fit (AE's Layer ▸ Transform submenu) ──────────────────────────
    // One-shot commands that COMPUTE a size and write it, rather than a stored
    // "fit mode" the renderer re-resolves every frame. The old Media panel had
    // the property version and it never did anything — see fitCommands.ts for
    // why the command form is the one that can work. They read intrinsic size
    // through `sourceOf`, so a placed composition fits exactly like footage.
    ...([
      ['layer.fitToComp', 'Fit to Comp', 'contain' as const, { key: 'f', meta: true, alt: true }],
      // AE's chords: Ctrl+Alt+Shift+H / G.
      ['layer.fitToCompWidth', 'Fit to Comp Width', 'width' as const, { key: 'h', meta: true, alt: true, shift: true }],
      ['layer.fitToCompHeight', 'Fit to Comp Height', 'height' as const, { key: 'g', meta: true, alt: true, shift: true }],
      ['layer.fillComp', 'Fill Comp (crop to frame)', 'cover' as const, undefined],
      ['layer.nativeSize', 'Set to Native Size', 'native' as const, undefined],
    ] as const).map(([id, label, mode, shortcut]) => ({
      id: asCommandId(id),
      label,
      ...(shortcut ? { shortcut } : {}),
      enabled: () => useSelectionStore.getState().count() > 0,
      execute: () => {
        const frame = activeTabCompSize();
        const ids = useSelectionStore.getState().ids;
        // Through the engine (B3): the whole selection, one entry. Every layer kind has a
        // width / height property; a composition root (a comp's own row) is not a layer.
        void fitLayersEdit(ids.filter((id) => isLayer(id)), frame, mode, playheadSeconds());
      },
    })),
    {
      id: asCommandId('layer.centreAnchor'),
      label: 'Centre Anchor Point in Layer Content',
      // AE: Ctrl/Cmd+Alt+Home.
      shortcut: { key: 'Home', meta: true, alt: true },
      enabled: () => useSelectionStore.getState().count() > 0,
      execute: () => {
        const ids = useSelectionStore.getState().ids;
        // Through the engine (B3): anchor + compensating Position, one entry for the selection.
        void centreAnchorEdit(ids, playheadSeconds()).then((done) => {
          // B3-legacy: engine gap — a node that is not a layer of a composition.
          if (!done) for (const nodeId of ids) centreAnchorInContent(nodeId);
        });
      },
    },
    {
      /*
        The companion to the fit commands above, and the reason `centreInFrame`
        existed with no caller.

        It sat in `fitCommands.ts` under a comment claiming import auto-fit used
        it — which was never true: `insertMedia` sizes with `computeFit` and
        positions with `placeInComp`, both before the node is in the graph, so it
        could not have been the caller. What the function actually is, is this
        menu command: AE has Layer ▸ Transform ▸ Center In View, and this did
        not.

        Distinct from the anchor command above. That one moves the ANCHOR inside
        the layer's own content and leaves the layer where it is; this moves the
        LAYER to the middle of the frame. They read similarly and do opposite
        halves of the same job, which is why both labels name what moves.
      */
      id: asCommandId('layer.centreInComp'),
      label: 'Centre Layer in Comp',
      // AE's Center In View: Ctrl/Cmd+Home. Plain Home stays "go to start" —
      // useTimelineKeys ignores Home while Ctrl/Cmd is held.
      shortcut: { key: 'Home', meta: true },
      enabled: () => useSelectionStore.getState().count() > 0,
      execute: () => {
        const frame = activeTabCompSize();
        const ids = useSelectionStore.getState().ids;
        void centreInCompEdit(ids, frame, playheadSeconds()).then((done) => {
          // B3-legacy: engine gap — a node that is not a layer of a composition.
          if (!done) for (const nodeId of ids) centreInFrame(nodeId, frame);
        });
      },
    },
    {
      // Flatten a multi-part logo (group / precomp / multi-selection) to one
      // image layer and drop a starter puppet rig on it — a single riggable
      // image/shape leaf is rigged in place instead. See rigLogo.ts.
      id: asCommandId('layer.rigLogo'),
      label: 'Rig Logo for Animation',
      icon: 'puppet-pin',
      enabled: () => useSelectionStore.getState().count() > 0,
      execute: () => {
        void rigLogoForAnimation();
      },
    },
    /*
      Arrange (z-order): a layer draws on top of the ones added before it, so a
      newly-imported background lands in front and hides everything. These give
      explicit stacking control (Figma/Illustrator chords: Ctrl/Cmd+] / [).

      Each one hands `arrangeNodes` the WHOLE selection rather than looping a
      single-layer move over it. The loop was wrong for any multi-selection —
      the layers leapfrogged each other (Bring Forward over two adjacent layers
      was a net no-op, Send to Back came out reversed) and each iteration landed
      its own undo step. `reorderSiblings` documents the block rules.

      The notice follows the RETURN value, so a layer already at the front no
      longer reports having been brought forward.
    */
    ...([
      ['layer.bringToFront', 'Bring to Front', 'arrow-up', 'front', 'Brought to front', { key: ']', meta: true, shift: true }],
      ['layer.bringForward', 'Bring Forward', 'chevron-up', 'forward', 'Brought forward', { key: ']', meta: true }],
      ['layer.sendBackward', 'Send Backward', 'chevron-down', 'backward', 'Sent backward', { key: '[', meta: true }],
      ['layer.sendToBack', 'Send to Back', 'arrow-down', 'back', 'Sent to back', { key: '[', meta: true, shift: true }],
    ] as const).map(([id, label, icon, action, message, shortcut]) => ({
      id: asCommandId(id),
      label,
      icon,
      shortcut,
      enabled: () => useSelectionStore.getState().count() > 0,
      execute: () => {
        // `reorderLayers` through the engine (B3), one entry.
        void arrangeLayersEdit(useSelectionStore.getState().ids, action).then((moved) => {
          if (moved) notify(message, 'info');
        });
      },
    })),
    {
      id: asCommandId('effect.blur'),
      label: 'Fast Box Blur',
      enabled: () => useSelectionStore.getState().primary !== null,
      execute: () => {
        const id = useSelectionStore.getState().primary;
        if (id) { void addEffectEdit([id], 'blur'); notify('Added Fast Box Blur', 'success'); }
      },
    },
    {
      id: asCommandId('effect.glow'),
      label: 'Glow',
      enabled: () => useSelectionStore.getState().primary !== null,
      execute: () => {
        const id = useSelectionStore.getState().primary;
        if (id) { void addEffectEdit([id], 'glow'); notify('Added Glow', 'success'); }
      },
    },
    {
      id: asCommandId('effect.brightness'),
      label: 'Brightness & Contrast',
      enabled: () => useSelectionStore.getState().primary !== null,
      execute: () => {
        const id = useSelectionStore.getState().primary;
        if (id) { void addEffectEdit([id], 'brightness'); notify('Added Brightness & Contrast', 'success'); }
      },
    },
    {
      id: asCommandId('effect.contrast'),
      label: 'Contrast',
      enabled: () => useSelectionStore.getState().primary !== null,
      execute: () => {
        const id = useSelectionStore.getState().primary;
        if (id) { void addEffectEdit([id], 'contrast'); notify('Added Contrast', 'success'); }
      },
    },
    {
      id: asCommandId('effect.saturate'),
      label: 'Hue/Saturation',
      enabled: () => useSelectionStore.getState().primary !== null,
      execute: () => {
        const id = useSelectionStore.getState().primary;
        if (id) { void addEffectEdit([id], 'saturate'); notify('Added Hue/Saturation', 'success'); }
      },
    },
    {
      id: asCommandId('effect.grayscale'),
      label: 'Grayscale',
      enabled: () => useSelectionStore.getState().primary !== null,
      execute: () => {
        const id = useSelectionStore.getState().primary;
        if (id) { void addEffectEdit([id], 'grayscale'); notify('Added Grayscale', 'success'); }
      },
    },
    {
      id: asCommandId('effect.sepia'),
      label: 'Sepia',
      enabled: () => useSelectionStore.getState().primary !== null,
      execute: () => {
        const id = useSelectionStore.getState().primary;
        if (id) { void addEffectEdit([id], 'sepia'); notify('Added Sepia', 'success'); }
      },
    },
    {
      id: asCommandId('effect.hue'),
      label: 'Hue Rotate',
      enabled: () => useSelectionStore.getState().primary !== null,
      execute: () => {
        const id = useSelectionStore.getState().primary;
        if (id) { void addEffectEdit([id], 'hue-rotate'); notify('Added Hue Rotate', 'success'); }
      },
    },
    {
      id: asCommandId(ProjectCommands.New),
      label: 'New Project',
      shortcut: { key: 'n', meta: true },
      enabled: () => true,
      execute: async () => {
        // Cmd+N is one key away from Cmd+B/Cmd+M. Without this, a slip
        // replaces the document with no way back.
        if (!await confirmDiscardChanges('Create a new project')) return;
        getProjectManager().newProject('Untitled');
        // The two things a blank DOCUMENT cannot express: the previous
        // project's precomp tabs and its timelines. After the restore, so the
        // timeline re-initialises against the new comp's frame rate.
        resetProjectWorkspace();
        // Creating a project is a document transition, exactly like opening
        // one, and needs the same undo re-baseline: history is a flat stack
        // with no project identity in it, so without this one Ctrl+Z pulled
        // the PREVIOUS document back into the new project.
        baselineProjectHistory('New Project');
        bumpScene();
        // After the bump — which emits SceneGraphChanged, which the boot wiring
        // turns back into markDirty(true). A brand-new empty project used to
        // arrive already flagged as unsaved, so the very next New/Open prompted
        // to discard changes that did not exist.
        afterProjectLoaded();
        notify('New project created', 'success');
      },
    },
    {
      id: asCommandId(ProjectCommands.Open),
      label: 'Open Project…',
      shortcut: { key: 'o', meta: true },
      enabled: () => true,
      execute: async () => {
        // Asked before the file picker, not after: a user who has decided not
        // to lose their work should not first have to choose a file.
        if (!await confirmDiscardChanges('Open another project')) return;
        // Local-first: `.motion` is a directory bundle → use the native folder
        // picker. Only when there IS one: `chooseBundleDir` returns null both
        // for "cancelled" and for "no picker in this build", and treating them
        // alike meant cancelling the folder dialog on the desktop immediately
        // opened a second one. Cancel means cancel; the browser build (no
        // picker) still falls through to the normal file open.
        if (isLocalFirst() && bundleDirPickerAvailable()) {
          const dir = await chooseBundleDir();
          if (!dir) {
            notify('Open cancelled', 'info');
            return;
          }
          const opened = await openProjectPath(dir);
          if (opened) {
            notify(`Opened “${opened.name}”`, 'success');
          } else {
            notify('Could not open that bundle', 'error');
          }
          return;
        }
        // Packed `.motion` zip (browser + cloud edition). Cloud projects stay
        // on the dashboard; this is File → Open Project for a local file.
        const opened = await openLocalMotionFile();
        if (opened.status === 'cancelled') {
          notify('Open cancelled', 'info');
          return;
        }
        if (opened.status === 'failed') {
          notify(opened.error ?? 'Could not open that project', 'error');
          return;
        }
        notify(`Opened “${opened.name}”`, 'success');
        // Same per-project reset the cloud loader does: the Footage tab must
        // not carry the previous project's last-previewed clip name.
        clearLastFootagePreview();
        if (opened.missing.length) offerRelink(opened.missing);
      },
    },
    {
      id: asCommandId(ProjectCommands.Save),
      label: 'Save',
      shortcut: { key: 's', meta: true },
      enabled: () => true,
      execute: async () => {
        // A document with no destination yet routes to Save As inside the
        // manager, so this covers the "no project open" case too — which used
        // to bail out and report success without writing anything.
        const pm = getProjectManager();
        const before = pm.getState().current?.path ?? null;
        // ...and in a browser with no picker, that internal Save As has nowhere
        // to route to, so Ctrl+S on a never-saved document would just report
        // "cancelled". Take the portable-file path instead.
        if (!before && needsPortableSaveFallback()) {
          await saveAsPortableFile(pm.getState().current?.name ?? 'Untitled');
          return;
        }
        reportSave(await pm.save(), { forkedFrom: before });
      },
    },
    {
      id: asCommandId(ProjectCommands.SaveAs),
      label: 'Save As…',
      shortcut: { key: 's', meta: true, shift: true },
      enabled: () => true,
      /**
       * Save As means ONE thing in every build: a save dialog, and a file
       * wherever on this machine the user points it.
       *
       * It used to mean three. On desktop it opened a native dialog; in a
       * browser without the File System Access API it opened nothing and wrote
       * to a localStorage virtual FS; and in the cloud editor it opened nothing
       * and forked a project on the SERVER — so the one build most people use
       * had a Save As that could not put a file on their laptop at all. That
       * is not a variant of Save As, it is a different command, and it has its
       * own entry now (Save Copy to Cloud…).
       *
       * Desktop still routes through `pm.saveAs`, which is already a native
       * dialog AND writes the local-first `.motion` bundle that Sync Project
       * reconciles against — sending it down the portable path would silently
       * turn a syncable bundle into a flat archive.
       */
      execute: async () => {
        const pm = getProjectManager();
        const before = pm.getState().current?.path ?? null;
        // The CURRENT name, not a hardcoded "Untitled" — Increment and Save
        // right below has always read it, and a Save As that proposes the
        // wrong filename is a Save As that quietly makes a second "Untitled".
        const name = pm.getState().current?.name ?? 'Untitled';
        if (getFileManager().environment === 'electron') {
          reportSave(await pm.saveAs(name), { forkedFrom: before });
          return;
        }
        await saveAsPortableFile(name);
      },
    },
    {
      id: asCommandId(ProjectCommands.SaveCopyToCloud),
      label: 'Save Copy to Cloud…',
      /**
       * What Save As used to do in the cloud editor: fork the project on the
       * server. Kept, because forking a cloud project is a real thing to want —
       * it just is not what "Save As" says, and it was the reason Save As
       * could not write a file.
       */
      enabled: () => getFileManager().environment === 'api',
      execute: async () => {
        const pm = getProjectManager();
        const before = pm.getState().current?.path ?? null;
        const entered = await customPrompt(
          'Save Copy to Cloud',
          'This creates a copy of the project in your cloud workspace. What should it be called?',
          pm.getState().current?.name ?? 'Untitled',
          { placeholder: 'Project name', confirmLabel: 'Save copy' },
        );
        if (!entered?.trim()) { notify('Save cancelled', 'info'); return; }
        reportSave(await pm.saveAs(entered.trim()), { forkedFrom: before });
      },
    },
    {
      id: asCommandId(ProjectCommands.SaveToComputer),
      // Named for what distinguishes it from Save As on the desktop: a single
      // portable `.motion` archive with assets embedded, rather than the
      // local-first directory bundle. "Save to Computer" said nothing, now that
      // Save As also saves to the computer.
      label: 'Save Portable Copy…',
      enabled: () => true,
      execute: async () => {
        const name = getProjectManager().getState().current?.name ?? 'Untitled';
        const result = await saveToComputer(name);
        if (result.status === 'cancelled') {
          notify('Save cancelled', 'info');
          return;
        }
        if (result.status === 'failed') {
          notify(result.error ?? 'Could not save to computer', 'error');
          return;
        }
        notify(`Saved “${name}.motion” to your computer`, 'success');
      },
    },
    {
      id: asCommandId(ProjectCommands.IncrementAndSave),
      label: 'Increment and Save',
      // AE: Cmd/Ctrl+Alt+Shift+S — save a fresh copy with the next number.
      shortcut: { key: 's', meta: true, alt: true, shift: true },
      enabled: () => true,
      execute: async () => {
        const pm = getProjectManager();
        const before = pm.getState().current?.path ?? null;
        const current = pm.getState().current?.name ?? 'Untitled';
        // Shares reportSave with the other two, so the copy also clears the
        // unsaved indicator — this used to leave the amber dot up after a
        // successful save, and the next New/Open still asked to discard.
        reportSave(await pm.saveAs(incrementName(current)), { forkedFrom: before });
      },
    },
    {
      id: asCommandId(ProjectCommands.Sync),
      label: 'Sync Project…',
      /**
       * Only for a local-first `.motion` bundle that is actually open — cloud
       * projects already live on the server, and there is nothing to reconcile
       * for an unsaved scratch document.
       */
      enabled: () => canSyncCurrentProject(),
      execute: async () => {
        const passphrase = await customPrompt(
          'Sync Project',
          'Enter this project’s sync passphrase. It never leaves this device — the ' +
            'server only ever stores ciphertext it cannot read. Use the same passphrase ' +
            'on every device, or they will not be able to decrypt each other’s changes.',
          '',
          { placeholder: 'Sync passphrase', confirmLabel: 'Sync' },
        );
        // Cancelled, or an empty passphrase — which would derive a real key from
        // nothing and silently encrypt the project under it.
        if (!passphrase) return;

        notify('Syncing…', 'info');
        try {
          const outcome = await syncCurrentProject(passphrase);
          if (outcome.status === 'synced') {
            notify('Project synced', 'success');
          } else if (outcome.status === 'conflict') {
            // Not an error: another device pushed first. The engine keeps both
            // sides, so say what happened rather than implying data was lost.
            notify('Another device changed this project — sync again to merge', 'warning');
          } else {
            notify('Sync failed — check your connection and passphrase', 'error');
          }
        } catch (err) {
          notify(err instanceof Error ? err.message : 'Sync failed', 'error');
        }
      },
    },
    {
      id: asCommandId(ProjectCommands.Close),
      label: 'Close Project',
      enabled: () => true,
      execute: async () => {
        if (!await confirmDiscardChanges('Close the project')) return;
        getProjectManager().close();
        bumpScene();
        notify('Project closed', 'info');
      },
    },
    {
      id: asCommandId(ProjectCommands.About),
      label: 'About Premation',
      enabled: () => true,
      // The dialog itself lives with Help; this used to be an inline modal with a
      // hand-typed "Version 0.1.0" that no release ever updated.
      execute: () => openAbout(),
    },
  ];
}

export function Providers({ children }: ProvidersProps): JSX.Element {
  const [ready, setReady] = useState(false);

  useEffect(() => {
    let cancelled = false;
    /**
     * Every subscription this boot makes, so the cleanup can actually release
     * them.
     *
     * The EventBus and the ThemeManager are process-wide singletons that outlive
     * this component, but `Providers` is mounted PER ROUTE (EditorPage and
     * PopoutRoute) and React StrictMode double-invokes effects. The disposers
     * returned by `getEventBus.on(...)` and `theme.subscribe(...)` were all
     * discarded, so every Dashboard → Editor navigation stacked another full set
     * of eight bus listeners on top of the previous ones.
     *
     * The cost compounds: on the Nth entry, one AnimationChanged fires bumpScene
     * N times, and bumpScene itself emits SceneGraphChanged — which then fires
     * scheduleRecord and markDirty N times each, plus N full syncFromScene walks.
     * That is O(N²) work per keyframe edit, which reads as "the editor gets slower
     * the longer I use it".
     */
    let stopSync: (() => void) | null = null;
    const subs: Array<() => void> = [];
    const track = (d: { dispose(): void } | (() => void)): void => {
      subs.push(typeof d === 'function' ? d : () => d.dispose());
    };
    (async () => {
      await applyPreferencesToDocument();
      // D5 / F2: does the C++ engine own the document in this window? Main
      // decides (engine:status.ownsDocument); default off. A pop-out never
      // owns anything (it mirrors the editor shell's window).
      const ownsDocument = !isPopoutWindow() && await processEngineOwnsDocument();
      setEngineOwnsDocument(ownsDocument);

      const selection = {
        get: () => useSelectionStore.getState().ids,
        set: (ids: ReadonlyArray<string>) => useSelectionStore.getState().set(ids),
        clear: () => useSelectionStore.getState().clear(),
      };
      const panels = {
        open: (id: string) => useLayoutStore.getState().openPanel(id),
        close: (id: string) => useLayoutStore.getState().closePanel(id),
        toggle: (id: string) => useLayoutStore.getState().togglePanel(id),
        isOpen: (id: string) => {
          const p = useLayoutStore.getState().panels[id];
          return !!p && useLayoutStore.getState().panelOrder[p.region].includes(id);
        },
      };
      const workspace = {
        setActive: (id: string) => useProjectStore.getState().actions.setActive(id),
        getActive: () => useProjectStore.getState().activeTabId ?? '',
      };

      Application.boot({
        getState: () => ({
          ui: useUIStore.getState(),
          layout: useLayoutStore.getState(),
          selection: useSelectionStore.getState(),
          workspace: useProjectStore.getState(),
          preferences: usePreferenceStore.getState(),
        }),
        selection,
        panels,
        workspace,
      });
      track(attachRenderBackendEvents());
      track(installProductAnalytics());

      // Core services are registered inside Application.boot; track the rest of
      // the boot sequence as a loading task so the UI can reflect it.
      const bootTask = getLoadingManager().begin('boot', 'Starting editor…');
      try {
        // Register built-in + project commands AFTER boot so the registry exists.
        const registry = getCommandRegistry();
        for (const cmd of buildStaticCommands()) registry.register(cmd);
        // Smart Animate has one command per TARGET composition, and comps are
        // created and renamed while the app runs — so that set is kept in step
        // rather than snapshotted here. Tracked like every other subscription
        // (see the note above about Providers mounting per route).
        track(installSmartAnimateCommandSync());
        registry.register({
          id: asCommandId(BuiltinCommands.Undo),
          label: 'Undo',
          shortcut: { key: 'z', meta: true },
          enabled: () => getCommandSystem().getHistory().canUndo(),
          execute: () => performUndo(),
        });
        registry.register({
          id: asCommandId(BuiltinCommands.Redo),
          label: 'Redo',
          shortcut: { key: 'z', meta: true, shift: true },
          enabled: () => getCommandSystem().getHistory().canRedo(),
          execute: () => performRedo(),
        });

        getShortcutManager().rehydrateFromRegistry();

        // Theme: ThemeManager is the single authority. Mirror the resolved theme
        // into the preference store so existing UI reading it stays correct.
        const theme = getThemeManager();
        track(theme.subscribe((t) => usePreferenceStore.getState().set('theme', asThemeId(t))));
        theme.apply();

        // Project: bridge to the scene document and refresh scene UI on load.
        const project = getProjectManager();
        // The FULL document (scene + animation + comps + timelines + render
        // settings). This was `sceneProjectIO` — scene-only — so every local
        // save silently dropped the entire animation.
        project.setDocumentIO(projectDocumentIO);
        track(getEventBus().on('ProjectLoaded', () => bumpScene()));
        track(getEventBus().on('ProjectUnloaded', () => bumpScene()));
        // The expression engine's providers (change sink, audio level, ctrl(),
        // layer(), thisComp / thisLayer, sourceRectAtTime, toComp…, marker):
        // engine-side wiring, see core/engine/expressionProviders.ts. Must run
        // before any engine emit (seeding below) reaches its listeners.
        installExpressionProviders();
        // Keyframe edits refresh the timeline tracks + inspector + viewport.
        //
        // Media decode/upload repaints are NOT edits and must not come through
        // here. They arrive on the same event at the source's frame rate, and
        // bumping the scene for each one ran a full scene-graph walk, content
        // re-hash and React reconcile per decoded video frame — while the
        // viewport's own render loop was already filtering these events out for
        // exactly that reason. The viewport still repaints for them; it just
        // does it without pretending the document changed.
        track(getEventBus().on('AnimationChanged', (payload) => {
          if (isMediaDecodeRepaint(payload)) return;
          bumpScene();
        }));

        // Native (Electron) menu items dispatch through the same CommandSystem.
        // `menu.action:` ids are the model's onSelect-only entries (workspace
        // presets); `useNativeMenuSync` answers those, not the registry.
        window.motionEditor?.onMenuCommand?.((id) => {
          if (isNativeMenuActionId(id)) return;
          void getCommandSystem().execute(asCommandId(id));
        });

        // Plugin host + UI commands (searchable in the Command Palette).
        try {
          // Registers the contributions of every plugin the user has enabled —
          // installs persist across reloads, so this is what makes them come
          // back — and starts only the ones that asked to start (`onStartup`).
          // The rest stay inactive, with their commands live, until used.
          // Package bytes live in IndexedDB now, so they have to be back in
          // memory before anything tries to spawn a worker from them.
          //
          // Skipped entirely in a build without plugins. Of the six gates this
          // is the one that matters: the others hide a surface, and this one is
          // what stops third-party code from running at all — `configure()`
          // brings up every enabled plugin and starts the ones that asked.
          if (pluginsEnabled()) {
            // Before hydrate, so nothing the reconcile or the user does next
            // is announced into a no-op sink. ACCOUNT sync only — a local build
            // has no account, so its sink stays the no-op and local-file
            // installs never try to announce themselves anywhere.
            const accountSync = pluginRegistryEnabled();
            if (accountSync) installInstalledSyncSink();
            await usePluginStore.getState().hydrate();
            /*
              Reconcile against the ACCOUNT's installed set.

              Deliberately NOT awaited, and deliberately after `hydrate()`. Not
              awaited because it is a network call and the editor must not wait
              on the registry to boot — an unreachable server would otherwise
              hold up the first frame. After hydrate because the local list is
              its input: running it against a list that had not loaded yet
              would report every plugin the user owns as "restorable".

              Safe to leave running in the background because it cannot delete
              anything locally — see `installedSync.ts`, where that is the
              load-bearing rule.
            */
            if (accountSync) {
              void reconcileInstalledSet(usePluginStore.getState().plugins)
                .then((report) => usePluginStore.getState().noteSync(report))
                .catch(() => undefined);
            }
            pluginHost.configure({
              getSelection: () => useSelectionStore.getState().ids,
              // What makes `motion.ui.openPanel()` real. The host cannot import
              // the dock itself (it must stay React-free and testable), so the
              // shell hands it the two calls it needs.
              showPanel: (id, panelId) => showPluginPanel(id, panelId),
              hidePanel: (id, panelId) => hidePluginPanel(id, panelId),
              // A contributed tool is selected through the same bridge the
              // toolbar uses, so the palette, the Plugins menu and the strip
              // all end up in one state rather than three.
              activateTool: (id, toolId) => activatePluginTool(id, toolId),
            });
            // Picking any built-in tool stands the plugin tool down — one tool
            // at a time, which is what a toolbar means.
            installPluginToolBridge();
          }
          const registry = getCommandRegistry();
          registry.register({
            id: asCommandId('file.export'), label: 'Export…', icon: 'arrow-up',
            // The COMPOSITION's duration and frame rate, like the Export button
            // in the title bar passes. These were hardcoded 10s/30fps, so the
            // menu route opened the dialog describing a composition the user
            // did not have.
            enabled: () => true,
            execute: () => {
              const settings = documentMirror().comp(activeCompIdNow() ?? '')?.settings;
              openExportDialog(settingsDurationSeconds(settings), settingsFps(settings));
            },
          });
          registry.register({
            id: asCommandId('file.openAfterEffects'), label: 'Open After Effects Project…', icon: 'upload',
            // Always available: it starts its own document, so there is no
            // state in which opening one would not make sense.
            enabled: () => true,
            execute: () => { void pickAndOpenAfterEffectsProject(); },
          });
          registry.register({
            id: asCommandId('file.import3DModel'), label: 'Import 3D Model…', icon: 'cube',
            // Always available: it creates layers in the active composition,
            // and there is always an active composition.
            enabled: () => true,
            execute: () => { void pickAndImport3DModel(); },
          });
          registry.register({
            id: asCommandId('comp.saveFrame'), label: 'Save Frame As PNG', icon: 'image',
            // AE: Composition > Save Frame As. Renders the current playhead frame
            // at comp resolution through the deterministic offline path.
            enabled: () => true,
            execute: async () => {
              const c = useCompositionStore.getState().comp();
              const frame = Math.round(getTimelineController().timeline.currentFrame);
              const blob = await renderStillFrame(
                { width: c.width, height: c.height, fps: c.fps, durationSec: c.durationSeconds, comp: { ...c, rootId: c.id, compSizeOf } },
                frame,
              );
              if (!blob) { notify('Could not render the frame', 'warning'); return; }
              const url = URL.createObjectURL(blob);
              const a = document.createElement('a');
              a.href = url;
              a.download = `${(c.name ?? 'comp').replace(/\s+/g, '_')}_frame${frame}.png`;
              a.click();
              URL.revokeObjectURL(url);
              notify(`Saved frame ${frame}`, 'success');
            },
          });
          registry.register({
            id: asCommandId('comp.copyFrame'), label: 'Copy Frame to Clipboard', icon: 'copy',
            // AE 26.3: the rendered frame straight to the clipboard, so a review
            // screenshot is one shortcut instead of save → find → attach. Same
            // deterministic path as Save Frame As; only the destination differs.
            enabled: () => typeof navigator !== 'undefined' && !!navigator.clipboard?.write,
            execute: async () => {
              const c = useCompositionStore.getState().comp();
              const frame = Math.round(getTimelineController().timeline.currentFrame);
              const blob = await renderStillFrame(
                { width: c.width, height: c.height, fps: c.fps, durationSec: c.durationSeconds, comp: { ...c, rootId: c.id, compSizeOf } },
                frame,
              );
              if (!blob) { notify('Could not render the frame', 'warning'); return; }
              try {
                await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
                notify(`Copied frame ${frame} to the clipboard`, 'success');
              } catch (err) {
                // Clipboard writes need a user gesture and a secure context;
                // say which rather than failing silently.
                notify(`Clipboard refused the frame: ${err instanceof Error ? err.message : String(err)}`, 'warning');
              }
            },
          });
          registry.register({
            id: asCommandId('view.presentation'), label: 'Present (Preview)', icon: 'tv',
            enabled: () => true, execute: () => usePresentationStore.getState().enter(),
          });
          // ONE command, because there is now one surface. `view.plugins` used
          // to open a manager modal beside this, and two managers over one
          // plugin drift: the modal reported what the user had GRANTED, the
          // detail tab reported what the manifest ASKED FOR, and whichever
          // screen the user happened to open decided what they believed. The
          // modal is retired — its log, permission editor and folder reload
          // live on the plugin's own page, beside everything else about it.
          /*
            One "New layer" command per registered plugin kind.

            This closes the gap that made layer kinds unusable in practice:
            nothing could create the FIRST layer of a custom kind. The plugin
            has to create it, and the plugin is not running — its
            `onLayerKind` event fires when a document CONTAINING the kind is
            opened, which is a chicken-and-egg the author cannot break from
            their side.

            Registered off `allLayerKinds()`, which lists kinds from ENABLED
            plugins whether or not their worker is up — so choosing one wakes
            the plugin lazily, exactly as opening a document does. A disabled
            plugin's kinds are absent from that list and therefore from this
            menu, consistent with `activateForDocument` refusing to wake
            software the user turned off.
          */
          for (const entry of pluginsEnabled() ? allLayerKinds() : []) {
            const kind = `${entry.pluginId}.${entry.kind.id}`;
            registry.register({
              id: asCommandId(`layer.new.${kind}`),
              label: `New ${entry.kind.label}`,
              icon: (entry.kind.icon as never) ?? 'plugin',
              enabled: () => true,
              // The plugin kind's schema builder runs off-document → ONE pasteLayers entry into the
              // active comp; the plugin wakes after, outside the entry (createCustomLayerFromMenu.ts).
              execute: async () => {
                const label = customLayerLabel(kind);
                if (!label) return;
                const ids = await insertBuiltLayers(label, (activeCompIdNow() ?? 'comp_root'), () => buildCustomLayerInto(kind, (activeCompIdNow() ?? 'comp_root')));
                if (ids && ids.length > 0) wakeCustomLayerKind(kind);
              },
            });
          }

          // Opens the marketplace panel, which a build without plugins does not
          // register — a palette entry that opens nothing is worse than no
          // entry, because the user concludes the app is broken rather than
          // that the feature is absent.
          if (pluginsEnabled()) {
            registry.register({
              id: asCommandId('view.marketplace'), label: 'Plugins', icon: 'plugin',
              enabled: () => true,
              execute: () => useLayoutStore.getState().openPanel('marketplace'),
            });
          }
          // Pre-existing gap, found by `onDemandPanelsReachable.test.ts`: the
          // History panel is registered, has a renderer, and had nothing that
          // opened it — so undo history was a panel no user could reach.
          registry.register({
            id: asCommandId('view.history'), label: 'History', icon: 'history',
            enabled: () => true,
            execute: () => useLayoutStore.getState().openPanel('history'),
          });
          // AE's Ctrl+4. The panel is permanent rather than on-demand, so this
          // is a "bring it to the front" rather than a "create it" — which is
          // also what AE's chord does to an already-docked Audio panel.
          registry.register({
            id: asCommandId('view.audio'), label: 'Audio', icon: 'audio',
            shortcut: { key: '4', ctrl: true },
            enabled: () => true,
            execute: () => useLayoutStore.getState().openPanel('audio'),
          });
          // Window ▸ Panels — one opener per panel that went on demand when
          // the rails were cut to the everyday set (2026-09-15; see the
          // header of `panelDefs.ts`). Written out as literal ids, not built
          // from PANEL_DEFS: `onDemandPanelsReachable.test.ts` greps for the
          // id, and the menu model names each command statically.
          for (const p of [
            { id: 'view.scene', panel: 'scene', label: 'Layers', icon: 'layers' },
            { id: 'view.character', panel: 'character', label: 'Text', icon: 'type' },
            { id: 'view.align', panel: 'align', label: 'Align', icon: 'align-center' },
            { id: 'view.swatches', panel: 'swatches', label: 'Swatches', icon: 'palette' },
            { id: 'view.info', panel: 'info', label: 'Info', icon: 'info' },
            { id: 'view.scopes', panel: 'scopes', label: 'Scopes', icon: 'waves' },
            { id: 'view.preview', panel: 'preview', label: 'Preview', icon: 'play' },
            { id: 'view.sourceMonitor', panel: 'sourceMonitor', label: 'Source Monitor', icon: 'tv' },
            { id: 'view.tracker', panel: 'tracker', label: 'Tracker', icon: 'crosshair' },
            { id: 'view.rig', panel: 'rig', label: 'Rigging', icon: 'bone' },
            { id: 'view.effects', panel: 'effects', label: 'Effects', icon: 'magic-wand' },
            { id: 'view.motion', panel: 'motion', label: 'Graph Panel', icon: 'graph-value' },
            { id: 'view.presets', panel: 'presets', label: 'Presets', icon: 'zap' },
          ] as const) {
            registry.register({
              id: asCommandId(p.id), label: p.label, icon: p.icon,
              enabled: () => true,
              execute: () => useLayoutStore.getState().openPanel(p.panel),
            });
          }
          registry.register({
            id: asCommandId('help.tour'), label: 'Take a Tour', icon: 'tour',
            enabled: () => true, execute: () => useOnboardingStore.getState().start(),
          });
          registry.register({
            id: asCommandId('view.safeAreas'), label: 'Toggle Safe Areas', icon: 'frame',
            enabled: () => true,
            // `isChecked` is what puts the tick beside a toggle in the menus.
            // It was declared on the Command interface and implemented by
            // nothing, so every one of these read as a plain action and the
            // menu could not tell you whether the thing was already on.
            isChecked: () => useGuidesStore.getState().safeArea,
            execute: () => useGuidesStore.getState().toggleSafeArea(),
          });
          registry.register({
            id: asCommandId('view.grid'), label: 'Show Grid', icon: 'grid',
            shortcut: { key: "'", meta: true },
            enabled: () => true,
            isChecked: () => useGuidesStore.getState().grid,
            execute: () => useGuidesStore.getState().toggleGrid(),
          });
          // AE keeps these three as separate View commands with AE's own chords.
          // Snap to Grid in particular is NOT tied to Show Grid — see the
          // guidesStore note.
          registry.register({
            id: asCommandId('view.proportionalGrid'), label: 'Show Proportional Grid', icon: 'grid',
            shortcut: { key: "'", alt: true },
            enabled: () => true,
            isChecked: () => useGuidesStore.getState().proportionalGrid,
            execute: () => useGuidesStore.getState().toggleProportionalGrid(),
          });
          registry.register({
            id: asCommandId('view.snapToGrid'), label: 'Snap to Grid', icon: 'grid',
            // AE's chord is Cmd/Ctrl+Shift+'. Registered as `"` because chords
            // are matched on `KeyboardEvent.key`, which is the SHIFTED character
            // — holding shift over the apostrophe key reports `"`, so keying it
            // as `'` would never fire. Layout-dependent, like every punctuation
            // chord in this system.
            shortcut: { key: '"', meta: true, shift: true },
            enabled: () => true,
            isChecked: () => useGuidesStore.getState().snapToGrid,
            execute: () => useGuidesStore.getState().toggleSnapToGrid(),
          });
          registry.register({
            id: asCommandId('view.rulers'), label: 'Toggle Rulers', icon: 'ruler',
            enabled: () => true,
            isChecked: () => useGuidesStore.getState().rulers,
            execute: () => useGuidesStore.getState().toggleRulers(),
          });
          registry.register({
            /*
              Use Proxies, comp-wide.

              The preference was always global — one `usePreferenceStore` flag
              that both viewport hosts read — but the only switch for it sat in
              the Inspector's Media section, which appears only while a footage
              LAYER is selected. So a project-wide preview setting could be
              changed only by first selecting a video, and there was no way at
              all to see whether it was on.

              Deliberately still that preference and not a new store: the export
              invariant is enforced by POLARITY (see `@core/assets/proxy`) —
              only the interactive viewport passes `useProxies` into a snapshot
              build, and every output path is statically forbidden from even
              naming it. A second home for the flag would be a second thing that
              could grow an output-path reader.
            */
            id: asCommandId('view.useProxies'), label: 'Use Proxies', icon: 'media',
            enabled: () => true,
            isChecked: () => usePreferenceStore.getState().useProxies,
            execute: () => {
              const next = !usePreferenceStore.getState().useProxies;
              usePreferenceStore.getState().set('useProxies', next);
              notify(
                next
                  ? 'Using proxies where they exist — exports always use the originals'
                  : 'Previewing the original media',
                'info',
              );
            },
          });
          registry.register({
            // WorkspaceController.fitSelection existed with ZERO consumers —
            // the port comment even said "retained for fit-to-selection".
            // Shift+F, since bare letters are tool shortcuts in the viewport
            // and AE itself never shipped this (its users lobby for it).
            id: asCommandId('view.fitSelection'), label: 'Fit Selection in View', icon: 'frame',
            shortcut: { key: 'f', shift: true },
            enabled: () => useSelectionStore.getState().ids.length > 0,
            execute: () => {
              getWorkspaceController().fitSelection();
              getWorkspaceController().requestRender();
            },
          });
          registry.register({
            // The ViewportTools tooltip has advertised this chord all along —
            // it just was never bound. Motion paths draw for selected layers
            // with position keyframes; this hides/shows them globally.
            id: asCommandId('view.motionPath'), label: 'Toggle Motion Paths', icon: 'path',
            shortcut: { key: 'm', meta: true, alt: true },
            enabled: () => true,
            isChecked: () => useGuidesStore.getState().motionPathVisible,
            execute: () => useGuidesStore.getState().toggleMotionPath(),
          });
          registry.register({
            id: asCommandId('view.renderQueue'), label: 'Render Queue', icon: 'queue',
            shortcut: { key: 'F6' },
            enabled: () => true,
            execute: () => {
              const ls = useLayoutStore.getState();
              const panel = ls.panels['renderQueue'];
              if (!panel) {
                ls.openPanel('renderQueue');
              } else {
                ls.togglePanel('renderQueue');
              }
            },
          });
          registry.register({
            // The left-sidebar Effect Controls panel — applied effects for the
            // selected layer. Used to target 'effects' (the right-sidebar
            // library) because 'effectControls' was never registered; F3 and
            // the Window menu therefore opened the browser you add FROM, not
            // the stack you edit. Both ids exist now, and this one is the
            // AE shortcut's actual job.
            id: asCommandId('view.effectControls'), label: 'Effect Controls', icon: 'stopwatch',
            shortcut: { key: 'F3' },
            enabled: () => true,
            execute: () => useLayoutStore.getState().openPanel('effectControls'),
          });
          registry.register({
            // Toggles the graph editor itself. This used to collapse the whole
            // bottom timeline region — the one thing the graph editor lives in.
            id: asCommandId('view.graphEditor'), label: 'Graph Editor', icon: 'track',
            shortcut: { key: 'g', shift: true },
            enabled: () => true,
            execute: () => {
              const ui = useUIStore.getState();
              ui.setGraphEditorOpen(!ui.graphEditorOpen);
            },
          });
          registry.register({
            id: asCommandId('view.customize'), label: 'Customize…', icon: 'settings',
            enabled: () => true, execute: () => openCustomizeDialog(),
          });
          // File → Version History. The menu item has always existed; this
          // command did not, so clicking it did nothing — meanwhile every
          // autosave has been quietly snapshotting the project, with no way
          // to see or restore any of it. Only meaningful for a cloud project:
          // snapshots live on the backend, keyed by project id.
          // In the local edition this command stays unregistered: snapshots live
          // in the project bundle instead, surfaced by VersionHistorySection —
          // registered in `inspectorSections.ts` behind `versionHistoryAvailable()`
          // (local edition + an open .motion bundle). Registering this would put a
          // permanently-disabled menu
          // item next to a feature that does work.
          if (cloudProjectsEnabled()) {
            registry.register({
              id: asCommandId('file.versionHistory'), label: 'Version History…', icon: 'undo',
              enabled: () => useCloudProjectStore.getState().projectId !== null,
              execute: () => openVersionHistory(),
            });
          }
          // AE reveal shortcuts. U reveals animated properties on the selected
          // layers; a second U within the double-tap window upgrades to
          // 'revealModified' (dispatched by ShortcutManager, which is why that
          // one carries no chord of its own). Both are consumed by the
          // RevealAnimatedProps listener in App.tsx.
          registry.register({
            id: asCommandId('timeline.revealAnimated'),
            label: 'Reveal Animated Properties',
            icon: 'keyframe',
            shortcut: { key: 'u' },
            enabled: () => true,
            execute: () => {
              getEventBus().emit('RevealAnimatedProps', {
                nodeIds: [...useSelectionStore.getState().ids],
                mode: 'animated',
              });
            },
          });
          registry.register({
            id: asCommandId('timeline.revealModified'),
            label: 'Reveal Modified Properties',
            icon: 'keyframe',
            enabled: () => true,
            execute: () => {
              // Empty nodeIds = every layer, per the listener's contract.
              getEventBus().emit('RevealAnimatedProps', { nodeIds: [], mode: 'modified' });
            },
          });
          getShortcutManager().rehydrateFromRegistry();
        } catch { /* ignore */ }

        // First-run onboarding tour (once, persisted in settings).
        try {
          if (!getSettingsManager().get<boolean>('onboarding.seen', false)) {
            useOnboardingStore.getState().start();
          }
        } catch { /* ignore */ }

        // Default property editors + starter scene content.
        try { registerDefaultEditors(); } catch { /* ignore */ }
        // A pop-out window must NOT seed its own scene. It renders a detached
        // view of the composition you already have open, and windowSync fills it
        // in from the editor shell. Seeding here is what made a popped-out Scene
        // panel list a completely different (demo) composition.
        // Owner mode seeds nothing: the first document is the engine's own
        // newProject, which the page's replica receives too (engineOwnedSession).
        if (!isPopoutWindow() && !ownsDocument) {
          try { seedDefaultScene(); } catch { /* ignore */ }
        }
        try { void useAssetStore.getState().initialize(); } catch { /* ignore */ }

        // History: initial "Open" state, then a debounced snapshot after edits.
        try {
          // The history baseline at boot (a load boundary; history infrastructure, not an edit).
          void baselineHistoryEdit('Open');
          // The debounce lives in the store so undo/redo can flush it — a
          // pending snapshot that only exists in a local closure is why Ctrl+Z
          // inside the window used to eat two actions.
          // The KEY tells history what is being edited, so a burst on one
          // target coalesces into a single undo step while a move to a
          // different layer/property commits the previous one first. A bare
          // `schedule` merged anything that happened to land inside the same
          // 700 ms — two unrelated edits, one Ctrl+Z, both gone.
          //
          // ONE attach point, deliberately. These were four separate `track`
          // lines here and three of them worked; the baseline sync had been
          // subscribed at MODULE SCOPE, so it landed on the bus this boot
          // discards and never fired once — every commanded edit then also
          // recorded a generic snapshot and Ctrl+Z took two presses, app-wide.
          // Keeping the set together in `historyStore` makes the half-wired
          // state unrepresentable, and lets the guard suite drive the same unit
          // boot does rather than a re-typed copy of it.
          track(attachHistoryRecording());
        } catch { /* ignore */ }
        // The engine API (NATIVE_CORE_PLAN §5 B3): ONE LocalEngine over the
        // live document, with the real file/media ports. After the history
        // wiring (its entries go on the same unified stack) and the default
        // scene seed; rebuilt on every ProjectLoaded/ProjectUnloaded.
        try {
          bootEngine({
            ports: createAppEnginePorts(getProjectManager()),
            projectPath: () => getProjectManager().getState().current?.path,
            // B5: the command log automation records/replays (dev builds and
            // VITE_RECORD_COMMAND_LOG=1; see core/automation/commandLog).
            recordLog: commandLogRecordingEnabled(),
            ownsDocument,
          });
          track(() => { void shutdownEngine(); });
          // B5 automation (record/replay a session, run a script) on window.
          // Not tracked: it holds no resources and always targets the CURRENT
          // engine, so a boot re-run (StrictMode) must not leave it uninstalled.
          installAutomationDevApi();
        } catch (err) {
          console.error('[boot] engine API failed to start', err);
        }
        track(getEventBus().on('SceneGraphChanged', () => {
          const nodeIds = new Set<string>();
          defaultSceneGraph.traverse((node) => nodeIds.add(node.id));
          const layerSelection = useSelectionStore.getState().ids;
          const survivingLayers = layerSelection.filter((id) => nodeIds.has(id));
          if (survivingLayers.length !== layerSelection.length) {
            useSelectionStore.getState().set(survivingLayers);
          }
          prunePropertySelectionToNodes(nodeIds);
          pruneKeyframeSelectionToNodes(nodeIds);
        }));

        // Dirty tracking + autosave (crash recovery). Edits mark the active
        // document dirty (amber dot); autosave persists a recovery snapshot
        // every 60s while dirty, never clearing the unsaved indicator.
        // Owner mode (D5 / F2): the engine's session does all three, from the
        // mirror (engineOwnedSession.tsx) — the TypeScript bus is the replica's.
        if (engineOwnsDocumentNow()) {
          try {
            await installEngineOwnedSession(track);
          } catch (err) {
            console.error('[boot] the engine-owned session failed to start', err);
          }
        } else try {
          const markDirty = (): void => {
            const s = useProjectStore.getState();
            if (s.activeTabId && !s.tabs[s.activeTabId]?.dirty) s.actions.markDirty(s.activeTabId, true);
          };
          // A landed video decode is not an unsaved edit — before this the
          // amber dot appeared just from playing footage back.
          track(getEventBus().on('AnimationChanged', (p) => { if (!isMediaDecodeRepaint(p)) markDirty(); }));
          track(getEventBus().on('NodeUpdated', markDirty));
          track(getEventBus().on('SceneGraphChanged', markDirty));
          getAutosaveController().start({
            intervalMs: 60_000,
            now: () => Date.now(),
            getTime: () => {
              const s = useProjectStore.getState();
              return (s.activeTabId ? s.tabs[s.activeTabId]?.time : 0) ?? 0;
            },
            isDirty: () => {
              const s = useProjectStore.getState();
              return !!(s.activeTabId && s.tabs[s.activeTabId]?.dirty);
            },
          });
        } catch { /* ignore */ }

        // Crash recovery: offer to restore the previous unsaved session.
        // (Owner mode: the engine's recovery record, offered above.)
        if (!engineOwnsDocumentNow()) try {
          const rec = readRecovery();
          if (rec) {
            const mins = Math.max(1, Math.round((Date.now() - rec.savedAt) / 60_000));
            openModal({
              // Fixed id so StrictMode's double-invoke can't stack duplicates.
              id: 'recovery-modal',
              title: 'Recover unsaved work?',
              size: 'sm',
              render: () => (
                <div style={{ color: 'var(--color-text-secondary)', fontSize: 'var(--font-size-md)', lineHeight: 1.6 }}>
                  Premation found unsaved changes from your last session
                  (about {mins} min ago). Restore them, or discard and start fresh.
                </div>
              ),
              footer: (close) => (
                <div style={{ display: 'flex', gap: 'var(--space-3)', justifyContent: 'flex-end' }}>
                  <Button variant="ghost" size="sm" onClick={() => { clearRecovery(); close(); }}>Discard</Button>
                  <Button
                    variant="primary"
                    size="sm"
                    onClick={() => {
                      const t = restoreRecovery(rec);
                      // Was `Math.round(t * 60)` — a hardcoded 60 fps that put
                      // the frame number on a different clock from the comp for
                      // every project not shot at 60.
                      seekPlayhead(t);
                      bumpScene();
                      // The history baseline after crash recovery (a load boundary).
                      void baselineHistoryEdit('Recovered');
                      const s = useProjectStore.getState();
                      if (s.activeTabId) s.actions.markDirty(s.activeTabId, true);
                      // The scene is back; get the project browser out of its way.
                      dismissStartScreen();
                      notify('Session recovered', 'success');
                      close();
                    }}
                  >
                    Restore
                  </Button>
                </div>
              ),
            });
          }
        } catch { /* ignore */ }
      } finally {
        bootTask.end();
      }

      // Live cross-window sync: a detached panel mirrors this window's document,
      // selection and playhead, and its own edits come back the other way.
      //
      // MUST be started here, INSIDE the boot IIFE, not beside it: `Application
      //.boot` calls `setEventBus(new EventBus)`, so anything that subscribes
      // before boot resolves is attached to a bus that is then thrown away. That
      // is why the scene-change subscription silently never fired while the
      // selection one (a plain zustand store, never replaced) worked fine.
      if (!cancelled) stopSync = startWindowSync();

      if (!cancelled) setReady(true);
    })();

    return () => {
      cancelled = true;
      stopSync?.();
      stopSync = null;
      for (const dispose of subs) dispose();
      subs.length = 0;
    };
  }, []);

  if (!ready) {
    return <LoadingScreen message="Loading editor…" />;
  }

  // TooltipProvider is mounted at the app root (main.tsx) so it also covers the
  // global TitleBar on the pre-boot routes — don't re-wrap here.
  return (
    <>
      {children}
      <AudioPlaybackBridge />
      <CommandPalette />
      <PresentationMode />
      <OnboardingOverlay onDone={() => getSettingsManager().set('onboarding.seen', true)} />
    </>
  );
}
