/**
 * Timeline geometry constants, the column model and the row union — the
 * module-level facts every piece of the timeline panel reads. Split out of
 * `Timeline.tsx` so the header column, the lanes, the ruler stack and the drag
 * hooks can import them without importing the composer (which imports them).
 */

import type { IconName } from '@components/Icon';
import type { ClipCut } from './clipCuts';
import { TIMELINE_EXTRA_COLUMNS, extraColumnsWidth } from './timelineColumns';
import { TIMELINE_GROUP_ORDER, groupForProp, type TimelineGroupKey } from '@core/timeline/propertyTree';
import type { TimelineTrack, TimelinePropertyTrack } from './TimelineModel';

/**
 * The column-head / ruler strip.
 *
 * 26, not 36. Everything in it is a 22px control or a 12px label, so ten of
 * those 36 pixels were padding — a header band half again as tall as the rows
 * it labels, which made the track list look like it started a third of the way
 * down the panel.
 */
export const RULER_HEIGHT_DEFAULT = 26;
export const TRACK_HEIGHT_DEFAULT = 36;
/**
 * Left margin of the lanes, px — time 0 sits this far in so the 0s tick and
 * the playhead head stand clear of the header border. Module-level and
 * exported: `timelineFit` parks a fitted range at the same gutter, and every
 * lane coordinate (clips, keyframes, snap lines, markers) adds it.
 */
export const TIMELINE_LEFT_OFFSET = 8;
/**
 * How near a cut the pointer must be, in SCREEN pixels, to start a roll.
 *
 * Pixels rather than frames so the grab feels the same at every zoom — a
 * frame-based radius would be unhittable zoomed out and would swallow whole
 * clips zoomed in, which is the same reasoning `clipSnap` gives for its own
 * threshold.
 */
export const ROLL_GRAB_PX = 6;
/**
 * How near a cut a chip has to be dropped, in pixels.
 *
 * Wider than the roll's grab radius on purpose: a roll is an edit that must not
 * fire by accident, while a drop is a deliberate act with a visible target
 * lighting up before the release — so the drop can afford to be forgiving.
 */
export const CUT_GRAB_PX = 14;
/** The width of the strip drawn at a cut while a chip hovers it. */
export const CUT_ZONE_PX = 12;
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
export const TL_COLUMN_WIDTHS = {
  /** `.colHeads` / `.trackHeader` horizontal padding, both edges. */
  padding: 8,
  /** `--tl-col-gap`, between every pair of columns. */
  gap: 4,
  /** A divider rule's margin + padding, on the one side that draws it. */
  rule: 16,
  preInfo: 97,
  name: 190,
  /** Ten 22px switches + nine 4px gaps — mirrors `--tl-col-switches`. */
  switches: 256,
  mode: 70,
  matte: 58,
  parent: 120,
  /** Each of In / Out / Duration — mirrors `TIMELINE_EXTRA_COLUMNS`. */
  extra: 72,
} as const;

/**
 * The narrowest the header column may be dragged.
 *
 * Not a limit on the COLUMNS — those keep their widths and scroll. It is the
 * width below which the name column and the switch block stop being readable
 * as a row. (The panel's toolbar used to split on this pixel too; it is one
 * flat row now and no longer mirrors it.)
 */
export const TRACK_HEADER_MIN_WIDTH = 260;

/**
 * Width the header needs for `columns` — see `TL_COLUMN_WIDTHS`.
 *
 * `extraCount` is how many of In / Out / Duration are switched on; they are
 * off by default, so every existing caller may keep omitting it.
 */
export function headerWidthFor(columns: 'switches' | 'modes' | 'both', extraCount = 0): number {
  const W = TL_COLUMN_WIDTHS;
  // A/V gutter (ruled) + gap + name. Always present.
  let total = W.padding + (W.preInfo + W.rule) + W.gap + W.name;
  if (columns !== 'modes') total += W.gap + W.switches + W.rule;
  if (columns !== 'switches') {
    total += W.gap + W.mode + W.rule;
    total += W.gap + W.matte + W.rule;
    total += W.gap + W.parent + W.rule;
  }
  total += extraColumnsWidth(
    TIMELINE_EXTRA_COLUMNS.slice(0, Math.max(0, extraCount)).map((c) => c.id),
    W.gap,
    W.rule,
  );
  return total;
}


/**
 * The header column's ACTUAL width — the one number the track headers, the
 * column resizer and the panel's toolbar above them all have to agree on.
 *
 * The model may pin one (tests, embeds); otherwise it is the user's dragged
 * preference; otherwise what the visible columns need. `<Timeline>` and
 * `<BottomTimeline>` both call this with the same inputs, so the toolbar's
 * left column and the header column below it cannot come apart.
 */
export function resolveTrackHeaderWidth(
  pinned: number | undefined,
  preferred: number | undefined | null,
  columns: 'switches' | 'modes' | 'both',
  extraCount = 0,
  available = 0,
): number {
  if (pinned !== undefined) return pinned;
  return capHeaderToPanel(preferred ?? headerWidthFor(columns, extraCount), available);
}

/** The least the LANES keep, however many columns are on: px, and share of the panel. */
export const TIMELINE_MIN_LANES_PX = 320;
export const TIMELINE_MIN_LANES_SHARE = 0.42;

/**
 * Never let the header column take the whole panel.
 *
 * The 'both' column set needs ~897px. On a laptop the docked timeline is ~855px
 * wide, so the lanes were left with ZERO width: no ruler, no bars, no keyframes,
 * no playhead — a timeline with no time in it, and nothing on screen saying why.
 * The columns scroll horizontally inside the header (they always could), so
 * capping the header costs a scroll; not capping it costs the timeline.
 *
 * `available` is the panel's measured width; 0 (not measured yet, or a test
 * with no layout) leaves the width alone.
 */
export function capHeaderToPanel(width: number, available: number): number {
  if (!(available > 0)) return width;
  const lanes = Math.max(TIMELINE_MIN_LANES_PX, Math.round(available * TIMELINE_MIN_LANES_SHARE));
  return Math.max(TRACK_HEADER_MIN_WIDTH, Math.min(width, available - lanes));
}

export const TIMELINE_TOP_PADDING = 6;

/** A stable identity for a cut — it has no id of its own, being emergent. */
export const cutKeyOf = (cut: ClipCut): string => `${cut.leftClipId}|${cut.rightClipId}`;
export const TIMELINE_BOTTOM_PADDING = 12;

/** A virtualized row is either a track summary row, a category accordion row, or a property sub-row. */
export type Row =
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
export const GROUP_HEADING: Readonly<Record<TimelineGroupKey, { label: string; icon: IconName }>> = {
  text: { label: 'Text', icon: 'type' },
  contents: { label: 'Contents', icon: 'shape' },
  masks: { label: 'Masks', icon: 'mask-square' },
  effects: { label: 'Effects', icon: 'sparkles' },
  transform: { label: 'Transform', icon: 'sliders-h' },
  styles: { label: 'Layer Styles', icon: 'palette' },
  camera: { label: 'Camera Options', icon: 'camera' },
  light: { label: 'Light Options', icon: 'light' },
  geometry: { label: 'Geometry Options', icon: 'cube' },
  material: { label: 'Material Options', icon: 'cube' },
  audio: { label: 'Audio', icon: 'audio' },
  time: { label: 'Time', icon: 'clock' },
};

/**
 * Which heading a property row sits under.
 *
 * The model states it (`prop.group`). A row built without one falls back to
 * the property tree's own `groupForProp` — the registry the model itself
 * uses — rather than the label-substring guess that used to live here, which
 * filed a text animator's Blur under Effects and could not tell a layer style
 * from the effect it compiles to.
 */
export function getPropertyCategory(prop: TimelinePropertyTrack): { key: string; label: string; icon: IconName; order: number } {
  if (prop.group) {
    const heading = GROUP_HEADING[prop.group];
    return { key: prop.group, ...heading, order: TIMELINE_GROUP_ORDER[prop.group] };
  }

  // The property tree's own classifier, which reads the prop PATH (effect
  // prefixes, mask paths, text animators) rather than words in the label.
  const group = groupForProp(prop.prop);
  return { key: group, ...GROUP_HEADING[group], order: TIMELINE_GROUP_ORDER[group] };
}
