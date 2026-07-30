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
  memo,
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
import { StopwatchButton, KeyframeNavigator } from '@components/PropertyRow';
import { keyframeShapes, keyframePaths, describeShapes } from './keyframeShape';
import { snapKeyframeGroup, type SnapTarget } from './keyframeSnap';
import { ValueField } from '@components/ValueField';
import { usePreferenceStore } from '@stores/preferenceStore';
import { useResizeObserver } from '@hooks/useResizeObserver';
import { clamp } from '@utils/lang';
import type {
  TimelineModel,
  TimelineTrack,
  TimelineKeyframeRef,
  TimelinePropertyTrack,
  TimelineClip,
} from './TimelineModel';
import { Dropdown } from '@components/Dropdown';
import { BLEND_MODES, type LayerBlendMode } from '@core/effects/blendMode';
import defaultSceneGraph from '@core/scene/DefaultSceneGraph';
import { useSelectionStore } from '@stores/selectionStore';
import { eligibleParents, parentOfNode } from '@core/scene/parenting';
import { useKeyframeSelectionStore } from '@stores/keyframeSelectionStore';
import {
  combineMarqueeSelection,
  exceedsDragThreshold,
  marqueeHitKeyframeIds,
  normalizeMarqueeRect,
  type MarqueeRect,
  type MarqueeRow,
} from './marqueeSelection';
import { audioEngine } from '@core/audio/AudioEngine';
import { waveformPath, peaksInRange } from '@core/audio/waveform';
import styles from './Timeline.module.css';
import { LABEL_COLORS } from '@core/scene/labelColor';

const RULER_HEIGHT_DEFAULT = 26;
const TRACK_HEIGHT_DEFAULT = 30;
const TRACK_HEADER_WIDTH_DEFAULT = 460;

/** A virtualized row is either a track summary row, a category accordion row, or a property sub-row. */
type Row =
  | { type: 'track'; track: TimelineTrack; expanded: boolean; hasProps: boolean }
  | { type: 'category'; track: TimelineTrack; categoryKey: string; label: string; icon: IconName; expanded: boolean; count: number }
  | { type: 'prop'; track: TimelineTrack; prop: TimelinePropertyTrack; categoryKey: string };

function getPropertyCategory(prop: TimelinePropertyTrack): { key: string; label: string; icon: IconName; order: number } {
  const p = prop.prop.toLowerCase();
  const label = (prop.label || '').toLowerCase();

  if (
    p.includes('anchor') ||
    p.includes('position') ||
    p === 'x' ||
    p === 'y' ||
    p === 'z' ||
    p.includes('scale') ||
    p.includes('rotation') ||
    p.includes('orientation') ||
    p.includes('opacity') ||
    label.includes('anchor') ||
    label.includes('position') ||
    label.includes('scale') ||
    label.includes('rotation') ||
    label.includes('opacity')
  ) {
    return { key: 'transform', label: 'Transform', icon: 'sliders-h', order: 1 };
  }

  if (
    p.includes('effect') ||
    p.includes('blur') ||
    p.includes('shadow') ||
    p.includes('glow') ||
    p.includes('filter') ||
    label.includes('effect') ||
    label.includes('blur') ||
    label.includes('shadow')
  ) {
    return { key: 'effects', label: 'Effects', icon: 'sparkles', order: 2 };
  }

  return { key: 'styles', label: 'Contents & Styles', icon: 'shape', order: 3 };
}

export interface TimelineProps {
  model: TimelineModel;
  onScrub?: (time: number) => void;
  /** Composition duration edit (seconds) from dragging the timeline end handle. */
  onDurationChange?: (duration: number) => void;
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
  /** Toggle a layer's AUDIO mute from its clip bar's speaker glyph. Distinct
   *  from the track's visibility eye, which mutes the picture. */
  onClipMuteToggle?: (nodeId: string) => void;
  onTrackToggleVisible?: (trackId: string) => void;
  onTrackToggleLock?: (trackId: string) => void;
  onTrackToggleSolo?: (trackId: string) => void;
  onTrackBlendModeChange?: (trackId: string, mode: LayerBlendMode) => void;
  onTrackMatteChange?: (trackId: string, matte: any) => void;
  onTrackParentChange?: (trackId: string, parentId: string | null) => void;
  onTrackToggleFlag?: (trackId: string, flag: 'shy' | 'collapse' | 'fxEnabled' | 'motionBlur' | 'adjustment' | 'threeD') => void;
  /** Rename a layer (confirmed on blur/Enter). */
  onTrackRename?: (trackId: string, newName: string) => void;
  onKeyframeSeek?: (keyframeId: string) => void;
  onKeyframeMove?: (keyframeId: string, time: number) => void;
  onKeyframeContextMenu?: (keyframeId: string, clientX: number, clientY: number) => void;
  /**
   * The keyframe navigator's diamond: add a keyframe at the playhead holding
   * the property's current value, or remove the one already there.
   */
  onPropertyKeyframeToggle?: (trackId: string, prop: string) => void;
  /**
   * A static placeholder row's stopwatch: create the first keyframe(s) for
   * the given engine props, enabling animation from the timeline (AE-style).
   */
  onPropertyStopwatch?: (trackId: string, props: ReadonlyArray<string>) => void;
  /**
   * The value to show in a property row's field, sampled at the playhead.
   * Supplied by the app because only it owns the scene + animation engine —
   * this component stays presentational.
   */
  onPropertyValue?: (trackId: string, prop: string) => number;
  /** Set a property's value from the timeline (keyframes when animated). */
  onPropertyValueChange?: (trackId: string, prop: string, value: number) => void;
  /** Called when user drags a track row to a new position. toIndex is 0-based. */
  onTrackReorder?: (fromId: string, toIndex: number) => void;
  onTrackColorChange?: (trackId: string, color: string) => void;
  className?: string;
  searchQuery?: string;
  globalShy?: boolean;
  /**
   * Playhead time in seconds, supplied SEPARATELY from `model` so playback
   * (60 fps) does not rebuild the model and force the entire row tree to
   * re-render. When set, the playhead visual, the per-property "at playhead"
   * markers, the playhead-keyboard nudge, and the PropertyHeader time all
   * read from this value; `model.currentTime` is then used only for
   * non-realtime consumers (GraphEditor, BottomTimeline timecode).
   */
  playheadTime?: number;
}

function Timeline({
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
  onClipMuteToggle,
  onTrackToggleVisible,
  onTrackToggleLock,
  onTrackToggleSolo,
  onTrackBlendModeChange,
  onTrackMatteChange,
  onTrackParentChange,
  onTrackToggleFlag,
  onTrackRename,
  onKeyframeSeek,
  onKeyframeMove,
  onKeyframeContextMenu,
  onPropertyKeyframeToggle,
  onPropertyStopwatch,
  onPropertyValue,
  onPropertyValueChange,
  onTrackReorder,
  onTrackColorChange,
  className,
  searchQuery,
  globalShy,
  onDurationChange,
  playheadTime,
}: TimelineProps): JSX.Element {
  const rulerHeight = model.rulerHeight ?? RULER_HEIGHT_DEFAULT;
  const trackHeight = model.trackHeight ?? TRACK_HEIGHT_DEFAULT;
  // The header column is user-resizable: property names + their value fields
  // need very different room depending on what's open, and a fixed column
  // either truncates labels or wastes half the panel. The model can still
  // pin a width (tests, embeds); otherwise it is the user's preference.
  const prefHeaderWidth = usePreferenceStore((s) => s.timelineHeaderWidth);
  const setPref = usePreferenceStore((s) => s.set);
  const headerWidth = model.trackHeaderWidth ?? prefHeaderWidth ?? TRACK_HEADER_WIDTH_DEFAULT;

  // Playhead is the one value that changes 60×/s during playback. We accept
  // it as a separate prop so the model can stay referentially stable and the
  // row tree (memos below) doesn't recompute. Fall back to model.currentTime
  // for callers that still pass the time inside the model.
  const currentTime = playheadTime ?? model.currentTime;

  const lanesRef = useRef<HTMLDivElement | null>(null);
  const headerRef = useRef<HTMLDivElement | null>(null);
  const { ref: containerRef, size } = useResizeObserver<HTMLDivElement>();
  const [scrollLeft, setScrollLeft] = useState(0);
  const [scrollTop, setScrollTop] = useState(0);

  const [, forceUpdate] = useState({});
  useEffect(() => {
    return audioEngine.onChange(() => forceUpdate({}));
  }, []);

  // ── Header column: resize + scroll ─────────────────────────────
  const resizeRef = useRef<{ startX: number; startW: number } | null>(null);
  const onHeaderResizeDown = useCallback((e: ReactPointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.stopPropagation();
    resizeRef.current = { startX: e.clientX, startW: headerWidth };
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
  }, [headerWidth]);

  const onHeaderResizeMove = useCallback((e: ReactPointerEvent<HTMLDivElement>) => {
    const st = resizeRef.current;
    if (!st) return;
    // Floor keeps the switch column reachable; ceiling keeps the lanes usable.
    setPref('timelineHeaderWidth', clamp(st.startW + (e.clientX - st.startX), 220, 900));
  }, [setPref]);

  const onHeaderResizeUp = useCallback((e: ReactPointerEvent<HTMLDivElement>) => {
    resizeRef.current = null;
    (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId);
    document.body.style.cursor = '';
    document.body.style.userSelect = '';
  }, []);

  /**
   * Scrolling over the header column scrolls the rows.
   *
   * The header is `overflow: hidden` and follows the lanes' scrollTop, so with
   * many rows a wheel over the names did nothing at all — you had to move the
   * pointer into the lanes to scroll. Forwarding the wheel keeps ONE scrollbar
   * (two would fight and drift) while making both halves scrollable.
   */
  const onHeaderWheel = useCallback((e: ReactWheelEvent<HTMLDivElement>) => {
    if (e.ctrlKey || e.metaKey) return; // zoom gesture — leave it to the root
    const lanes = lanesRef.current;
    if (!lanes) return;
    lanes.scrollTop += e.deltaY;
  }, []);

  // ── Category accordion collapse state ──
  const [collapsedCategoryKeys, setCollapsedCategoryKeys] = useState<Set<string>>(new Set());
  const toggleCategory = useCallback((trackId: string, categoryKey: string) => {
    const key = `${trackId}:${categoryKey}`;
    setCollapsedCategoryKeys((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }, []);

  // ── Flatten tracks + expanded property sub-rows into a uniform row list ──
  const expanded = useMemo(() => new Set(expandedTrackIds ?? []), [expandedTrackIds]);
  const revealSet = useMemo(
    () => (revealProps ? new Set(revealProps) : null),
    [revealProps],
  );
  const rows = useMemo<Row[]>(() => {
    const out: Row[] = [];
    const query = searchQuery?.trim().toLowerCase();

    for (const track of model.tracks) {
      if (globalShy && (track as any).shy) {
        continue;
      }
      const trackName = (track.name ?? '').toLowerCase();
      const hasProps = (track.properties?.length ?? 0) > 0 || track.isGroup === true;
      
      const layerMatches = !query || trackName.includes(query);
      const matchingProps = query && track.properties
        ? track.properties.filter(
            (p) =>
              p.prop.toLowerCase().includes(query) ||
              (p.label ?? '').toLowerCase().includes(query)
          )
        : [];
      
      const hasMatchingProps = matchingProps.length > 0;
      
      if (!query || layerMatches || hasMatchingProps) {
        const isExpanded = hasProps && (expanded.has(track.id) || hasMatchingProps);
        out.push({ type: 'track', track, expanded: isExpanded, hasProps });
        
        if (track.properties) {
          let shownProps = track.properties;
          if (query) {
            if (hasMatchingProps) {
              shownProps = matchingProps;
            } else if (layerMatches && isExpanded) {
              shownProps = revealSet
                ? track.properties.filter((p) => revealSet.has(p.prop))
                : track.properties;
            } else {
              shownProps = [];
            }
          } else {
            if (isExpanded) {
              shownProps = revealSet
                ? track.properties.filter((p) => revealSet.has(p.prop))
                : track.properties;
            } else {
              shownProps = [];
            }
          }
          
          if (shownProps.length > 0) {
            // Group shownProps by category
            const catMap = new Map<string, { key: string; label: string; icon: IconName; order: number; props: TimelinePropertyTrack[] }>();
            for (const prop of shownProps) {
              const cat = getPropertyCategory(prop);
              if (!catMap.has(cat.key)) {
                catMap.set(cat.key, { ...cat, props: [] });
              }
              catMap.get(cat.key)!.props.push(prop);
            }

            const sortedCats = Array.from(catMap.values()).sort((a, b) => a.order - b.order);

            for (const cat of sortedCats) {
              const catKey = `${track.id}:${cat.key}`;
              const isCatExpanded = !collapsedCategoryKeys.has(catKey);
              out.push({
                type: 'category',
                track,
                categoryKey: cat.key,
                label: cat.label,
                icon: cat.icon,
                expanded: isCatExpanded,
                count: cat.props.length,
              });

              if (isCatExpanded) {
                for (const prop of cat.props) {
                  out.push({ type: 'prop', track, prop, categoryKey: cat.key });
                }
              }
            }
          }
        }
      }
    }
    return out;
  }, [model.tracks, expanded, revealSet, searchQuery, globalShy, collapsedCategoryKeys]);

  // Left margin offset so 0s indicator & playhead head stand clear of header border
  const TIMELINE_LEFT_OFFSET = 8;

  // ── Derived geometry ───────────────────────────────────────────
  const totalSeconds = Math.max(model.duration, 1);
  const pps = model.pixelsPerSecond;
  // Lanes extend past the comp end when clips overhang it (AE-style), so an
  // overhanging bar stays visible/scrollable instead of clipping at the edge.
  const contentSeconds = useMemo(() => {
    let max = totalSeconds;
    for (const t of model.tracks) {
      for (const c of t.clips ?? []) max = Math.max(max, c.start + c.duration);
    }
    return max;
  }, [model.tracks, totalSeconds]);
  const laneWidth = TIMELINE_LEFT_OFFSET + (contentSeconds + 1) * pps;
  const totalLanesHeight = rows.length * trackHeight;
  const effectiveLanesHeight = Math.max(totalLanesHeight, Math.max(0, size.height - rulerHeight));

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

  // ── Scrubbing / playhead drag ──────────────────────────────────
  const draggingRef = useRef(false);
  const onPlayheadDown = useCallback((e: ReactPointerEvent<HTMLDivElement>) => {
    if (!lanesRef.current) return;
    draggingRef.current = true;
    const rect = lanesRef.current.getBoundingClientRect();
    const x = e.clientX - rect.left + lanesRef.current.scrollLeft - TIMELINE_LEFT_OFFSET;
    const time = clamp(x / pps, 0, totalSeconds);
    onScrub?.(time);
    document.body.style.cursor = 'ew-resize';
    document.body.style.userSelect = 'none';
  }, [lanesRef, pps, totalSeconds, onScrub, TIMELINE_LEFT_OFFSET]);
  useEffect(() => {
    const onMove = (e: PointerEvent): void => {
      if (!draggingRef.current || !lanesRef.current) return;
      const rect = lanesRef.current.getBoundingClientRect();
      const x = e.clientX - rect.left + scrollLeft - TIMELINE_LEFT_OFFSET;
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
  }, [pps, scrollLeft, totalSeconds, onScrub, TIMELINE_LEFT_OFFSET]);

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

  // ── Composition duration drag (extend / shorten video length) ────
  const startDurationDrag = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!onDurationChange) return;
    e.preventDefault();
    e.stopPropagation();
    const startX = e.clientX;
    const startDuration = model.duration;
    const owner = e.currentTarget;
    try {
      owner.setPointerCapture(e.pointerId);
    } catch {
      // best-effort
    }

    const onPointerMove = (moveEvent: PointerEvent) => {
      const deltaX = moveEvent.clientX - startX;
      const deltaSec = deltaX / pps;
      const newDuration = Math.max(0.1, startDuration + deltaSec);
      
      // Snap to frames
      const fps = model.frameRate || 30;
      const frameIndex = Math.round(newDuration * fps);
      const snappedDuration = Math.max(1 / fps, frameIndex / fps);
      
      onDurationChange?.(snappedDuration);
    };

    const onPointerUp = (upEvent: PointerEvent) => {
      try {
        owner.releasePointerCapture(upEvent.pointerId);
      } catch {
        // best-effort
      }
      window.removeEventListener('pointermove', onPointerMove);
      window.removeEventListener('pointerup', onPointerUp);
    };

    window.addEventListener('pointermove', onPointerMove);
    window.addEventListener('pointerup', onPointerUp);
  };

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
        startX: e.clientX - lanesRect.left + lanesRef.current.scrollLeft,
        start: clip.start,
        duration: clip.duration,
        live: { start: clip.start, duration: clip.duration },
      };
      setClipPreview({ id: clip.id, start: clip.start, duration: clip.duration });
      try {
        lanesRef.current.setPointerCapture(e.pointerId);
      } catch {
        /* best-effort capture */
      }
      document.body.style.userSelect = 'none';
    },
    [onClipMove, onClipTrim],
  );

  useEffect(() => {
    const onMove = (e: PointerEvent): void => {
      const d = clipDrag.current;
      if (!d || !lanesRef.current) return;
      const lanesRect = lanesRef.current.getBoundingClientRect();
      const currentScrollLeft = lanesRef.current.scrollLeft;
      const deltaSec = (e.clientX - lanesRect.left + currentScrollLeft - d.startX) / pps;
      const frameDur = 1 / (model.frameRate || 30);
      const minGap = frameDur;
      // Snap to the frame grid DURING the drag — the engine stores whole
      // frames, so an unsnapped preview visibly jumped on release. Alt frees
      // the drag (same convention as keyframe drags); the engine still rounds
      // to a whole frame on commit.
      const snapToFrame = (v: number): number => Math.round(v / frameDur) * frameDur;
      const passThrough = (v: number): number => v;
      const snap = e.altKey ? passThrough : snapToFrame;
      let start = d.start;
      let duration = d.duration;
      // AE semantics: clip bars may OVERHANG the composition end freely (the
      // render simply stops at the comp bound) — only the left edge pins at 0.
      // Clamping to totalSeconds made full-comp clips immovable and turned
      // every "expand" gesture into a shrink.
      if (d.mode === 'move') {
        start = snap(Math.max(0, d.start + deltaSec));
      } else if (d.mode === 'start') {
        const end = d.start + d.duration;
        start = snap(clamp(d.start + deltaSec, 0, end - minGap));
        start = Math.min(start, end - minGap);
        duration = end - start;
      } else {
        const end = snap(Math.max(d.start + minGap, d.start + d.duration + deltaSec));
        duration = Math.max(minGap, end - d.start);
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
  }, [pps, totalSeconds, onClipMove, onClipTrim, model.frameRate]);

  // ── Playhead keyboard nudge (role="slider" must be operable) ──
  // Arrow keys step one frame; Shift steps one second; Home/End jump to bounds.
  const onPlayheadKey = useCallback(
    (e: React.KeyboardEvent<HTMLDivElement>) => {
      const frame = 1 / (model.frameRate || 30);
      let next: number | null = null;
      switch (e.key) {
        case 'ArrowLeft':
          next = currentTime - (e.shiftKey ? 1 : frame);
          break;
        case 'ArrowRight':
          next = currentTime + (e.shiftKey ? 1 : frame);
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
    [model.frameRate, currentTime, totalSeconds, onScrub],
  );

  // ── Track row reorder ──────────────────────────────────────────────────────
  const rowDrag = useRef<{ id: string; startY: number; currentIndex: number } | null>(null);
  const [rowDragOver, setRowDragOver] = useState<number | null>(null);

  useEffect(() => {
    const onMove = (e: PointerEvent): void => {
      const d = rowDrag.current;
      if (!d || !headerRef.current) return;
      const rect = headerRef.current.getBoundingClientRect();
      const relY = e.clientY - rect.top + (headerRef.current.scrollTop ?? 0);
      const idx = Math.max(0, Math.min(rows.length, Math.round(relY / trackHeight)));
      setRowDragOver(idx);
    };
    const onUp = (): void => {
      const d = rowDrag.current;
      if (!d) return;
      const idx = rowDragOver;
      rowDrag.current = null;
      setRowDragOver(null);
      document.body.style.userSelect = '';
      if (idx === null) return;
      // The pixel math yields FLATTENED row indices (which include expanded
      // property sub-rows), but reorder consumers expect a sibling/track
      // index — convert both sides, else drops land at the wrong position
      // whenever any layer above is expanded.
      const toTrackIndex = (flatIdx: number): number =>
        rows.slice(0, Math.max(0, Math.min(flatIdx, rows.length))).filter((r) => r.type === 'track').length;
      const to = toTrackIndex(idx);
      const from = toTrackIndex(d.currentIndex);
      if (to !== from && to !== from + 1) {
        onTrackReorder?.(d.id, to);
      }
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    return () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
    };
  }, [rows, trackHeight, rowDragOver, onTrackReorder]);

  // ── Multi-keyframe selection ────────────────────────────────────────────────
  const [selectedKfIds, setSelectedKfIds] = useState<Set<string>>(new Set());
  // Mirror the selection into a store so sibling surfaces (the timeline easing
  // pills in BottomTimeline) can act on the same keyframes.
  const syncKfSelection = useKeyframeSelectionStore((s) => s.set);
  useEffect(() => {
    syncKfSelection(selectedKfIds);
  }, [selectedKfIds, syncKfSelection]);
  const activeKf = useRef<{ ids: string[]; times: Map<string, number>; startX: number; moved: boolean } | null>(null);
  const [kfPreview, setKfPreview] = useState<Map<string, number>>(new Map());

  // Build a lookup from keyframe id → time across all visible tracks
  const kfTimeById = useMemo<Map<string, number>>(() => {
    const m = new Map<string, number>();
    for (const track of model.tracks) {
      for (const kf of track.keyframes ?? []) m.set(kf.id, kf.time);
      for (const prop of track.properties ?? []) {
        for (const kf of prop.keyframes) m.set(kf.id, kf.time);
      }
    }
    return m;
  }, [model.tracks]);

  const onKeyframeDown = useCallback((kf: TimelineKeyframeRef, e: ReactPointerEvent<HTMLDivElement>) => {
    e.stopPropagation();
    
    // Compute next selection synchronously to avoid stale closure in drag start
    const nextSel = new Set(selectedKfIds);
    if (e.shiftKey) {
      if (nextSel.has(kf.id)) nextSel.delete(kf.id);
      else nextSel.add(kf.id);
    } else {
      if (!nextSel.has(kf.id)) { nextSel.clear(); nextSel.add(kf.id); }
    }
    setSelectedKfIds(nextSel);

    const times = new Map<string, number>();
    for (const id of nextSel) {
      const t = id === kf.id ? kf.time : (kfTimeById.get(id) ?? 0);
      times.set(id, t);
    }
    activeKf.current = { ids: [...nextSel], times, startX: e.clientX, moved: false };

    setKfPreview(new Map());
  }, [selectedKfIds, kfTimeById]);

  /** What the in-flight drag is snapped to — drives the indicator line. */
  const [kfSnap, setKfSnap] = useState<SnapTarget | null>(null);

  useEffect(() => {
    const onMove = (e: PointerEvent): void => {
      const d = activeKf.current;
      if (!d || !lanesRef.current) return;
      const dx = e.clientX - d.startX;
      if (!d.moved && Math.abs(dx) < 3) return;
      d.moved = true;
      const dtSec = dx / pps;
      const frameDur = 1 / (model.frameRate || 30);

      // Snap to the playhead, then to other keyframes, then to the frame grid.
      // Alt frees the drag entirely. The dragged keys are excluded from the
      // target list — a keyframe must not snap to itself.
      const dragging = new Set(d.ids);
      const others: number[] = [];
      for (const [id, t] of kfTimeById) if (!dragging.has(id)) others.push(t);

      const moved = [...d.times.values()].map((t) => t + dtSec);
      const { delta, target } = snapKeyframeGroup(moved, {
        pixelsPerSecond: pps,
        frameDuration: frameDur,
        playheadTime: model.currentTime,
        keyframeTimes: others,
        disabled: e.altKey,
      });
      setKfSnap(target);

      const newPreview = new Map<string, number>();
      for (const [id, origTime] of d.times) {
        newPreview.set(id, Math.max(0, origTime + dtSec + delta));
      }
      setKfPreview(newPreview);
    };
    const onUp = (): void => {
      const d = activeKf.current;
      if (!d) return;
      activeKf.current = null;
      setKfSnap(null);
      if (d.moved) {
        // Commit moves for all dragged keyframes
        for (const [id, origTime] of d.times) {
          const dtSec = (kfPreview.get(id) ?? origTime) - origTime;
          onKeyframeMove?.(id, Math.max(0, origTime + dtSec));
        }
      } else {
        // Click without move → seek
        const singleId = d.ids[0];
        if (singleId) onKeyframeSeek?.(singleId);
      }
      setKfPreview(new Map());
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    return () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
    };
  }, [pps, scrollLeft, totalSeconds, onKeyframeMove, onKeyframeSeek, kfPreview]);

  // ── Marquee (rubber-band) keyframe selection ──────────────────
  // Pointer-down on EMPTY lane space (not a keyframe, clip, playhead, marker
  // flag — those either stopPropagation or are guarded below) starts a drag
  // that draws a translucent rect and live-selects every keyframe it touches.
  // Shift at drag START adds to the existing selection; a plain click with no
  // movement clears it. Rows list is the FULL flattened list (not just the
  // virtualized window), so the rect selects across offscreen rows too.
  const marqueeRows = useMemo<ReadonlyArray<MarqueeRow>>(
    () =>
      rows.map((row) =>
        row.type === 'prop'
          ? { keyframes: row.prop.keyframes }
          : // Collapsed summary rows stand in for their property keyframes
            // (track.keyframes is the flat union, same ids); expanded rows
            // defer to the property sub-rows that follow them.
            { keyframes: row.expanded ? [] : (row.track.keyframes ?? []) },
      ),
    [rows],
  );
  const marqueeDrag = useRef<
    null | { x0: number; y0: number; additive: boolean; base: Set<string>; moved: boolean }
  >(null);
  const [marqueeRect, setMarqueeRect] = useState<MarqueeRect | null>(null);

  /** Pointer position → lane content coords (x from t=0, y from first row). */
  const lanesPoint = useCallback(
    (clientX: number, clientY: number): { x: number; y: number } | null => {
      const lanes = lanesRef.current;
      if (!lanes) return null;
      const rect = lanes.getBoundingClientRect();
      return {
        x: Math.max(0, clientX - rect.left + lanes.scrollLeft - TIMELINE_LEFT_OFFSET),
        y: clamp(clientY - rect.top + lanes.scrollTop - rulerHeight, 0, effectiveLanesHeight),
      };
    },
    [rulerHeight, effectiveLanesHeight, TIMELINE_LEFT_OFFSET],
  );

  const onLanesPointerDown = useCallback(
    (e: ReactPointerEvent<HTMLDivElement>) => {
      if (e.button !== 0) return;
      // Keyframes and clips stopPropagation in their own handlers; the
      // playhead and marker flags do not, so guard them (and re-guard the
      // others defensively) before claiming the gesture.
      const target = e.target as HTMLElement;
      if (
        target.closest(`.${styles.playhead}`) ||
        target.closest(`.${styles.keyframe}`) ||
        target.closest(`.${styles.clip}`) ||
        target.closest(`.${styles.markerFlag}`)
      ) {
        return;
      }
      const p = lanesPoint(e.clientX, e.clientY);
      if (!p) return;
      marqueeDrag.current = {
        x0: p.x,
        y0: p.y,
        additive: e.shiftKey,
        base: new Set(selectedKfIds),
        moved: false,
      };
      document.body.style.userSelect = 'none';
    },
    [lanesPoint, selectedKfIds],
  );

  useEffect(() => {
    const onMove = (e: PointerEvent): void => {
      const d = marqueeDrag.current;
      if (!d) return;
      const p = lanesPoint(e.clientX, e.clientY);
      if (!p) return;
      if (!d.moved && !exceedsDragThreshold(p.x - d.x0, p.y - d.y0)) return;
      d.moved = true;
      const rect = normalizeMarqueeRect(d.x0, d.y0, p.x, p.y);
      setMarqueeRect(rect);
      const hits = marqueeHitKeyframeIds(marqueeRows, rect, {
        pixelsPerSecond: pps,
        trackHeight,
      });
      setSelectedKfIds(combineMarqueeSelection(d.base, hits, d.additive));
    };
    const onUp = (): void => {
      const d = marqueeDrag.current;
      if (!d) return;
      marqueeDrag.current = null;
      setMarqueeRect(null);
      document.body.style.userSelect = '';
      // Marquee selection was applied live — release just clears the rect.
      // A plain click (no movement) on empty space clears the selection;
      // Shift+click on empty space leaves it untouched.
      if (!d.moved && !d.additive) setSelectedKfIds(new Set());
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    return () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
    };
  }, [lanesPoint, marqueeRows, pps, trackHeight]);

  // ── Keyframe selection keyboard shortcuts ──────────────────────
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent): void => {
      const target = e.target as HTMLElement | null;
      if (
        target?.tagName === 'INPUT' ||
        target?.tagName === 'TEXTAREA' ||
        target?.isContentEditable
      ) {
        return;
      }
      if (e.key === 'Delete' || e.key === 'Backspace') {
        if (selectedKfIds.size > 0) {
          selectedKfIds.forEach(id => onKeyframeMove?.(id, -1)); // -1 signals delete
          setSelectedKfIds(new Set());
        }
      }
      if ((e.ctrlKey || e.metaKey) && e.key === 'a') {
        // Select all keyframes across all tracks
        const allIds = new Set<string>();
        model.tracks.forEach(t => t.keyframes?.forEach(kf => allIds.add(kf.id)));
        setSelectedKfIds(allIds);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [selectedKfIds, model.tracks, onKeyframeMove]);

  // ── Ruler ticks ────────────────────────────────────────────────
  const ticks = useMemo(
    () => generateRulerTicks(totalSeconds, pps, model.frameRate, (model.startFrame ?? 0) / (model.frameRate || 30), TIMELINE_LEFT_OFFSET),
    [totalSeconds, pps, model.frameRate, model.startFrame, TIMELINE_LEFT_OFFSET],
  );

  // Layer number column (AE-style) — index within the track order.
  const trackIndexById = useMemo(
    () => new Map(model.tracks.map((t, i) => [t.id, i + 1])),
    [model.tracks],
  );

  const playheadX = TIMELINE_LEFT_OFFSET + currentTime * pps;

  return (
    <div ref={containerRef} className={cn(styles.root, className)} onWheel={onWheel}>
      <div
        className={styles.headerCol}
        style={{ width: headerWidth, height: '100%' }}
        onWheel={onHeaderWheel}
      >
        <div className={styles.ruler} style={{ height: rulerHeight }}>
          {/* Column heads for the switches and modes (AE layout). */}
          <div className={styles.colHeads} aria-hidden>
            <span className={styles.colHeadLayer} style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <span>Layer Name</span>
              <button
                type="button"
                onClick={() => {
                  const url = `${window.location.origin}${window.location.pathname}#/popout/timeline`;
                  window.open(url, 'popout-timeline', 'width=1280,height=500,resizable=yes');
                }}
                title="Pop Out Timeline into Separate Window"
                style={{ background: 'transparent', border: 'none', color: 'rgba(255, 255, 255, 0.6)', cursor: 'pointer', padding: 2, display: 'inline-flex' }}
              >
                <Icon name="export" size={12} />
              </button>
            </span>
            <span className={styles.colHeadMode}>Mode</span>
            <span className={styles.colHeadMatte}>Track Matte</span>
            <span className={styles.colHeadParent}>Parent & Link</span>
            <span className={styles.colHeadAeSwitches}>
              {/* Legend for the per-layer switch column below (AE shows the
                  same glyphs in its column head — five unlabeled dots were
                  unguessable for new users). */}
              <Icon name="shy" size={9} title="Shy" />
              <span className={styles.fxText} title="Effects" style={{ fontSize: 8 }}>fx</span>
              <Icon name="motion-blur" size={9} title="Motion Blur" />
              <Icon name="adjustment" size={9} title="Adjustment Layer" />
              <Icon name="3d" size={9} title="3D Layer" />
            </span>
            <span className={styles.colHeadSwitches}>Switches</span>
          </div>
        </div>
        <div
          ref={headerRef}
          className={styles.trackHeaderScroller}
          style={{ height: `calc(100% - ${rulerHeight}px)` }}
        >
          <div style={{ height: effectiveLanesHeight, position: 'relative' }}>
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
                    onBlendModeChange={(mode) => onTrackBlendModeChange?.(row.track.id, mode)}
                    onMatteChange={(matte) => onTrackMatteChange?.(row.track.id, matte)}
                    onParentChange={(parentId) => onTrackParentChange?.(row.track.id, parentId)}
                    onToggleFlag={(flag) => onTrackToggleFlag?.(row.track.id, flag)}
                    onRename={(name) => onTrackRename?.(row.track.id, name)}
                    onTrackColorChange={onTrackColorChange}
                    onReorderStart={(e) => {
                      rowDrag.current = { id: row.track.id, startY: e.clientY, currentIndex: realIndex };
                      document.body.style.userSelect = 'none';
                    }}
                    style={rowStyle}
                  />
                );
              }
              if (row.type === 'category') {
                const categoryStyle: CSSProperties = {
                  ...rowStyle,
                  paddingLeft: 32 + (row.track.depth ?? 0) * 16,
                };
                return (
                  <TrackCategoryHeader
                    key={`h_${row.track.id}_cat_${row.categoryKey}`}
                    label={row.label}
                    icon={row.icon}
                    expanded={row.expanded}
                    count={row.count}
                    style={categoryStyle}
                    onToggle={() => toggleCategory(row.track.id, row.categoryKey)}
                  />
                );
              }
              const propStyle: CSSProperties = {
                ...rowStyle,
                paddingLeft: 56 + (row.track.depth ?? 0) * 16,
              };
              return (
                <PropertyHeader
                  key={`h_${row.track.id}_${row.prop.prop}`}
                  label={row.prop.label}
                  style={propStyle}
                  keyframes={row.prop.keyframes}
                  currentTime={currentTime}
                  animated={row.prop.animated !== false}
                  onToggleKeyframe={
                    onPropertyKeyframeToggle
                      ? () => onPropertyKeyframeToggle(row.track.id, row.prop.prop)
                      : undefined
                  }
                  onStopwatch={
                    onPropertyStopwatch && row.prop.stopwatchProps
                      ? () => onPropertyStopwatch(row.track.id, row.prop.stopwatchProps!)
                      : undefined
                  }
                  valueProps={row.prop.valueProps}
                  valueUnit={row.prop.valueUnit}
                  propertyValue={
                    onPropertyValue ? (p) => onPropertyValue(row.track.id, p) : undefined
                  }
                  onValueChange={
                    onPropertyValueChange
                      ? (p, v) => onPropertyValueChange(row.track.id, p, v)
                      : undefined
                  }
                  onSeek={onScrub}
                />
              );
            })}
            {/* Drop indicator — horizontal line showing insertion target during row drag */}
            {rowDragOver !== null && (
              <div
                className={styles.dropIndicator}
                style={{ top: rowDragOver * trackHeight }}
                aria-hidden
              />
            )}
          </div>
        </div>
      </div>

      {/* Drag the column edge to widen the header (AE-style). */}
      <div
        className={styles.headerResizer}
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize track header column"
        onPointerDown={onHeaderResizeDown}
        onPointerMove={onHeaderResizeMove}
        onPointerUp={onHeaderResizeUp}
        onDoubleClick={() => setPref('timelineHeaderWidth', TRACK_HEADER_WIDTH_DEFAULT)}
        title="Drag to resize · double-click to reset"
      />
      <div ref={lanesRef} className={styles.lanes} onScroll={onLanesScroll}>
        <div
          style={{
            width: laneWidth,
            minWidth: '100%',
            height: rulerHeight + effectiveLanesHeight,
            position: 'relative',
          }}
        >
          <Ruler ticks={ticks} height={rulerHeight} width={laneWidth} onPointerDown={onPlayheadDown} />

          {/* RAM-preview cache bar */}
          {model.cachedRanges?.map((r, i) => (
            <div
              key={`cache_${i}`}
              className={styles.cacheBar}
              style={{ left: TIMELINE_LEFT_OFFSET + r.start * pps, width: Math.max(1, (r.end - r.start) * pps), top: rulerHeight - 3 }}
              aria-hidden
            />
          ))}

          {/* Work-area band on the ruler (in/out region for looped playback).
              Drag the body to move it; drag an edge handle to trim in/out. */}
          {model.workArea ? (
            <div
              className={styles.workAreaBar}
              style={{
                top: 0,
                height: rulerHeight,
                left: TIMELINE_LEFT_OFFSET + model.workArea.start * pps,
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

          {/* Composition duration drag handle on the ruler */}
          {onDurationChange ? (
            <div
              className={styles.durationHandle}
              style={{
                position: 'absolute',
                top: 0,
                height: rulerHeight + effectiveLanesHeight,
                left: TIMELINE_LEFT_OFFSET + model.duration * pps,
                width: 8,
                transform: 'translateX(-4px)',
                cursor: 'ew-resize',
                zIndex: 25,
              }}
              title="Drag to adjust composition duration"
              onPointerDown={startDurationDrag}
            >
              {/* The visual line */}
              <div
                style={{
                  position: 'absolute',
                  left: 3,
                  top: 0,
                  width: 2,
                  height: '100%',
                  backgroundColor: 'var(--color-primary)',
                  opacity: 0.8,
                }}
              />
              {/* The handle cap on the ruler */}
              <div
                style={{
                  position: 'absolute',
                  left: 0,
                  top: 0,
                  width: 8,
                  height: 8,
                  backgroundColor: 'var(--color-primary)',
                  borderRadius: '0 0 4px 4px',
                }}
              />
            </div>
          ) : null}

          <div
            className={styles.lanesInner}
            style={{ position: 'absolute', top: rulerHeight, left: 0, right: 0, height: effectiveLanesHeight }}
            onPointerDown={onLanesPointerDown}
          >
            {/* Snap indicator — a vertical line at whatever the in-flight drag
                latched onto. Without it, snapping is a mystery force: the
                keyframe stops where you did not put it and nothing says why. */}
            {kfSnap && (
              <div
                className={cn(
                  styles.kfSnapLine,
                  kfSnap.kind === 'playhead' && styles.kfSnapPlayhead,
                  kfSnap.kind === 'keyframe' && styles.kfSnapKeyframe,
                )}
                style={{ transform: `translateX(${8 + kfSnap.time * pps}px)` }}
                aria-hidden
              />
            )}

            {/* Row backgrounds */}
            {visibleRows.map((row, i) => {
              const realIndex = startRow + i;
              const key = row.type === 'track'
                ? `bg_${row.track.id}`
                : row.type === 'category'
                ? `bg_${row.track.id}_cat_${row.categoryKey}`
                : `bg_${row.track.id}_${row.prop.prop}`;
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
                    ghosted={row.track.ghosted ?? false}
                    pps={pps}
                    trackHeight={trackHeight}
                    top={top}
                    clipPreview={clipPreview}
                    onClipDown={onClipDown}
                    onClipContextMenu={onClipContextMenu}
                    onActivate={onTrackActivate}
                    clipMuted={row.track.audioMuted}
                    onClipMuteToggle={onClipMuteToggle}
                  />
                );
              }
              if (row.type === 'category') {
                return (
                  <LaneRow key={`c_${row.track.id}_cat_${row.categoryKey}`} top={top} trackHeight={trackHeight}>
                    <div />
                  </LaneRow>
                );
              }
              return (
                <LaneRow key={`c_${row.track.id}_${row.prop.prop}`} top={top} trackHeight={trackHeight}>
                  <Keyframes
                    keyframes={row.prop.keyframes}
                    pps={pps}
                    kfPreview={kfPreview}
                    selectedKfIds={selectedKfIds}
                    onKeyframeDown={onKeyframeDown}
                    onKeyframeContextMenu={onKeyframeContextMenu}
                  />
                </LaneRow>
              );
            })}

            {/* Past-comp-end shade — clips may overhang the composition (AE-style);
                this darkens the region beyond the comp so the bound stays legible. */}
            {contentSeconds > totalSeconds ? (
              <div
                className={styles.pastEndShade}
                style={{
                  left: TIMELINE_LEFT_OFFSET + totalSeconds * pps,
                  width: (contentSeconds + 1 - totalSeconds) * pps,
                  height: effectiveLanesHeight,
                }}
                aria-hidden
              />
            ) : null}

            {/* Work-area tint spanning all lanes (visual context for the region). */}
            {model.workArea ? (
              <div
                className={styles.workAreaTint}
                style={{
                  left: TIMELINE_LEFT_OFFSET + model.workArea.start * pps,
                  width: Math.max(2, (model.workArea.end - model.workArea.start) * pps),
                  height: effectiveLanesHeight,
                }}
                aria-hidden
              />
            ) : null}

            {/* Markers */}
            {model.markers.map((m) => (
              <div
                key={m.id}
                className={styles.marker}
                style={{ transform: `translateX(${TIMELINE_LEFT_OFFSET + m.time * pps}px)` }}
                aria-hidden
              >
                <span className={styles.markerFlag} title={m.label}>
                  <Icon name="marker" size={12} />
                </span>
              </div>
            ))}

            {/* Marquee selection rectangle (drag on empty lane space). */}
            {marqueeRect ? (
              <div
                className={styles.marquee}
                style={{
                  left: marqueeRect.left,
                  top: marqueeRect.top,
                  width: marqueeRect.right - marqueeRect.left,
                  height: marqueeRect.bottom - marqueeRect.top,
                }}
                aria-hidden
              />
            ) : null}

            {/* Playhead */}
            <div
              className={styles.playhead}
              style={{ transform: `translateX(${playheadX}px)`, height: effectiveLanesHeight }}
              onPointerDown={onPlayheadDown}
              onKeyDown={onPlayheadKey}
              tabIndex={0}
              role="slider"
              aria-label="Playhead"
              aria-orientation="horizontal"
              aria-valuemin={0}
              aria-valuemax={model.duration}
              aria-valuenow={currentTime}
              aria-valuetext={`${currentTime.toFixed(2)} seconds`}
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

/**
 * Memoize so that the row tree (and its many sub-memos) does not re-run
 * whenever the host re-renders for an unrelated reason — the entire point
 * of the `playheadTime` prop is that the model can stay referentially
 * stable across playback frames, and a plain `React.memo` on this entry
 * point makes that promise real.
 *
 * The file is consumed as `import { Timeline } from './Timeline'`; this
 * `React.memo` wrap is what that name resolves to, so consumers get the
 * skipped-render behavior for free.
 */
const MemoizedTimeline = memo(Timeline);
export { MemoizedTimeline as Timeline };

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
  onPointerDown,
}: {
  ticks: { x: number; major: boolean; label: string }[];
  height: number;
  width: number;
  onPointerDown?: (e: ReactPointerEvent<HTMLDivElement>) => void;
}): JSX.Element {
  return (
    <div className={styles.ruler} style={{ height, width }} onPointerDown={onPointerDown}>
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

// Label colours come from the ONE palette in `core/scene/labelColor`. This file
// used to carry its own 12 hexes, so the same layer showed a different red in the
// timeline than in the scene tree and the canvas menu — three palettes for one
// property. (A fourth lived in the since-removed Motion Tools panel, which also
// wrote `node.color` directly instead of through `setNodeLabelColor`, so its
// choice never even saved.)

const TrackHeader = memo(function TrackHeader({
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
  onBlendModeChange,
  onMatteChange,
  onParentChange,
  onToggleFlag,
  onRename,
  onTrackColorChange,
  onReorderStart,
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
  onBlendModeChange?: (mode: LayerBlendMode) => void;
  onMatteChange?: (matte: any) => void;
  onParentChange?: (parentId: string | null) => void;
  onToggleFlag?: (flag: 'shy' | 'collapse' | 'fxEnabled' | 'motionBlur' | 'adjustment' | 'threeD') => void;
  onRename?: (newName: string) => void;
  onTrackColorChange?: (trackId: string, color: string) => void;
  onReorderStart?: (e: ReactPointerEvent<HTMLDivElement>) => void;
  style: CSSProperties;
}): JSX.Element {
  const hidden = track.muted === true;
  const locked = track.locked === true;
  const solo = track.solo === true;

  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(track.name);
  const inputRef = useRef<HTMLInputElement>(null);

  const startRename = (e: React.MouseEvent): void => {
    e.stopPropagation();
    setDraft(track.name);
    setEditing(true);
    setTimeout(() => { inputRef.current?.select(); }, 10);
  };
  const commitRename = (): void => {
    setEditing(false);
    const trimmed = draft.trim();
    if (trimmed && trimmed !== track.name) onRename?.(trimmed);
  };

  const currentParent = parentOfNode(track.id);
  const parentOptions = eligibleParents(track.id);
  const currentParentName = currentParent
    ? parentOptions.find((o) => o.id === currentParent)?.name ?? 'Parent'
    : 'None';

  const currentMatteMode = typeof track.matteMode === 'object' && track.matteMode !== null
    ? track.matteMode.mode
    : track.matteMode || 'none';

  const MATTE_LABELS: Record<string, string> = {
    none: 'None',
    alpha: 'Alpha Matte',
    'alpha-inv': 'Alpha Inv Matte',
    luma: 'Luma Matte',
    'luma-inv': 'Luma Inv Matte',
  };
  const currentMatteLabel = MATTE_LABELS[currentMatteMode] ?? 'None';

  const parentItems = [
    {
      type: 'item' as const,
      id: '__none__',
      label: 'None',
      icon: currentParent === null ? ('check' as const) : undefined,
      onSelect: () => onParentChange?.(null),
    },
    ...(parentOptions.length ? [{ type: 'separator' as const }] : []),
    ...parentOptions.map((o) => ({
      type: 'item' as const,
      id: o.id,
      label: o.name,
      icon: o.id === currentParent ? ('check' as const) : undefined,
      onSelect: () => onParentChange?.(o.id),
    })),
  ];

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
      <div className={styles.layerInfoCol} style={{ paddingLeft: track.depth ? track.depth * 16 : undefined }}>
        <div
          className={styles.dragHandle}
          title="Drag to reorder"
          onPointerDown={onReorderStart}
        >
          <Icon name="grip-vertical" size={11} />
        </div>
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
        {typeof track.nodeColor === 'string' && (
          <div onClick={(e) => e.stopPropagation()} style={{ marginRight: 'var(--space-2)', display: 'inline-flex', alignItems: 'center' }}>
            <Dropdown
              placement="bottom-start"
              trigger={
                <button
                  type="button"
                  style={{
                    width: '12px',
                    height: '12px',
                    borderRadius: '2px',
                    backgroundColor: track.nodeColor,
                    border: '1px solid rgba(255, 255, 255, 0.1)',
                    cursor: 'pointer',
                    padding: 0,
                  }}
                  aria-label="Layer label color"
                  title="Change layer color / Select label group"
                />
              }
              items={[
                ...LABEL_COLORS.map((color) => ({
                  type: 'item' as const,
                  id: `color-${color.id}`,
                  label: (
                    <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                      <div style={{ width: '12px', height: '12px', borderRadius: '2px', backgroundColor: color.color }} />
                      <span>{color.label}</span>
                    </div>
                  ),
                  onSelect: () => onTrackColorChange?.(track.id, color.color),
                })),
                { type: 'separator' as const },
                {
                  type: 'item' as const,
                  id: 'select-label-group',
                  label: 'Select Label Group',
                  onSelect: () => {
                    const findSameColorNodes = (): string[] => {
                      const result: string[] = [];
                      const traverse = (nodeId: string) => {
                        const node = defaultSceneGraph.getNode(nodeId);
                        if (!node) return;
                        if ((node as any).color === track.nodeColor) {
                          result.push(node.id);
                        }
                        const kids = defaultSceneGraph.getChildren(nodeId);
                        for (const k of kids) traverse(k.id);
                      };
                      const roots = defaultSceneGraph.getRoots();
                      for (const r of roots) traverse(r.id);
                      return result;
                    };
                    const sameColorNodeIds = findSameColorNodes();
                    if (sameColorNodeIds.length > 0) {
                      useSelectionStore.getState().set(sameColorNodeIds);
                    }
                  },
                },
              ]}
            />
          </div>
        )}
        {editing ? (
          <input
            ref={inputRef}
            className={styles.trackNameInput}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={commitRename}
            onKeyDown={(e) => {
              if (e.key === 'Enter') { e.preventDefault(); commitRename(); }
              if (e.key === 'Escape') { e.preventDefault(); setEditing(false); }
            }}
            onClick={(e) => e.stopPropagation()}
            autoFocus
          />
        ) : (
          <span
            className={styles.trackName}
            title={`${track.name} — double-click to rename`}
            onDoubleClick={startRename}
          >
            {track.name}
          </span>
        )}
      </div>

      <div className={styles.modeCol} onClick={(e) => e.stopPropagation()}>
        <Dropdown
          placement="bottom-start"
          trigger={
            <button type="button" className={styles.timelineSelectTrigger} aria-label="Layer Blend Mode">
              {BLEND_MODES.find((b) => b.mode === track.blendMode)?.label ?? 'Normal'}
            </button>
          }
          items={BLEND_MODES.map((b) => ({
            type: 'item',
            id: b.mode,
            label: b.label,
            icon: b.mode === track.blendMode ? ('check' as const) : undefined,
            onSelect: () => onBlendModeChange?.(b.mode as LayerBlendMode),
          }))}
        />
      </div>

      <div className={styles.matteCol} onClick={(e) => e.stopPropagation()}>
        <Dropdown
          placement="bottom-start"
          trigger={
            <button type="button" className={styles.timelineSelectTrigger} aria-label="Track Matte">
              {currentMatteLabel}
            </button>
          }
          items={[
            { value: 'none', label: 'None' },
            { value: 'alpha', label: 'Alpha' },
            { value: 'alpha-inv', label: 'Alpha Inv' },
            { value: 'luma', label: 'Luma' },
            { value: 'luma-inv', label: 'Luma Inv' },
          ].map((m) => ({
            type: 'item',
            id: m.value,
            label: m.label,
            icon: m.value === currentMatteMode ? ('check' as const) : undefined,
            onSelect: () => onMatteChange?.(m.value as any),
          }))}
        />
      </div>

      <div className={styles.parentCol} onClick={(e) => e.stopPropagation()}>
        <Dropdown
          placement="bottom-start"
          trigger={
            <button type="button" className={styles.timelineSelectTrigger} aria-label="Parent Layer">
              {currentParentName}
            </button>
          }
          items={parentItems}
        />
      </div>

      <div className={styles.aeSwitchesCol}>
        <button
          type="button"
          className={styles.trackAction}
          data-kind="shy"
          data-on={(track as any).shy || undefined}
          title="Toggle Shy Layer"
          onClick={(e) => { e.stopPropagation(); onToggleFlag?.('shy'); }}
        >
          <Icon name="shy" size={10} />
        </button>
        <button
          type="button"
          className={styles.trackAction}
          data-kind="fx"
          data-on={track.fxEnabled !== false || undefined}
          title="Toggle Effects (fx)"
          onClick={(e) => { e.stopPropagation(); onToggleFlag?.('fxEnabled'); }}
        >
          <span className={styles.fxText}>fx</span>
        </button>
        <button
          type="button"
          className={styles.trackAction}
          data-kind="motionBlur"
          data-on={track.motionBlur || undefined}
          title="Toggle Motion Blur"
          onClick={(e) => { e.stopPropagation(); onToggleFlag?.('motionBlur'); }}
        >
          <Icon name="motion-blur" size={10} />
        </button>
        <button
          type="button"
          className={styles.trackAction}
          data-kind="adjustment"
          data-on={track.adjustment || undefined}
          title="Toggle Adjustment Layer"
          onClick={(e) => { e.stopPropagation(); onToggleFlag?.('adjustment'); }}
        >
          <Icon name="adjustment" size={10} />
        </button>
        <button
          type="button"
          className={styles.trackAction}
          data-kind="threeD"
          data-on={track.threeD || undefined}
          title="Toggle 3D Layer"
          onClick={(e) => { e.stopPropagation(); onToggleFlag?.('threeD'); }}
        >
          <Icon name="3d" size={11} />
        </button>
      </div>

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
}, areRowPropsEqual);

/** Times within this many seconds of the playhead count as "at" it. */
const KEYFRAME_EPSILON = 1e-4;

/**
 * A property sub-row: its name plus AE's keyframe navigator — `◀ ◆ ▶`. The
 * diamond is filled when a keyframe sits at the playhead and hollow otherwise;
 * clicking it adds or removes one *without changing the value*, which is the
 * only way to anchor a property before animating it away.
 */
/**
 * One property row in the timeline's track header column: the name, its live
 * value field(s), and either the keyframe navigator or a stopwatch.
 *
 * Exported so its behaviour can be tested directly — driving it through the
 * whole virtualized Timeline would test the scroller, not the row.
 */
export function PropertyHeader({
  label,
  style,
  keyframes,
  currentTime,
  animated = true,
  valueProps,
  valueUnit,
  propertyValue,
  onValueChange,
  onToggleKeyframe,
  onStopwatch,
  onSeek,
}: {
  label: string;
  style: CSSProperties;
  keyframes: ReadonlyArray<TimelineKeyframeRef>;
  currentTime: number;
  /** False for a static placeholder row — shows the stopwatch instead of ◀◆▶. */
  animated?: boolean;
  /** Engine props this row edits — one value field each (Position → x, y). */
  valueProps?: ReadonlyArray<string>;
  valueUnit?: string;
  propertyValue?: (prop: string) => number;
  onValueChange?: (prop: string, value: number) => void;
  onToggleKeyframe?: () => void;
  /** Enable animation for a static placeholder row (create first keyframe). */
  onStopwatch?: () => void;
  onSeek?: (time: number) => void;
}): JSX.Element {
  const sorted = useMemo(() => [...keyframes].sort((a, b) => a.time - b.time), [keyframes]);
  const at = sorted.find((k) => Math.abs(k.time - currentTime) < KEYFRAME_EPSILON);
  const prev = [...sorted].reverse().find((k) => k.time < currentTime - KEYFRAME_EPSILON);
  const next = sorted.find((k) => k.time > currentTime + KEYFRAME_EPSILON);

  // AE puts a live, scrubbable value beside every property here, so a whole
  // animation can be built without leaving the timeline.
  const fields =
    valueProps && valueProps.length > 0 && propertyValue && onValueChange ? (
      <div className={styles.propValues}>
        {valueProps.map((p) => (
          <ValueField
            key={p}
            value={propertyValue(p)}
            unit={valueUnit}
            onChange={(v) => onValueChange(p, v)}
            aria-label={valueProps.length > 1 ? `${label} ${p}` : label}
          />
        ))}
      </div>
    ) : null;

  /**
   * The stopwatch sits on EVERY property row, left of its name, lit when the
   * property is animated — that is where AE puts it and what it means there.
   *
   * It used to appear only on un-animated rows, so the timeline could turn
   * animation ON but never OFF: removing a property's animation meant crossing
   * to the inspector to find the same control.
   */
  // The SHARED stopwatch — the same component the inspector and the effect
  // stack render, so the control that turns animation on cannot look like a
  // checkbox in one panel and a stopwatch in another.
  const stopwatch = onStopwatch ? (
    <StopwatchButton animated={animated} label={label} onToggle={onStopwatch} />
  ) : null;

  if (!animated) {
    // Static placeholder: the AE property tree before any keyframes exist.
    return (
      <div className={`${styles.propHeader} ${styles.propHeaderStatic}`} style={style}>
        {stopwatch}
        <span className={styles.propName} title={label}>{label}</span>
        {fields}
      </div>
    );
  }

  return (
    <div className={styles.propHeader} style={style}>
      {stopwatch}
      <span className={styles.propName} title={label}>{label}</span>
      {fields}
      <div className={styles.propNav}>
        <KeyframeNavigator
          label={label}
          hasPrev={!!prev}
          hasNext={!!next}
          atKeyframe={!!at}
          onPrev={() => prev && onSeek?.(prev.time)}
          onNext={() => next && onSeek?.(next.time)}
          onToggleKeyframe={() => onToggleKeyframe?.()}
        />
      </div>
    </div>
  );
}

/** A track's lane content: the calm animation block + (collapsed) keyframes. */
const TrackContent = memo(function TrackContent({
  track,
  ghosted,
  pps,
  trackHeight,
  top,
  clipPreview,
  onClipDown,
  onClipContextMenu,
  onActivate,
  clipMuted,
  onClipMuteToggle,
}: {
  track: TimelineTrack;
  ghosted: boolean;
  pps: number;
  trackHeight: number;
  top: number;
  clipPreview: { id: string; start: number; duration: number } | null;
  onClipDown?: (clip: TimelineClip, mode: 'move' | 'start' | 'end', e: ReactPointerEvent<HTMLDivElement>) => void;
  onClipContextMenu?: (clipId: string, clientX: number, clientY: number) => void;
  onActivate?: (nodeId: string) => void;
  /** Whether this layer's audio is muted, for the speaker glyph. */
  clipMuted?: boolean;
  /** Toggle this layer's audio mute. Absent = no speaker button. */
  onClipMuteToggle?: (nodeId: string) => void;
}): JSX.Element {
  return (
    <LaneRow top={top} trackHeight={trackHeight} ghosted={ghosted}>
      {/* Clips — draggable body (move) + edge handles (trim). */}
      {track.clips?.map((clip) => {
        const view = clipPreview && clipPreview.id === clip.id ? clipPreview : clip;
        const wave = clip.assetId ? audioEngine.getWaveform(clip.assetId) : undefined;
        const width = Math.max(2, view.duration * pps);
        const height = trackHeight - 6;
        // Slice to the bar's own window onto the source. Drawing `wave.peaks`
        // whole — which this did — squeezed the entire file into the bar, so
        // the peaks under the playhead were not the audio you would hear there
        // and trimming or slipping changed nothing on screen.
        const slice =
          wave && clip.sourceInSec !== undefined && clip.sourceOutSec !== undefined
            ? peaksInRange(wave, clip.sourceInSec, clip.sourceOutSec)
            : wave?.peaks;
        const pathD = slice ? waveformPath(slice, width, height) : '';
        const audible = clip.assetId !== undefined && wave !== undefined;
        return (
          <div
            key={clip.id}
            className={styles.clip}
            style={{
              transform: `translateX(${8 + view.start * pps}px)`,
              width,
              height,
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
            onDoubleClick={onActivate ? () => onActivate(track.id) : undefined}
          >
            {pathD && (
              <svg
                style={{
                  position: 'absolute',
                  left: 0,
                  top: 0,
                  width: '100%',
                  height: '100%',
                  pointerEvents: 'none',
                  opacity: 0.35,
                }}
              >
                <path d={pathD} fill="currentColor" />
              </svg>
            )}
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
            {audible && onClipMuteToggle && (
              <button
                type="button"
                className={styles.clipMute}
                title={clipMuted ? 'Unmute this layer’s audio' : 'Mute this layer’s audio'}
                aria-label={clipMuted ? 'Unmute audio' : 'Mute audio'}
                aria-pressed={clipMuted}
                // The bar is a drag handle; without stopping propagation the
                // pointerdown would start a move and the click never lands.
                onPointerDown={(e) => e.stopPropagation()}
                onClick={(e) => {
                  e.stopPropagation();
                  onClipMuteToggle(clip.nodeId);
                }}
              >
                <Icon name={clipMuted ? 'audio-off' : 'audio'} size={11} />
              </button>
            )}
            <span className={styles.clipLabel}>{clip.label ?? clip.id}</span>
          </div>
        );
      })}

      {/* Layer markers — anchored to this row, on the comp axis (AE draws them
          on the layer bar, and they move with a trimmed layer because the
          engine stores them layer-relative). */}
      {track.markers?.map((m) => (
        <div
          key={m.id}
          className={styles.layerMarker}
          style={{ left: `${8 + m.time * pps}px`, background: m.color ?? undefined }}
          title={m.label}
        />
      ))}
    </LaneRow>
  );
}, areRowPropsEqual);

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

const Keyframes = memo(function Keyframes({
  keyframes,
  pps,
  kfPreview,
  selectedKfIds,
  onKeyframeDown,
  onKeyframeContextMenu,
}: {
  keyframes: ReadonlyArray<TimelineKeyframeRef>;
  pps: number;
  kfPreview: Map<string, number>;
  selectedKfIds: Set<string>;
  onKeyframeDown: (kf: TimelineKeyframeRef, e: ReactPointerEvent<HTMLDivElement>) => void;
  onKeyframeContextMenu?: (keyframeId: string, clientX: number, clientY: number) => void;
}): JSX.Element {
  return (
    <>
      {keyframes.map((kf) => {
        const dragging = kfPreview.has(kf.id);
        const selected = selectedKfIds.has(kf.id);
        const time = dragging ? kfPreview.get(kf.id)! : kf.time;
        // Roving keeps its own full-circle glyph: it is a statement about TIME
        // (this key is auto-positioned for constant speed), not about the
        // interpolation curve, so it must stay distinguishable from auto-bezier.
        const shapes = keyframeShapes(kf.easeIn, kf.easeOut, { isFirst: kf.isFirst, isLast: kf.isLast });
        const paths = keyframePaths(shapes.left, shapes.right);
        return (
          <div
            key={kf.id}
            className={cn(
              styles.keyframe,
              dragging && styles.keyframeDragging,
              selected && styles.keyframeSelected,
              kf.roving && styles.keyframeRoving,
            )}
            style={{ left: `${8 + time * pps}px` }}
            onPointerDown={(e) => onKeyframeDown(kf, e)}
            onContextMenu={(e) => {
              e.preventDefault();
              onKeyframeContextMenu?.(kf.id, e.clientX, e.clientY);
            }}
            title={`${time.toFixed(2)}s · ${describeShapes(shapes.left, shapes.right)} — drag to move, Shift+click to multi-select, right-click for options`}
          >
            {!kf.roving && (
              <svg className={styles.keyframeGlyph} viewBox="0 0 12 12" aria-hidden focusable="false">
                <path d={paths.left} />
                <path d={paths.right} />
              </svg>
            )}
          </div>
        );
      })}
    </>
  );
}, areRowPropsEqual);

function TrackCategoryHeader({
  label,
  icon,
  expanded,
  count,
  style,
  onToggle,
}: {
  label: string;
  icon: IconName;
  expanded: boolean;
  count: number;
  style: CSSProperties;
  onToggle: () => void;
}): JSX.Element {
  return (
    <div className={styles.categoryHeader} style={style} onClick={onToggle}>
      <span className={styles.disclosure}>
        <Icon name={expanded ? 'chevron-down' : 'chevron-right'} size={10} />
      </span>
      <span className={styles.categoryIcon}>
        <Icon name={icon} size={11} />
      </span>
      <span className={styles.categoryName}>{label}</span>
      <span className={styles.categoryBadge}>{count}</span>
    </div>
  );
}

// ── Helpers ─────────────────────────────────────────────────────

/**
 * Prop equality for the timeline's row subcomponents (track headers, lane
 * content, keyframes). The Timeline re-renders on every playback frame to move
 * the playhead — up to 60×/s — but none of these rows depend on the playhead,
 * so re-rendering them each frame is pure waste that made dense comps feel laggy
 * (the "not yet pleasant for dense compositions" note in ROADMAP.md).
 *
 * A plain shallow `memo` cannot help: every row is handed a freshly-built
 * `style` object and freshly-bound callbacks each render. But those callbacks
 * are all bound to a STABLE `track.id`, so a new closure identity is not a
 * behavioural change, and the geometry only changes on scroll or a row-height
 * switch, not per frame. So: ignore function identity, compare `style` by value,
 * and compare everything else by identity. Any real data change — the track
 * object, selection, index, expansion, geometry — still re-renders normally.
 */
export function areRowPropsEqual(prevProps: object, nextProps: object): boolean {
  const prev = prevProps as Record<string, unknown>;
  const next = nextProps as Record<string, unknown>;
  const keys = Object.keys(prev);
  if (keys.length !== Object.keys(next).length) return false;
  for (const key of keys) {
    const a = prev[key];
    const b = next[key];
    if (Object.is(a, b)) continue;
    // Callbacks are bound to stable ids; identity churn is not a real change.
    if (typeof a === 'function' && typeof b === 'function') continue;
    // Geometry arrives as a fresh object literal each render — compare by value.
    if (key === 'style' && isShallowEqualStyle(a, b)) continue;
    return false;
  }
  return true;
}

function isShallowEqualStyle(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (!a || !b || typeof a !== 'object' || typeof b !== 'object') return false;
  const ao = a as Record<string, unknown>;
  const bo = b as Record<string, unknown>;
  const keys = Object.keys(ao);
  if (keys.length !== Object.keys(bo).length) return false;
  for (const k of keys) if (!Object.is(ao[k], bo[k])) return false;
  return true;
}

function generateRulerTicks(durationSec: number, pps: number, fps: number, startSec = 0, offset = 0): { x: number; major: boolean; label: string }[] {
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
    // The tick's POSITION is 0-based plus left margin offset (pixel layout is the real time domain); its
    // LABEL adds the comp's start offset so the ruler reads the same timecode
    // the playhead readout does.
    ticks.push({ x: offset + snapped * pps, major: isMajor, label: formatTime(snapped + startSec, fps, majorSec) });
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
