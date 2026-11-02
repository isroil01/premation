/**
 * windowSync — makes a popped-out panel a LIVE VIEW of the main editor.
 *
 * The DOCUMENT is never sent between windows: the C++ engine owns it and every
 * window is a mirror of that engine (main relays its events to each window;
 * edits are engine requests).
 *
 * What travels here is EDITOR state, which the engine does not hold:
 *
 *   main  ──selection/time──▶  popout
 *   main  ◀──selection/time──  popout
 *
 * Echo control: `syncChannel` drops messages from the sender's own window id, and
 * `applying` suppresses the re-publish that applying a remote change would
 * otherwise trigger through the stores.
 */

import { syncChannel } from './syncChannel';
import { useSelectionStore } from '@stores/selectionStore';
import { useProjectStore } from '@stores/projectStore';
import { usePlaybackClockStore, setTime as setClockTime } from '@stores/playbackClockStore';

/** This window renders a detached panel, not the editor shell. */
export function isPopoutWindow(): boolean {
  return typeof window !== 'undefined' && window.location.hash.startsWith('#/popout/');
}

const MSG_SELECTION = 'selection-update';
const MSG_TIME = 'time-update';
const MSG_ACTIVE_COMP = 'active-comp-update';
const MSG_PLAYING = 'playing-update';
/** A window that just opened asks the others where things stand. */
const MSG_HELLO = 'sync-hello';

/**
 * The playhead moves 60×/s; a detached view does not need every tick, but a
 * popped-out timeline's playhead at 16 Hz read as stutter. 30 Hz.
 */
const TIME_THROTTLE_MS = 33;

interface TimePayload {
  time: number;
  frame: number;
}

/** Which composition the editor is on — a pop-out's tabs are its own and start on a placeholder. */
interface ActiveCompPayload {
  compositionId: string;
  breadcrumbPath: string[];
  breadcrumbVia: string[];
  title: string;
}

function activeCompPayload(): ActiveCompPayload | null {
  const s = useProjectStore.getState();
  const tab = s.activeTabId ? s.tabs[s.activeTabId] : undefined;
  if (!tab?.compositionId) return null;
  return {
    compositionId: tab.compositionId,
    breadcrumbPath: [...tab.breadcrumbPath],
    breadcrumbVia: [...(tab.breadcrumbVia ?? [])],
    title: tab.title,
  };
}

function activeCompKey(p: ActiveCompPayload | null): string {
  return p ? `${p.compositionId}|${p.breadcrumbPath.join('/')}` : '';
}

function activePlaying(): boolean {
  const s = useProjectStore.getState();
  return s.activeTabId ? s.tabs[s.activeTabId]?.playing === true : false;
}

/**
 * Start syncing this window with the others. Returns a teardown function.
 * Safe to call in any window; both roles publish and both apply.
 */
export function startWindowSync(): () => void {
  if (typeof window === 'undefined') return () => undefined;

  /** True while we are writing a remote change into local state. */
  let applying = false;

  const unsubSelection = useSelectionStore.subscribe((state, prev) => {
    if (applying || state.ids === prev.ids) return;
    syncChannel.publish<readonly string[]>(MSG_SELECTION, [...state.ids]);
  });

  // The LIVE clock, not the project store: the tab record there is only a
  // ≤4Hz mirror during playback (see playbackClockStore).
  let lastTimeSent = 0;
  const unsubTime = usePlaybackClockStore.subscribe((state, prev) => {
    if (applying) return;
    const id = useProjectStore.getState().activeTabId;
    if (!id) return;
    const now = state.clocks[id];
    const before = prev.clocks[id];
    if (!now || now.time === before?.time) return;
    const stamp = performance.now();
    if (stamp - lastTimeSent < TIME_THROTTLE_MS) return;
    lastTimeSent = stamp;
    syncChannel.publish<TimePayload>(MSG_TIME, { time: now.time, frame: now.frame });
  });

  const offSelection = syncChannel.subscribe<readonly string[]>(MSG_SELECTION, (ids) => {
    if (!Array.isArray(ids)) return;
    applying = true;
    try {
      useSelectionStore.getState().set(ids as string[]);
    } finally {
      window.setTimeout(() => { applying = false; }, 0);
    }
  });

  const offTime = syncChannel.subscribe<TimePayload>(MSG_TIME, (p) => {
    if (!p || typeof p.time !== 'number') return;
    applying = true;
    try {
      const id = useProjectStore.getState().activeTabId;
      if (id) setClockTime(id, p.time, p.frame);
    } finally {
      window.setTimeout(() => { applying = false; }, 0);
    }
  });

  // The active composition and its play flag. Only the editor window has an
  // engine transport (engineTransport follows ITS active tab), so a pop-out's
  // Play reaches the engine by flipping the editor's flag, and the editor's
  // flag is what the pop-out's Play button shows.
  let lastComp = activeCompKey(activeCompPayload());
  let lastPlaying = activePlaying();
  const unsubProject = useProjectStore.subscribe(() => {
    const comp = activeCompPayload();
    const compKey = activeCompKey(comp);
    const playing = activePlaying();
    if (compKey !== lastComp) {
      lastComp = compKey;
      if (!applying && comp) syncChannel.publish<ActiveCompPayload>(MSG_ACTIVE_COMP, comp);
    }
    if (playing !== lastPlaying) {
      lastPlaying = playing;
      if (!applying) syncChannel.publish<boolean>(MSG_PLAYING, playing);
    }
  });

  const applyRemote = (fn: () => void): void => {
    applying = true;
    try {
      fn();
    } finally {
      window.setTimeout(() => { applying = false; }, 0);
    }
  };

  const offActiveComp = syncChannel.subscribe<ActiveCompPayload>(MSG_ACTIVE_COMP, (p) => {
    if (!p || typeof p.compositionId !== 'string' || !Array.isArray(p.breadcrumbPath)) return;
    if (activeCompKey(activeCompPayload()) === activeCompKey(p)) return;
    applyRemote(() => {
      const actions = useProjectStore.getState().actions;
      const tabId = actions.openTab(p.compositionId, p.breadcrumbPath, p.title);
      actions.setBreadcrumb(tabId, p.breadcrumbPath, Array.isArray(p.breadcrumbVia) ? p.breadcrumbVia : []);
    });
  });

  const offPlaying = syncChannel.subscribe<boolean>(MSG_PLAYING, (playing) => {
    if (typeof playing !== 'boolean' || playing === activePlaying()) return;
    applyRemote(() => useProjectStore.getState().actions.setPlaying(playing));
  });

  // A pop-out opens knowing nothing: selection and time only travel when they
  // CHANGE, so a Properties pop-out opened on a selected layer said "Select a
  // layer". It asks; the editor window (the one that holds the truth) answers.
  const offHello = syncChannel.subscribe<null>(MSG_HELLO, () => {
    if (isPopoutWindow()) return;
    // The composition first: the time and play flag below land on its tab.
    const comp = activeCompPayload();
    if (comp) syncChannel.publish<ActiveCompPayload>(MSG_ACTIVE_COMP, comp);
    syncChannel.publish<readonly string[]>(MSG_SELECTION, [...useSelectionStore.getState().ids]);
    const id = useProjectStore.getState().activeTabId;
    const clock = id ? usePlaybackClockStore.getState().clocks[id] : undefined;
    if (clock) syncChannel.publish<TimePayload>(MSG_TIME, { time: clock.time, frame: clock.frame });
    syncChannel.publish<boolean>(MSG_PLAYING, activePlaying());
  });
  if (isPopoutWindow()) syncChannel.publish<null>(MSG_HELLO, null);

  return () => {
    unsubSelection();
    unsubTime();
    unsubProject();
    offSelection();
    offTime();
    offActiveComp();
    offPlaying();
    offHello();
  };
}
