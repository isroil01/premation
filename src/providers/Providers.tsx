/**
 * UI Provider — application-level wrapper that:
 *   1. Applies persisted preferences to the document.
 *   2. Boots the Application core (services DI, EventBus, CommandSystem, ShortcutManager).
 *   3. Registers built-in + project commands and default panels.
 *   4. Wires the ThemeManager and ProjectManager into the UI.
 *   5. Mounts the global overlay hosts (modals, context menus, notifications).
 */

import { useEffect, useState, type ReactNode } from 'react';
import { Application } from '@core/application/Application';
import { getWorkspaceController } from '@core/workspace/WorkspaceController';
import {
  applyPreferencesToDocument,
  usePreferenceStore,
} from '@stores/preferenceStore';
import { allLayerKinds } from '@core/plugins/layerKindRegistry';
import { createCustomLayerFromMenu } from '@core/plugins/createCustomLayerFromMenu';
import { useLayoutStore } from '@stores/layoutStore';
import { useSelectionStore } from '@stores/selectionStore';
import { isPickArmed } from '@stores/trackerStore';
import { pruneKeyframeSelectionToNodes, useKeyframeSelectionStore } from '@stores/keyframeSelectionStore';
import { prunePropertySelectionToNodes } from '@stores/propertySelectionStore';
import { useCompositionStore } from '@stores/compositionStore';
import { cutSelection, copySelection, pasteSelection } from '@core/commands/clipboard';
import { getTimelineController } from '@core/timeline/TimelineController';
import { useProjectStore } from '@stores/projectStore';
import { useUIStore } from '@stores/uiStore';
import { bumpScene } from '@stores/sceneStore';
import { isMediaDecodeRepaint } from '@core/rendering/mediaRepaint';
import { openProjectPath } from '@core/project/openProjectPath';
import { openLocalMotionFile, saveToComputer } from '@core/project/localProjectIO';
import { offerRelink } from '@layout/Project/RelinkAssetsDialog';
import { clearLastFootagePreview } from '@layout/Assets/FootagePreviewDialog';
import { openModal } from '@stores/modalStore';
import { customConfirm, customPrompt } from '@components/Modal';
import { attachHistoryRecording, useHistoryStore, performUndo, performRedo } from '@stores/historyStore';
import { attachRenderBackendEvents } from '@stores/renderBackendStore';
import { Button } from '@components/Button';
import { Logo } from '@components/Logo';
import { getAutosaveController } from '@core/persistence/AutosaveController';
import { readRecovery, clearRecovery, restoreRecovery } from '@core/persistence/recovery';
import pluginHost from '@core/plugins/PluginHost';
import { usePluginStore } from '@stores/pluginStore';
import { reconcileInstalledSet, installInstalledSyncSink } from '@core/plugins/installedSync';
import { showPluginPanel, hidePluginPanel } from '@layout/Plugins/PluginPanel';
import { openExportDialog } from '@layout/Export/ExportDialog';
import { usePresentationStore } from '@stores/presentationStore';
import { useGuidesStore } from '@stores/guidesStore';
import { getCommandRegistry, BuiltinCommands, type Command } from '@core/commands/Command';
import { getCommandSystem } from '@core/commands/CommandSystem';
import { getShortcutManager } from '@core/commands/ShortcutManager';
import { getEventBus } from '@core/events/EventBus';
import { getThemeManager, getProjectManager, getLoadingManager, getSettingsManager, getFileManager } from '@core/services/coreServices';
import { LoadingScreen } from '@components/LoadingScreen';
import { isLocalFirst } from '@core/config/flags';
import { cloudProjectsEnabled, pluginsEnabled } from '@core/config/edition';
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
import {
  buildSmartAnimateCommands,
  installSmartAnimateCommandSync,
} from '@core/animation/smartAnimateCommands';
import { buildReframeCommands } from '@core/reframe/reframeCommands';
import { type EasingPreset } from '@core/animation/keyframeAssistants';
import { applyEasingToSelection, easingTargetKeyframes } from '@core/animation/easingSelection';
import { useAssetStore } from '@stores/assetStore';
import { openCustomizeDialog } from '@layout/Settings/CustomizeDialog';
import { openVersionHistory } from '@layout/History/VersionHistoryPanel';
import { useCloudProjectStore } from '@stores/cloudProjectStore';
import { registerDefaultEditors } from '@components/Inspector/DefaultEditors';
import { seedDefaultScene } from '@core/scene/seedDefaultScene';
import { loadBlockTower } from '@core/scene/seedBlockTower';
import { isPopoutWindow, startWindowSync } from '@core/layout/windowSync';
import { resolveLayerRef, defaultAnimation } from '@motion/animation';
import defaultSceneGraph from '@core/scene/DefaultSceneGraph';
import { RIG_PRESETS, RIG_PRESET_LABELS, type RigPresetId } from '@core/rig/rigPresets';
import { applyRigPreset } from '@core/rig/skeletonCommands';
import { readGeometry } from '@core/workspace/geometry';
import { isAudioNode } from '@core/audio/audioScene';
import { convertAudioToSliderNull } from '@core/audio/audioKeyframes';
import { applyExponentialScale, eligibleScaleTracks, REFUSAL_TEXT } from '@core/animation/exponentialScale';
import {
  convertExpressionToKeyframes,
  eligibleExpressionProps,
  BAKE_REFUSAL_TEXT,
} from '@core/animation/convertExpressionToKeyframes';
import {
  timeReverseKeyframes,
  easyEaseAll,
  sequenceLayers,
  applySmoother,
  applyWiggler,
} from '@core/animation/keyframeAssistants';
import { armMotionSketch, finishMotionSketch, cancelMotionSketch } from '@core/animation/motionSketch';
import { isGuideLayer, setGuideLayer } from '@core/scene/guideLayer';
import { measureTextNodeBoxes } from '@core/text/measureText';
import { flattenComposition, readNodeKind } from '@core/scene/sceneDerive';
import { layerSpaceAt } from '@core/scene/layerSpace';
import { audioEngine } from '@core/audio/AudioEngine';
import { AudioPlaybackBridge } from '@core/audio/useAudioPlayback';
import { controlValue } from '@core/animation/expressionControls';
import { ProjectCommands } from '@layout/Menu';
import { CommandPalette } from '@layout/CommandPalette';
import { PresentationMode } from '@layout/Presentation/PresentationMode';
import { openPalette } from '@stores/commandPaletteStore';
import { insertCamera, insertLight, insertAdjustmentLayer, precomposeSelected, insertPrimitive, insertSolid, deleteSelectedLayers, duplicateSelectedLayers } from '@core/scene/sceneInsert';
import { findNavTarget } from '@core/workspace/cameraNav';
import { insertNull, moveNodeInStack } from '@core/scene/parenting';
import { createNullsFromPath, pathVertices } from '@core/scene/nullsFromPaths';
import { createShapesFromText, canCreateShapesFromText } from '@core/scene/shapesFromText';
import { autoTraceLayer } from '@core/effects/autoTrace';
import { fitNodeTo, centreAnchorInContent, centreInFrame } from '@core/source/fitCommands';
import { activeCompSize } from '@core/scene/activeComp';
import { rigLogoForAnimation } from '@core/scene/rigLogo';
import { addEffect } from '@core/effects/effects';
import { openCompositionSettings } from '@layout/Composition/CompositionSettingsDialog';
import { openNewCompositionDialog } from '@layout/Composition/NewCompositionDialog';
import { deleteComposition } from '@core/composition/compositionOps';

interface ProvidersProps {
  children: ReactNode;
}

function notify(message: string, level: 'info' | 'success' | 'warning' | 'error' = 'info'): void {
  useUIStore.getState().notify({ level, message, durationMs: 2600 });
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
    { tool: 'brush', label: 'Brush Tool' },
    { tool: 'text', label: 'Text Tool', chord: { key: 't', meta: true } },
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
  };
  return tools.map(({ tool, label, chord }) => ({
    id: asCommandId(`tool.${tool}`),
    label,
    icon: TOOL_ICONS[tool] ?? ('crosshair' as const),
    ...(chord ? { shortcut: chord } : {}),
    enabled: () => true,
    execute: () => useUIStore.getState().setActiveTool(tool),
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
      label: 'Camera Tool (Orbit / Pan / Dolly)',
      icon: 'camera',
      shortcut: { key: 'c' },
      enabled: () => findNavTarget() !== null,
      execute: () => {
        useGuidesStore.getState().cycleCameraTool();
        const mode = useGuidesStore.getState().cameraTool;
        notify(`Camera tool: ${mode === 'pan' ? 'Pan (Track XY)' : mode === 'dolly' ? 'Dolly' : 'Orbit'} — Esc to exit`, 'info');
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
    enabled: () => getTimelineController().compMarkerCount() >= n,
    execute: () => {
      if (!getTimelineController().goToMarkerIndex(n)) {
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
import { mergeSelectedPaths, type MergeOp } from '@core/scene/mergePaths';
import { compSizeOf } from '@core/composition/compSizes';

function buildMergePathCommands(): ReadonlyArray<Command> {
  const ops: Array<{ id: string; label: string; op: MergeOp }> = [
    { id: 'shape.mergeUnion', label: 'Merge Paths: Union', op: 'union' },
    { id: 'shape.mergeSubtract', label: 'Merge Paths: Subtract', op: 'subtract' },
    { id: 'shape.mergeIntersect', label: 'Merge Paths: Intersect', op: 'intersect' },
    { id: 'shape.mergeExclude', label: 'Merge Paths: Exclude (XOR)', op: 'exclude' },
  ];
  return ops.map(({ id, label, op }) => ({
    id: asCommandId(id),
    label,
    icon: 'layers' as const,
    enabled: () => useSelectionStore.getState().ids.length >= 2,
    execute: () => {
      const ids = mergeSelectedPaths(op);
      if (ids.length > 0) notify(`Merged paths (${op})`, 'success');
      else notify('Select at least two shape layers to merge', 'warning');
    },
  }));
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
    execute: () => {
      if (applyEasingToSelection(preset)) notify(`${label} applied`, 'success');
    },
  }));
}

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
      shortcut: { key: '`' },
      enabled: () => true,
      execute: () => {
        document.querySelector<HTMLElement>('[data-workspace-viewport]')?.focus();
      },
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
        const next = !isGuideLayer(ids[0]!);
        for (const id of ids) setGuideLayer(id, next);
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
        const ctrl = getTimelineController();
        if (!ctrl.isPlaying) ctrl.play();
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
          if (ctrl.isPlaying) ctrl.pause();
          notify(
            n > 0 ? `Motion Sketch — ${n} keyframes recorded` : 'Motion Sketch — nothing recorded',
            n > 0 ? 'success' : 'warning',
          );
        };
        const onKey = (ev: KeyboardEvent): void => {
          if (ev.key !== 'Escape') return;
          cleanup();
          cancelMotionSketch();
          if (ctrl.isPlaying) ctrl.pause();
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
        const { written, refusal } = applyExponentialScale(nodeId);
        if (refusal) { notify(REFUSAL_TEXT[refusal], 'warning'); return; }
        const total = [...written.values()].reduce((a, b) => a + b, 0);
        notify(`Exponential scale — ${total} keyframes across ${written.size} tracks`, 'success');
      },
    },
    {
      /** AE Animation ▸ Keyframe Assistant ▸ Time-Reverse Keyframes (Ctrl/Cmd+Alt+R). */
      id: asCommandId('animation.timeReverseKeyframes'),
      label: 'Time-Reverse Keyframes',
      icon: 'skip-back',
      shortcut: { key: 'r', meta: true, alt: true },
      enabled: () => {
        const id = useSelectionStore.getState().ids[0];
        return !!id && defaultAnimation.animatedProps(id).length > 0;
      },
      execute: () => {
        const id = useSelectionStore.getState().ids[0];
        if (!id) return;
        if (timeReverseKeyframes(id)) notify('Keyframes reversed', 'success');
        else notify('Layer has no keyframes yet', 'warning');
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
        if (easyEaseAll(id)) notify('Eased all keyframes', 'success');
        else notify('Layer has no keyframes yet', 'warning');
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
      enabled: () => {
        const id = useSelectionStore.getState().ids[0];
        return !!id && defaultAnimation.animatedProps(id).some(
          (p) => (defaultAnimation.getTrackKeyframes(id, p)?.length ?? 0) >= 3,
        );
      },
      execute: async () => {
        const id = useSelectionStore.getState().ids[0];
        if (!id) return;
        const raw = await customPrompt(
          'The Smoother',
          'Replace dense keyframes with the fewest that keep each curve within this tolerance (in the property’s own units — px for position), then smooth the survivors’ tangents.',
          '5',
          { placeholder: 'e.g. 5', confirmLabel: 'Smooth' },
        );
        if (raw === null) return;
        const tolerance = Number(raw);
        if (!Number.isFinite(tolerance) || tolerance <= 0) {
          notify('Tolerance must be a number above 0', 'warning');
          return;
        }
        const r = applySmoother(id, tolerance);
        if (!r) { notify('Needs a track with 3+ keyframes', 'warning'); return; }
        notify(`Smoothed ${r.tracks} track${r.tracks === 1 ? '' : 's'}: ${r.before} → ${r.after} keyframes`, 'success');
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
        return !!id && (['x', 'y'] as const).some(
          (p) => (defaultAnimation.getTrackKeyframes(id, p)?.length ?? 0) >= 2,
        );
      },
      execute: async () => {
        const id = useSelectionStore.getState().ids[0];
        if (!id) return;
        const raw = await customPrompt(
          'The Wiggler',
          'Bake a deterministic wobble into the animated position: wobbles per second, then peak deviation in px — e.g. "5, 25". Authored keyframes keep their times and values.',
          '5, 25',
          { placeholder: 'frequency, amplitude', confirmLabel: 'Wiggle' },
        );
        if (raw === null) return;
        const [f, a] = raw.split(/[,\s]+/).filter(Boolean).map(Number);
        if (!Number.isFinite(f) || !Number.isFinite(a) || f! <= 0 || a === 0) {
          notify('Enter frequency (per second, above 0) and amplitude (px, not 0)', 'warning');
          return;
        }
        const r = applyWiggler(id, { frequency: f!, amplitude: a! });
        if (!r) { notify('Animate position first (2+ keyframes on x or y)', 'warning'); return; }
        notify(`Wiggled ${r.tracks === 2 ? 'x and y' : 'position'} — ${r.added} keyframes added`, 'success');
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
        if (!getTimelineController().sequenceLayerBars(selectedIds, overlap, { crossfade: overlap > 0 })) {
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
      /** Stagger keyframe timing across selected animated layers (does not move bars). */
      id: asCommandId('animation.sequenceLayers'),
      label: 'Stagger Animations (0.3s)',
      icon: 'layers',
      enabled: () => useSelectionStore.getState().ids.length >= 2,
      execute: () => {
        const ids = useSelectionStore.getState().ids;
        if (sequenceLayers(ids, 0.3)) notify('Animations staggered', 'success');
        else notify('Select 2+ animated layers first', 'warning');
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
        const node = defaultSceneGraph.getNode(ids[0]!);
        return !!node && isAudioNode(node);
      },
      execute: () => {
        const nodeId = useSelectionStore.getState().ids[0];
        if (!nodeId) return;
        void convertAudioToSliderNull(nodeId).then(({ nodeId: nullId, written }) => {
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
        const { written, refusal } = convertExpressionToKeyframes(nodeId);
        if (refusal) { notify(BAKE_REFUSAL_TEXT[refusal], 'warning'); return; }
        const total = [...written.values()].reduce((a, b) => a + b, 0);
        notify(
          `Expression baked — ${total} keyframes across ${written.size} ` +
            `${written.size === 1 ? 'property' : 'properties'}. The expression is disabled, not deleted.`,
          'success',
        );
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
        deleteSelectedLayers();
        notify('Deleted selected layers', 'info');
      },
    },
    {
      id: asCommandId('edit.deleteSelected.del'),
      label: 'Delete Selected (Del key)',
      shortcut: { key: 'Delete' },
      enabled: () => useSelectionStore.getState().count() > 0,
      execute: () => {
        deleteSelectedLayers();
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
        duplicateSelectedLayers();
        notify('Duplicated layers', 'success');
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
        cutSelection();
        notify('Cut', 'info');
      },
    },
    {
      id: BuiltinCommands.Copy,
      label: 'Copy',
      shortcut: { key: 'c', meta: true },
      enabled: () => hasCutCopyTarget(),
      execute: () => {
        copySelection();
        notify('Copied', 'info');
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
        void pasteSelection().then((kind) => {
          if (kind === 'svg') notify('Pasted SVG as shapes', 'success');
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
    execute: () => {
      const nodeId = useSelectionStore.getState().ids[0];
      if (!nodeId) return;
      const node = defaultSceneGraph.getNode(nodeId);
      if (!node) return;
      // Sized from the layer's own box, so the rig fits the artwork. `readGeometry`
      // reports the UNSCALED size, which is what keeps a scaled layer from getting
      // a differently-proportioned skeleton.
      const geom = readGeometry(node);
      const problems = applyRigPreset(
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
    ...buildCameraToolCommands(),
    ...buildViewSwitchCommands(),
    ...buildMarkerCommands(),
    ...buildEasingCommands(),
    ...buildMergePathCommands(),
    ...buildProjectCommands(),
    ...buildRigPresetCommands(),
    ...buildCaptionCommands(),
    ...buildChoreographyCommands(),
    ...buildBeatCommands(),
    ...buildSpeedRampCommands(),
    ...buildSmartAnimateCommands(),
    ...buildReframeCommands(),
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
        const layers = Math.max(0, flattenComposition(defaultSceneGraph, compId).length - 1);
        const warn = layers > 0
          ? `Delete “${comp.name}” and its ${layers} layer${layers === 1 ? '' : 's'}?`
          : `Delete “${comp.name}”?`;
        if (await customConfirm('Delete Composition', warn, { isDanger: true, confirmLabel: 'Delete' })) {
          deleteComposition(compId);
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
      execute: () => insertPrimitive('text', 'Text'),
    },
    {
      id: asCommandId('layer.newSolid'),
      label: 'Solid…',
      shortcut: { key: 'y', meta: true },
      enabled: () => true,
      execute: () => insertSolid(),
    },
    {
      id: asCommandId('layer.newCamera'),
      label: 'Camera',
      enabled: () => true,
      execute: () => insertCamera(),
    },
    {
      id: asCommandId('layer.newLight'),
      label: 'Light',
      enabled: () => true,
      execute: () => insertLight(),
    },
    {
      id: asCommandId('layer.newNull'),
      label: 'Null Object',
      shortcut: { key: 'y', meta: true, alt: true, shift: true },
      enabled: () => true,
      execute: () => insertNull(),
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
        const n = defaultSceneGraph.getNode(ids[0]!);
        return !!n && readNodeKind(n) === 'shape' && pathVertices(n, getTimelineController().currentSeconds).length > 0;
      },
      execute: () => {
        const id = useSelectionStore.getState().ids[0];
        if (!id) return;
        const made = createNullsFromPath(id, getTimelineController().currentSeconds);
        notify(made.length ? `Created ${made.length} null${made.length === 1 ? '' : 's'} on the path` : 'No path points to create nulls from', made.length ? 'success' : 'warning');
      },
    },
    {
      // The live direction: every vertex follows its null from now on.
      id: asCommandId('layer.nullsFromPathLive'),
      label: 'Create Nulls From Path Points (Points Follow Nulls)',
      enabled: () => {
        const ids = useSelectionStore.getState().ids;
        if (ids.length !== 1) return false;
        const n = defaultSceneGraph.getNode(ids[0]!);
        return !!n && readNodeKind(n) === 'shape' && pathVertices(n, getTimelineController().currentSeconds).length > 0;
      },
      execute: () => {
        const id = useSelectionStore.getState().ids[0];
        if (!id) return;
        const made = createNullsFromPath(id, getTimelineController().currentSeconds, { pointsFollowNulls: true });
        notify(made.length ? `${made.length} null${made.length === 1 ? '' : 's'} now drive the path — move one and the outline follows` : 'No path points to create nulls from', made.length ? 'success' : 'warning');
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
        const made = await createShapesFromText(id);
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
      execute: () => insertAdjustmentLayer(),
    },
    {
      id: asCommandId('layer.precompose'),
      label: 'Pre-compose…',
      shortcut: { key: 'c', meta: true, shift: true },
      enabled: () => useSelectionStore.getState().count() > 0,
      execute: () => precomposeSelected(),
    },
    // ── Fit (AE's Layer ▸ Transform submenu) ──────────────────────────
    // One-shot commands that COMPUTE a size and write it, rather than a stored
    // "fit mode" the renderer re-resolves every frame. The old Media panel had
    // the property version and it never did anything — see fitCommands.ts for
    // why the command form is the one that can work. They read intrinsic size
    // through `sourceOf`, so a placed composition fits exactly like footage.
    ...([
      ['layer.fitToComp', 'Fit to Comp', 'contain' as const, { key: 'f', meta: true, alt: true }],
      ['layer.fitToCompWidth', 'Fit to Comp Width', 'width' as const, undefined],
      ['layer.fitToCompHeight', 'Fit to Comp Height', 'height' as const, undefined],
      ['layer.fillComp', 'Fill Comp (crop to frame)', 'cover' as const, undefined],
      ['layer.nativeSize', 'Set to Native Size', 'native' as const, undefined],
    ] as const).map(([id, label, mode, shortcut]) => ({
      id: asCommandId(id),
      label,
      ...(shortcut ? { shortcut } : {}),
      enabled: () => useSelectionStore.getState().count() > 0,
      execute: () => {
        const frame = activeCompSize();
        for (const nodeId of useSelectionStore.getState().ids) fitNodeTo(nodeId, frame, mode);
      },
    })),
    {
      id: asCommandId('layer.centreAnchor'),
      label: 'Centre Anchor Point in Layer Content',
      enabled: () => useSelectionStore.getState().count() > 0,
      execute: () => {
        for (const nodeId of useSelectionStore.getState().ids) centreAnchorInContent(nodeId);
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
      enabled: () => useSelectionStore.getState().count() > 0,
      execute: () => {
        const frame = activeCompSize();
        for (const nodeId of useSelectionStore.getState().ids) centreInFrame(nodeId, frame);
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
    // Arrange (z-order): a layer draws on top of the ones added before it, so a
    // newly-imported background lands in front and hides everything. These give
    // explicit stacking control (Figma/Illustrator chords: Ctrl/Cmd+] / [).
    {
      id: asCommandId('layer.bringToFront'),
      label: 'Bring to Front',
      icon: 'arrow-up',
      shortcut: { key: ']', meta: true, shift: true },
      enabled: () => useSelectionStore.getState().count() > 0,
      execute: () => {
        for (const id of useSelectionStore.getState().ids) moveNodeInStack(id, 'front');
        notify('Brought to front', 'info');
      },
    },
    {
      id: asCommandId('layer.bringForward'),
      label: 'Bring Forward',
      icon: 'chevron-up',
      shortcut: { key: ']', meta: true },
      enabled: () => useSelectionStore.getState().count() > 0,
      execute: () => {
        for (const id of useSelectionStore.getState().ids) moveNodeInStack(id, 'forward');
        notify('Brought forward', 'info');
      },
    },
    {
      id: asCommandId('layer.sendBackward'),
      label: 'Send Backward',
      icon: 'chevron-down',
      shortcut: { key: '[', meta: true },
      enabled: () => useSelectionStore.getState().count() > 0,
      execute: () => {
        for (const id of useSelectionStore.getState().ids) moveNodeInStack(id, 'backward');
        notify('Sent backward', 'info');
      },
    },
    {
      id: asCommandId('layer.sendToBack'),
      label: 'Send to Back',
      icon: 'arrow-down',
      shortcut: { key: '[', meta: true, shift: true },
      enabled: () => useSelectionStore.getState().count() > 0,
      execute: () => {
        for (const id of useSelectionStore.getState().ids) moveNodeInStack(id, 'back');
        notify('Sent to back', 'info');
      },
    },
    {
      id: asCommandId('effect.blur'),
      label: 'Fast Box Blur',
      enabled: () => useSelectionStore.getState().primary !== null,
      execute: () => {
        const id = useSelectionStore.getState().primary;
        if (id) { addEffect(id, 'blur'); notify('Added Fast Box Blur', 'success'); }
      },
    },
    {
      id: asCommandId('effect.glow'),
      label: 'Glow',
      enabled: () => useSelectionStore.getState().primary !== null,
      execute: () => {
        const id = useSelectionStore.getState().primary;
        if (id) { addEffect(id, 'glow'); notify('Added Glow', 'success'); }
      },
    },
    {
      id: asCommandId('effect.brightness'),
      label: 'Brightness & Contrast',
      enabled: () => useSelectionStore.getState().primary !== null,
      execute: () => {
        const id = useSelectionStore.getState().primary;
        if (id) { addEffect(id, 'brightness'); notify('Added Brightness & Contrast', 'success'); }
      },
    },
    {
      id: asCommandId('effect.contrast'),
      label: 'Contrast',
      enabled: () => useSelectionStore.getState().primary !== null,
      execute: () => {
        const id = useSelectionStore.getState().primary;
        if (id) { addEffect(id, 'contrast'); notify('Added Contrast', 'success'); }
      },
    },
    {
      id: asCommandId('effect.saturate'),
      label: 'Hue/Saturation',
      enabled: () => useSelectionStore.getState().primary !== null,
      execute: () => {
        const id = useSelectionStore.getState().primary;
        if (id) { addEffect(id, 'saturate'); notify('Added Hue/Saturation', 'success'); }
      },
    },
    {
      id: asCommandId('effect.grayscale'),
      label: 'Grayscale',
      enabled: () => useSelectionStore.getState().primary !== null,
      execute: () => {
        const id = useSelectionStore.getState().primary;
        if (id) { addEffect(id, 'grayscale'); notify('Added Grayscale', 'success'); }
      },
    },
    {
      id: asCommandId('effect.sepia'),
      label: 'Sepia',
      enabled: () => useSelectionStore.getState().primary !== null,
      execute: () => {
        const id = useSelectionStore.getState().primary;
        if (id) { addEffect(id, 'sepia'); notify('Added Sepia', 'success'); }
      },
    },
    {
      id: asCommandId('effect.hue'),
      label: 'Hue Rotate',
      enabled: () => useSelectionStore.getState().primary !== null,
      execute: () => {
        const id = useSelectionStore.getState().primary;
        if (id) { addEffect(id, 'hue-rotate'); notify('Added Hue Rotate', 'success'); }
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
      execute: () => {
        openModal({
          title: 'Premation',
          size: 'sm',
          render: () => (
            <div style={{ color: 'var(--color-text-secondary)', lineHeight: 1.6, fontSize: 'var(--font-size-md)' }}>
              <Logo variant="lockup" size={34} />
              <div style={{ marginTop: '14px' }}>
                Professional AI-native motion design application.
                <br />
                Version 0.1.0 — frontend foundation.
              </div>
            </div>
          ),
        });
      },
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
        // Bind the (framework-independent) animation engine's change sink onto
        // the app EventBus so its mutations surface as 'AnimationChanged'. Must
        // run before any engine emit (seeding below) reaches its listeners.
        defaultAnimation.setChangeListener((nodeId) =>
          getEventBus().emit('AnimationChanged', { nodeId }),
        );
        // Audio-reactive expressions read live amplitude from the AudioEngine.
        defaultAnimation.setAudioLevelProvider(() => audioEngine.currentLevel());
        // ctrl('name') expressions read slider-control rigs from the scene.
        defaultAnimation.setControlProvider((name, t) => controlValue(name, t));
        // The remaining four providers had NO callers, so the engine kept its
        // placeholder defaults and the expression API quietly lied: layer
        // always returned 0, thisComp.width was a hardcoded 1920 regardless of
        // the real comp, and thisLayer.name was the string 'Layer'. A plausible
        // wrong number is worse than an error — it fails silently on exactly
        // the comps where people rely on it.
        defaultAnimation.setLayerResolver((name) => {
          let found: string | null = null;
          defaultSceneGraph.traverse((n) => {
            if (found === null && n.name === name) found = n.id;
          });
          return found;
        });
        defaultAnimation.setBaseValueProvider((nodeId, prop) => {
          const node = defaultSceneGraph.getNode(nodeId);
          if (!node) return undefined;
          const t = node.components.find((c) => c.type === 'Transform');
          const v = t?.props[prop as string];
          return typeof v === 'number' ? v : undefined;
        });
        defaultAnimation.setCompInfoProvider(() => {
          const comp = useCompositionStore.getState().comp();
          let numLayers = 0;
          defaultSceneGraph.traverse(() => { numLayers += 1; });
          return {
            width: comp.width,
            height: comp.height,
            duration: comp.durationSeconds,
            fps: comp.fps,
            numLayers,
          };
        });
        defaultAnimation.setLayerInfoProvider((nodeId) => {
          const comp = useCompositionStore.getState().comp();
          const node = defaultSceneGraph.getNode(nodeId);
          const t = node?.components.find((c) => c.type === 'Transform');
          const w = t?.props.width;
          const h = t?.props.height;
          return {
            name: node?.name ?? 'Layer',
            width: typeof w === 'number' ? w : comp.width,
            height: typeof h === 'number' ? h : comp.height,
          };
        });
        /**
         * `sourceRectAtTime` — a layer's CONTENT bounds, not its box.
         *
         * For TEXT this is the whole value of the function: the box is whatever
         * the user dragged, while the bounds are where the glyphs actually are,
         * and an auto-sizing plate needs the second. `measureTextNodeBoxes`
         * already does the real measurement (it is what buildSnapshot uses), so
         * this is a lookup rather than an estimate — `estimateNodeBounds` in
         * anchor.ts is deliberately NOT used here, because for text it returns a
         * hardcoded 300×50.
         *
         * The time argument is honoured through `evaluateNode(nodeId, t)`, which
         * resolves the node's animated props at `t` before measuring. Without
         * that, a plate behind text whose size or tracking is animated would
         * measure the playhead's bounds while sitting on another frame.
         *
         * Non-text layers have no ink/font distinction, so they report their
         * transform box and `extents` makes no difference — stated here rather
         * than silently returning the same thing twice.
         */
        defaultAnimation.setSourceRectProvider((nodeId, t, extents) => {
          const node = defaultSceneGraph.getNode(nodeId);
          if (!node) return undefined;
          if (readNodeKind(node) === 'text') {
            const overrides: Record<string, unknown> = {};
            for (const [prop, v] of defaultAnimation.evaluateNode(nodeId, t)) overrides[prop] = v;
            const boxes = measureTextNodeBoxes(node, overrides);
            if (boxes) {
              // extents → the FONT box (stable per font and line count);
              // default → the glyph INK box (tight, what a plate wants).
              const b = extents ? boxes.font : boxes.ink;
              return { top: b.top, left: b.left, width: b.width, height: b.height };
            }
          }
          const tr = node.components.find((c) => c.type === 'Transform');
          const w = tr?.props.width;
          const h = tr?.props.height;
          if (typeof w !== 'number' || typeof h !== 'number') return undefined;
          return { top: -h / 2, left: -w / 2, width: w, height: h };
        });
        /**
         * `toComp` / `toWorld` / `fromComp` / `fromWorld` — coordinate spaces.
         *
         * `name` is null for the layer the expression is on, or another layer's
         * name. Resolution matches `layer(name, prop)`: by name, first match.
         *
         * Everything real happens in `layerSpaceAt`, which composes nothing of
         * its own — it routes to `worldMatrixOf` (2D), `nodeWorldWithParents3d`
         * (3D) and `readSceneCamera`, the same three the renderer uses.
         */
        defaultAnimation.setLayerSpaceProvider((self, name, t) => {
          const comp = useCompositionStore.getState().comp();
          let nodeId: string | null = self;
          if (name !== null) {
            // Through the same resolution as `layer()`, so a `#<id>` reference
            // survives a rename here too. Two lookups with different rules
            // would mean `layer('#id', …)` worked and `toComp` on the same
            // reference silently did not.
            nodeId = resolveLayerRef(name, (n: string) => {
              let found: string | null = null;
              defaultSceneGraph.traverse((node) => {
                if (found === null && node.name === n) found = node.id;
              });
              return found;
            });
          }
          if (nodeId === null) return undefined;
          return layerSpaceAt(nodeId, t, { width: comp.width, height: comp.height });
        });
        /**
         * `marker.*` — comp and layer markers.
         *
         * Goes through `getMarkers` / `getLayerMarkers` rather than reading
         * `timeline.markers` directly, deliberately. `getLayerMarkers` is the
         * ONE place that undoes the layer-relative storage (via
         * `toAbsoluteTime`), and a second copy of that conversion here is the
         * §2·0 shape: two readers of one rule, nothing forcing them to agree,
         * and a discrepancy that shows up only on a trimmed or slid layer.
         *
         * `label` maps to `name` because that is the field the app's marker
         * commands fill; `comment` is the note. Both are exposed so a
         * `marker.key("...")` lookup works whichever one the user typed into.
         */
        defaultAnimation.setMarkerProvider((nodeId, scope) => {
          const ctrl = getTimelineController();
          const src = scope === 'comp' ? ctrl.getMarkers() : ctrl.getLayerMarkers(nodeId);
          return src.map((m) => ({
            time: m.time,
            duration: m.duration,
            name: m.label,
            comment: m.comment,
          }));
        });
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
        window.motionEditor?.onMenuCommand?.((id) => {
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
            // is announced into a no-op sink.
            installInstalledSyncSink();
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
            void reconcileInstalledSet(usePluginStore.getState().plugins)
              .then((report) => usePluginStore.getState().noteSync(report))
              .catch(() => undefined);
            pluginHost.configure({
              getSelection: () => useSelectionStore.getState().ids,
              // What makes `motion.ui.openPanel()` real. The host cannot import
              // the dock itself (it must stay React-free and testable), so the
              // shell hands it the two calls it needs.
              showPanel: (id, panelId) => showPluginPanel(id, panelId),
              hidePanel: (id, panelId) => hidePluginPanel(id, panelId),
            });
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
              const comp = useCompositionStore.getState();
              openExportDialog(comp.durationSeconds, comp.fps);
            },
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
              execute: () => { void createCustomLayerFromMenu(kind); },
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
          // in the project bundle instead, surfaced by VersionHistorySection in
          // the inspector. Registering it would put a permanently-disabled menu
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
        if (!isPopoutWindow()) {
          try { seedDefaultScene(); } catch { /* ignore */ }
        }
        try { void useAssetStore.getState().initialize(); } catch { /* ignore */ }

        // History: initial "Open" state, then a debounced snapshot after edits.
        try {
          useHistoryStore.getState().reset();
          useHistoryStore.getState().record('Open', true);
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
        try {
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
        try {
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
                      getTimelineController().seekSeconds(t);
                      bumpScene();
                      useHistoryStore.getState().record('Recovered', true);
                      const s = useProjectStore.getState();
                      if (s.activeTabId) s.actions.markDirty(s.activeTabId, true);
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
