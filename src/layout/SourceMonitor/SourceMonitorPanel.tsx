/**
 * SourceMonitorPanel — the docked SOURCE viewer.
 *
 * An NLE has two viewers. The PROGRAM viewer shows the edit (this app's
 * viewport); the SOURCE viewer shows ONE clip, before it is in the edit, and it
 * is where you decide which part of that clip you actually want. Until now this
 * app had only the modal `FootagePreviewDialog`, which can answer "is this the
 * right take?" but not "which three seconds of it" — a modal covers the
 * timeline the trimmed clip is going into, so it cannot host an in/out
 * workflow, and it cannot stay open while you work.
 *
 * ── What is genuinely new here, and what is reused ──────────────────────
 * The preview MECHANICS are the dialog's, imported (`footagePreviewHooks`):
 * the same `<video>` transport and the same WebCodecs exact stepper, so the
 * two surfaces cannot disagree about which frame is frame 12. What this panel
 * adds is the editorial half: in/out points (SOURCE seconds, in
 * `sourceMonitorStore`), JKL shuttle, and four verbs that put the marked range
 * into the edit (`sourceMonitorOps`).
 *
 * ── Keyboard ────────────────────────────────────────────────────────────
 * The chords are bound on the panel ROOT, not globally, and the root carries
 * `data-shortcut-claim` so `ShortcutManager` — which listens in the CAPTURE
 * phase and stops propagation — lets them through to this panel when it has
 * focus. That is the mechanism that keeps the timeline's own J/K/L (and every
 * other global chord) untouched: nothing here is registered as a command.
 *
 * Space is the exception in the other direction: it is not a ShortcutManager
 * binding at all but a window listener (`useSpaceTransport`), so it cannot be
 * claimed by attribute — the handler stops propagation instead, which is what
 * keeps Space from ALSO starting the comp playing behind the panel.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { Icon } from '@components/Icon';
import { EmptyState } from '@components/EmptyState';
import { cn } from '@utils/cn';
import { useAssetStore } from '@stores/assetStore';
import { useSourceMonitorStore, sourceRange } from '@stores/sourceMonitorStore';
import { webCodecsAvailable } from '@core/video/exactVideoSource';
import { framesToTimecode } from '@core/time/timecode';
import { factsOf, useExactStepper } from '@layout/Assets/footagePreviewHooks';
import { insertFromSource, newCompFromRange } from './sourceMonitorOps';
import type { ImportedAsset } from '@stores/assetStore';
import styles from './SourceMonitorPanel.module.css';

/**
 * The chords this panel takes for itself while focused, as `chordKey` strings.
 *
 * Space is deliberately absent: `chordKey` renders it as a literal space, which
 * a whitespace-separated attribute cannot express — see the header.
 */
const CLAIMED_CHORDS = 'j k l i o arrowleft arrowright shift+arrowleft shift+arrowright';

/** Shuttle speeds, in the order repeated J/L presses walk them. */
const SHUTTLE_MAX = 4;

/** Tick rate of the REVERSE shuttle. No browser plays a media element with a
 *  negative `playbackRate`, so reverse is stepped by hand on a timer. */
const REVERSE_TICK_MS = 1000 / 30;

/**
 * The rate used for frame-stepping and the timecode readout.
 *
 * Probed only, falling back to 30 — the browser cannot report a file's real
 * rate, and printing the COMP's rate here would be the lie the footage
 * dialog's facts row already refuses to tell. The fallback is a step size, not
 * a claim about the file, and the readout says which one it is on hover.
 */
function displayFps(asset: ImportedAsset | null): number {
  const fps = asset?.metadata?.fps;
  return fps && fps > 0 ? fps : 30;
}

export function SourceMonitorPanel(): JSX.Element {
  const assetId = useSourceMonitorStore((s) => s.assetId);
  const time = useSourceMonitorStore((s) => s.time);
  const duration = useSourceMonitorStore((s) => s.duration);
  const inPoint = useSourceMonitorStore((s) => s.inPoint);
  const outPoint = useSourceMonitorStore((s) => s.outPoint);
  const assets = useAssetStore((s) => s.assets);
  const asset = assetId ? assets.find((a) => a.id === assetId) ?? null : null;

  if (!asset) {
    return (
      <div className={styles.root}>
        <EmptyState
          icon="tv"
          title="No clip loaded"
          message="Open a clip from the Assets panel — “Open in Source Monitor” — to mark in and out points before it reaches the timeline."
        />
      </div>
    );
  }
  return (
    <SourceMonitorBody
      // Keyed on the SOURCE: the stepper, the shuttle and the media element all
      // hold per-clip state, and remounting is the honest way to drop it.
      key={asset.src}
      asset={asset}
      time={time}
      duration={duration}
      inPoint={inPoint}
      outPoint={outPoint}
    />
  );
}

function SourceMonitorBody({
  asset, time, duration, inPoint, outPoint,
}: {
  asset: ImportedAsset;
  time: number;
  duration: number;
  inPoint: number | null;
  outPoint: number | null;
}): JSX.Element {
  const [failed, setFailed] = useState(false);
  /** −4…4. 0 is stopped; negatives are reverse. */
  const [shuttle, setShuttle] = useState(0);
  const [busy, setBusy] = useState(false);
  const audioRef = useRef<HTMLAudioElement>(null);
  const scrubRef = useRef<HTMLDivElement>(null);
  const stepper = useExactStepper(asset);
  const inFrames = stepper.mode === 'frames';
  const isVideo = asset.type === 'video';
  const fps = displayFps(asset);
  const range = sourceRange({ duration, inPoint, outPoint });

  const mediaEl = useCallback(
    (): HTMLMediaElement | null => (isVideo ? stepper.videoRef.current : audioRef.current),
    [isVideo, stepper.videoRef],
  );

  const store = useSourceMonitorStore;

  /** Move the playhead — store, media element and exact stepper together.
   *  One function so the four things that seek (scrub, arrows, shuttle, marks)
   *  cannot each keep their own idea of where the playhead is. */
  const seekTo = useCallback((seconds: number): void => {
    const clamped = Math.max(0, duration > 0 ? Math.min(seconds, duration) : seconds);
    store.getState().setTime(clamped);
    const el = mediaEl();
    if (el) {
      try { el.currentTime = clamped; } catch { /* not seekable yet */ }
    }
    if (stepper.mode === 'frames') stepper.seekSeconds(clamped);
  }, [duration, mediaEl, stepper, store]);

  // The media element is the clock while it plays; the store mirrors it so the
  // scrub bar, the readout and the marks all read one time.
  useEffect(() => {
    const el = mediaEl();
    if (!el) return;
    const onTime = (): void => { store.getState().setTime(el.currentTime); };
    const onMeta = (): void => {
      // The REAL length, which an import often does not know: the desktop probe
      // fills `metadata.duration` in, the browser import path usually cannot.
      if (Number.isFinite(el.duration) && el.duration > 0) store.getState().setDuration(el.duration);
    };
    const onEnded = (): void => setShuttle(0);
    el.addEventListener('timeupdate', onTime);
    el.addEventListener('loadedmetadata', onMeta);
    el.addEventListener('ended', onEnded);
    onMeta();
    return () => {
      el.removeEventListener('timeupdate', onTime);
      el.removeEventListener('loadedmetadata', onMeta);
      el.removeEventListener('ended', onEnded);
    };
  }, [mediaEl, store]);

  // Seed the duration from the probe when there is one, so in/out can be
  // marked before the element has loaded a byte.
  useEffect(() => {
    const probed = asset.metadata?.duration;
    if (probed && probed > 0) store.getState().setDuration(probed);
  }, [asset.metadata?.duration, store]);

  // The shuttle. Forward is the element's own playback (audio included);
  // reverse is a timer, because a negative `playbackRate` plays nowhere.
  useEffect(() => {
    store.getState().setPlaying(shuttle !== 0);
    const el = mediaEl();
    if (!el) return;
    if (shuttle > 0) {
      el.playbackRate = shuttle;
      try { void el.play()?.catch(() => setShuttle(0)); } catch { setShuttle(0); }
      return;
    }
    // `paused` first: pausing an already-paused element is a no-op everywhere
    // that matters and a console-noise generator in jsdom.
    try { if (!el.paused) el.pause(); } catch { /* not implemented (jsdom) */ }
    if (shuttle === 0) return;
    const perTick = (-shuttle) * (REVERSE_TICK_MS / 1000);
    const id = window.setInterval(() => {
      const next = store.getState().time - perTick;
      if (next <= 0) {
        setShuttle(0);
        seekTo(0);
        return;
      }
      seekTo(next);
    }, REVERSE_TICK_MS);
    return () => window.clearInterval(id);
  }, [shuttle, mediaEl, seekTo, store]);

  // Playing must never outlive the panel: an unmounted monitor whose <video>
  // kept its audio going is the bug every hidden media element eventually has.
  useEffect(() => () => { store.getState().setPlaying(false); }, [store]);

  const shuttleForward = (): void => setShuttle((s) => (s <= 0 ? 1 : Math.min(SHUTTLE_MAX, s * 2)));
  const shuttleReverse = (): void => setShuttle((s) => (s >= 0 ? -1 : Math.max(-SHUTTLE_MAX, s * 2)));
  const pause = (): void => setShuttle(0);
  const togglePlay = (): void => setShuttle((s) => (s === 0 ? 1 : 0));

  const stepFrames = (n: number): void => {
    if (inFrames) { stepper.step(n); return; }
    setShuttle(0);
    seekTo(time + n / fps);
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>): void => {
    // A text field inside the panel (there is none today, but panels grow)
    // keeps its own keys.
    const t = e.target as HTMLElement | null;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
    const shift = e.shiftKey;
    const step = shift ? 10 : 1;
    switch (e.key.toLowerCase()) {
      case 'j': shuttleReverse(); break;
      case 'k': pause(); break;
      case 'l': shuttleForward(); break;
      case 'i': store.getState().setIn(); break;
      case 'o': store.getState().setOut(); break;
      case ' ': togglePlay(); break;
      case 'arrowleft': stepFrames(-step); break;
      case 'arrowright': stepFrames(step); break;
      default: return;
    }
    e.preventDefault();
    // Space in particular: `useSpaceTransport` is a window listener, so without
    // this the comp would start playing behind the panel as well.
    e.stopPropagation();
  };

  const scrubTo = (clientX: number): void => {
    const box = scrubRef.current?.getBoundingClientRect();
    if (!box || box.width <= 0 || duration <= 0) return;
    setShuttle(0);
    seekTo(((clientX - box.left) / box.width) * duration);
  };

  const pct = (seconds: number): string => `${duration > 0 ? Math.max(0, Math.min(100, (seconds / duration) * 100)) : 0}%`;

  const run = (fn: () => Promise<unknown>): void => {
    if (busy) return;
    setBusy(true);
    void fn().finally(() => setBusy(false));
  };

  const rangeLabel = range
    ? `${framesToTimecode(range.inSec, fps)} → ${framesToTimecode(range.outSec, fps)} (${(range.outSec - range.inSec).toFixed(2)}s)`
    : 'no usable range';

  return (
    <div
      className={styles.root}
      tabIndex={0}
      data-shortcut-claim={CLAIMED_CHORDS}
      onKeyDown={onKeyDown}
      role="group"
      aria-label="Source monitor"
    >
      <div className={styles.header}>
        <span className={styles.name} title={asset.name}>{asset.name}</span>
        {shuttle !== 0 && (
          <span className={styles.shuttle}>{shuttle > 0 ? `${shuttle}×` : `${-shuttle}× rev`}</span>
        )}
      </div>

      <div className={styles.stage}>
        {failed ? (
          <div className={styles.dead}>Preview unavailable — the source may need relinking.</div>
        ) : isVideo ? (
          <>
            {/* Both mounted, one shown — same reason as the dialog: unmounting
                the <video> would forget the point the stepper resumes from. */}
            <video
              ref={stepper.videoRef}
              className={styles.media}
              style={inFrames ? { display: 'none' } : undefined}
              src={asset.src}
              onError={() => setFailed(true)}
            />
            <canvas
              ref={stepper.canvasRef}
              className={styles.media}
              style={inFrames ? undefined : { display: 'none' }}
            />
          </>
        ) : asset.type === 'audio' ? (
          <audio ref={audioRef} className={styles.audio} src={asset.src} onError={() => setFailed(true)} />
        ) : (
          <img className={styles.media} src={asset.src} alt={asset.name} onError={() => setFailed(true)} />
        )}
      </div>

      {/* ── Scrub bar with in/out brackets ───────────────────────────── */}
      <div
        ref={scrubRef}
        className={styles.scrub}
        role="slider"
        aria-label="Source playhead"
        aria-valuemin={0}
        aria-valuemax={duration || 0}
        aria-valuenow={time}
        tabIndex={-1}
        onPointerDown={(e) => {
          e.currentTarget.setPointerCapture(e.pointerId);
          scrubTo(e.clientX);
        }}
        onPointerMove={(e) => { if (e.buttons !== 0) scrubTo(e.clientX); }}
      >
        {range && duration > 0 && (
          <div
            className={styles.rangeFill}
            style={{ left: pct(range.inSec), width: `${((range.outSec - range.inSec) / duration) * 100}%` }}
          />
        )}
        {inPoint !== null && (
          <div className={styles.markIn} style={{ left: pct(inPoint) }} title={`In ${framesToTimecode(inPoint, fps)}`} />
        )}
        {outPoint !== null && (
          <div className={styles.markOut} style={{ left: pct(outPoint) }} title={`Out ${framesToTimecode(outPoint, fps)}`} />
        )}
        <div className={styles.playhead} style={{ left: pct(time) }} />
      </div>

      <div className={styles.readout}>
        <span
          className={styles.timecode}
          title={asset.metadata?.fps ? `${asset.metadata.fps} fps (probed)` : 'Rate not probed — timecode shown at 30 fps'}
        >
          {framesToTimecode(time, fps)}
        </span>
        <span className={styles.dim}>/ {duration > 0 ? framesToTimecode(duration, fps) : '--:--:--'}</span>
        {inFrames && (
          <span className={styles.dim}>{`frame ${stepper.frameIdx + 1} / ${stepper.frameCount}`}</span>
        )}
        <span className={styles.spacer} />
        <span className={styles.dim}>{rangeLabel}</span>
      </div>

      {/* ── Transport ────────────────────────────────────────────────── */}
      <div className={styles.transport}>
        <button type="button" className={styles.btn} onClick={shuttleReverse} title="Reverse shuttle (J) — press again for 2× and 4×">
          <Icon name="skip-back" size="sm" />
        </button>
        <button type="button" className={styles.btn} onClick={() => stepFrames(-1)} title="Previous frame (←)">
          <Icon name="chevron-left" size="sm" />
        </button>
        <button type="button" className={styles.btn} onClick={togglePlay} title="Play / pause (Space, K)">
          <Icon name={shuttle !== 0 ? 'pause' : 'play'} size="sm" />
        </button>
        <button type="button" className={styles.btn} onClick={() => stepFrames(1)} title="Next frame (→)">
          <Icon name="chevron-right" size="sm" />
        </button>
        <button type="button" className={styles.btn} onClick={shuttleForward} title="Forward shuttle (L) — press again for 2× and 4×">
          <Icon name="skip-forward" size="sm" />
        </button>

        <span className={styles.divider} />

        <button type="button" className={styles.btn} onClick={() => useSourceMonitorStore.getState().setIn()} title="Mark In (I)">
          <Icon name="trim-in" size="sm" /> In
        </button>
        <button type="button" className={styles.btn} onClick={() => useSourceMonitorStore.getState().setOut()} title="Mark Out (O)">
          <Icon name="trim-out" size="sm" /> Out
        </button>
        <button
          type="button"
          className={styles.btn}
          onClick={() => useSourceMonitorStore.getState().clearInOut()}
          disabled={inPoint === null && outPoint === null}
          title="Clear both marks"
        >
          Clear
        </button>

        {isVideo && webCodecsAvailable() && !inFrames && !failed && (
          <button type="button" className={styles.btn} onClick={stepper.enter} title="Exact stepping on true frame boundaries (WebCodecs decode)">
            Frame by frame
          </button>
        )}
        {inFrames && (
          <button type="button" className={styles.btn} onClick={stepper.exit} title="Back to the realtime player">
            Player
          </button>
        )}
      </div>

      {stepper.note && <div className={styles.note}>{stepper.note}</div>}

      <div className={styles.facts}>{factsOf(asset) || 'No metadata probed for this file.'}</div>

      {/* ── The verbs ────────────────────────────────────────────────── */}
      <div className={styles.actions}>
        <button
          type="button"
          className={cn(styles.action, styles.actionPrimary)}
          disabled={!range || busy}
          onClick={() => range && run(() => insertFromSource(asset, range, { at: 'playhead' }))}
          title="Insert the marked range with its clip starting at the comp playhead"
        >
          Insert at playhead
        </button>
        <button
          type="button"
          className={styles.action}
          disabled={!range || busy}
          onClick={() => range && run(() => insertFromSource(asset, range, { at: 'playhead' }, { overwrite: true }))}
          title="Insert at the playhead and trim the clips it lands on"
        >
          Overwrite at playhead
        </button>
        <button
          type="button"
          className={styles.action}
          disabled={!range || busy}
          onClick={() => range && run(() => insertFromSource(asset, range, { at: 'end' }))}
          title="Append the marked range after everything already in the comp"
        >
          Add to comp end
        </button>
        {asset.type !== 'audio' && (
          <button
            type="button"
            className={styles.action}
            disabled={!range || busy}
            onClick={() => range && run(() => newCompFromRange(asset, range))}
            title="New composition sized and paced to this clip, as long as the marked range"
          >
            New comp from range
          </button>
        )}
      </div>
    </div>
  );
}
