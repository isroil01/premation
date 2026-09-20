/**
 * The strip above the lanes: the frame ruler and the row minimap, plus the
 * tick generator that feeds the ruler. Split out of `Timeline.tsx`; both are
 * memoised because neither depends on the playhead.
 */

import { forwardRef, memo, useCallback, useEffect, useRef, type ForwardedRef, type Ref, type PointerEvent as ReactPointerEvent } from 'react';
import { cn } from '@utils/cn';
import styles from './Timeline.module.css';
import { TIMELINE_LEFT_OFFSET, TIMELINE_TOP_PADDING, type Row } from './timelineShared';

/** Vertical overview of all rows with a draggable viewport window.
 *
 *  Memoized for the same reason as {@link Ruler}: it draws a strip per row and
 *  none of it depends on the playhead, so it should not be rebuilt by a frame
 *  tick. Its `onScrollTo` is a useCallback at the call site — an inline arrow
 *  there would defeat this wrapper completely.
 *
 *  Forwards its root ref: the minimap overlays the lanes' right edge, and the
 *  timeline measures how much of that edge it covers so the panel's time
 *  navigator can stop where the visible clips do. */
const MinimapImpl = forwardRef(function MinimapImpl({
  rows,
  trackHeight,
  totalHeight,
  viewportTop,
  viewportHeight,
  scrollTop,
  onScrollTo,
}: {
  rows: Row[];
  trackHeight: number;
  totalHeight: number;
  viewportTop: number;
  viewportHeight: number;
  scrollTop: number;
  onScrollTo: (top: number) => void;
}, forwarded: ForwardedRef<HTMLDivElement>): JSX.Element {
  const scale = viewportHeight / totalHeight;
  const winH = viewportHeight * scale;
  const winTop = scrollTop * scale;
  const dragging = useRef(false);
  const barRef = useRef<HTMLDivElement | null>(null);
  const setBarRef = useCallback((el: HTMLDivElement | null): void => {
    barRef.current = el;
    if (typeof forwarded === 'function') forwarded(el);
    else if (forwarded) forwarded.current = el;
  }, [forwarded]);

  const scrollFromPointer = useCallback((clientY: number): void => {
    const rect = barRef.current?.getBoundingClientRect();
    if (!rect) return;
    const y = clientY - rect.top;
    const top = y / scale - viewportHeight / 2;
    onScrollTo(Math.max(0, Math.min(totalHeight - viewportHeight, top)));
  }, [scale, viewportHeight, totalHeight, onScrollTo]);
  // The window listeners read the LATEST scroller through a ref, so they bind
  // once per mount. This effect had no dependency array at all: it re-bound
  // both listeners on every render of the minimap, i.e. on every scroll.
  const scrollFromPointerRef = useRef(scrollFromPointer);
  scrollFromPointerRef.current = scrollFromPointer;

  useEffect(() => {
    const move = (e: PointerEvent): void => { if (dragging.current) scrollFromPointerRef.current(e.clientY); };
    const up = (): void => { dragging.current = false; };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    return () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); };
  }, []);

  return (
    <div
      ref={setBarRef}
      className={styles.minimap}
      style={{ top: viewportTop, height: viewportHeight }}
      onPointerDown={(e) => { dragging.current = true; scrollFromPointer(e.clientY); }}
    >
      {rows.map((row, i) => (
        <div
          key={i}
          className={styles.minimapRow}
          style={{
            top: (TIMELINE_TOP_PADDING + i * trackHeight) * scale,
            height: Math.max(1, trackHeight * scale - 1),
            background: row.type === 'track' ? (row.track.color ?? 'var(--color-text-muted)') : 'var(--color-border-strong)',
            opacity: row.type === 'track' ? 0.7 : 0.4,
          }}
        />
      ))}
      <div className={styles.minimapWindow} style={{ top: winTop, height: winH }} />
    </div>
  );
});

export const Minimap = memo(MinimapImpl);

// ── Subcomponents ───────────────────────────────────────────────

/**
 * The frame ruler.
 *
 * Memoized, and worth it: it emits one absolutely-positioned div per tick over
 * the WHOLE composition, so at a 10-second comp and default zoom it is one of
 * the largest subtrees in the panel — and it does not depend on the playhead at
 * all. Its props are already stable across a frame tick (`ticks` is a useMemo,
 * `onPointerDown` a useCallback, the rest numbers), so without the memo it was
 * rebuilding every one of those nodes on every frame of playback purely because
 * its parent re-rendered to move the playhead.
 */
function RulerImpl({
  ticks,
  height,
  width,
  onPointerDown,
  currentTime = 0,
  duration = 0,
  pixelsPerSecond = 80,
  leftOffset = TIMELINE_LEFT_OFFSET,
  fillRef,
}: {
  ticks: { x: number; major: boolean; label: string }[];
  height: number;
  width: number;
  onPointerDown?: (e: ReactPointerEvent<HTMLDivElement>) => void;
  currentTime?: number;
  duration?: number;
  pixelsPerSecond?: number;
  leftOffset?: number;
  /**
   * When given, the progress fill's WIDTH belongs to the owner of this ref (a
   * live playhead subscription) and React leaves it alone — `currentTime` is
   * then a throttled value that must not overwrite the live one.
   */
  fillRef?: Ref<HTMLDivElement>;
}): JSX.Element {
  const progressWidth = rulerProgressWidth(currentTime, duration, pixelsPerSecond);
  const trackWidth = duration > 0 ? duration * pixelsPerSecond : width;

  return (
    <div className={styles.ruler} style={{ height, width }} onPointerDown={onPointerDown}>
      {/* Background progress track */}
      <div
        className={styles.rulerProgressTrack}
        style={{ left: leftOffset, width: trackWidth }}
        aria-hidden
      />

      {/* Video progress fill with primary color as video passes */}
      <div
        ref={fillRef}
        className={styles.rulerProgressFill}
        style={fillRef ? { left: leftOffset } : { left: leftOffset, width: progressWidth }}
        aria-hidden
      />

      {/* Ruler ticks and timecode labels at the top */}
      {ticks.map((t, i) => (
        <div
          key={i}
          className={cn(styles.tick, t.major && styles.tickMajor)}
          style={{ transform: `translateX(${t.x}px)` }}
        >
          {t.major ? <span className={styles.tickLabel}>{t.label}</span> : null}
        </div>
      ))}
    </div>
  );
}

export const Ruler = memo(RulerImpl);

/** The ruler's progress-fill width in px: the playhead's x, clamped to the comp. */
export function rulerProgressWidth(time: number, duration: number, pixelsPerSecond: number): number {
  return Math.max(0, Math.min(duration * pixelsPerSecond, time * pixelsPerSecond));
}

/** Aim for roughly this many pixels between labelled ticks. */
const TARGET_PX_BETWEEN_MAJOR = 100;

/**
 * The tick spacings the ruler may choose from, finest first.
 *
 * FRAME-derived steps are in the ladder, not just decimal seconds, and that is
 * the point of it. The ladder used to bottom out at 0.1s, so once the zoom was
 * deep enough to see individual frames the ruler went on drawing 100ms majors
 * that lined up with no frame at all — the gridlines disagreed with the only
 * grid the editor actually snaps to. Below a frame it keeps subdividing, since
 * keyframe times are continuous and the sub-frame nudge can reach those times.
 *
 * Sorted at run time rather than written in order because the relationship
 * between a frame and half a second depends on the frame rate: 10 frames is
 * 0.33s at 30fps but 0.83s at 12fps, so no fixed spelling is ordered for both.
 */
function tickCandidates(frameDur: number): number[] {
  const seconds = [0.5, 1, 2, 5, 10, 30, 60, 120, 300, 600];
  const frames = frameDur > 0
    ? [frameDur / 8, frameDur / 4, frameDur / 2, frameDur, 2 * frameDur, 5 * frameDur, 10 * frameDur]
    : [];
  return [...frames, ...seconds].sort((a, b) => a - b);
}

/**
 * Ruler ticks for a time range.
 *
 * `window` bounds the generation, and it is not an optimisation detail — it is
 * what makes deep zoom survivable. Ticks used to be generated for the WHOLE
 * comp and filtered afterwards, which was fine while the finest spacing was
 * 20ms: a 10-minute comp cost 30,000 objects. With a frame-aware ladder and a
 * zoom ceiling that reaches individual milliseconds, the same code would build
 * close to a million objects on every zoom change and hang the panel. The
 * window it is given is page-snapped (`pagedTimeWindow`), so this still only
 * re-runs when the view crosses a page boundary rather than on every scroll.
 */
export function generateRulerTicks(
  durationSec: number,
  pps: number,
  fps: number,
  startSec = 0,
  offset = 0,
  window?: { t0: number; t1: number },
): { x: number; major: boolean; label: string }[] {
  const frameDur = fps > 0 ? 1 / fps : 0;
  let majorSec = 1;
  for (const c of tickCandidates(frameDur)) {
    if (c * pps >= TARGET_PX_BETWEEN_MAJOR) { majorSec = c; break; }
  }
  const minorSec = majorSec / 5;
  if (!(minorSec > 0)) return [];

  // Clamp the range to the comp and to the window. Half-open at the top like
  // the window itself, plus one minor tick of slack either side so a tick that
  // straddles the edge of a page is not missing while that page is on screen.
  const from = Math.max(0, (window ? window.t0 : 0) - minorSec);
  const to = Math.min(durationSec, (window ? window.t1 : durationSec) + minorSec);
  if (!(to >= from)) return [];

  const ticks: { x: number; major: boolean; label: string }[] = [];
  const firstIndex = Math.ceil(from / minorSec - 1e-6);
  const lastIndex = Math.floor(to / minorSec + 1e-6);
  for (let i = firstIndex; i <= lastIndex; i++) {
    const snapped = i * minorSec;
    const isMajor = Math.abs((snapped / majorSec) - Math.round(snapped / majorSec)) < 1e-6;
    // The tick's POSITION is 0-based plus left margin offset (pixel layout is the real time domain); its
    // LABEL adds the comp's start offset so the ruler reads the same timecode
    // the playhead readout does.
    ticks.push({ x: offset + snapped * pps, major: isMajor, label: formatTime(snapped + startSec, fps, majorSec) });
  }
  return ticks;
}

function formatTime(sec: number, fps: number, majorSec: number): string {
  // Below a frame, milliseconds need a decimal or adjacent labels collide:
  // at 30fps an eighth of a frame is 4.2ms, and three consecutive labels all
  // round to "4ms", "8ms", "12ms" with the spacing silently wrong.
  if (majorSec < 0.01) return `${(sec * 1000).toFixed(1)}ms`;
  // At frame scale the frame NUMBER is the unit people edit in, and a bare
  // millisecond reading cannot be matched against the timecode field.
  if (majorSec < 0.5 && fps > 0) return `${Math.round(sec * fps)}f`;
  if (majorSec < 1) return `${(sec * 1000).toFixed(0)}ms`;
  if (majorSec < 60) return `${sec.toFixed(0)}s`;
  const m = Math.floor(sec / 60);
  const s = sec - m * 60;
  return `${m}:${s.toFixed(0).padStart(2, '0')}`;
}
