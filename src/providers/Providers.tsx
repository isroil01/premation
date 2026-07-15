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
import { useProjectStore } from '@stores/projectStore';
import { useUIStore } from '@stores/uiStore';
import { bumpScene } from '@stores/sceneStore';
import { openModal } from '@stores/modalStore';
import { useHistoryStore } from '@stores/historyStore';
import { Button } from '@components/Button';
import { TooltipProvider } from '@components/Tooltip';
import { getAutosaveController } from '@core/persistence/AutosaveController';
import { readRecovery, clearRecovery, restoreRecovery } from '@core/persistence/recovery';
import renderCache from '@core/rendering/renderCache';
import pluginHost from '@core/plugins/PluginHost';
import { openPluginsModal } from '@layout/Plugins/PluginsModal';
import { openExportDialog } from '@layout/Export/ExportDialog';
import { usePresentationStore } from '@stores/presentationStore';
import { useGuidesStore } from '@stores/guidesStore';
import { getCommandRegistry, BuiltinCommands, type Command } from '@core/commands/Command';
import { getCommandSystem } from '@core/commands/CommandSystem';
import { getShortcutManager } from '@core/commands/ShortcutManager';
import { getEventBus } from '@core/events/EventBus';
import { getThemeManager, getProjectManager, getLoadingManager, getSettingsManager } from '@core/services/coreServices';
import { OnboardingOverlay } from '@layout/Onboarding/OnboardingOverlay';
import { useOnboardingStore } from '@stores/onboardingStore';
import { sceneProjectIO } from '@core/scene/sceneProjectIO';
import { asThemeId, asCommandId } from '@app-types/common';
import { hydrateComposition } from '@stores/compositionStore';
import { useAssetStore } from '@stores/assetStore';
import { openCustomizeDialog } from '@layout/Settings/CustomizeDialog';
import { registerDefaultEditors } from '@components/Inspector/DefaultEditors';
import { seedDefaultScene } from '@core/scene/seedDefaultScene';
import { seedDemoAnimation } from '@core/animation/seedDemoAnimation';
import { defaultAnimation } from '@motion/animation';
import defaultSceneGraph from '@core/scene/DefaultSceneGraph';
import { audioEngine } from '@core/audio/AudioEngine';
import { AudioPlaybackBridge } from '@core/audio/useAudioPlayback';
import { controlValue } from '@core/animation/expressionControls';
import { ProjectCommands } from '@layout/Menu';
import { ModalHost, ContextMenuHost, NotificationHost } from '@layout/overlays';
import { CommandPalette } from '@layout/CommandPalette';
import { PresentationMode } from '@layout/Presentation/PresentationMode';
import { openPalette } from '@stores/commandPaletteStore';
import { insertCamera, insertLight, insertAdjustmentLayer, precomposeSelected, insertPrimitive, insertSolid, deleteSelectedLayers, duplicateSelectedLayers } from '@core/scene/sceneInsert';
import { insertNull } from '@core/scene/parenting';
import { addEffect } from '@core/effects/effects';
import { openNewCompositionDialog } from '@layout/Composition/NewCompositionDialog';
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
  const tools: Array<{ tool: import('@stores/uiStore').Tool; label: string; key: string }> = [
    { tool: 'select', label: 'Select Tool', key: 'v' },
    { tool: 'direct-select', label: 'Direct Selection Tool', key: 'a' },
    { tool: 'hand', label: 'Hand Tool', key: 'h' },
    { tool: 'zoom', label: 'Zoom Tool', key: 'z' },
    { tool: 'move', label: 'Move Tool', key: 'w' },
    { tool: 'rotate', label: 'Rotate Tool', key: 'r' },
    { tool: 'pen', label: 'Pen Tool', key: 'p' },
    { tool: 'text', label: 'Text Tool', key: 't' },
    { tool: 'shape', label: 'Rectangle Tool', key: 'u' },
    { tool: 'ellipse', label: 'Ellipse Tool', key: 'e' },
  ];
  return tools.map(({ tool, label, key }) => ({
    id: asCommandId(`tool.${tool}`),
    label,
    icon: 'crosshair' as const,
    shortcut: { key },
    enabled: () => true,
    execute: () => useUIStore.getState().setActiveTool(tool),
  }));
}

function buildBuiltinCommands(): ReadonlyArray<Command> {
  return [
    {
      // The palette owns the Cmd/Ctrl+K key itself (so it fires even while a
      // field is focused); this command is for menus/discoverability. No
      // shortcut here on purpose — binding it would double-fire with the
      // palette's own listener.
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
  ];
}

function buildProjectCommands(): ReadonlyArray<Command> {
  return [
    {
      id: asCommandId('comp.new'),
      label: 'New Composition…',
      shortcut: { key: 'n', meta: true, ctrl: true },
      enabled: () => true,
      execute: () => {
        openNewCompositionDialog();
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
        registry.register({
          id: asCommandId(BuiltinCommands.Undo),
          label: 'Undo',
          shortcut: { key: 'z', meta: true },
          enabled: () => getCommandSystem().getHistory().canUndo(),
          execute: () => {
            if (getCommandSystem().getHistory().canUndo()) {
              getCommandSystem().getHistory().undo();
            }
          },
        });
        registry.register({
          id: asCommandId(BuiltinCommands.Redo),
          label: 'Redo',
          shortcut: { key: 'z', meta: true, shift: true },
          enabled: () => getCommandSystem().getHistory().canRedo(),
          execute: () => {
            if (getCommandSystem().getHistory().canRedo()) {
              getCommandSystem().getHistory().redo();
            }
          },
        });

        for (const cmd of buildProjectCommands()) registry.register(cmd);

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
        project.setDocumentIO(sceneProjectIO);
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
        // Keyframe edits refresh the timeline tracks + inspector + viewport,
        // and invalidate the render cache (cached frames are now stale).
        getEventBus().on('AnimationChanged', () => { renderCache.invalidate(); bumpScene(); });

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
            id: asCommandId('view.presentation'), label: 'Present (Preview)', icon: 'eye',
            enabled: () => true, execute: () => usePresentationStore.getState().enter(),
          });
          registry.register({
            id: asCommandId('view.plugins'), label: 'Plugins…', icon: 'settings',
            enabled: () => true, execute: () => openPluginsModal(),
          });
          registry.register({
            id: asCommandId('help.tour'), label: 'Take a Tour', icon: 'sparkles',
            enabled: () => true, execute: () => useOnboardingStore.getState().start(),
          });
          registry.register({
            id: asCommandId('view.safeAreas'), label: 'Toggle Safe Areas', icon: 'crosshair',
            enabled: () => true, execute: () => useGuidesStore.getState().toggleSafeArea(),
          });
          registry.register({
            id: asCommandId('view.grid'), label: 'Toggle Grid', icon: 'layout',
            enabled: () => true, execute: () => useGuidesStore.getState().toggleGrid(),
          });
          registry.register({
            id: asCommandId('view.rulers'), label: 'Toggle Rulers', icon: 'layout',
            enabled: () => true, execute: () => useGuidesStore.getState().toggleRulers(),
          });
          registry.register({
            id: asCommandId('view.renderQueue'), label: 'Render Queue', icon: 'layers',
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
            id: asCommandId('view.effectControls'), label: 'Effect Controls', icon: 'keyframe',
            shortcut: { key: 'F3' },
            enabled: () => true,
            execute: () => {
              const ls = useLayoutStore.getState();
              if (!ls.panels['effectControls']) ls.openPanel('effectControls');
              else ls.togglePanel('effectControls');
            },
          });
          registry.register({
            id: asCommandId('view.graphEditor'), label: 'Graph Editor', icon: 'track',
            shortcut: { key: 'g', shift: true },
            enabled: () => true,
            execute: () => useLayoutStore.getState().toggleRegion('bottomTimeline'),
          });
          registry.register({
            id: asCommandId('view.customize'), label: 'Customize…', icon: 'settings',
            enabled: () => true, execute: () => openCustomizeDialog(),
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
          let recordTimer: ReturnType<typeof setTimeout> | undefined;
          const scheduleRecord = (): void => {
            if (useHistoryStore.getState().restoring) return;
            clearTimeout(recordTimer);
            recordTimer = setTimeout(() => {
              if (useHistoryStore.getState().restoring) return;
              useHistoryStore.getState().record();
            }, 700);
          };
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

  return (
    <TooltipProvider>
      {children}
      <AudioPlaybackBridge />
      <CommandPalette />
      <PresentationMode />
      <OnboardingOverlay onDone={() => getSettingsManager().set('onboarding.seen', true)} />
      <ModalHost />
      <ContextMenuHost />
      <NotificationHost />
    </TooltipProvider>
  );
}
