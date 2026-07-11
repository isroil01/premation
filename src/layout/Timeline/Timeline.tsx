/**
 * Timeline — UI shell for the timeline panel (spec: "Default state: calm").
 *
 * Calm by default: every layer is a SINGLE row showing one neutral animation
 * block that summarizes where its keyframes live. A track expands — via the
 * disclosure chevron or the `U` reveal shortcut — into one sub-row per animated
 * property, each with its own draggable keyframes. Collapsed rows stay quiet.
 *
 * Layout:
 *   - Ruler (top) with a cache bar directly beneath it (cached = green 40%)
 *   - TrackHeader column (left) | Lanes (right, scrolls both axes)
 *   - Rows (track + expanded property sub-rows) are virtualized uniformly.
 *
 * This component contains ZERO animation or playback logic — it is a
 * controlled renderer that reports intents to the host.
 */

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
  type PointerEvent as ReactPointerEvent,
  type WheelEvent as ReactWheelEvent,
} from 'react';
import { cn } from '@utils/cn';
import { Icon, type IconName } from '@components/Icon';
import { useResizeObserver } from '@hooks/useResizeObserver';
import { clamp } from '@utils/lang';
import type {
  TimelineModel,
  TimelineTrack,
  TimelineKeyframeRef,
  TimelinePropertyTrack,
  TimelineClip,
} from './TimelineModel';
import styles from './Timeline.module.css';

const RULER_HEIGHT_DEFAULT = 26;
const TRACK_HEIGHT_DEFAULT = 30;
const TRACK_HEADER_WIDTH_DEFAULT = 220;
const CACHE_BAR_HEIGHT = 4;

/** A virtualized row is either a track summary row or a property sub-row. */
type Row =
  | { type: 'track'; track: TimelineTrack; expanded: boolean; hasProps: boolean }
  | { type: 'prop'; track: TimelineTrack; prop: TimelinePropertyTrack };

export interface TimelineProps {
  model: TimelineModel;
  onScrub?: (time: number) => void;
  /** Work-area edit (seconds) from dragging the band's edges or body. */
  onWorkAreaChange?: (start: number, end: number) => void;
  /** Clip moved to a new absolute start (seconds). */
  onClipMove?: (clipId: string, start: number) => void;
  /** Clip edge trimmed to an absolute time (seconds). */
  onClipTrim?: (clipId: string, edge: 'start' | 'end', time: number) => void;
  /** Right-click a clip (for split / delete). */
  onClipContextMenu?: (clipId: string, clientX: number, clientY: number) => void;
  onTrackSelect?: (trackId: string, additive: boolean) => void;
  onScroll?: (scrollLeft: number) => void;
  onZoom?: (pixelsPerSecond: number) => void;
  selectedTrackIds?: ReadonlyArray<string>;
  /** Tracks whose animated properties are revealed (expanded). */
  expandedTrackIds?: ReadonlyArray<string>;
  /** Restrict revealed sub-rows to these props (P/S/R/T reveal); null = all. */
  revealProps?: ReadonlyArray<string> | null;
  onTrackToggleExpand?: (trackId: string) => void;
  /** Double-click a track — enter it (precomp) or isolate it (Focus Mode). */
  onTrackActivate?: (trackId: string) => void;
  onTrackToggleVisible?: (trackId: string) => void;
  onTrackToggleLock?: (trackId: string) => void;
  onTrackToggleSolo?: (trackId: string) => void;
  onKeyframeSeek?: (keyframeId: string) => void;
  onKeyframeMove?: (keyframeId: string, time: number) => void;
  onKeyframeContextMenu?: (keyframeId: string, clientX: number, clientY: number) => void;
  className?: string;
}

export function Timeline({
  model,
  onScrub,
  onWorkAreaChange,
  onClipMove,
  onClipTrim,
  onClipContextMenu,
  onTrackSelect,
  onScroll,
  onZoom,
  selectedTrackIds,
  expandedTrackIds,
  revealProps,
  onTrackToggleExpand,
  onTrackActivate,
  onTrackToggleVisible,
  onTrackToggleLock,
  onTrackToggleSolo,
  onKeyframeSeek,
  onKeyframeMove,
  onKeyframeContextMenu,
  className,
}: TimelineProps): JSX.Element {
  const rulerHeight = model.rulerHeight ?? RULER_HEIGHT_DEFAULT;
  const trackHeight = model.trackHeight ?? TRACK_HEIGHT_DEFAULT;
  const headerWidth = model.trackHeaderWidth ?? TRACK_HEADER_WIDTH_DEFAULT;

  const lanesRef = useRef<HTMLDivElement | null>(null);
  const headerRef = useRef<HTMLDivElement | null>(null);
  const { ref: containerRef, size } = useResizeObserver<HTMLDivElement>();
  const [scrollLeft, setScrollLeft] = useState(0);
  const [scrollTop, setScrollTop] = useState(0);

  // ── Flatten tracks + expanded property sub-rows into a uniform row list ──
  const expanded = useMemo(() => new Set(expandedTrackIds ?? []), [expandedTrackIds]);
  const revealSet = useMemo(
    () => (revealProps ? new Set(revealProps) : null),
    [revealProps],
  );
  const rows = useMemo<Row[]>(() => {
    const out: Row[] = [];
    for (const track of model.tracks) {
      const hasProps = (track.properties?.length ?? 0) > 0;
      const isExpanded = hasProps && expanded.has(track.id);
      out.push({ type: 'track', track, expanded: isExpanded, hasProps });
      if (isExpanded && track.properties) {
        // P/S/R/T reveal filters which property sub-rows are shown.
        const shown = revealSet
          ? track.properties.filter((p) => revealSet.has(p.prop))
          : track.properties;
        for (const prop of shown) out.push({ type: 'prop', track, prop });
      }
    }
    return out;
  }, [model.tracks, expanded, revealSet]);

  // ── Derived geometry ───────────────────────────────────────────
  const totalSeconds = Math.max(model.duration, 1);
  const pps = model.pixelsPerSecond;
  const laneWidth = totalSeconds * pps;
  const totalLanesHeight = rows.length * trackHeight;

  // ── Vertical virtualization (rows) ─────────────────────────────
  const visibleRowCount = Math.ceil(size.height / trackHeight) + 8;
  const startRow = Math.max(0, Math.floor(scrollTop / trackHeight) - 4);
  const endRow = Math.min(rows.length, startRow + visibleRowCount);
  const visibleRows = useMemo(() => rows.slice(startRow, endRow), [rows, startRow, endRow]);

  // ── Horizontal scrolling sync (header follows lanes) ──────────
  const onLanesScroll = useCallback(
    (e: React.UIEvent<HTMLDivElement>) => {
      const el = e.currentTarget;
      setScrollLeft(el.scrollLeft);
      setScrollTop(el.scrollTop);
      if (headerRef.current) headerRef.current.scrollTop = el.scrollTop;
      onScroll?.(el.scrollLeft);
    },
    [onScroll],
  );

  // ── Wheel zoom (Ctrl + Wheel) ──────────────────────────────────
  const onWheel = useCallback(
    (e: ReactWheelEvent<HTMLDivElement>) => {
      if (!e.ctrlKey && !e.metaKey) return;
      e.preventDefault();
      const factor = e.deltaY < 0 ? 1.15 : 1 / 1.15;
      const next = clamp(pps * factor, 4, 800);
      onZoom?.(next);
    },
    [pps, onZoom],
  );

  // ── Playhead drag ──────────────────────────────────────────────
  const draggingRef = useRef(false);
  const onPlayheadDown = useCallback((e: ReactPointerEvent<HTMLDivElement>) => {
    draggingRef.current = true;
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    document.body.style.cursor = 'ew-resize';
    document.body.style.userSelect = 'none';
  }, []);
  useEffect(() => {
    const onMove = (e: PointerEvent): void => {
      if (!draggingRef.current || !lanesRef.current) return;
      const rect = lanesRef.current.getBoundingClientRect();
      const x = e.clientX - rect.left + scrollLeft;
      const time = clamp(x / pps, 0, totalSeconds);
      onScrub?.(time);
    };
    const onUp = (): void => {
      if (!draggingRef.current) return;
      draggingRef.current = false;
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    return () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
    };
  }, [pps, scrollLeft, totalSeconds, onScrub]);

  // ── Work-area band drag (edge handles resize in/out; body moves) ──
  const waDrag = useRef<null | { mode: 'in' | 'out' | 'move'; startX: number; s: number; e: number }>(null);
  const startWaDrag = useCallback(
    (mode: 'in' | 'out' | 'move') => (ev: ReactPointerEvent<HTMLDivElement>) => {
      if (!model.workArea || !lanesRef.current) return;
      ev.stopPropagation();
      const lanesRect = lanesRef.current.getBoundingClientRect();
      waDrag.current = {
        mode,
        startX: ev.clientX - lanesRect.left + scrollLeft,
        s: model.workArea.start,
        e: model.workArea.end,
      };
      try {
        (ev.currentTarget as HTMLElement).setPointerCapture(ev.pointerId);
      } catch {
        /* best-effort capture (synthetic/edge pointers) */
      }
      document.body.style.userSelect = 'none';
    },
    [model.workArea, scrollLeft],
  );
  useEffect(() => {
    const onMove = (e: PointerEvent): void => {
      const d = waDrag.current;
      if (!d || !lanesRef.current || !onWorkAreaChange) return;
      const lanesRect = lanesRef.current.getBoundingClientRect();
      const contentX = e.clientX - lanesRect.left + scrollLeft;
      const deltaSec = (contentX - d.startX) / pps;
      const minGap = 1 / (model.frameRate || 30);
      let s = d.s;
      let en = d.e;
      if (d.mode === 'in') {
        s = clamp(d.s + deltaSec, 0, d.e - minGap);
      } else if (d.mode === 'out') {
        en = clamp(d.e + deltaSec, d.s + minGap, totalSeconds);
      } else {
        const width = d.e - d.s;
        s = clamp(d.s + deltaSec, 0, totalSeconds - width);
        en = s + width;
      }
      onWorkAreaChange(s, en);
    };
    const onUp = (): void => {
      if (!waDrag.current) return;
      waDrag.current = null;
      document.body.style.userSelect = '';
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    return () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
    };
  }, [pps, scrollLeft, totalSeconds, onWorkAreaChange, model.frameRate]);

  // ── Clip drag (body = move; edge handles = trim) ──────────────────
  // Live geometry lives on the ref (survives without a render); a preview state
  // drives the visual; the engine is only told the final value on release.
  const clipDrag = useRef<
    null | { id: string; mode: 'move' | 'start' | 'end'; startX: number; start: number; duration: number; live: { start: number; duration: number } }
  >(null);
  const [clipPreview, setClipPreview] = useState<null | { id: string; start: number; duration: number }>(null);

  const onClipDown = useCallback(
    (clip: TimelineClip, mode: 'move' | 'start' | 'end', e: ReactPointerEvent<HTMLDivElement>) => {
      if ((!onClipMove && !onClipTrim) || !lanesRef.current) return;
      e.stopPropagation();
      const lanesRect = lanesRef.current.getBoundingClientRect();
      clipDrag.current = {
        id: clip.id,
        mode,
        startX: e.clientX - lanesRect.left + scrollLeft,
        start: clip.start,
        duration: clip.duration,
        live: { start: clip.start, duration: clip.duration },
      };
      setClipPreview({ id: clip.id, start: clip.start, duration: clip.duration });
      try {
        (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
      } catch {
        /* best-effort capture */
      }
      document.body.style.userSelect = 'none';
    },
    [onClipMove, onClipTrim, scrollLeft],
  );

  useEffect(() => {
    const onMove = (e: PointerEvent): void => {
      const d = clipDrag.current;
      if (!d || !lanesRef.current) return;
      const lanesRect = lanesRef.current.getBoundingClientRect();
      const deltaSec = (e.clientX - lanesRect.left + scrollLeft - d.startX) / pps;
      const minGap = 1 / (model.frameRate || 30);
      let start = d.start;
      let duration = d.duration;
      if (d.mode === 'move') {
        start = clamp(d.start + deltaSec, 0, Math.max(0, totalSeconds - d.duration));
      } else if (d.mode === 'start') {
        const end = d.start + d.duration;
        start = clamp(d.start + deltaSec, 0, end - minGap);
        duration = end - start;
      } else {
        duration = clamp(d.duration + deltaSec, minGap, totalSeconds - d.start);
      }
      d.live = { start, duration };
      setClipPreview({ id: d.id, start, duration });
    };
    const onUp = (): void => {
      const d = clipDrag.current;
      if (!d) return;
      const { start, duration } = d.live;
      if (d.mode === 'move') onClipMove?.(d.id, start);
      else if (d.mode === 'start') onClipTrim?.(d.id, 'start', start);
      else onClipTrim?.(d.id, 'end', start + duration);
      clipDrag.current = null;
      setClipPreview(null);
      document.body.style.userSelect = '';
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    return () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
    };
  }, [pps, scrollLeft, totalSeconds, onClipMove, onClipTrim, model.frameRate]);

  // ── Playhead keyboard nudge (role="slider" must be operable) ──
  // Arrow keys step one frame; Shift steps one second; Home/End jump to bounds.
  const onPlayheadKey = useCallback(
    (e: React.KeyboardEvent<HTMLDivElement>) => {
      const frame = 1 / (model.frameRate || 30);
      let next: number | null = null;
      switch (e.key) {
        case 'ArrowLeft':
          next = model.currentTime - (e.shiftKey ? 1 : frame);
          break;
        case 'ArrowRight':
          next = model.currentTime + (e.shiftKey ? 1 : frame);
          break;
        case 'Home':
          next = 0;
          break;
        case 'End':
          next = totalSeconds;
          break;
        default:
          return;
      }
      e.preventDefault();
      onScrub?.(clamp(next, 0, totalSeconds));
    },
    [model.frameRate, model.currentTime, totalSeconds, onScrub],
  );

  // ── Keyframe drag ──────────────────────────────────────────────
  // Drag state is a synchronous ref (so a fast click's pointerdown→pointerup
  // works without waiting for a render); React state only drives the visual
  // preview. Nothing mutates the model until release (single commit).
  const activeKf = useRef<{ id: string; time: number; moved: boolean } | null>(null);
  const kfStartX = useRef(0);
  const [kfPreview, setKfPreview] = useState<{ id: string; time: number } | null>(null);

  const onKeyframeDown = useCallback((kf: TimelineKeyframeRef, e: ReactPointerEvent<HTMLDivElement>) => {
    e.stopPropagation();
    kfStartX.current = e.clientX;
    activeKf.current = { id: kf.id, time: kf.time, moved: false };
    setKfPreview(null);
  }, []);

  useEffect(() => {
    const onMove = (e: PointerEvent): void => {
      const d = activeKf.current;
      if (!d || !lanesRef.current) return;
      if (!d.moved && Math.abs(e.clientX - kfStartX.current) < 3) return;
      const rect = lanesRef.current.getBoundingClientRect();
      const time = clamp((e.clientX - rect.left + scrollLeft) / pps, 0, totalSeconds);
      d.moved = true;
      d.time = time;
      setKfPreview({ id: d.id, time });
    };
    const onUp = (): void => {
      const d = activeKf.current;
      if (!d) return;
      activeKf.current = null;
      setKfPreview(null);
      if (d.moved) onKeyframeMove?.(d.id, d.time);
      else onKeyframeSeek?.(d.id);
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    return () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
    };
  }, [pps, scrollLeft, totalSeconds, onKeyframeMove, onKeyframeSeek]);

  // ── Ruler ticks ────────────────────────────────────────────────
  const ticks = useMemo(
    () => generateRulerTicks(totalSeconds, pps, model.frameRate),
    [totalSeconds, pps, model.frameRate],
  );

  // Layer number column (AE-style) — index within the track order.
  const trackIndexById = useMemo(
    () => new Map(model.tracks.map((t, i) => [t.id, i + 1])),
    [model.tracks],
  );

  const playheadX = model.currentTime * pps;

  return (
    <div ref={containerRef} className={cn(styles.root, className)} onWheel={onWheel}>
      <div className={styles.headerCol} style={{ width: headerWidth, height: '100%' }}>
        <div className={styles.ruler} style={{ height: rulerHeight }}>
          {/* Column heads for the switch columns (AE muscle memory). */}
          <div className={styles.colHeads} aria-hidden>
            <span className={styles.colHead}><Icon name="eye" size={11} /></span>
            <span className={styles.colHead}><Icon name="circle" size={10} /></span>
            <span className={styles.colHead}><Icon name="lock" size={11} /></span>
          </div>
        </div>
        <div
          ref={headerRef}
          className={styles.trackHeaderScroller}
          style={{ height: `calc(100% - ${rulerHeight}px)` }}
        >
          <div style={{ height: totalLanesHeight, position: 'relative' }}>
            {visibleRows.map((row, i) => {
              const realIndex = startRow + i;
              const rowStyle: CSSProperties = {
                position: 'absolute',
                top: realIndex * trackHeight,
                left: 0,
                right: 0,
                height: trackHeight,
              };
              if (row.type === 'track') {
                return (
                  <TrackHeader
                    key={`h_${row.track.id}`}
                    track={row.track}
                    index={trackIndexById.get(row.track.id) ?? 0}
                    selected={selectedTrackIds?.includes(row.track.id) ?? false}
                    expanded={row.expanded}
                    hasProps={row.hasProps}
                    onToggleExpand={() => onTrackToggleExpand?.(row.track.id)}
                    onActivate={() => onTrackActivate?.(row.track.id)}
                    onClick={(additive) => onTrackSelect?.(row.track.id, additive)}
                    onToggleVisible={() => onTrackToggleVisible?.(row.track.id)}
                    onToggleLock={() => onTrackToggleLock?.(row.track.id)}
                    onToggleSolo={() => onTrackToggleSolo?.(row.track.id)}
                    style={rowStyle}
                  />
                );
              }
              return (
                <PropertyHeader
                  key={`h_${row.track.id}_${row.prop.prop}`}
                  label={row.prop.label}
                  style={rowStyle}
                />
              );
            })}
          </div>
        </div>
      </div>

      <div ref={lanesRef} className={styles.lanes} onScroll={onLanesScroll}>
        <div
          style={{
            width: laneWidth,
            minWidth: '100%',
            height: rulerHeight + totalLanesHeight,
            position: 'relative',
          }}
        >
          <Ruler ticks={ticks} height={rulerHeight} width={laneWidth} />

          {/* Cache bar — directly under the ruler; preserves AE muscle memory. */}
          <div
            className={styles.cacheBar}
            style={{ top: rulerHeight - CACHE_BAR_HEIGHT, height: CACHE_BAR_HEIGHT, width: laneWidth }}
            aria-hidden
          >
            {(model.cachedRanges ?? []).map((r, i) => (
              <div
                key={i}
                className={styles.cacheSegment}
                style={{ left: r.start * pps, width: Math.max(1, (r.end - r.start) * pps) }}
              />
            ))}
          </div>

          {/* Work-area band on the ruler (in/out region for looped playback).
              Drag the body to move it; drag an edge handle to trim in/out. */}
          {model.workArea ? (
            <div
              className={styles.workAreaBar}
              style={{
                top: 0,
                height: rulerHeight,
                left: model.workArea.start * pps,
                width: Math.max(2, (model.workArea.end - model.workArea.start) * pps),
              }}
              title="Work area — drag to move, drag edges to trim"
              aria-label="Work area"
              onPointerDown={onWorkAreaChange ? startWaDrag('move') : undefined}
            >
              <div
                className={styles.workAreaHandle}
                data-edge="in"
                aria-label="Work area in"
                onPointerDown={onWorkAreaChange ? startWaDrag('in') : undefined}
              />
              <div
                className={styles.workAreaHandle}
                data-edge="out"
                aria-label="Work area out"
                onPointerDown={onWorkAreaChange ? startWaDrag('out') : undefined}
              />
            </div>
          ) : null}

          <div
            className={styles.lanesInner}
            style={{ position: 'absolute', top: rulerHeight, left: 0, right: 0, height: totalLanesHeight }}
          >
            {/* Row backgrounds */}
            {visibleRows.map((row, i) => {
              const realIndex = startRow + i;
              const key = row.type === 'track' ? `bg_${row.track.id}` : `bg_${row.track.id}_${row.prop.prop}`;
              return (
                <div
                  key={key}
                  className={cn(
                    styles.lane,
                    row.type === 'prop' && styles.lanePropBg,
                    realIndex % 2 === 0 && styles.laneAlt,
                  )}
                  style={{ position: 'absolute', top: realIndex * trackHeight, left: 0, right: 0, height: trackHeight }}
                />
              );
            })}

            {/* Row content: animation block + keyframes */}
            {visibleRows.map((row, i) => {
              const realIndex = startRow + i;
              const top = realIndex * trackHeight;
              if (row.type === 'track') {
                return (
                  <TrackContent
                    key={`c_${row.track.id}`}
                    track={row.track}
                    expanded={row.expanded}
                    ghosted={row.track.ghosted ?? false}
                    pps={pps}
                    trackHeight={trackHeight}
                    top={top}
                    kfPreview={kfPreview}
                    onKeyframeDown={onKeyframeDown}
                    onKeyframeContextMenu={onKeyframeContextMenu}
                    clipPreview={clipPreview}
                    onClipDown={onClipDown}
                    onClipContextMenu={onClipContextMenu}
                  />
                );
              }
              return (
                <LaneRow key={`c_${row.track.id}_${row.prop.prop}`} top={top} trackHeight={trackHeight}>
                  <Keyframes
                    keyframes={row.prop.keyframes}
                    pps={pps}
                    kfPreview={kfPreview}
                    onKeyframeDown={onKeyframeDown}
                    onKeyframeContextMenu={onKeyframeContextMenu}
                  />
                </LaneRow>
              );
            })}

            {/* Work-area tint spanning all lanes (visual context for the region). */}
            {model.workArea ? (
              <div
                className={styles.workAreaTint}
                style={{
                  left: model.workArea.start * pps,
                  width: Math.max(2, (model.workArea.end - model.workArea.start) * pps),
                  height: totalLanesHeight,
                }}
                aria-hidden
              />
            ) : null}

            {/* Markers */}
            {model.markers.map((m) => (
              <div
                key={m.id}
                className={styles.marker}
                style={{ transform: `translateX(${m.time * pps}px)` }}
                aria-hidden
              >
                <span className={styles.markerFlag} title={m.label}>
                  <Icon name="marker" size={12} />
                </span>
              </div>
            ))}

            {/* Playhead */}
            <div
              className={styles.playhead}
              style={{ transform: `translateX(${playheadX}px)`, height: totalLanesHeight }}
              onPointerDown={onPlayheadDown}
              onKeyDown={onPlayheadKey}
              tabIndex={0}
              role="slider"
              aria-label="Playhead"
              aria-orientation="horizontal"
              aria-valuemin={0}
              aria-valuemax={model.duration}
              aria-valuenow={model.currentTime}
              aria-valuetext={`${model.currentTime.toFixed(2)} seconds`}
            >
              <div className={styles.playheadHead} />
            </div>
          </div>
        </div>
      </div>

      {/* Layer minimap — auto-appears only when layers exceed one screen. */}
      {size.height > 0 && totalLanesHeight > size.height - rulerHeight ? (
        <Minimap
          rows={rows}
          trackHeight={trackHeight}
          totalHeight={totalLanesHeight}
          viewportTop={rulerHeight}
          viewportHeight={size.height - rulerHeight}
          scrollTop={scrollTop}
          onScrollTo={(top) => {
            if (lanesRef.current) lanesRef.current.scrollTop = top;
          }}
        />
      ) : null}
    </div>
  );
}

/** Vertical overview of all rows with a draggable viewport window. */
function Minimap({
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
}): JSX.Element {
  const scale = viewportHeight / totalHeight;
  const winH = viewportHeight * scale;
  const winTop = scrollTop * scale;
  const dragging = useRef(false);
  const barRef = useRef<HTMLDivElement | null>(null);

  const scrollFromPointer = (clientY: number): void => {
    const rect = barRef.current?.getBoundingClientRect();
    if (!rect) return;
    const y = clientY - rect.top;
    const top = y / scale - viewportHeight / 2;
    onScrollTo(Math.max(0, Math.min(totalHeight - viewportHeight, top)));
  };

  useEffect(() => {
    const move = (e: PointerEvent): void => { if (dragging.current) scrollFromPointer(e.clientY); };
    const up = (): void => { dragging.current = false; };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    return () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); };
  });

  return (
    <div
      ref={barRef}
      className={styles.minimap}
      style={{ top: viewportTop, height: viewportHeight }}
      onPointerDown={(e) => { dragging.current = true; scrollFromPointer(e.clientY); }}
    >
      {rows.map((row, i) => (
        <div
          key={i}
          className={styles.minimapRow}
          style={{
            top: i * trackHeight * scale,
            height: Math.max(1, trackHeight * scale - 1),
            background: row.type === 'track' ? (row.track.color ?? 'var(--color-text-muted)') : 'var(--color-border-strong)',
            opacity: row.type === 'track' ? 0.7 : 0.4,
          }}
        />
      ))}
      <div className={styles.minimapWindow} style={{ top: winTop, height: winH }} />
    </div>
  );
}

// ── Subcomponents ───────────────────────────────────────────────

function Ruler({
  ticks,
  height,
  width,
}: {
  ticks: { x: number; major: boolean; label: string }[];
  height: number;
  width: number;
}): JSX.Element {
  return (
    <div className={styles.ruler} style={{ height, width }}>
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

function TrackHeader({
  track,
  index,
  selected,
  expanded,
  hasProps,
  onToggleExpand,
  onActivate,
  onClick,
  onToggleVisible,
  onToggleLock,
  onToggleSolo,
  style,
}: {
  track: TimelineTrack;
  index: number;
  selected: boolean;
  expanded: boolean;
  hasProps: boolean;
  onToggleExpand: () => void;
  onActivate: () => void;
  onClick: (additive: boolean) => void;
  onToggleVisible: () => void;
  onToggleLock: () => void;
  onToggleSolo: () => void;
  style: CSSProperties;
}): JSX.Element {
  const hidden = track.muted === true;
  const locked = track.locked === true;
  const solo = track.solo === true;
  return (
    <div
      className={cn(styles.trackHeader, selected && styles.trackHeaderSelected)}
      style={{ ...style, '--track-color': track.color ?? 'transparent' } as CSSProperties}
      data-track-id={track.id}
      data-hidden={hidden || undefined}
      data-ghost={track.ghosted || undefined}
      onClick={(e) => onClick(e.ctrlKey || e.metaKey || e.shiftKey)}
      onDoubleClick={onActivate}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onClick(e.ctrlKey || e.metaKey || e.shiftKey);
        } else if (e.key === 'F2') {
          e.preventDefault();
          onActivate();
        }
      }}
      role="option"
      tabIndex={0}
      aria-selected={selected}
      aria-label={track.name}
      title="Enter to select · F2 to focus"
    >
      <span className={styles.trackIndex}>{index}</span>
      <button
        type="button"
        className={cn(styles.disclosure, !hasProps && styles.disclosureHidden)}
        aria-label={expanded ? 'Collapse properties' : 'Reveal animated properties'}
        aria-expanded={expanded}
        title={expanded ? 'Collapse' : 'Reveal animated properties (U)'}
        onClick={(e) => {
          e.stopPropagation();
          if (hasProps) onToggleExpand();
        }}
      >
        <Icon name={expanded ? 'chevron-down' : 'chevron-right'} size={12} />
      </button>
      <span
        className={styles.trackIcon}
        style={{ color: track.color ?? 'var(--color-accent)' }}
        title={track.kind}
      >
        <Icon name={(track.icon as IconName) ?? 'layers'} size={14} />
      </span>
      <span className={styles.trackName} title={track.name}>{track.name}</span>
      <div className={styles.trackHeaderActions}>
        <button
          type="button"
          className={styles.trackAction}
          data-kind="visible"
          data-on={hidden || undefined}
          aria-label={hidden ? 'Show track' : 'Hide track'}
          title={hidden ? 'Show' : 'Hide'}
          onClick={(e) => { e.stopPropagation(); onToggleVisible(); }}
        >
          <Icon name={hidden ? 'eye-off' : 'eye'} size={12} />
        </button>
        <button
          type="button"
          className={styles.trackAction}
          data-kind="solo"
          data-on={solo || undefined}
          aria-label={solo ? 'Unsolo track' : 'Solo track'}
          title={solo ? 'Unsolo' : 'Solo (only soloed layers render)'}
          onClick={(e) => { e.stopPropagation(); onToggleSolo(); }}
        >
          <Icon name="circle" size={11} />
        </button>
        <button
          type="button"
          className={styles.trackAction}
          data-kind="lock"
          data-on={locked || undefined}
          aria-label={locked ? 'Unlock track' : 'Lock track'}
          title={locked ? 'Unlock' : 'Lock'}
          onClick={(e) => { e.stopPropagation(); onToggleLock(); }}
        >
          <Icon name="lock" size={12} />
        </button>
      </div>
    </div>
  );
}

function PropertyHeader({ label, style }: { label: string; style: CSSProperties }): JSX.Element {
  return (
    <div className={styles.propHeader} style={style}>
      <span className={styles.propName}>{label}</span>
    </div>
  );
}

/** A track's lane content: the calm animation block + (collapsed) keyframes. */
function TrackContent({
  track,
  expanded,
  ghosted,
  pps,
  trackHeight,
  top,
  kfPreview,
  onKeyframeDown,
  onKeyframeContextMenu,
  clipPreview,
  onClipDown,
  onClipContextMenu,
}: {
  track: TimelineTrack;
  expanded: boolean;
  ghosted: boolean;
  pps: number;
  trackHeight: number;
  top: number;
  kfPreview: { id: string; time: number } | null;
  onKeyframeDown: (kf: TimelineKeyframeRef, e: ReactPointerEvent<HTMLDivElement>) => void;
  onKeyframeContextMenu?: (keyframeId: string, clientX: number, clientY: number) => void;
  clipPreview: { id: string; start: number; duration: number } | null;
  onClipDown?: (clip: TimelineClip, mode: 'move' | 'start' | 'end', e: ReactPointerEvent<HTMLDivElement>) => void;
  onClipContextMenu?: (clipId: string, clientX: number, clientY: number) => void;
}): JSX.Element {
  const span = keyframeSpan(track.keyframes);
  return (
    <LaneRow top={top} trackHeight={trackHeight} ghosted={ghosted}>
      {/* Clips — draggable body (move) + edge handles (trim). */}
      {track.clips?.map((clip) => {
        const view = clipPreview && clipPreview.id === clip.id ? clipPreview : clip;
        return (
          <div
            key={clip.id}
            className={styles.clip}
            style={{
              transform: `translateX(${view.start * pps}px)`,
              width: Math.max(2, view.duration * pps),
              height: trackHeight - 6,
              // Category color as a subtle fill; the solid hue forms the border.
              background: clip.color
                ? `color-mix(in srgb, ${clip.color} 26%, transparent)`
                : 'var(--color-primary-subtle)',
              borderColor: clip.color ?? 'var(--color-primary)',
              cursor: onClipDown ? 'grab' : undefined,
            }}
            title={clip.label ?? clip.id}
            onPointerDown={onClipDown ? (e) => onClipDown(clip, 'move', e) : undefined}
            onContextMenu={
              onClipContextMenu
                ? (e) => {
                    e.preventDefault();
                    onClipContextMenu(clip.id, e.clientX, e.clientY);
                  }
                : undefined
            }
          >
            {onClipDown ? (
              <>
                <div
                  className={styles.clipHandle}
                  data-edge="start"
                  onPointerDown={(e) => onClipDown(clip, 'start', e)}
                />
                <div
                  className={styles.clipHandle}
                  data-edge="end"
                  onPointerDown={(e) => onClipDown(clip, 'end', e)}
                />
              </>
            ) : null}
            <span className={styles.clipLabel}>{clip.label ?? clip.id}</span>
          </div>
        );
      })}

      {/* Animation summary block — neutral bar spanning first→last keyframe.
          Color stays reserved for clips (the thing the user actually added). */}
      {span ? (
        <div
          className={styles.animBlock}
          style={{
            left: span.start * pps,
            width: Math.max(6, (span.end - span.start) * pps),
          }}
          title={`Animated ${span.start.toFixed(2)}s – ${span.end.toFixed(2)}s`}
        />
      ) : null}

      {/* Collapsed rows show the keyframes inline; expanded rows defer to props. */}
      {!expanded ? (
        <Keyframes
          keyframes={track.keyframes ?? []}
          pps={pps}
          kfPreview={kfPreview}
          onKeyframeDown={onKeyframeDown}
          onKeyframeContextMenu={onKeyframeContextMenu}
        />
      ) : null}
    </LaneRow>
  );
}

function LaneRow({
  top,
  trackHeight,
  ghosted,
  children,
}: {
  top: number;
  trackHeight: number;
  ghosted?: boolean;
  children: ReactNode;
}): JSX.Element {
  return (
    <div
      className={styles.laneRow}
      style={{ position: 'absolute', top, left: 0, right: 0, height: trackHeight, opacity: ghosted ? 0.32 : undefined }}
    >
      {children}
    </div>
  );
}

function Keyframes({
  keyframes,
  pps,
  kfPreview,
  onKeyframeDown,
  onKeyframeContextMenu,
}: {
  keyframes: ReadonlyArray<TimelineKeyframeRef>;
  pps: number;
  kfPreview: { id: string; time: number } | null;
  onKeyframeDown: (kf: TimelineKeyframeRef, e: ReactPointerEvent<HTMLDivElement>) => void;
  onKeyframeContextMenu?: (keyframeId: string, clientX: number, clientY: number) => void;
}): JSX.Element {
  return (
    <>
      {keyframes.map((kf) => {
        const dragging = kfPreview?.id === kf.id;
        const time = dragging ? kfPreview.time : kf.time;
        return (
          <div
            key={kf.id}
            className={cn(styles.keyframe, dragging && styles.keyframeDragging)}
            style={{ left: `${time * pps}px` }}
            onPointerDown={(e) => onKeyframeDown(kf, e)}
            onContextMenu={(e) => {
              e.preventDefault();
              onKeyframeContextMenu?.(kf.id, e.clientX, e.clientY);
            }}
            title={`${time.toFixed(2)}s — drag to move, right‑click to delete`}
          />
        );
      })}
    </>
  );
}

// ── Helpers ─────────────────────────────────────────────────────

/** First→last keyframe times, or null when there is nothing to summarize. */
function keyframeSpan(
  keyframes: ReadonlyArray<TimelineKeyframeRef> | undefined,
): { start: number; end: number } | null {
  if (!keyframes || keyframes.length < 2) return null;
  let start = Infinity;
  let end = -Infinity;
  for (const kf of keyframes) {
    if (kf.time < start) start = kf.time;
    if (kf.time > end) end = kf.time;
  }
  if (!Number.isFinite(start) || end <= start) return null;
  return { start, end };
}

function generateRulerTicks(durationSec: number, pps: number, fps: number): { x: number; major: boolean; label: string }[] {
  const targetPxBetweenMajor = 100;
  const candidateSec = [0.1, 0.25, 0.5, 1, 2, 5, 10, 30, 60, 120, 300, 600];
  let majorSec = 1;
  for (const c of candidateSec) {
    if (c * pps >= targetPxBetweenMajor) { majorSec = c; break; }
  }
  const minorSec = majorSec / 5;
  const ticks: { x: number; major: boolean; label: string }[] = [];
  for (let t = 0; t <= durationSec + 1e-6; t += minorSec) {
    const snapped = Math.round(t / minorSec) * minorSec;
    const isMajor = Math.abs((snapped / majorSec) - Math.round(snapped / majorSec)) < 1e-6;
    ticks.push({ x: snapped * pps, major: isMajor, label: formatTime(snapped, fps, majorSec) });
  }
  return ticks;
}

function formatTime(sec: number, _fps: number, majorSec: number): string {
  if (majorSec < 1) return `${(sec * 1000).toFixed(0)}ms`;
  if (majorSec < 60) return `${sec.toFixed(majorSec < 1 ? 2 : 0)}s`;
  const m = Math.floor(sec / 60);
  const s = sec - m * 60;
  return `${m}:${s.toFixed(0).padStart(2, '0')}`;
}
