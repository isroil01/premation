/**
 * The viewport's commands — everything the comp viewer does that deserves a
 * key, a palette entry or a menu row: JKL shuttle and in/out marks (the
 * shared transport controller), snapshot compare, camera bookmarks, guide
 * lock / clear / show, display modes, the HUD, snap-to-pixel, PAR
 * correction, the viewer LUT, the Roto Brush tool and the inline AI prompt.
 *
 * Registered from `Workspace.tsx` (mounted once per editor), the same pattern
 * as `previewCacheCommands`. Menu rows are NOT added here — `menuModel.ts` is
 * not this directory's to edit — the rows wanted are listed at the bottom.
 *
 * ## J, K and L are one rule
 *
 * All three take the same gate: the viewport or its transport bar has focus,
 * OR nothing has focus, OR a shuttle is already running.
 *
 * K used to take a STRICTER one, because it was also the Knife tool's key and
 * "nothing has focus" is the app's resting state. The cost was the transport:
 * hold-K-and-tap-J/L, the frame step editors reach for without thinking, did
 * nothing from rest. The Knife now lives on Shift+K (`tool.knife` in
 * `Providers.tsx`) and K belongs to the transport alone.
 *
 * With the TIMELINE focused none of this applies: the timeline root claims
 * `j` and `k` (`data-shortcut-claim`), where they are AE's previous / next
 * keyframe — see `useTimelineKeys`.
 *
 * `F6` used to be shared the same way (Show Snapshot once a snapshot existed,
 * the Render Queue otherwise). It no longer is: Show Snapshot is `Shift+F5`.
 */

import { asCommandId } from '@app-types/common';
import { getCommandRegistry, type Command } from '@core/commands/Command';
import { getShortcutManager } from '@core/commands/ShortcutManager';
import { aiEnabled } from '@core/config/edition';
import { getWorkspaceController } from '@core/workspace/WorkspaceController';
import {
  getCompositionShuttle,
  markIn,
  markOut,
  goToIn,
  goToOut,
  clearInOut,
  hasInOut,
  installAudioScrub,
  isAudioScrubEnabled,
  setAudioScrubEnabled,
} from '@core/timeline/transportController';
import {
  BOOKMARK_SLOTS,
  bookmarkAt,
  recallCameraBookmark,
  saveCameraBookmark,
} from '@core/workspace/cameraBookmarks';
import { useCompareStore, canCompare, COMPARE_MODE_LABEL, type CompareMode } from '@stores/compareStore';
import { usePreviewBehaviorStore } from '@stores/previewBehaviorStore';
import { getTimelineController } from '@core/timeline/TimelineController';
import { useGuidesStore } from '@stores/guidesStore';
import { useSelectionStore } from '@stores/selectionStore';
import { useUIStore } from '@stores/uiStore';
import { useViewportDisplayStore, DISPLAY_MODE_LABEL, type DisplayMode } from '@stores/viewportDisplayStore';
import { useViewerLutStore } from '@stores/viewerLutStore';
import { openViewerLutPicker } from './viewerLutPicker';
import { openInlineAiPrompt } from './inlineAiPromptStore';

export const VIEWPORT_COMMAND_IDS = {
  shuttleReverse: 'transport.shuttleReverse',
  shuttleStop: 'transport.shuttleStop',
  shuttleForward: 'transport.shuttleForward',
  markIn: 'transport.markIn',
  markOut: 'transport.markOut',
  goToIn: 'transport.goToIn',
  goToOut: 'transport.goToOut',
  clearInOut: 'transport.clearInOut',
  audioScrub: 'transport.audioScrub',
  previewAudioOnly: 'transport.previewAudioOnly',
  previewAudioOnlyWorkArea: 'transport.previewAudioOnlyWorkArea',
  includeVideo: 'transport.includeVideo',
  includeAudio: 'transport.includeAudio',
  snapshot: 'view.snapshot',
  compareToggle: 'view.compareToggle',
  compareFlip: 'view.compareFlip',
  compareClear: 'view.compareClear',
  compareMode: (m: CompareMode) => `view.compareMode.${m}`,
  bookmarkRecall: (n: number) => `view.cameraBookmark.recall${n}`,
  bookmarkSave: (n: number) => `view.cameraBookmark.save${n}`,
  guidesLock: 'view.guides.lockAll',
  guidesUnlock: 'view.guides.unlockAll',
  guidesClear: 'view.guides.clear',
  guidesShow: 'view.guides.show',
  displayMode: (m: DisplayMode) => `view.displayMode.${m}`,
  displayModeCycle: 'view.displayMode.cycle',
  hud: 'view.hud',
  snapToPixel: 'view.snapToPixel',
  pixelAspectCorrection: 'view.pixelAspectCorrection',
  viewerLutLoad: 'view.viewerLut.load',
  viewerLutClear: 'view.viewerLut.clear',
  rotoTool: 'tool.roto',
  inlineAiPrompt: 'ai.inlinePrompt',
} as const;

/**
 * Whether the comp transport may take J/K/L right now — see the header.
 * Exported for the test; reads the DOM, so a headless caller gets `true`
 * whenever a shuttle is running and otherwise "nothing has focus".
 */
export function transportChordsActive(): boolean {
  if (getCompositionShuttle().rate() !== 0) return true;
  if (typeof document === 'undefined') return true;
  const el = document.activeElement;
  if (!el || el === document.body) return true;
  return viewportHasFocus(el);
}


/**
 * Start an audio-only preview, and put the picture back when it ends.
 *
 * The restore is the fiddly half. `includeVideo: false` is a transient mode,
 * not a preference — leaving it set after the transport stops would freeze the
 * viewport with no visible cause, which is the single worst way this feature
 * could fail. So the flag is cleared on the first tick where the transport is
 * no longer playing, however it stopped: the user hit space, the playhead ran
 * off the end, or another command paused it. Polling rather than subscribing
 * because the controller exposes no play-state event; the poll lives only for
 * the duration of the preview and stops itself.
 */
function playAudioOnly(workAreaOnly: boolean): void {
  const c = getTimelineController();
  const behavior = usePreviewBehaviorStore.getState().actions;

  if (workAreaOnly) {
    const wa = c.getWorkArea();
    if (wa) c.seekSeconds(wa.start);
  }

  behavior.setAudioOnly();
  c.play();

  const restore = (): void => {
    behavior.reset();
    getWorkspaceController().requestRender();
  };

  // Belt and braces: if the transport never actually started (no comp, zero
  // duration), do not leave the viewport dark waiting for a stop that will
  // never come.
  if (!c.isPlaying) {
    restore();
    return;
  }

  const POLL_MS = 120;
  const timer = setInterval(() => {
    if (c.isPlaying) return;
    clearInterval(timer);
    restore();
  }, POLL_MS);
}

function viewportHasFocus(el: Element): boolean {
  return !!el.closest('[data-workspace-viewport], [data-transport-bar]');
}

export function buildViewportCommands(): ReadonlyArray<Command> {
  const cmds: Command[] = [
    // ── Transport ────────────────────────────────────────────────────
    {
      id: asCommandId(VIEWPORT_COMMAND_IDS.shuttleReverse),
      label: 'Shuttle Reverse',
      description: 'J — reverse; again for 2× and 4×. With K held, step one frame back.',
      icon: 'skip-back',
      shortcut: { key: 'j' },
      enabled: transportChordsActive,
      execute: () => getCompositionShuttle().keyDown('j'),
    },
    {
      id: asCommandId(VIEWPORT_COMMAND_IDS.shuttleStop),
      label: 'Shuttle Stop',
      description: 'K — stop the shuttle. Hold with J / L to step frames.',
      icon: 'pause',
      shortcut: { key: 'k' },
      enabled: transportChordsActive,
      execute: () => getCompositionShuttle().keyDown('k'),
    },
    {
      id: asCommandId(VIEWPORT_COMMAND_IDS.shuttleForward),
      label: 'Shuttle Forward',
      description: 'L — forward; again for 2× and 4×. With K held, step one frame forward.',
      icon: 'skip-forward',
      shortcut: { key: 'l' },
      enabled: transportChordsActive,
      execute: () => getCompositionShuttle().keyDown('l'),
    },
    {
      id: asCommandId(VIEWPORT_COMMAND_IDS.markIn),
      label: 'Mark In at Playhead',
      icon: 'trim-in',
      shortcut: { key: 'i' },
      enabled: () => true,
      execute: () => markIn(),
    },
    {
      id: asCommandId(VIEWPORT_COMMAND_IDS.markOut),
      label: 'Mark Out at Playhead',
      icon: 'trim-out',
      shortcut: { key: 'o' },
      enabled: () => true,
      execute: () => markOut(),
    },
    {
      id: asCommandId(VIEWPORT_COMMAND_IDS.goToIn),
      label: 'Go to In Point',
      icon: 'skip-back',
      shortcut: { key: 'i', shift: true },
      enabled: hasInOut,
      execute: () => { goToIn(); },
    },
    {
      id: asCommandId(VIEWPORT_COMMAND_IDS.goToOut),
      label: 'Go to Out Point',
      icon: 'skip-forward',
      shortcut: { key: 'o', shift: true },
      enabled: hasInOut,
      execute: () => { goToOut(); },
    },
    {
      id: asCommandId(VIEWPORT_COMMAND_IDS.clearInOut),
      label: 'Clear In and Out',
      enabled: hasInOut,
      execute: () => clearInOut(),
    },
    /**
     * AE's Numpad `.` and Alt+Numpad `.` — preview ONLY the audio.
     *
     * The picture is switched off for the duration (see
     * `previewBehaviorStore`), which is what makes this useful: nothing is
     * rendered, so nothing can fall behind, and a long comp auditions at true
     * speed even when a frame takes half a second to draw. Stopping restores
     * the picture, so the flag can never be left on by accident — the state
     * that would look like a broken viewport.
     */
    {
      id: asCommandId(VIEWPORT_COMMAND_IDS.previewAudioOnly),
      label: 'Preview Only Audio',
      description: 'Play the sound from the playhead in real time, without drawing the picture.',
      icon: 'audio',
      shortcut: { key: 'Numpad.' },
      enabled: () => true,
      execute: () => playAudioOnly(false),
    },
    {
      id: asCommandId(VIEWPORT_COMMAND_IDS.previewAudioOnlyWorkArea),
      label: 'Preview Only Audio in Work Area',
      description: 'Play the work area’s sound in real time, without drawing the picture.',
      icon: 'audio',
      shortcut: { key: 'Numpad.', alt: true },
      enabled: () => true,
      execute: () => playAudioOnly(true),
    },
    {
      id: asCommandId(VIEWPORT_COMMAND_IDS.includeVideo),
      label: 'Include Video in Preview',
      description: 'Draw the picture while previewing. Off is an audio-only preview.',
      enabled: () => true,
      isChecked: () => usePreviewBehaviorStore.getState().includeVideo,
      execute: () => {
        const a = usePreviewBehaviorStore.getState();
        a.actions.setIncludeVideo(!a.includeVideo);
      },
    },
    {
      id: asCommandId(VIEWPORT_COMMAND_IDS.includeAudio),
      label: 'Include Audio in Preview',
      description: 'Play the composition’s sound while previewing.',
      enabled: () => true,
      isChecked: () => usePreviewBehaviorStore.getState().includeAudio,
      execute: () => {
        const a = usePreviewBehaviorStore.getState();
        a.actions.setIncludeAudio(!a.includeAudio);
      },
    },
    {
      id: asCommandId(VIEWPORT_COMMAND_IDS.audioScrub),
      label: 'Audio Scrub While Dragging',
      description: 'Sound a short slice of the audio under the playhead as it is dragged.',
      enabled: () => true,
      isChecked: isAudioScrubEnabled,
      execute: () => setAudioScrubEnabled(!isAudioScrubEnabled()),
    },
    // ── Snapshot compare ─────────────────────────────────────────────
    {
      id: asCommandId(VIEWPORT_COMMAND_IDS.snapshot),
      label: 'Take Snapshot',
      description: 'Freeze the frame on screen for A/B, wipe or difference comparison.',
      icon: 'camera',
      shortcut: { key: 'F5' },
      enabled: () => true,
      execute: () => {
        useCompareStore.getState().requestCapture();
        getWorkspaceController().requestRender();
      },
    },
    {
      id: asCommandId(VIEWPORT_COMMAND_IDS.compareToggle),
      label: 'Show Snapshot',
      description: 'Show or hide the comparison with the last snapshot.',
      icon: 'eye',
      // Shift+F5, beside Take Snapshot's F5 — NOT F6. F6 is the Render Queue,
      // and the queue says so in three tooltips and a toast. Sharing it on an
      // `enabled()` gate meant the same key opened a panel until the first
      // snapshot was taken and toggled an overlay ever after, with nothing on
      // screen to say which one you were about to get.
      shortcut: { key: 'F5', shift: true },
      enabled: canCompare,
      isChecked: () => useCompareStore.getState().visible,
      execute: () => useCompareStore.getState().toggleVisible(),
    },
    {
      id: asCommandId(VIEWPORT_COMMAND_IDS.compareFlip),
      label: 'Flip A/B',
      enabled: () => canCompare() && useCompareStore.getState().visible,
      execute: () => useCompareStore.getState().flip(),
    },
    {
      id: asCommandId(VIEWPORT_COMMAND_IDS.compareClear),
      label: 'Clear Snapshots',
      enabled: canCompare,
      execute: () => useCompareStore.getState().clear(),
    },
    ...(Object.keys(COMPARE_MODE_LABEL) as CompareMode[]).map<Command>((m) => ({
      id: asCommandId(VIEWPORT_COMMAND_IDS.compareMode(m)),
      label: `Compare: ${COMPARE_MODE_LABEL[m]}`,
      enabled: () => true,
      isChecked: () => useCompareStore.getState().mode === m,
      execute: () => useCompareStore.getState().setMode(m),
    })),
    // ── Camera bookmarks ─────────────────────────────────────────────
    ...BOOKMARK_SLOTS.map<Command>((n) => ({
      id: asCommandId(VIEWPORT_COMMAND_IDS.bookmarkRecall(n)),
      label: `Recall Camera Bookmark ${n}`,
      icon: 'camera',
      shortcut: { key: String(n), meta: true, alt: true },
      enabled: () => bookmarkAt(n) !== null,
      execute: () => { recallCameraBookmark(n); },
    })),
    ...BOOKMARK_SLOTS.map<Command>((n) => ({
      id: asCommandId(VIEWPORT_COMMAND_IDS.bookmarkSave(n)),
      label: `Save Camera Bookmark ${n}`,
      icon: 'camera',
      shortcut: { key: String(n), meta: true, alt: true, shift: true },
      enabled: () => true,
      execute: () => {
        const b = saveCameraBookmark(n);
        useUIStore.getState().notify({ level: 'success', message: `Saved “${b.name}” (Ctrl+Alt+${n} recalls it)`, durationMs: 2400 });
      },
    })),
    // ── Guides ───────────────────────────────────────────────────────
    {
      id: asCommandId(VIEWPORT_COMMAND_IDS.guidesLock),
      label: 'Lock Guides',
      enabled: () => getWorkspaceController().ws.guides.list().some((g) => g.kind === 'user' && !g.locked),
      execute: () => setAllGuidesLocked(true),
    },
    {
      id: asCommandId(VIEWPORT_COMMAND_IDS.guidesUnlock),
      label: 'Unlock Guides',
      enabled: () => getWorkspaceController().ws.guides.list().some((g) => g.kind === 'user' && g.locked),
      execute: () => setAllGuidesLocked(false),
    },
    {
      id: asCommandId(VIEWPORT_COMMAND_IDS.guidesClear),
      label: 'Clear Guides',
      description: 'Remove every unlocked guide.',
      enabled: () => getWorkspaceController().ws.guides.list().some((g) => g.kind === 'user'),
      execute: () => {
        getWorkspaceController().ws.guides.clear(false);
        getWorkspaceController().requestRender();
      },
    },
    {
      id: asCommandId(VIEWPORT_COMMAND_IDS.guidesShow),
      label: 'Show Guides',
      shortcut: { key: ';', meta: true },
      enabled: () => true,
      isChecked: () => useGuidesStore.getState().guidesVisible,
      execute: () => {
        useGuidesStore.getState().toggleGuidesVisible();
        getWorkspaceController().requestRender();
      },
    },
    // ── Display modes ────────────────────────────────────────────────
    ...(Object.keys(DISPLAY_MODE_LABEL) as DisplayMode[]).map<Command>((m) => ({
      id: asCommandId(VIEWPORT_COMMAND_IDS.displayMode(m)),
      label: `Display: ${DISPLAY_MODE_LABEL[m]}`,
      enabled: () => true,
      isChecked: () => useViewportDisplayStore.getState().displayMode === m,
      execute: () => useViewportDisplayStore.getState().setDisplayMode(m),
    })),
    {
      id: asCommandId(VIEWPORT_COMMAND_IDS.displayModeCycle),
      label: 'Cycle Display Mode',
      description: 'Shaded → Wireframe → Bounding box.',
      shortcut: { key: 'F4', shift: true },
      enabled: () => true,
      execute: () => useViewportDisplayStore.getState().cycleDisplayMode(),
    },
    // ── HUD / snap / PAR ─────────────────────────────────────────────
    {
      id: asCommandId(VIEWPORT_COMMAND_IDS.hud),
      label: 'Viewport HUD',
      description: 'fps, frame time, cache hits, resolution and backend in the viewport corner.',
      shortcut: { key: 'h', meta: true, alt: true },
      enabled: () => true,
      isChecked: () => useViewportDisplayStore.getState().hud,
      execute: () => useViewportDisplayStore.getState().toggleHud(),
    },
    {
      id: asCommandId(VIEWPORT_COMMAND_IDS.snapToPixel),
      label: 'Snap to Pixel',
      description: 'Round positions and sizes to whole pixels while dragging or nudging.',
      shortcut: { key: 'p', meta: true, alt: true, shift: true },
      enabled: () => true,
      isChecked: () => useViewportDisplayStore.getState().snapToPixel,
      execute: () => useViewportDisplayStore.getState().toggleSnapToPixel(),
    },
    {
      id: asCommandId(VIEWPORT_COMMAND_IDS.pixelAspectCorrection),
      label: 'Pixel Aspect Ratio Correction',
      description: 'Stretch the preview by the composition’s pixel aspect so non-square pixels look right.',
      enabled: () => true,
      isChecked: () => useViewportDisplayStore.getState().pixelAspectCorrection,
      execute: () => useViewportDisplayStore.getState().togglePixelAspectCorrection(),
    },
    // ── Viewer LUT ───────────────────────────────────────────────────
    {
      id: asCommandId(VIEWPORT_COMMAND_IDS.viewerLutLoad),
      label: 'Load Viewer LUT…',
      description: 'A .cube monitor look for the viewport only — never in output.',
      enabled: () => true,
      execute: () => { openViewerLutPicker(); },
    },
    {
      id: asCommandId(VIEWPORT_COMMAND_IDS.viewerLutClear),
      label: 'Clear Viewer LUT',
      enabled: () => useViewerLutStore.getState().lut !== null,
      execute: () => useViewerLutStore.getState().clear(),
    },
    // ── Tools ────────────────────────────────────────────────────────
    {
      id: asCommandId(VIEWPORT_COMMAND_IDS.rotoTool),
      label: 'Roto Brush Tool',
      description: 'Paint over the subject to cut a matte; Alt-paint marks background.',
      icon: 'brush',
      shortcut: { key: 'w', alt: true },
      enabled: () => true,
      execute: () => useUIStore.getState().setActiveTool('roto'),
    },
    // ── AI ───────────────────────────────────────────────────────────
    {
      id: asCommandId(VIEWPORT_COMMAND_IDS.inlineAiPrompt),
      label: 'Ask AI About Selection…',
      description: 'An inline prompt anchored to the selected layers.',
      icon: 'sparkles',
      shortcut: { key: 'Enter', meta: true },
      enabled: () => aiEnabled() && useSelectionStore.getState().ids.length > 0,
      execute: () => openInlineAiPrompt(),
    },
  ];
  return cmds;
}

function setAllGuidesLocked(locked: boolean): void {
  const ws = getWorkspaceController().ws;
  for (const g of ws.guides.list()) if (g.kind === 'user') ws.guides.setLocked(g.id, locked);
  getWorkspaceController().requestRender();
}

let installed = false;
let teardown: (() => void) | null = null;

/**
 * Register the commands, re-scan the shortcut bindings, and start the two
 * listeners the shuttle needs beyond the command system: K key-UP (the
 * dispatcher only sees key-down, and "K held" must end when the key lifts)
 * and audio scrub on playhead drags. Idempotent.
 */
export function installViewportCommands(): void {
  if (installed) return;
  installed = true;
  const registry = getCommandRegistry();
  for (const c of buildViewportCommands()) registry.register(c);
  getShortcutManager().rehydrateFromRegistry();

  if (typeof window !== 'undefined') {
    const onKeyUp = (e: KeyboardEvent): void => {
      if (e.key === 'k' || e.key === 'K') getCompositionShuttle().keyUp('k');
    };
    window.addEventListener('keyup', onKeyUp, { capture: true });
    const offScrub = installAudioScrub();
    teardown = () => {
      window.removeEventListener('keyup', onKeyUp, { capture: true } as EventListenerOptions);
      offScrub();
    };
  }
}

/** Test seam. */
export function resetViewportCommandsForTest(): void {
  teardown?.();
  teardown = null;
  installed = false;
}

/*
 * Menu rows wanted in `menuModel.ts` (not this directory's file):
 *
 *   View ▸ Guides:          view.guides.show (checkbox) · view.guides.lockAll ·
 *                           view.guides.unlockAll · view.guides.clear
 *   View ▸ Display Mode:    view.displayMode.shaded / wireframe / bounds (radio)
 *   View ▸ Camera Bookmarks: view.cameraBookmark.recall1…9 · save1…9
 *   View:                   view.hud (checkbox) · view.snapToPixel (checkbox) ·
 *                           view.pixelAspectCorrection (checkbox)
 *   View ▸ Snapshot:        view.snapshot · view.compareToggle (checkbox) ·
 *                           view.compareFlip · view.compareMode.* (radio) · view.compareClear
 *   View ▸ Preview:         view.viewerLut.load · view.viewerLut.clear
 *   Composition ▸ Transport: transport.markIn · transport.markOut ·
 *                           transport.goToIn · transport.goToOut ·
 *                           transport.clearInOut · transport.audioScrub (checkbox)
 *   Tools:                  tool.roto
 *   AI:                     ai.inlinePrompt
 */
