/**
 * D5 — transport through the C++ engine when it owns the document
 * (NATIVE_CORE_PLAN §5 D5, ENGINE_API.md §6: the engine owns the clock).
 *
 * The page keeps its playhead MODEL — the transient clock (playbackClockStore)
 * every timeline widget reads, moved through core/timeline/timelineView.ts —
 * but never advances it itself. Instead:
 *
 *   engine → page   `playhead` events write the clock store (→
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
import { getClock, setTime, usePlaybackClockStore } from '@stores/playbackClockStore';
import { documentMirror } from '@stores/documentMirror';
import { previewIncludesAudio } from '@stores/previewBehaviorStore';
import { isTransportLooping } from '@core/timeline/timelineView';

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

/** The installed transport's teardown: there is exactly one per page. */
let installedTeardown: (() => void) | null = null;

/**
 * Wire the page's transport to `client` (the owner). Returns the teardown.
 * `stats` (optional) is filled for the harness / HUD.
 *
 * ONE transport per page: installing a second one tears the first down. Two
 * wirings each guard only their own echo (`applying`), so each takes the
 * other's engine-driven play flag and playhead for a user action: an engine
 * `transportChanged: stopped` applied by one is sent back as `pause` by the
 * other, the next `playing` as `play`, and every playhead as a `seek` — a
 * play/pause/seek storm that pins the playhead near the start, draws frames
 * out of order and ignores Pause (seen in `electron:dev`, where StrictMode ran
 * the editor boot twice).
 */
export function installEngineTransport(client: () => EngineClient, stats?: EngineTransportStats): () => void {
  installedTeardown?.();
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
    if (disposed || !comp || (!force && comp === sentComp)) return;
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
      const looping = isTransportLooping();
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
        // Stopped, the page's playhead is the authority: while a page seek is in flight or
        // queued, an event echoes an OLDER seek — applied, it would overwrite the newer
        // position (and the queued seek would then send that stale time back).
        if (!enginePlaying && (seekInFlight || seekPending)) continue;
        st.playheadEvents += 1;
        applying = true;
        try {
          // A FRAME-EXACT time into the clock store: the frame the engine drew.
          const rate = documentMirror().comp(tab.comp)?.settings.frameRate;
          if (rate && rate.num > 0) {
            const frame = Math.round((flicksToSeconds(e.time) * rate.num) / (rate.den || 1));
            if (getClock(tab.id).frame !== frame || !tab.playing) setTime(tab.id, (frame * (rate.den || 1)) / rate.num, frame);
          }
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

  const teardown = (): void => {
    if (disposed) return;
    disposed = true;
    if (installedTeardown === teardown) installedTeardown = null;
    unsubEngine();
    unsubProject();
    unsubClock();
    unsubMirror();
  };
  installedTeardown = teardown;
  return teardown;
}

