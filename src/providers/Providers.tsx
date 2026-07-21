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
import { openModal } from '@stores/modalStore';
import { customConfirm } from '@components/Modal';
import { useHistoryStore, performUndo, performRedo } from '@stores/historyStore';
import { Button } from '@components/Button';
import { getAutosaveController } from '@core/persistence/AutosaveController';
import { readRecovery, clearRecovery, restoreRecovery } from '@core/persistence/recovery';
import pluginHost from '@core/plugins/PluginHost';
import { openPluginsModal } from '@layout/Plugins/PluginsModal';
import { openExportDialog } from '@layout/Export/ExportDialog';
import { usePresentationStore } from '@stores/presentationStore';
import { useGuidesStore } from '@stores/guidesStore';
import { getCommandRegistry, BuiltinCommands, type Command } from '@core/commands/Command';
import { getCommandSystem } from '@core/commands/CommandSystem';
import { getShortcutManager } from '@core/commands/ShortcutManager';
import { getEventBus } from '@core/events/EventBus';
import { getThemeManager, getProjectManager, getLoadingManager, getSettingsManager, getFileManager } from '@core/services/coreServices';
import { OnboardingOverlay } from '@layout/Onboarding/OnboardingOverlay';
import { useOnboardingStore } from '@stores/onboardingStore';
import { projectDocumentIO } from '@core/project/projectDocumentIO';
import { incrementName } from '@core/project/incrementName';
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
import { seedDemoAnimation } from '@core/animation/seedDemoAnimation';
import { defaultAnimation } from '@motion/animation';
import defaultSceneGraph from '@core/scene/DefaultSceneGraph';
import { audioEngine } from '@core/audio/AudioEngine';
import { AudioPlaybackBridge } from '@core/audio/useAudioPlayback';
import { controlValue } from '@core/animation/expressionControls';
import { ProjectCommands } from '@layout/Menu';
import { CommandPalette } from '@layout/CommandPalette';
import { PresentationMode } from '@layout/Presentation/PresentationMode';
import { openPalette } from '@stores/commandPaletteStore';
import { insertCamera, insertLight, insertAdjustmentLayer, precomposeSelected, insertPrimitive, insertSolid, deleteSelectedLayers, duplicateSelectedLayers } from '@core/scene/sceneInsert';
import { insertNull, moveNodeInStack } from '@core/scene/parenting';
import { rigLogoForAnimation } from '@core/scene/rigLogo';
import { addEffect } from '@core/effects/effects';
import { openCompositionSettings } from '@layout/Composition/CompositionSettingsDialog';

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
 * Keyframe-assistant commands (AE's F9 family + interpolation).
 *
 * These already existed and worked, but had NO menu home — the audit's "F9
 * commands exist with no menu home". They live in the Animation menu now (see
 * menuModel), so they're discoverable rather than shortcut-only.
 */
import { mergeSelectedPaths, type MergeOp } from '@core/scene/mergePaths';

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
 * Each REPLACES the current scene (they call defaultSceneGraph.clear()), so
 * they confirm first — silently discarding the user's work would be worse than
 * the no-op they replace.
 */
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
      execute: () => {
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
      id: asCommandId(ProjectCommands.Close),
      label: 'Close Project',
      enabled: () => true,
      execute: () => {
        getProjectManager().close();
        bumpScene();
        notify('Project closed', 'info');
      },
    },
    {
      id: asCommandId(ProjectCommands.About),
      label: 'About Motion Editor',
      enabled: () => true,
      execute: () => {
        openModal({
          title: 'Motion Editor',
          size: 'sm',
          render: () => (
            <div style={{ color: 'var(--color-text-secondary)', lineHeight: 1.6, fontSize: 'var(--font-size-md)' }}>
              Professional AI-native motion design application.
              <br />
              Version 0.1.0 — frontend foundation.
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
        for (const cmd of buildBuiltinCommands()) registry.register(cmd);
        for (const cmd of buildToolCommands()) registry.register(cmd);
        for (const cmd of buildEasingCommands()) registry.register(cmd);
        for (const cmd of buildMergePathCommands()) registry.register(cmd);
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

        for (const cmd of buildProjectCommands()) registry.register(cmd);
        for (const cmd of buildExampleCommands()) registry.register(cmd);

        getShortcutManager().rehydrateFromRegistry();

        // Theme: ThemeManager is the single authority. Mirror the resolved theme
        // into the preference store so existing UI reading it stays correct.
        const theme = getThemeManager();
        theme.subscribe((t) => usePreferenceStore.getState().set('theme', asThemeId(t)));
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
        getEventBus().on('ProjectLoaded', () => bumpScene());
        getEventBus().on('ProjectUnloaded', () => bumpScene());
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
        // placeholder defaults and the expression API quietly lied: layer()
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
        // Keyframe edits refresh the timeline tracks + inspector + viewport.
        getEventBus().on('AnimationChanged', () => { bumpScene(); });

        // Native (Electron) menu items dispatch through the same CommandSystem.
        window.motionEditor?.onMenuCommand?.((id) => {
          void getCommandSystem().execute(asCommandId(id));
        });

        // Plugin host + UI commands (searchable in the Command Palette).
        try {
          pluginHost.configure({
            getSelection: () => useSelectionStore.getState().ids,
            notify: (m) => notify(m, 'success'),
          });
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
                { width: c.width, height: c.height, fps: c.fps, durationSec: c.durationSeconds, comp: { ...c, rootId: c.id } },
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
            id: asCommandId('view.presentation'), label: 'Present (Preview)', icon: 'eye',
            enabled: () => true, execute: () => usePresentationStore.getState().enter(),
          });
          registry.register({
            id: asCommandId('view.plugins'), label: 'Plugins…', icon: 'plugin',
            enabled: () => true, execute: () => openPluginsModal(),
          });
          registry.register({
            id: asCommandId('help.tour'), label: 'Take a Tour', icon: 'sparkles',
            enabled: () => true, execute: () => useOnboardingStore.getState().start(),
          });
          registry.register({
            id: asCommandId('view.safeAreas'), label: 'Toggle Safe Areas', icon: 'frame',
            enabled: () => true, execute: () => useGuidesStore.getState().toggleSafeArea(),
          });
          registry.register({
            id: asCommandId('view.grid'), label: 'Toggle Grid', icon: 'grid',
            enabled: () => true, execute: () => useGuidesStore.getState().toggleGrid(),
          });
          registry.register({
            id: asCommandId('view.rulers'), label: 'Toggle Rulers', icon: 'ruler',
            enabled: () => true, execute: () => useGuidesStore.getState().toggleRulers(),
          });
          registry.register({
            // The ViewportHeader tooltip has advertised this chord all along —
            // it just was never bound. Motion paths draw for selected layers
            // with position keyframes; this hides/shows them globally.
            id: asCommandId('view.motionPath'), label: 'Toggle Motion Paths', icon: 'path',
            shortcut: { key: 'm', meta: true, alt: true },
            enabled: () => true, execute: () => useGuidesStore.getState().toggleMotionPath(),
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
          registry.register({
            id: asCommandId('file.versionHistory'), label: 'Version History…', icon: 'undo',
            enabled: () => useCloudProjectStore.getState().projectId !== null,
            execute: () => openVersionHistory(),
          });
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
        try { seedDefaultScene(); } catch { /* ignore */ }
        try { seedDemoAnimation(); } catch { /* ignore */ }
        try { void useAssetStore.getState().initialize(); } catch { /* ignore */ }

        // History: initial "Open" state, then a debounced snapshot after edits.
        try {
          useHistoryStore.getState().reset();
          useHistoryStore.getState().record('Open', true);
          // The debounce lives in the store so undo/redo can flush it — a
          // pending snapshot that only exists in a local closure is why Ctrl+Z
          // inside the window used to eat two actions.
          const scheduleRecord = (): void => useHistoryStore.getState().schedule();
          getEventBus().on('AnimationChanged', scheduleRecord);
          getEventBus().on('NodeUpdated', scheduleRecord);
          getEventBus().on('SceneGraphChanged', scheduleRecord);
        } catch { /* ignore */ }

        // Dirty tracking + autosave (crash recovery). Edits mark the active
        // document dirty (amber dot); autosave persists a recovery snapshot
        // every 60s while dirty, never clearing the unsaved indicator.
        try {
          const markDirty = (): void => {
            const s = useProjectStore.getState();
            if (s.activeTabId && !s.tabs[s.activeTabId]?.dirty) s.actions.markDirty(s.activeTabId, true);
          };
          getEventBus().on('AnimationChanged', markDirty);
          getEventBus().on('NodeUpdated', markDirty);
          getEventBus().on('SceneGraphChanged', markDirty);
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
                  Motion Editor found unsaved changes from your last session
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
                      useProjectStore.getState().actions.setTime(t, Math.round(t * 60));
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

      if (!cancelled) setReady(true);
    })();
    return () => { cancelled = true; };
  }, []);

  if (!ready) {
    return (
      <div
        style={{
          height: '100%',
          display: 'grid',
          placeItems: 'center',
          color: 'var(--color-text-muted)',
        }}
      >
        Loading editor…
      </div>
    );
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
