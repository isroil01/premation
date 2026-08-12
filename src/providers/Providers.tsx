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
import {
  applyPreferencesToDocument,
  usePreferenceStore,
} from '@stores/preferenceStore';
import { allLayerKinds } from '@core/plugins/layerKindRegistry';
import { createCustomLayerFromMenu } from '@core/plugins/createCustomLayerFromMenu';
import { useLayoutStore } from '@stores/layoutStore';
import { useSelectionStore } from '@stores/selectionStore';
import { useKeyframeSelectionStore } from '@stores/keyframeSelectionStore';
import { useCompositionStore } from '@stores/compositionStore';
import { cutSelection, copySelection, pasteSelection, hasClipboardContent } from '@core/commands/clipboard';
import { getTimelineController } from '@core/timeline/TimelineController';
import { buildSaaSAd } from '@core/scene/seedSaaSAd';
import { buildComplexShowcase } from '@core/scene/seedComplexShowcase';
import { useProjectStore } from '@stores/projectStore';
import { useUIStore } from '@stores/uiStore';
import { bumpScene } from '@stores/sceneStore';
import { openProjectPath } from '@core/project/openProjectPath';
import { openModal } from '@stores/modalStore';
import { customConfirm, customPrompt } from '@components/Modal';
import { attachHistoryRecording, useHistoryStore, performUndo, performRedo } from '@stores/historyStore';
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
import { chooseBundleDir } from '@core/project/bundle/bundleProjectIO';
import { OnboardingOverlay } from '@layout/Onboarding/OnboardingOverlay';
import { useOnboardingStore } from '@stores/onboardingStore';
import { projectDocumentIO } from '@core/project/projectDocumentIO';
import { incrementName } from '@core/project/incrementName';
import { confirmDiscardChanges } from '@core/project/confirmDiscard';
import { canSyncCurrentProject, syncCurrentProject } from '@core/sync/syncCurrentProject';
import { renderStillFrame } from '@core/export/offlineRenderer';
import { asThemeId, asCommandId, type KeyChord } from '@app-types/common';
import { type EasingPreset } from '@core/animation/keyframeAssistants';
import { applyEasingToSelection, easingTargetKeyframes } from '@core/animation/easingSelection';
import { hydrateComposition } from '@stores/compositionStore';
import { useAssetStore } from '@stores/assetStore';
import { openCustomizeDialog } from '@layout/Settings/CustomizeDialog';
import { openVersionHistory } from '@layout/History/VersionHistoryPanel';
import { useCloudProjectStore } from '@stores/cloudProjectStore';
import { registerDefaultEditors } from '@components/Inspector/DefaultEditors';
import { seedDefaultScene } from '@core/scene/seedDefaultScene';
import { isPopoutWindow, startWindowSync } from '@core/layout/windowSync';
import { seedDemoAnimation } from '@core/animation/seedDemoAnimation';
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
import { armMotionSketch, finishMotionSketch, cancelMotionSketch } from '@core/animation/motionSketch';
import { isGuideLayer, setGuideLayer } from '@core/scene/guideLayer';
import { measureTextNodeBoxes } from '@core/text/measureText';
import { readNodeKind } from '@core/scene/sceneDerive';
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
import { fitNodeTo, centreAnchorInContent, centreInFrame } from '@core/source/fitCommands';
import { activeCompSize } from '@core/scene/activeComp';
import { rigLogoForAnimation } from '@core/scene/rigLogo';
import { addEffect } from '@core/effects/effects';
import { openCompositionSettings } from '@layout/Composition/CompositionSettingsDialog';
import { openNewCompositionDialog } from '@layout/Composition/NewCompositionDialog';

interface ProvidersProps {
  children: ReactNode;
}

function notify(message: string, level: 'info' | 'success' | 'warning' | 'error' = 'info'): void {
  useUIStore.getState().notify({ level, message, durationMs: 2600 });
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
      label: 'Guide Layer (exclude from render)',
      icon: 'eye-off',
      enabled: () => useSelectionStore.getState().ids.length > 0,
      execute: () => {
        const ids = useSelectionStore.getState().ids;
        if (ids.length === 0) return;
        const next = !isGuideLayer(ids[0]!);
        for (const id of ids) setGuideLayer(id, next);
        const plural = ids.length > 1 ? 's' : '';
        notify(
          next
            ? `Guide layer${plural} — hidden from render and export`
            : `No longer a guide layer${plural}`,
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
      enabled: () => useSelectionStore.getState().count() > 0,
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
      enabled: () => hasClipboardContent(),
      execute: () => {
        pasteSelection();
        notify('Pasted', 'success');
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
  ];
}

function buildExampleCommands(): ReadonlyArray<Command> {
  const load = (label: string, build: () => void) => async (): Promise<void> => {
    const dirty = useProjectStore.getState().activeTabId
      ? useProjectStore.getState().tabs[useProjectStore.getState().activeTabId!]?.dirty
      : false;
    if (dirty && !await customConfirm('Load Example', `Load "${label}"? This replaces the current scene and your unsaved changes will be lost.`, { isDanger: true, confirmLabel: 'Load' })) {
      return;
    }
    build();
    getTimelineController().syncFromScene();
    bumpScene();
    notify(`Loaded ${label}`, 'success');
  };

  return [
    {
      id: asCommandId('scene.loadSaaSAd'),
      label: 'Load: Nova AI — SaaS Ad',
      enabled: () => true,
      execute: load('Nova AI — SaaS Ad', () => { buildSaaSAd(); }),
    },
    {
      id: asCommandId('scene.loadShowcase'),
      label: 'Load: Complex Showcase',
      enabled: () => true,
      execute: load('Complex Showcase', () => { buildComplexShowcase(); }),
    },
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
      id: asCommandId('comp.settings'),
      label: 'Composition Settings…',
      shortcut: { key: 'k', meta: true },
      enabled: () => true,
      execute: () => {
        openCompositionSettings();
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
        bumpScene();
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
        // picker. In the browser build `chooseBundleDir` returns null, so this
        // falls through to the normal file open.
        if (isLocalFirst()) {
          const dir = await chooseBundleDir();
          if (dir) {
            // Shared with the start screen's recent list — see openProjectPath,
            // which also re-baselines undo so the first Ctrl+Z after an open
            // cannot step back into the previous document.
            const opened = await openProjectPath(dir);
            if (opened) {
              notify(`Opened “${opened.name}”`, 'success');
            } else {
              notify('Could not open that bundle', 'error');
            }
            return;
          }
        }
        // Cloud projects have no file picker — send the user to the dashboard,
        // which is the real "choose a project" surface.
        if (getFileManager().environment === 'api') {
          notify('Choose a project from your dashboard', 'info');
          window.location.hash = '#/';
          return;
        }
        const ref = await getProjectManager().open();
        if (ref) {
          bumpScene();
          notify(`Opened “${ref.name}”`, 'success');
        } else {
          notify('Open cancelled', 'info');
        }
      },
    },
    {
      id: asCommandId(ProjectCommands.Save),
      label: 'Save',
      shortcut: { key: 's', meta: true },
      enabled: () => true,
      execute: async () => {
        const ok = await getProjectManager().save();
        // An explicit save clears the unsaved indicator + recovery snapshot.
        const ws = useProjectStore.getState();
        if (ws.activeTabId) ws.actions.markDirty(ws.activeTabId, false);
        clearRecovery();
        notify(ok ? 'Project saved' : 'Saved', 'success');
      },
    },
    {
      id: asCommandId(ProjectCommands.SaveAs),
      label: 'Save As…',
      shortcut: { key: 's', meta: true, shift: true },
      enabled: () => true,
      execute: async () => {
        const ok = await getProjectManager().saveAs('Untitled');
        notify(ok ? 'Project saved' : 'Save cancelled', ok ? 'success' : 'info');
      },
    },
    {
      id: asCommandId(ProjectCommands.IncrementAndSave),
      label: 'Increment and Save',
      // AE: Cmd/Ctrl+Alt+Shift+S — save a fresh copy with the next number.
      shortcut: { key: 's', meta: true, alt: true, shift: true },
      enabled: () => true,
      execute: async () => {
        const current = getProjectManager().getState().current?.name ?? 'Untitled';
        const next = incrementName(current);
        const ok = await getProjectManager().saveAs(next);
        notify(ok ? `Saved “${next}”` : 'Save cancelled', ok ? 'success' : 'info');
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

      // Core services are registered inside Application.boot; track the rest of
      // the boot sequence as a loading task so the UI can reflect it.
      const bootTask = getLoadingManager().begin('boot', 'Starting editor…');
      try {
        // Register built-in + project commands AFTER boot so the registry exists.
        const registry = getCommandRegistry();
        for (const cmd of buildStaticCommands()) registry.register(cmd);
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

        for (const cmd of buildExampleCommands()) registry.register(cmd);

        getShortcutManager().rehydrateFromRegistry();

        // Theme: ThemeManager is the single authority. Mirror the resolved theme
        // into the preference store so existing UI reading it stays correct.
        const theme = getThemeManager();
        track(theme.subscribe((t) => usePreferenceStore.getState().set('theme', asThemeId(t))));
        theme.apply();

        // Composition settings + pasteboard colour: load persisted values now
        // that the SettingsManager is booted (defaults until the user edits).
        hydrateComposition();

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
        track(getEventBus().on('AnimationChanged', () => { bumpScene(); }));

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
            enabled: () => true, execute: () => openExportDialog(10, 30),
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
            // AE's Project panel: the list of compositions.
            id: asCommandId('view.project'), label: 'Project', icon: 'folder',
            enabled: () => true,
            execute: () => useLayoutStore.getState().openPanel('project'),
          });
          registry.register({
            // Targets the 'effects' panel registered in App.tsx. This used to
            // open 'effectControls', an id that is never registered — and both
            // openPanel and togglePanel bail on an unknown id, so the menu item
            // and F3 silently did nothing.
            id: asCommandId('view.effectControls'), label: 'Effect Controls', icon: 'keyframe',
            shortcut: { key: 'F3' },
            enabled: () => true,
            execute: () => useLayoutStore.getState().openPanel('effects'),
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
          try { seedDemoAnimation(); } catch { /* ignore */ }
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

        // Dirty tracking + autosave (crash recovery). Edits mark the active
        // document dirty (amber dot); autosave persists a recovery snapshot
        // every 60s while dirty, never clearing the unsaved indicator.
        try {
          const markDirty = (): void => {
            const s = useProjectStore.getState();
            if (s.activeTabId && !s.tabs[s.activeTabId]?.dirty) s.actions.markDirty(s.activeTabId, true);
          };
          track(getEventBus().on('AnimationChanged', markDirty));
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
