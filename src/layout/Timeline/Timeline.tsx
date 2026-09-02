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
import { CacheBars } from './CacheBars';
import { Icon, type IconName } from '@components/Icon';
import { StopwatchButton, KeyframeNavigator } from '@components/PropertyRow';
import { PickWhip } from '@components/PickWhip';
import { keyframeShapes, keyframePaths, describeShapes } from './keyframeShape';
import { snapKeyframeGroup, type SnapTarget } from './keyframeSnap';
import { collectClipSnapTargets, snapClipEdges, type ClipSnapTarget } from './clipSnap';
import { registerTimelineScroll, setTimelineViewportWidth } from './timelineViewport';
import { scaleSelection, scaleGrip } from './keyframeTimeScale';
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
import { type LayerBlendMode } from '@core/effects/blendMode';
import { blendDropdownItems, blendModeLabel } from '@layout/Inspector/blendMenu';
import { eligibleParents, parentOfNode, parentOptionsFor } from '@core/scene/parenting';
import type { MenuSelectModifiers } from '@components/Menu';
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
import { ColorPicker } from '@components/ColorPicker';
import { MATTE_OPTIONS, MATTE_SHORT_LABEL, matteOptionId, applyMatteOption } from '@components/MatteControl/matteMenu';
import { TIMELINE_GROUP_ORDER, type TimelineGroupKey } from '@core/timeline/propertyTree';
import { useUIStore } from '@stores/uiStore';

/**
 * The column-head / ruler strip.
 *
 * 26, not 36. Everything in it is a 22px control or a 12px label, so ten of
 * those 36 pixels were padding — a header band half again as tall as the rows
 * it labels, which made the track list look like it started a third of the way
 * down the panel.
 */
const RULER_HEIGHT_DEFAULT = 26;
const TRACK_HEIGHT_DEFAULT = 36;
/**
 * The track-header column model, in pixels — the TypeScript half of the one in
 * Timeline.module.css. Both halves have to agree.
 *
 * These are FIXED widths: a header narrower than their sum does not squeeze the
 * columns, it hides the right-hand ones behind the lanes. That is how Mode,
 * TrkMat and Parent & Link came to be unreachable — the stored default was
 * 460px against the ~576px the mode columns need — so `headerWidthFor` below
 * turns the sum into a floor instead of leaving it to chance.
 */
const TL_COLUMN_WIDTHS = {
  /** `.colHeads` / `.trackHeader` horizontal padding, both edges. */
  padding: 8,
  /** `--tl-col-gap`, between every pair of columns. */
  gap: 4,
  /** A divider rule's margin + padding, on the one side that draws it. */
  rule: 16,
  preInfo: 72,
  name: 190,
  switches: 178,
  mode: 70,
  matte: 58,
  parent: 120,
} as const;

/**
 * The narrowest the header column may be dragged.
 *
 * Not a limit on the COLUMNS — those keep their widths and scroll. It is the
 * width the sub-header row above needs: the timecode, the filter field and the
 * eight toggles share that strip, and below this they stop being a row and
 * start overlapping. Mirrored by `.searchBarCol`'s `min-width`, so the vertical
 * line those two share cannot break at any drag position.
 */
export const TRACK_HEADER_MIN_WIDTH = 260;

/** Width the header needs for `columns` — see `TL_COLUMN_WIDTHS`. */
export function headerWidthFor(columns: 'switches' | 'modes' | 'both'): number {
  const W = TL_COLUMN_WIDTHS;
  // A/V gutter (ruled) + gap + name. Always present.
  let total = W.padding + (W.preInfo + W.rule) + W.gap + W.name;
  if (columns !== 'modes') total += W.gap + W.switches + W.rule;
  if (columns !== 'switches') {
    total += W.gap + W.mode + W.rule;
    total += W.gap + W.matte + W.rule;
    total += W.gap + W.parent + W.rule;
  }
  return total;
}

const TIMELINE_TOP_PADDING = 6;
const TIMELINE_BOTTOM_PADDING = 12;

/** A virtualized row is either a track summary row, a category accordion row, or a property sub-row. */
type Row =
  | { type: 'track'; track: TimelineTrack; expanded: boolean; hasProps: boolean }
  | { type: 'category'; track: TimelineTrack; categoryKey: string; label: string; icon: IconName; expanded: boolean; count: number }
  | { type: 'prop'; track: TimelineTrack; prop: TimelinePropertyTrack; categoryKey: string };

/**
 * The heading each section gets, in AE's own twirl order.
 *
 * The ORDER lives in the model (`TIMELINE_GROUP_ORDER`) because it is a fact
 * about the layer's structure, not about this view; only the words and the
 * glyph are decided here.
 */
const GROUP_HEADING: Readonly<Record<TimelineGroupKey, { label: string; icon: IconName }>> = {
  text: { label: 'Text', icon: 'type' },
  contents: { label: 'Contents', icon: 'shape' },
  masks: { label: 'Masks', icon: 'mask-square' },
  effects: { label: 'Effects', icon: 'sparkles' },
  transform: { label: 'Transform', icon: 'sliders-h' },
  styles: { label: 'Layer Styles', icon: 'palette' },
  material: { label: 'Material Options', icon: 'cube' },
  audio: { label: 'Audio', icon: 'audio' },
  time: { label: 'Time', icon: 'clock' },
};

/**
 * Which heading a property row sits under.
 *
 * The model states it (`prop.group`). The substring guess below survives only
 * for rows built before it did — it reads the label for words like "blur", so
 * it filed a text animator's Blur under Effects and could not tell a layer
 * style from the effect it compiles to.
 */
function getPropertyCategory(prop: TimelinePropertyTrack): { key: string; label: string; icon: IconName; order: number } {
  if (prop.group) {
    const heading = GROUP_HEADING[prop.group];
    return { key: prop.group, ...heading, order: TIMELINE_GROUP_ORDER[prop.group] };
  }

  const p = prop.prop.toLowerCase();
  const label = (prop.label || '').toLowerCase();
  if (
    p.includes('anchor') || p.includes('position') || p === 'x' || p === 'y' || p === 'z' ||
    p.includes('scale') || p.includes('rotation') || p.includes('orientation') || p.includes('opacity') ||
    label.includes('anchor') || label.includes('position') || label.includes('scale') ||
    label.includes('rotation') || label.includes('opacity')
  ) {
    return { key: 'transform', ...GROUP_HEADING.transform, order: TIMELINE_GROUP_ORDER.transform };
  }
  if (
    p.includes('effect') || p.includes('blur') || p.includes('shadow') || p.includes('glow') ||
    p.includes('filter') || label.includes('effect') || label.includes('blur') || label.includes('shadow')
  ) {
    return { key: 'effects', ...GROUP_HEADING.effects, order: TIMELINE_GROUP_ORDER.effects };
  }
  return { key: 'contents', ...GROUP_HEADING.contents, order: TIMELINE_GROUP_ORDER.contents };
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
  /** Clip edge trimmed to an absolute time (seconds). `ripple` closes the gap on in/out trim. */
  onClipTrim?: (clipId: string, edge: 'start' | 'end', time: number, opts?: { ripple?: boolean }) => void;
  /** Alt-drag clip body: slip source under a fixed bar (sourceInSec). */
  onClipSlip?: (clipId: string, sourceInSec: number) => void;
  /** Shift+Alt-drag clip body: slide bar + trim abutting neighbors (new start sec). */
  onClipSlide?: (clipId: string, startSec: number) => void;
  /** Right-click a clip (for split / delete). */
  onClipContextMenu?: (clipId: string, clientX: number, clientY: number) => void;
  onTrackSelect?: (trackId: string, additive: boolean) => void;
  onScroll?: (scrollLeft: number) => void;
  /**
   * Horizontal scroll to RESTORE (px). The lanes own their scroll position, but
   * while the Graph Editor replaces them it scrolls on its own; on return the
   * lanes jump to wherever the graph left off so the two views stay aligned.
   */
  scrollLeftSync?: number;
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
  onTrackParentChange?: (trackId: string, parentId: string | null, options?: { preserveWorld?: boolean }) => void;
  onTrackToggleFlag?: (trackId: string, flag: 'shy' | 'collapse' | 'fxEnabled' | 'motionBlur' | 'adjustment' | 'threeD' | 'guide' | 'preserveTransparency') => void;
  /** Rename a layer (confirmed on blur/Enter). */
  onTrackRename?: (trackId: string, newName: string) => void;
  onKeyframeSeek?: (keyframeId: string) => void;
  onKeyframeMove?: (keyframeId: string, time: number) => void;
  onKeyframesDelete?: (keyframeIds: ReadonlyArray<string>) => void;
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
  /**
   * A value-field scrub is beginning / has ended on this property. Lets the
   * owner snapshot the selected properties' start values so the drag can be
   * distributed across them (Proportional Scrubbing).
   */
  onPropertyScrubStart?: (trackId: string, prop: string) => void;
  onPropertyScrubEnd?: () => void;
  /** Property ROW selection: `${trackId}::${prop}` keys, in selection order. */
  selectedPropertyKeys?: ReadonlyArray<string>;
  /** Click on a property name. `toggle` is Ctrl/Cmd-click (add/remove). */
  onPropertySelect?: (trackId: string, prop: string, mode: 'replace' | 'toggle') => void;
  /** Called when user drags a track row to a new position. toIndex is 0-based. */
  onTrackReorder?: (fromId: string, toIndex: number) => void;
  onTrackColorChange?: (trackId: string, color: string) => void;
  className?: string;
  searchQuery?: string;
  globalShy?: boolean;
  /**
   * AE's Toggle Switches / Modes. `switches` shows shy·fx·blur·adjustment·
   * guide·T·3D; `modes` shows Mode·TrkMat·Parent; `both` shows the lot and
   * needs a very wide header. Defaults to `both` so an embedder that has not
   * been taught about the toggle keeps every column it had.
   */
  columns?: 'switches' | 'modes' | 'both';
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
  onClipSlip,
  onClipSlide,
  onClipContextMenu,
  onTrackSelect,
  onScroll,
  scrollLeftSync,
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
  onKeyframesDelete,
  onKeyframeContextMenu,
  onPropertyKeyframeToggle,
  onPropertyStopwatch,
  onPropertyValue,
  onPropertyValueChange,
  onPropertyScrubStart,
  onPropertyScrubEnd,
  selectedPropertyKeys,
  onPropertySelect,
  onTrackReorder,
  onTrackColorChange,
  className,
  searchQuery,
  globalShy,
  columns = 'both',
  onDurationChange,
  playheadTime,
}: TimelineProps): JSX.Element {
  const showSwitches = columns !== 'modes';
  const showModes = columns !== 'switches';
  const rulerHeight = model.rulerHeight ?? RULER_HEIGHT_DEFAULT;
  const trackHeight = model.trackHeight ?? TRACK_HEIGHT_DEFAULT;
  // The header column is user-resizable: property names + their value fields
  // need very different room depending on what's open, and a fixed column
  // either truncates labels or wastes half the panel. The model can still
  // pin a width (tests, embeds); otherwise it is the user's preference.
  const prefHeaderWidth = usePreferenceStore((s) => s.timelineHeaderWidth);
  const setPref = usePreferenceStore((s) => s.set);
  // What the visible columns need. It is the DEFAULT and the reset target, no
  // longer a floor on the drag: the header column scrolls horizontally now, so
  // narrowing it hides columns behind an edge you can scroll back — which is
  // the AE behaviour, and does not force the panel to a width the user did not
  // ask for. See `.colHeads` / `.trackHeaderScroller`.
  const minHeaderWidth = headerWidthFor(columns);
  const headerWidth = model.trackHeaderWidth ?? prefHeaderWidth ?? minHeaderWidth;

  // Playhead is the one value that changes 60×/s during playback. We accept
  // it as a separate prop so the model can stay referentially stable and the
  // row tree (memos below) doesn't recompute. Fall back to model.currentTime
  // for callers that still pass the time inside the model.
  const currentTime = playheadTime ?? model.currentTime;

  const lanesRef = useRef<HTMLDivElement | null>(null);
  const headerRef = useRef<HTMLDivElement | null>(null);
  /**
   * The column-head strip, kept in step with the rows' horizontal scroll.
   *
   * The heads live in the ruler and the rows live in their own scroller, so
   * they are two boxes that happen to share a column model — scroll one and the
   * legend stops naming the columns under it. Written straight to the DOM
   * rather than through state: this fires on every frame of a drag-scroll, and
   * re-rendering every visible row to move one strip 4px is not what a scroll
   * should cost.
   */
  const colHeadsRef = useRef<HTMLDivElement | null>(null);
  const { ref: containerRef, size } = useResizeObserver<HTMLDivElement>();
  /** Latest `onScroll`, so the mount-once viewport effect can report a
   *  programmatic scroll without re-registering on every render. */
  const onScrollRef = useRef(onScroll);
  onScrollRef.current = onScroll;
  const [scrollLeft, setScrollLeft] = useState(0);
  const [scrollTop, setScrollTop] = useState(0);

  const [, forceUpdate] = useState({});
  useEffect(() => {
    return audioEngine.onChange(() => forceUpdate({}));
  }, []);

  // ── Publish the lane viewport, for out-of-panel zoom actions ────
  // "Fit composition" lives in the status bar and cannot measure this: the lane
  // width is whatever is left after the user-resizable header column, which is
  // known here and nowhere else. Written to a module store rather than lifted
  // through props — the timeline's host does not connect the two panels, and
  // this fires on every frame of a divider drag.
  useEffect(() => {
    const el = lanesRef.current;
    if (!el) return;
    const publish = (): void => setTimelineViewportWidth(el.clientWidth);
    publish();
    const ro = new ResizeObserver(publish);
    ro.observe(el);
    const unregister = registerTimelineScroll((px) => {
      el.scrollLeft = px;
      setScrollLeft(el.scrollLeft);
      onScrollRef.current?.(el.scrollLeft);
    });
    return () => {
      ro.disconnect();
      // Only blank the measurement if no OTHER timeline (the popout window)
      // took over in the meantime — React mounts the new one before this runs.
      if (unregister()) setTimelineViewportWidth(0);
    };
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
    // Past the minimum the columns scroll rather than shrink, so dragging in
    // costs nothing but visible width.
    setPref(
      'timelineHeaderWidth',
      clamp(st.startW + (e.clientX - st.startX), TRACK_HEADER_MIN_WIDTH, 900),
    );
  }, [setPref]);

  const onHeaderResizeUp = useCallback((e: ReactPointerEvent<HTMLDivElement>) => {
    resizeRef.current = null;
    (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId);
    document.body.style.cursor = '';
    document.body.style.userSelect = '';
  }, []);
  useEffect(() => () => {
    if (!resizeRef.current) return;
    resizeRef.current = null;
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
      // `canExpand` first: a collapsed track ships no `properties` at all, so
      // reading only the payload hid the chevron on every un-keyed layer and
      // sealed off the static Transform tree behind it.
      const hasProps =
        track.canExpand === true || (track.properties?.length ?? 0) > 0 || track.isGroup === true;

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
  const totalLanesHeight = TIMELINE_TOP_PADDING + rows.length * trackHeight + TIMELINE_BOTTOM_PADDING;
  const effectiveLanesHeight = Math.max(totalLanesHeight, Math.max(0, size.height - rulerHeight));

  // ── Vertical virtualization (rows) ─────────────────────────────
  const visibleRowCount = Math.ceil(size.height / trackHeight) + 8;
  const startRow = Math.max(0, Math.floor(Math.max(0, scrollTop - TIMELINE_TOP_PADDING) / trackHeight) - 4);
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

  // Restore an externally-driven scroll (the Graph Editor's) when it changes.
  useEffect(() => {
    const el = lanesRef.current;
    if (scrollLeftSync === undefined || !el) return;
    if (Math.abs(el.scrollLeft - scrollLeftSync) > 0.5) el.scrollLeft = scrollLeftSync;
  }, [scrollLeftSync]);

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

  // Stable, so <Minimap>'s memo can actually skip — an inline arrow here is a
  // new prop identity on every frame of playback, which would make the memo
  // wrapper pure overhead.
  const onMinimapScrollTo = useCallback((top: number) => {
    if (lanesRef.current) lanesRef.current.scrollTop = top;
  }, []);

  // ── Scrubbing / playhead drag ──────────────────────────────────
  const draggingRef = useRef(false);
  const onPlayheadDown = useCallback((e: ReactPointerEvent<HTMLDivElement>) => {
    if (!lanesRef.current) return;
    draggingRef.current = true;
    // A scrub is a drag the viewport should degrade for (Adaptive Resolution),
    // exactly like a gizmo drag — same flag, same subscriber.
    useUIStore.getState().setDragging(true);
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
      useUIStore.getState().setDragging(false);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    return () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      if (draggingRef.current) {
        draggingRef.current = false;
        useUIStore.getState().setDragging(false);
        document.body.style.cursor = '';
        document.body.style.userSelect = '';
      }
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
      if (waDrag.current) {
        waDrag.current = null;
        document.body.style.userSelect = '';
      }
    };
  }, [pps, scrollLeft, totalSeconds, onWorkAreaChange, model.frameRate]);

  // ── Composition duration drag (extend / shorten video length) ────
  const durationDragCleanupRef = useRef<(() => void) | null>(null);
  useEffect(() => () => durationDragCleanupRef.current?.(), []);
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

    const cleanup = (): void => {
      window.removeEventListener('pointermove', onPointerMove);
      window.removeEventListener('pointerup', onPointerUp);
      durationDragCleanupRef.current = null;
    };
    const onPointerUp = (upEvent: PointerEvent) => {
      try {
        owner.releasePointerCapture(upEvent.pointerId);
      } catch {
        // best-effort
      }
      cleanup();
    };

    durationDragCleanupRef.current?.();
    durationDragCleanupRef.current = cleanup;
    window.addEventListener('pointermove', onPointerMove);
    window.addEventListener('pointerup', onPointerUp);
  };

  // ── Clip drag (body = move; Alt+body = slip; Shift+Alt = slide; edges = trim) ──
  // Live geometry lives on the ref (survives without a render); a preview state
  // drives the visual; the engine is only told the final value on release.
  const clipDrag = useRef<
    null | {
      id: string;
      /** Scene node behind the bar — the unit selection actually addresses. */
      trackId: string;
      /** Set when pointer-down landed on an ALREADY-selected bar: the
       *  selection collapses to it on release, but only if no drag happened. */
      collapseSelectionOnUp: boolean;
      /** Client-space pointer-down origin, for the click-vs-drag threshold. */
      downX: number;
      downY: number;
      /** Set once the pointer travels past the drag threshold. */
      moved: boolean;
      mode: 'move' | 'start' | 'end' | 'slip' | 'slide';
      ripple: boolean;
      startX: number;
      start: number;
      duration: number;
      sourceInSec: number;
      live: { start: number; duration: number; sourceInSec: number };
      /**
       * What this drag may latch onto, snapshotted at pointer-DOWN.
       *
       * The list cannot change mid-gesture (no clip but this one is moving, and
       * markers/work area are not editable during a drag), and rebuilding it on
       * every pointermove would walk every clip on every track at pointer rate.
       */
      snapTargets: readonly ClipSnapTarget[];
    }
  >(null);
  /**
   * Everything a clip drag needs to build its snap targets, refreshed each
   * render. A ref rather than a dependency so the drag listeners below are not
   * re-bound (and the in-flight gesture torn down) every time the model object
   * changes identity — which, during playback, is every frame.
   */
  const clipSnapCtx = useRef({ tracks: model.tracks, markers: model.markers, workArea: model.workArea, currentTime, duration: model.duration });
  clipSnapCtx.current = { tracks: model.tracks, markers: model.markers, workArea: model.workArea, currentTime, duration: model.duration };
  /** What the in-flight clip drag is latched onto — drives the guide line. */
  const [clipSnap, setClipSnap] = useState<ClipSnapTarget | null>(null);
  /** Mirror of `clipSnap`, so pointermove can skip a re-render when the latch
   *  has not actually changed — this runs at pointer rate. */
  const clipSnapShown = useRef<ClipSnapTarget | null>(null);
  const [clipPreview, setClipPreview] = useState<null | {
    id: string;
    start: number;
    duration: number;
    sourceInSec?: number;
  }>(null);

  const onClipDown = useCallback(
    (clip: TimelineClip, mode: 'move' | 'start' | 'end', e: ReactPointerEvent<HTMLDivElement>) => {
      // Selection happens even when no clip-edit handler is wired: clicking a
      // bar in the lanes is how most people reach for a layer, and requiring
      // them to travel back to the name column for it was the single most
      // repeated complaint about the timeline. Runs BEFORE the drag guard so
      // a read-only timeline still selects.
      //
      // Deferred-collapse rules (standard for draggable rows):
      //   • additive modifier      → add to the selection now
      //   • bar not yet selected   → select it now, so the drag moves the
      //                              thing under the cursor
      //   • bar already selected   → wait for pointer-up: collapsing a
      //                              multi-selection on pointer-DOWN would
      //                              make a group impossible to drag
      const additive = e.ctrlKey || e.metaKey || e.shiftKey;
      const alreadySelected = selectedTrackIds?.includes(clip.trackId) ?? false;
      let collapseSelectionOnUp = false;
      if (onTrackSelect) {
        if (additive || !alreadySelected) onTrackSelect(clip.trackId, additive);
        else collapseSelectionOnUp = true;
      }

      if ((!onClipMove && !onClipTrim && !onClipSlip && !onClipSlide) || !lanesRef.current) {
        e.stopPropagation();
        return;
      }
      e.stopPropagation();
      // Shift+Alt on body → slide (move bar, trim abutting neighbors).
      // Alt alone → slip (shift source under a fixed bar).
      let actualMode: 'move' | 'start' | 'end' | 'slip' | 'slide' = mode;
      if (mode === 'move' && e.altKey && e.shiftKey && onClipSlide) actualMode = 'slide';
      else if (mode === 'move' && e.altKey && onClipSlip) actualMode = 'slip';
      const lanesRect = lanesRef.current.getBoundingClientRect();
      const sourceInSec = clip.sourceInSec ?? 0;
      clipDrag.current = {
        id: clip.id,
        trackId: clip.trackId,
        collapseSelectionOnUp,
        downX: e.clientX,
        downY: e.clientY,
        moved: false,
        mode: actualMode,
        // Ctrl/Cmd on an edge → ripple trim (in or out).
        ripple: (actualMode === 'start' || actualMode === 'end') && (e.ctrlKey || e.metaKey),
        startX: e.clientX - lanesRect.left + lanesRef.current.scrollLeft,
        start: clip.start,
        duration: clip.duration,
        sourceInSec,
        live: { start: clip.start, duration: clip.duration, sourceInSec },
        // The dragged bar is excluded from its own target list — otherwise its
        // start would pull it straight back to where it began and the bar would
        // be immovable inside one snap radius.
        snapTargets: collectClipSnapTargets({
          tracks: clipSnapCtx.current.tracks,
          excludeClipIds: [clip.id],
          playheadTime: clipSnapCtx.current.currentTime,
          markers: clipSnapCtx.current.markers,
          workArea: clipSnapCtx.current.workArea ?? null,
          compDuration: clipSnapCtx.current.duration,
        }),
      };
      setClipPreview({ id: clip.id, start: clip.start, duration: clip.duration, sourceInSec });
      try {
        lanesRef.current.setPointerCapture(e.pointerId);
      } catch {
        /* best-effort capture */
      }
      document.body.style.userSelect = 'none';
      document.body.style.cursor =
        actualMode === 'slip' || actualMode === 'slide' ? 'ew-resize' : '';
    },
    [onClipMove, onClipTrim, onClipSlip, onClipSlide, onTrackSelect, selectedTrackIds],
  );

  useEffect(() => {
    const onMove = (e: PointerEvent): void => {
      const d = clipDrag.current;
      if (!d || !lanesRef.current) return;
      // Threshold, not "any pointermove": trackpads and high-DPI mice emit
      // sub-pixel moves during an ordinary click, and treating those as a drag
      // swallowed the collapse-selection-on-release case below.
      if (!d.moved && exceedsDragThreshold(e.clientX - d.downX, e.clientY - d.downY)) d.moved = true;
      const lanesRect = lanesRef.current.getBoundingClientRect();
      const currentScrollLeft = lanesRef.current.scrollLeft;
      const deltaSec = (e.clientX - lanesRect.left + currentScrollLeft - d.startX) / pps;
      const frameDur = 1 / (model.frameRate || 30);
      const minGap = frameDur;
      // Snapping. The frame grid is the LAST resort inside `snapClipEdges`, so
      // a drag that latches onto nothing still quantizes exactly as it always
      // did (the engine stores whole frames, so an unsnapped preview visibly
      // jumped on release) — but a bar that comes within a few pixels of a
      // neighbour's edge, the playhead, a marker or a work-area bound now lands
      // on it exactly, which is the alignment people were doing by eye.
      //
      // Alt frees a move/trim entirely. Slip and slide always snap, because Alt
      // is the modifier that CHOSE those modes and cannot also mean "no snap".
      const snapDisabled = d.mode !== 'slip' && d.mode !== 'slide' && e.altKey;
      const snapOpts = { pixelsPerSecond: pps, frameDuration: frameDur, disabled: snapDisabled };
      const snapToFrame = (v: number): number =>
        snapDisabled || frameDur <= 0 ? v : Math.round(v / frameDur) * frameDur;
      // Boxed so TypeScript keeps the declared type: a plain `let` written only
      // from inside `snapBody` narrows to `never` at the read site below.
      const hit: { target: ClipSnapTarget | null } = { target: null };
      /** Snap a set of MOVING edges as one body; returns the offset to apply. */
      const snapBody = (edges: readonly number[]): number => {
        const { delta, target } = snapClipEdges(edges, d.snapTargets, snapOpts);
        // No guide line for the frame grid: it is quantization, not an
        // alignment the user was aiming at, and a line on every drag would be
        // noise. Same rule as the keyframe snapper's indicator.
        hit.target = target && target.kind !== 'frame' ? target : null;
        return delta;
      };
      let start = d.start;
      let duration = d.duration;
      let sourceInSec = d.sourceInSec;
      // AE semantics: clip bars may OVERHANG the composition end freely (the
      // render simply stops at the comp bound) — only the left edge pins at 0.
      // Clamping to totalSeconds made full-comp clips immovable and turned
      // every "expand" gesture into a shrink.
      if (d.mode === 'slip') {
        // Drag right → later into the source (positive sourceIn), matching AE.
        // Frame grid only: slip does not move the BAR, so there is no edge to
        // align with anything on the timeline axis.
        sourceInSec = snapToFrame(Math.max(0, d.sourceInSec + deltaSec));
      } else if (d.mode === 'move' || d.mode === 'slide') {
        const rawStart = Math.max(0, d.start + deltaSec);
        // Both edges are candidates — a bar is just as often butted up by its
        // tail as by its head, and only trying the head would make the common
        // "snap the out-point to the playhead" gesture impossible.
        start = Math.max(0, rawStart + snapBody([rawStart, rawStart + d.duration]));
      } else if (d.mode === 'start') {
        const end = d.start + d.duration;
        const raw = clamp(d.start + deltaSec, 0, end - minGap);
        start = clamp(raw + snapBody([raw]), 0, end - minGap);
        duration = end - start;
      } else {
        const raw = Math.max(d.start + minGap, d.start + d.duration + deltaSec);
        const end = Math.max(d.start + minGap, raw + snapBody([raw]));
        duration = Math.max(minGap, end - d.start);
      }
      // Only while the gesture is a real drag: a guide flashing under a plain
      // click on a bar would be feedback for an edit that never happened.
      const nextSnap = d.moved ? hit.target : null;
      if ((nextSnap?.time ?? null) !== (clipSnapShown.current?.time ?? null) ||
          (nextSnap?.kind ?? null) !== (clipSnapShown.current?.kind ?? null)) {
        clipSnapShown.current = nextSnap;
        setClipSnap(nextSnap);
      }
      d.live = { start, duration, sourceInSec };
      setClipPreview({ id: d.id, start, duration, sourceInSec });
    };
    const onUp = (): void => {
      const d = clipDrag.current;
      if (!d) return;
      if (clipSnapShown.current) {
        clipSnapShown.current = null;
        setClipSnap(null);
      }
      // A click that never became a drag on an already-selected bar collapses
      // the selection down to it (the deferred half of the rule in onClipDown).
      if (d.collapseSelectionOnUp && !d.moved) onTrackSelect?.(d.trackId, false);
      const { start, duration, sourceInSec } = d.live;
      // Below the drag threshold this was a SELECT, not an edit. Committing
      // anyway pushed an identity move onto the undo stack, so every click on
      // a bar cost the user one Ctrl+Z before their real edit.
      if (!d.moved) {
        clipDrag.current = null;
        setClipPreview(null);
        document.body.style.userSelect = '';
        document.body.style.cursor = '';
        return;
      }
      if (d.mode === 'slip') onClipSlip?.(d.id, sourceInSec);
      else if (d.mode === 'slide') onClipSlide?.(d.id, start);
      else if (d.mode === 'move') onClipMove?.(d.id, start);
      else if (d.mode === 'start') onClipTrim?.(d.id, 'start', start, { ripple: d.ripple });
      else onClipTrim?.(d.id, 'end', start + duration, { ripple: d.ripple });
      clipDrag.current = null;
      setClipPreview(null);
      document.body.style.userSelect = '';
      document.body.style.cursor = '';
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    return () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      if (clipDrag.current) {
        clipDrag.current = null;
        clipSnapShown.current = null;
        setClipSnap(null);
        document.body.style.cursor = '';
        document.body.style.userSelect = '';
      }
    };
  }, [pps, totalSeconds, onClipMove, onClipTrim, onClipSlip, onClipSlide, onTrackSelect, model.frameRate]);

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
      const idx = Math.max(0, Math.min(rows.length, Math.round(Math.max(0, relY - TIMELINE_TOP_PADDING) / trackHeight)));
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
  // Shared with GraphEditor / F9 / easing pills — store is the source of truth
  // (not a one-way mirror from local state, which would wipe graph selections).
  const selectedKfIds = useKeyframeSelectionStore((s) => s.ids);
  const setSelectedKfIds = useKeyframeSelectionStore((s) => s.set);
  const activeKf = useRef<{
    ids: string[];
    times: Map<string, number>;
    startX: number;
    moved: boolean;
    /** Which keyframe the pointer went down on — the grip for Alt time-scaling. */
    grabbedId: string;
  } | null>(null);
  const [kfPreview, setKfPreview] = useState<Map<string, number>>(new Map());
  const kfPreviewRef = useRef<Map<string, number>>(new Map());

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
  const kfDragLive = useRef({ currentTime, kfTimeById, frameRate: model.frameRate });
  kfDragLive.current = { currentTime, kfTimeById, frameRate: model.frameRate };

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
    activeKf.current = { ids: [...nextSel], times, startX: e.clientX, moved: false, grabbedId: kf.id };

    const emptyPreview = new Map<string, number>();
    kfPreviewRef.current = emptyPreview;
    setKfPreview(emptyPreview);
  }, [selectedKfIds, kfTimeById, setSelectedKfIds]);

  /**
   * Which selected keyframes are an END of the selection, and so act as the
   * grip for Alt time-scaling. Computed once over the whole selection because
   * a row only sees its own keyframes and the selection spans rows.
   */
  const scaleGripIds = useMemo<Set<string>>(() => {
    const out = new Set<string>();
    if (selectedKfIds.size < 2) return out;
    const times = new Map<string, number>();
    for (const id of selectedKfIds) {
      const t = kfTimeById.get(id);
      if (t !== undefined) times.set(id, t);
    }
    for (const id of times.keys()) if (scaleGrip(times, id)) out.add(id);
    return out;
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
      const live = kfDragLive.current;
      const frameDur = 1 / (live.frameRate || 30);

      // Alt on an END of a multi-selection is AE's time-scale gesture: the
      // group stretches about its opposite end instead of sliding. Everywhere
      // else — a single keyframe, or an interior one — Alt keeps its existing
      // meaning of "free the drag from snapping", because there is no span to
      // scale in those cases and the two readings can never both apply.
      if (e.altKey) {
        const scaled = scaleSelection(d.times, d.grabbedId, dtSec, frameDur);
        if (scaled) {
          setKfSnap(null);
          kfPreviewRef.current = scaled;
          setKfPreview(scaled);
          return;
        }
      }

      // Snap to the playhead, then to other keyframes, then to the frame grid.
      // Alt frees the drag entirely. The dragged keys are excluded from the
      // target list — a keyframe must not snap to itself.
      const dragging = new Set(d.ids);
      const others: number[] = [];
      for (const [id, t] of live.kfTimeById) if (!dragging.has(id)) others.push(t);

      const moved = [...d.times.values()].map((t) => t + dtSec);
      const { delta, target } = snapKeyframeGroup(moved, {
        pixelsPerSecond: pps,
        frameDuration: frameDur,
        // The RESOLVED playhead (separate prop first): model.currentTime is a
        // non-reactive snapshot when the host splits the playhead out, and
        // snapping to a stale snapshot missed the real playhead position.
        playheadTime: live.currentTime,
        keyframeTimes: others,
        disabled: e.altKey,
      });
      setKfSnap(target);

      const newPreview = new Map<string, number>();
      for (const [id, origTime] of d.times) {
        newPreview.set(id, Math.max(0, origTime + dtSec + delta));
      }
      kfPreviewRef.current = newPreview;
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
          const dtSec = (kfPreviewRef.current.get(id) ?? origTime) - origTime;
          onKeyframeMove?.(id, Math.max(0, origTime + dtSec));
        }
      } else {
        // Click without move → seek
        const singleId = d.ids[0];
        if (singleId) onKeyframeSeek?.(singleId);
      }
      const emptyPreview = new Map<string, number>();
      kfPreviewRef.current = emptyPreview;
      setKfPreview(emptyPreview);
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    return () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
    };
  }, [pps, scrollLeft, totalSeconds, onKeyframeMove, onKeyframeSeek]);

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
        y: clamp(clientY - rect.top + lanes.scrollTop - rulerHeight - TIMELINE_TOP_PADDING, 0, effectiveLanesHeight),
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
      if (marqueeDrag.current) {
        marqueeDrag.current = null;
        document.body.style.userSelect = '';
      }
    };
  }, [lanesPoint, marqueeRows, pps, trackHeight, setSelectedKfIds]);

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
          e.preventDefault();
          e.stopPropagation();
          if (onKeyframesDelete) onKeyframesDelete([...selectedKfIds]);
          else selectedKfIds.forEach(id => onKeyframeMove?.(id, -1));
          setSelectedKfIds(new Set());
        }
      }
      if ((e.ctrlKey || e.metaKey) && e.key === 'a') {
        e.preventDefault();
        e.stopPropagation();
        // Select all keyframes across all tracks
        const allIds = new Set<string>();
        model.tracks.forEach((track) => {
          track.keyframes?.forEach((kf) => allIds.add(kf.id));
          track.properties?.forEach((property) => {
            property.keyframes.forEach((kf) => allIds.add(kf.id));
          });
        });
        setSelectedKfIds(allIds);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [selectedKfIds, model.tracks, onKeyframeMove, onKeyframesDelete, setSelectedKfIds]);

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

  const fps = model.frameRate || 30;

  return (
    <div
      ref={containerRef}
      className={cn(styles.root, className)}
      onWheel={onWheel}
      data-shortcut-claim="delete backspace Ctrl+a Meta+a"
    >
      <div
        className={styles.headerCol}
        style={{ width: headerWidth, height: '100%' }}
        onWheel={onHeaderWheel}
      >
        <div className={styles.ruler} style={{ height: rulerHeight }}>
          {/* Column heads for the switches and modes (AE layout). */}
          <div ref={colHeadsRef} className={styles.colHeads}>
            {/* A/V toggles come FIRST, as they do in AE — the eye / solo / lock
                gutter is the left edge of the panel there, not something that
                trails the layer name. `.trackHeader` below is ordered to
                match; the two must stay in step or the legend names the wrong
                control. */}
            <div className={styles.colHeadPreInfo} aria-hidden>
              <span className={styles.colHeadItem}><Icon name="eye" size="sm" title="Video Visibility" /></span>
              <span className={styles.colHeadItem}><Icon name="circle" size="sm" title="Solo" /></span>
              <span className={styles.colHeadItem}><Icon name="lock" size="sm" title="Lock" /></span>
            </div>
            <span className={styles.colHeadLayer}>
              <span className={styles.colHeadIndex} aria-hidden>#</span>
              <span className={styles.colHeadLayerLabel}>Source Name</span>
              <button
                type="button"
                className={styles.colHeadPopOut}
                onClick={() => {
                  const url = `${window.location.origin}${window.location.pathname}#/popout/timeline`;
                  window.open(url, 'popout-timeline', 'width=1280,height=500,resizable=yes');
                }}
                title="Pop Out Timeline into Separate Window"
                aria-label="Pop out timeline into a separate window"
              >
                <Icon name="export" size="sm" />
              </button>
            </span>
            {/* Legend for the per-layer switch column below — one glyph per
                switch that actually exists on the rows, in ROW ORDER. The
                guide-layer glyph is not optional: `data-kind="guide"` ships on
                every row between adjustment and 3D, and a legend that skips a
                live switch is worse than no legend. */}
            {showSwitches && (
              <span className={styles.colHeadAeSwitches} aria-hidden>
                <span className={styles.colHeadItem}><Icon name="shy" size="sm" title="Shy" /></span>
                <span className={styles.colHeadItem}><span className={styles.fxText} title="Effects">fx</span></span>
                <span className={styles.colHeadItem}><Icon name="motion-blur" size="sm" title="Motion Blur" /></span>
                <span className={styles.colHeadItem}><Icon name="adjustment" size="sm" title="Adjustment Layer" /></span>
                <span className={styles.colHeadItem}><Icon name="frame" size="sm" title="Guide Layer (not rendered)" /></span>
                <span className={styles.colHeadItem}><span className={styles.fxText} title="Preserve Underlying Transparency">T</span></span>
                <span className={styles.colHeadItem}><Icon name="3d" size="sm" title="3D Layer" /></span>
              </span>
            )}
            {showModes && (
              <>
                <span className={styles.colHeadMode}>Mode</span>
                <span className={styles.colHeadMatte}>TrkMat</span>
                <span className={styles.colHeadParent}>Parent &amp; Link</span>
              </>
            )}
          </div>
        </div>
        <div
          ref={headerRef}
          className={styles.trackHeaderScroller}
          style={{ height: `calc(100% - ${rulerHeight}px)` }}
          onScroll={(e) => {
            const x = (e.currentTarget as HTMLDivElement).scrollLeft;
            if (colHeadsRef.current) colHeadsRef.current.style.transform = `translateX(${-x}px)`;
          }}
        >
          <div style={{ height: effectiveLanesHeight, position: 'relative' }}>
            {visibleRows.map((row, i) => {
              const realIndex = startRow + i;
              const rowStyle: CSSProperties = {
                position: 'absolute',
                top: TIMELINE_TOP_PADDING + realIndex * trackHeight,
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
                    onParentChange={(parentId, options) => onTrackParentChange?.(row.track.id, parentId, options)}
                    onToggleFlag={(flag) => onTrackToggleFlag?.(row.track.id, flag)}
                    onRename={(name) => onTrackRename?.(row.track.id, name)}
                    onTrackColorChange={onTrackColorChange}
                    showSwitches={showSwitches}
                    showModes={showModes}
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
                  paddingLeft: 88 + (row.track.depth ?? 0) * 14,
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
                paddingLeft: 124 + (row.track.depth ?? 0) * 14,
              };
              return (
                <PropertyHeader
                  key={`h_${row.track.id}_${row.prop.prop}`}
                  whipNodeId={row.track.id}
                  whipProp={row.prop.prop}
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
                  onScrubStart={
                    onPropertyScrubStart ? (p) => onPropertyScrubStart(row.track.id, p) : undefined
                  }
                  onScrubEnd={onPropertyScrubEnd}
                  selected={
                    // A row is selected when ANY of the props it edits is — a
                    // merged Position row stands for x and y together.
                    !!selectedPropertyKeys?.some((k) =>
                      (row.prop.valueProps ?? row.prop.stopwatchProps ?? [row.prop.prop]).some(
                        (p) => k === `${row.track.id}::${p}`,
                      ),
                    )
                  }
                  onSelect={
                    onPropertySelect
                      ? (mode) => {
                          for (const p of row.prop.valueProps ?? row.prop.stopwatchProps ?? [row.prop.prop]) {
                            onPropertySelect(row.track.id, p, mode);
                            // A plain click replaces, but a row with several
                            // props must end up with ALL of them selected.
                            mode = 'toggle';
                          }
                        }
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
                style={{ top: TIMELINE_TOP_PADDING + rowDragOver * trackHeight }}
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
        onDoubleClick={() => setPref('timelineHeaderWidth', minHeaderWidth)}
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
          {/* The time header STICKS to the top of the lanes viewport.
              Ruler, cache bars, work area and the playhead grabber ride in one
              sticky stack: expand a layer's properties, scroll down, and the
              frame ruler is still there to scrub against. Before this they
              scrolled away with the rows and every frame change meant
              scrolling back up first. The composition-duration handle stays
              OUTSIDE the stack — it spans ruler + lanes, so it cannot stick. */}
          <div className={styles.rulerStack} style={{ height: rulerHeight }}>
            <Ruler
              ticks={ticks}
              height={rulerHeight}
              width={laneWidth}
              onPointerDown={onPlayheadDown}
              currentTime={currentTime}
              duration={totalSeconds}
              pixelsPerSecond={pps}
              leftOffset={TIMELINE_LEFT_OFFSET}
            />

            {/* Preview-coverage lanes (green = RAM, blue = disk). They
                SUBSCRIBE THEMSELVES to the frame cache rather than taking
                coverage as a prop: it changes on every rendered frame, and
                routing that through this component's model would re-render the
                whole timeline — and the app shell above it — 60 times a second.
                See CacheBars for the throttling. */}
            <CacheBars
              fps={fps}
              pixelsPerSecond={pps}
              leftOffset={TIMELINE_LEFT_OFFSET}
              rulerHeight={rulerHeight}
            />

            {/* Work-area band on the ruler (in/out region for looped playback).
                Drag the body to move it; drag an edge handle to trim in/out. */}
            {model.workArea ? (
              <div
                className={styles.workAreaBar}
                style={{
                  top: 14,
                  height: Math.max(12, rulerHeight - 17),
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

            {/* Playhead grabber, pinned to the ruler. The full-height line below
                lives in `lanesInner` and scrolls; this is the part you drag, so
                it has to stay reachable at any scroll offset. */}
            <div
              className={styles.stickyPlayhead}
              style={{ transform: `translateX(${playheadX}px)`, height: rulerHeight }}
              onPointerDown={onPlayheadDown}
              aria-hidden
            >
              <div className={styles.playheadHead} />
            </div>
          </div>

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

            {/* The same indicator for a CLIP drag. Coloured by what was hit, so
                the line says *why* the bar stopped there — butted against a
                neighbour reads differently from parked on the playhead. */}
            {clipSnap && (
              <div
                className={cn(
                  styles.kfSnapLine,
                  clipSnap.kind === 'playhead' && styles.kfSnapPlayhead,
                  clipSnap.kind === 'clip' && styles.clipSnapClip,
                  clipSnap.kind === 'marker' && styles.clipSnapMarker,
                  (clipSnap.kind === 'workArea' || clipSnap.kind === 'comp') && styles.clipSnapBound,
                )}
                style={{ transform: `translateX(${TIMELINE_LEFT_OFFSET + clipSnap.time * pps}px)` }}
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
                  style={{ position: 'absolute', top: TIMELINE_TOP_PADDING + realIndex * trackHeight, left: 0, right: 0, height: trackHeight }}
                />
              );
            })}

            {/* Row content: animation block + keyframes */}
            {visibleRows.map((row, i) => {
              const realIndex = startRow + i;
              const top = TIMELINE_TOP_PADDING + realIndex * trackHeight;
              if (row.type === 'track') {
                return (
                  <TrackContent
                    key={`c_${row.track.id}`}
                    track={row.track}
                    ghosted={row.track.ghosted ?? false}
                    pps={pps}
                    trackHeight={trackHeight}
                    top={top}
                    selected={selectedTrackIds?.includes(row.track.id) ?? false}
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
                    scaleGripIds={scaleGripIds}
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
                  <Icon name="marker" size="sm" />
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
          onScrollTo={onMinimapScrollTo}
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

/** Vertical overview of all rows with a draggable viewport window.
 *
 *  Memoized for the same reason as {@link Ruler}: it draws a strip per row and
 *  none of it depends on the playhead, so it should not be rebuilt by a frame
 *  tick. Its `onScrollTo` is a useCallback at the call site — an inline arrow
 *  there would defeat this wrapper completely. */
function MinimapImpl({
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
}

const Minimap = memo(MinimapImpl);

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
  leftOffset = 8,
}: {
  ticks: { x: number; major: boolean; label: string }[];
  height: number;
  width: number;
  onPointerDown?: (e: ReactPointerEvent<HTMLDivElement>) => void;
  currentTime?: number;
  duration?: number;
  pixelsPerSecond?: number;
  leftOffset?: number;
}): JSX.Element {
  const progressWidth = Math.max(0, Math.min(duration * pixelsPerSecond, currentTime * pixelsPerSecond));
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
        className={styles.rulerProgressFill}
        style={{ left: leftOffset, width: progressWidth }}
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

const Ruler = memo(RulerImpl);

// Label colours come from the ONE palette in `core/scene/labelColor`. This file
// used to carry its own 12 hexes, so the same layer showed a different red in the
// timeline than in the scene tree and the canvas menu — three palettes for one
// property. (A fourth lived in the since-removed Motion Tools panel, which also
// wrote `node.color` directly instead of through `setNodeLabelColor`, so its
// choice never even saved.)

/*
  `data-whip-layer` on the row makes it a pick-whip drop target. `track.id` IS
  the scene node id — `deriveTimelineTracks` builds one track per node — so no
  lookup is needed on the drop side. See `@core/whip/whipTarget`.
*/
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
  showSwitches = true,
  showModes = true,
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
  /** `options.preserveWorld: false` is the Alt variant — link without compensating. */
  onParentChange?: (parentId: string | null, options?: { preserveWorld?: boolean }) => void;
  onToggleFlag?: (flag: 'shy' | 'collapse' | 'fxEnabled' | 'motionBlur' | 'adjustment' | 'threeD' | 'guide' | 'preserveTransparency') => void;
  onRename?: (newName: string) => void;
  onTrackColorChange?: (trackId: string, color: string) => void;
  /** AE's Toggle Switches / Modes — see `TimelineProps['columns']`. */
  showSwitches?: boolean;
  showModes?: boolean;
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

  // Option id + label come from the SHARED menu, not a second hardcoded copy of
  // the four labels. This row and the inspector used to each own their own list.
  const currentMatteOption = matteOptionId(track.matteMode);
  const currentMatteLabel = MATTE_SHORT_LABEL[currentMatteOption] ?? 'None';

  const parentItems = [
    {
      type: 'item' as const,
      id: '__none__',
      label: 'None',
      icon: currentParent === null ? ('check' as const) : undefined,
      onSelect: (m: MenuSelectModifiers) => onParentChange?.(null, parentOptionsFor(m)),
    },
    ...(parentOptions.length ? [{ type: 'separator' as const }] : []),
    ...parentOptions.map((o) => ({
      type: 'item' as const,
      id: o.id,
      label: o.name,
      icon: o.id === currentParent ? ('check' as const) : undefined,
      onSelect: (m: MenuSelectModifiers) => onParentChange?.(o.id, parentOptionsFor(m)),
    })),
  ];

  return (
    <div
      className={cn(styles.trackHeader, selected && styles.trackHeaderSelected)}
      style={{ ...style, '--track-color': track.color ?? 'transparent' } as CSSProperties}
      data-track-id={track.id}
      data-whip-layer={track.id}
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
      <div className={styles.preInfoCol}>
        <button
          type="button"
          className={styles.trackAction}
          data-kind="visible"
          data-on={!hidden || undefined}
          aria-label={hidden ? 'Show track' : 'Hide track'}
          title={hidden ? 'Hide' : 'Show (Video)'}
          onClick={(e) => { e.stopPropagation(); onToggleVisible(); }}
        >
          <Icon name={hidden ? 'eye-off' : 'eye'} size="sm" />
        </button>
        <button
          type="button"
          className={styles.trackAction}
          data-kind="solo"
          data-on={solo || undefined}
          aria-label={solo ? 'Unsolo track' : 'Solo track'}
          title={solo ? 'Unsolo' : 'Solo'}
          onClick={(e) => { e.stopPropagation(); onToggleSolo(); }}
        >
          <Icon name="circle" size="sm" />
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
          <Icon name="lock" size="sm" />
        </button>
      </div>

      <div className={styles.layerInfoCol} style={{ paddingLeft: track.depth ? track.depth * 14 : undefined }}>
        <div
          className={styles.dragHandle}
          title="Drag to reorder"
          onPointerDown={onReorderStart}
        >
          <Icon name="grip-vertical" size="sm" />
        </div>
        <span className={styles.trackIndex}>{index}</span>
        {typeof track.nodeColor === 'string' && (
          <div onClick={(e) => e.stopPropagation()} style={{ display: 'inline-flex', alignItems: 'center' }}>
            <ColorPicker
              value={track.nodeColor || '#5282b8'}
              onChange={(hex) => onTrackColorChange?.(track.id, hex)}
              compact
              alpha={false}
              aria-label="Layer label color"
            />
          </div>
        )}
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
          <Icon name={expanded ? 'chevron-down' : 'chevron-right'} size="sm" />
        </button>
        <span
          className={styles.trackIcon}
          style={{ color: track.color ?? 'var(--color-accent)' }}
          title={track.kind}
        >
          <Icon name={(track.icon as IconName) ?? 'layers'} size="sm" />
        </span>
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

      {showSwitches && (
        <div className={styles.aeSwitchesCol}>
          <button
            type="button"
            className={styles.trackAction}
            data-kind="shy"
            data-on={(track as any).shy || undefined}
            title="Toggle Shy Layer"
            onClick={(e) => { e.stopPropagation(); onToggleFlag?.('shy'); }}
          >
            <Icon name="shy" size="sm" />
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
            <Icon name="motion-blur" size="sm" />
          </button>
          <button
            type="button"
            className={styles.trackAction}
            data-kind="adjustment"
            data-on={track.adjustment || undefined}
            title="Toggle Adjustment Layer"
            onClick={(e) => { e.stopPropagation(); onToggleFlag?.('adjustment'); }}
          >
            <Icon name="adjustment" size="sm" />
          </button>
          <button
            type="button"
            className={styles.trackAction}
            data-kind="guide"
            data-on={track.guide || undefined}
            aria-pressed={track.guide === true}
            title={track.guide ? 'Guide layer — not rendered on export' : 'Make Guide Layer'}
            onClick={(e) => { e.stopPropagation(); onToggleFlag?.('guide'); }}
          >
            {/* NOT `eye-off`. That is the glyph the VISIBILITY switch shows when
                a layer is hidden, so every row carried two eyes doing unrelated
                jobs — visibility over in the pre-info column, guide-layer here —
                and the pair read as one control duplicated. A guide layer is
                reference framing the render skips, which is what `frame` says. */}
            <Icon name="frame" size="sm" />
          </button>
          {/* Preserve Underlying Transparency — AE's "T" switch. A glyph rather
              than an icon because that is what it is called and what AE draws;
              the column legend carries the same T in the same position. */}
          <button
            type="button"
            className={styles.trackAction}
            data-kind="preserveTransparency"
            data-on={track.preserveTransparency || undefined}
            aria-pressed={track.preserveTransparency === true}
            aria-label="Preserve Underlying Transparency"
            title={track.preserveTransparency
              ? 'Preserve Underlying Transparency — visible only where layers beneath are opaque'
              : 'Preserve Underlying Transparency'}
            onClick={(e) => { e.stopPropagation(); onToggleFlag?.('preserveTransparency'); }}
          >
            <span className={styles.fxText}>T</span>
          </button>
          <button
            type="button"
            className={styles.trackAction}
            data-kind="threeD"
            data-on={track.threeD || undefined}
            title="Toggle 3D Layer"
            onClick={(e) => { e.stopPropagation(); onToggleFlag?.('threeD'); }}
          >
            <Icon name="3d" size="sm" />
          </button>
        </div>
      )}

      {showModes && (
        <>
        <div className={styles.modeCol} onClick={(e) => e.stopPropagation()}>
          <Dropdown
            placement="bottom-start"
            trigger={
              <button type="button" className={styles.timelineSelectTrigger} aria-label="Layer Blend Mode">
                {blendModeLabel(track.blendMode as LayerBlendMode | undefined)}
              </button>
            }
            items={blendDropdownItems(
              track.blendMode as LayerBlendMode | undefined,
              (m) => onBlendModeChange?.(m),
            )}
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
            items={MATTE_OPTIONS.map((m) => ({
              type: 'item',
              id: m.id,
              label: MATTE_SHORT_LABEL[m.id] ?? m.label,
              icon: m.id === currentMatteOption ? ('check' as const) : undefined,
              onSelect: () => onMatteChange?.(applyMatteOption(track.matteMode, m.id)),
            }))}
          />
        </div>

        {/*
          "Parent & Link" — the column's name, and now both halves of it. The
          whip is the gesture; the dropdown is for a parent that is scrolled out
          of sight. Both call `onParentChange`, so parenting cannot mean two
          different things depending on which control was used.
        */}
        <div className={styles.parentCol} onClick={(e) => e.stopPropagation()}>
          <PickWhip
            label="Parent pick-whip — drag onto a layer (Alt: keep values, layer jumps)"
            accept={(target) => parentOptions.some((o) => o.id === target.nodeId)}
            onPick={(target, m) => onParentChange?.(target.nodeId, parentOptionsFor(m))}
          />
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
        </>
      )}
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
  onScrubStart,
  onScrubEnd,
  selected = false,
  onSelect,
  onToggleKeyframe,
  onStopwatch,
  onSeek,
  whipNodeId,
  whipProp,
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
  onScrubStart?: (prop: string) => void;
  onScrubEnd?: () => void;
  /** This row is in the property selection (highlighted name). */
  selected?: boolean;
  onSelect?: (mode: 'replace' | 'toggle') => void;
  onToggleKeyframe?: () => void;
  /** Enable animation for a static placeholder row (create first keyframe). */
  onStopwatch?: () => void;
  onSeek?: (time: number) => void;
  /** The layer and property this row edits, so a pick-whip can land on it. */
  whipNodeId?: string;
  whipProp?: string;
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
            onScrubStart={onScrubStart ? () => onScrubStart(p) : undefined}
            onScrubEnd={onScrubEnd}
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

  // The name is the row's SELECT target — AE's property selection, on which
  // proportional scrubbing is defined. Ctrl/Cmd-click adds to the ordered
  // selection; a plain click replaces it.
  const name = (
    <span
      className={cn(styles.propName, onSelect && styles.propNameSelectable, selected && styles.propNameSelected)}
      title={label}
      role={onSelect ? 'button' : undefined}
      tabIndex={onSelect ? 0 : undefined}
      aria-pressed={onSelect ? selected : undefined}
      onClick={
        onSelect
          ? (e) => {
              e.stopPropagation();
              onSelect(e.ctrlKey || e.metaKey ? 'toggle' : 'replace');
            }
          : undefined
      }
      onKeyDown={
        onSelect
          ? (e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                onSelect(e.ctrlKey || e.metaKey ? 'toggle' : 'replace');
              }
            }
          : undefined
      }
    >
      {label}
    </span>
  );

  if (!animated) {
    // Static placeholder: the AE property tree before any keyframes exist.
    return (
      <div
        className={cn(styles.propHeader, styles.propHeaderStatic, selected && styles.propHeaderSelected)}
        style={style}
        data-whip-layer={whipNodeId}
        data-whip-prop={whipProp}
      >
        {stopwatch}
        {name}
        {fields}
      </div>
    );
  }

  return (
    <div
      className={cn(styles.propHeader, selected && styles.propHeaderSelected)}
      style={style}
      data-whip-layer={whipNodeId}
      data-whip-prop={whipProp}
    >
      {stopwatch}
      {name}
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
  selected,
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
  /** This layer is in the selection — the bar carries the highlight so the
   *  lanes show what is selected without a trip back to the name column. */
  selected: boolean;
  clipPreview: { id: string; start: number; duration: number; sourceInSec?: number } | null;
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
      {/* Clips — body: move / Alt-slip / Shift+Alt-slide; edges: trim. */}
      {track.clips?.map((clip) => {
        const view = clipPreview && clipPreview.id === clip.id ? clipPreview : clip;
        const wave = clip.assetId ? audioEngine.getWaveform(clip.assetId) : undefined;
        const width = Math.max(2, view.duration * pps);
        const height = trackHeight - 6;
        // Slice to the bar's own window onto the source. Drawing `wave.peaks`
        // whole — which this did — squeezed the entire file into the bar, so
        // the peaks under the playhead were not the audio you would hear there
        // and trimming or slipping changed nothing on screen.
        const sourceInSec =
          (view as { sourceInSec?: number }).sourceInSec ?? clip.sourceInSec;
        const sourceOutSec =
          sourceInSec !== undefined
            ? sourceInSec + view.duration
            : clip.sourceOutSec;
        const slice =
          wave && sourceInSec !== undefined && sourceOutSec !== undefined
            ? peaksInRange(wave, sourceInSec, sourceOutSec)
            : wave?.peaks;
        const pathD = slice ? waveformPath(slice, width, height) : '';
        const audible = clip.assetId !== undefined && wave !== undefined;
        return (
          <div
            key={clip.id}
            className={cn(styles.clip, selected && styles.clipSelected)}
            style={{
              transform: `translateX(${8 + view.start * pps}px)`,
              width,
              height,
              background: clip.color ?? 'var(--color-primary)',
              border: 'none',
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
                <Icon name={clipMuted ? 'audio-off' : 'audio'} size="sm" />
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
  scaleGripIds,
  onKeyframeDown,
  onKeyframeContextMenu,
}: {
  keyframes: ReadonlyArray<TimelineKeyframeRef>;
  pps: number;
  kfPreview: Map<string, number>;
  selectedKfIds: Set<string>;
  /** Keyframes that are an END of the current multi-selection — the Alt grips. */
  scaleGripIds: Set<string>;
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
            title={`${time.toFixed(2)}s · ${describeShapes(shapes.left, shapes.right)} — drag to move, Shift+click to multi-select, right-click for options${scaleGripIds.has(kf.id) ? ', Alt+drag to scale the selection in time' : ''
              }`}
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
        <Icon name={expanded ? 'chevron-down' : 'chevron-right'} size="sm" />
      </span>
      <span className={styles.categoryIcon}>
        <Icon name={icon} size="sm" />
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
