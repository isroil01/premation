/**
 * D5 — transport through the C++ engine when it owns the document
 * (NATIVE_CORE_PLAN §5 D5, ENGINE_API.md §6: the engine owns the clock).
 *
 * The page keeps its playhead MODEL — the TimelineController and the transient
 * clock (playbackClockStore) every timeline widget already reads — but while
 * the engine owns the document the page no longer advances it
 * (usePlaybackClock stands down). Instead:
 *
 *   engine → page   `playhead` events move the controller (→ the clock store →
 *                   the timeline's playhead, the time readouts, the overlays);
 *                   `transportChanged` sets the active tab's `playing` flag.
 *   page → engine   a playhead move the ENGINE did not cause (a scrub, a click
 *                   on the ruler, a keyframe jump, Home/End, a step) is sent as
 *                   `seek` — coalesced, latest wins, one in flight; the tab's
 *                   `playing` flag flipped by the transport bar / Space becomes
 *                   `play{audio}` / `pause`; the active tab's composition is
 *                   `setActiveComposition`.
 *
 * So every existing transport entry point keeps working unchanged, and the
 * engine's clock (audio paced, E2) is what actually plays. Nothing here renders
 * or allocates per frame beyond the clock store's own write.
 *
 * No React (src/core).
 */

import { frameToFlicks, flicksToSeconds, type EngineClient, type EventBatch } from '@motion/engine-api';
import { useProjectStore } from '@stores/projectStore';
import { getClock, usePlaybackClockStore } from '@stores/playbackClockStore';
import { documentMirror } from '@stores/documentMirror';
import { previewIncludesAudio } from '@stores/previewBehaviorStore';
import { getTimelineController } from '@core/timeline/TimelineController';

export interface EngineTransportStats {
  seeksSent: number;
  seeksCoalesced: number;
  playheadEvents: number;
  plays: number;
  pauses: number;
  /** The comp the engine was last told to follow. */
  activeComp: string;
}

function activeTab(): { id: string; comp: string; playing: boolean } | null {
  const s = useProjectStore.getState();
  const id = s.activeTabId;
  const tab = id ? s.tabs[id] : undefined;
  if (!id || !tab) return null;
  return { id, comp: tab.compositionId ?? '', playing: tab.playing === true };
}

/**
 * Wire the page's transport to `client` (the owner). Returns the teardown.
 * `stats` (optional) is filled for the harness / HUD.
 */
export function installEngineTransport(client: () => EngineClient, stats?: EngineTransportStats): () => void {
  const st: EngineTransportStats = stats ?? { seeksSent: 0, seeksCoalesced: 0, playheadEvents: 0, plays: 0, pauses: 0, activeComp: '' };
  /** Set while the ENGINE is moving the page's playhead / play flag (no echo back). */
  let applying = false;
  let enginePlaying = false;
  let disposed = false;

  // ── comp ──
  let sentComp = '';
  const syncComp = (force = false): void => {
    const tab = activeTab();
    const comp = tab?.comp ?? '';
    if (!comp || (!force && comp === sentComp)) return;
    if (!documentMirror().comp(comp)) return;  // not in the engine's document (yet)
    sentComp = comp;
    st.activeComp = comp;
    void client().execute({ type: 'setActiveComposition', comp }).then((r) => {
      if (!r.ok && sentComp === comp) sentComp = '';  // retry on the next change
    });
    // The engine's playhead for this comp starts where the page's is.
    queueSeek();
  };

  // ── seek (coalesced: one in flight, latest wins) ──
  let seekInFlight = false;
  let seekPending = false;
  const currentFlicks = (): number | null => {
    const tab = activeTab();
    if (!tab?.comp) return null;
    const rate = documentMirror().comp(tab.comp)?.settings.frameRate;
    if (!rate || !(rate.num > 0)) return null;
    return frameToFlicks(Math.max(0, getClock(tab.id).frame), rate.num, rate.den || 1);
  };
  const sendSeek = (): void => {
    const t = currentFlicks();
    if (t === null) return;
    seekInFlight = true;
    st.seeksSent += 1;
    void client().execute({ type: 'seek', time: t, mode: enginePlaying ? 'exact' : 'scrub' }).finally(() => {
      seekInFlight = false;
      if (seekPending && !disposed) {
        seekPending = false;
        sendSeek();
      }
    });
  };
  function queueSeek(): void {
    if (disposed) return;
    if (seekInFlight) {
      if (seekPending) st.seeksCoalesced += 1;
      seekPending = true;
      return;
    }
    sendSeek();
  }

  // ── play / pause ──
  /** Set between a page-initiated pause and its position seek (see syncPlaying). */
  let holdUntilSeek = false;
  const syncPlaying = (playing: boolean): void => {
    if (playing === enginePlaying) return;
    enginePlaying = playing;
    if (playing) {
      st.plays += 1;
      const looping = safe(() => getTimelineController().isLooping(), true);
      const tab = activeTab();
      const workArea = tab ? documentMirror().comp(tab.comp)?.settings.workArea : undefined;
      void client().execute({ type: 'setLoop', mode: looping ? 'loop' : 'once' });
      void client().execute({
        type: 'play',
        rate: 1,
        range: workArea && workArea.duration > 0 ? 'workArea' : 'all',
        audio: previewIncludesAudio(),
        cacheFirst: false,
        ...(currentFlicks() !== null ? { from: currentFlicks()! } : {}),
      });
    } else {
      st.pauses += 1;
      // The engine's transport reports its last SEEK time once stopped (the
      // TypeScript Transport's `time`, kept for parity), not where playback
      // stopped. Pause holds the picture (AE), so the page's playhead — which
      // followed the engine's playhead events — is sent back as a seek, and
      // the stopped-state playhead events in between are not applied.
      holdUntilSeek = true;
      void client().execute({ type: 'pause', returnToStart: false });
      const t = currentFlicks();
      if (t !== null) {
        st.seeksSent += 1;
        void client().execute({ type: 'seek', time: t, mode: 'exact' }).finally(() => { holdUntilSeek = false; });
      } else {
        holdUntilSeek = false;
      }
    }
  };

  // ── engine → page ──
  const onBatch = (b: EventBatch): void => {
    for (const e of b.events) {
      if (e.type === 'playhead') {
        const tab = activeTab();
        if (!tab || e.comp !== tab.comp || holdUntilSeek) continue;
        st.playheadEvents += 1;
        applying = true;
        try {
          // The controller mirrors a frame-exact time into the clock store.
          getTimelineController().seekSeconds(flicksToSeconds(e.time));
        } catch {
          // no timeline for this comp in the page (yet)
        } finally {
          applying = false;
        }
      } else if (e.type === 'transportChanged') {
        const tab = activeTab();
        if (!tab || (e.comp && e.comp !== tab.comp)) continue;
        const playing = e.state === 'playing' || e.state === 'caching';
        enginePlaying = playing;
        if (tab.playing !== playing) {
          applying = true;
          try {
            useProjectStore.getState().actions.setPlaying(playing);
          } finally {
            applying = false;
          }
        }
      } else if (e.type === 'documentReset') {
        // A new / opened / recovered document (or an engine restart): the
        // engine's active comp and playhead start over.
        sentComp = '';
        void Promise.resolve().then(() => syncComp(true));
      }
    }
  };
  const unsubEngine = client().subscribe(onBatch);

  // ── page → engine ──
  let lastTabId: string | null = null;
  let lastComp = '';
  let lastPlaying = false;
  const unsubProject = useProjectStore.subscribe((s) => {
    const id = s.activeTabId;
    const tab = id ? s.tabs[id] : undefined;
    const comp = tab?.compositionId ?? '';
    const playing = tab?.playing === true;
    if (id !== lastTabId || comp !== lastComp) {
      lastTabId = id;
      lastComp = comp;
      syncComp();
    }
    if (playing !== lastPlaying) {
      lastPlaying = playing;
      if (!applying) syncPlaying(playing);
    }
  });
  let lastFrame = Number.NaN;
  const unsubClock = usePlaybackClockStore.subscribe((s) => {
    if (applying) {
      const tab = activeTab();
      if (tab) lastFrame = s.clocks[tab.id]?.frame ?? lastFrame;
      return;
    }
    const tab = activeTab();
    if (!tab) return;
    const f = s.clocks[tab.id]?.frame;
    if (f === undefined || f === lastFrame) return;
    lastFrame = f;
    queueSeek();
  });
  // The mirror learns the comps after the first fetch; follow it.
  const unsubMirror = documentMirror().subscribe(['comps', 'doc'], () => syncComp());
  syncComp();

  return () => {
    disposed = true;
    unsubEngine();
    unsubProject();
    unsubClock();
    unsubMirror();
  };
}

function safe<T>(fn: () => T, fallback: T): T {
  try {
    return fn();
  } catch {
    return fallback;
  }
}
