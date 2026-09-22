/**
 * The property row — one layout and one set of controls for every animatable
 * property in the app.
 *
 * Before this there were two different stopwatches with two different meanings
 * of "the same control": the timeline drew a real stopwatch icon left of the
 * property name, while the inspector and the effect stack drew a bare
 * `<input type="checkbox">`. Same job, different affordance, different glyph,
 * different position — and the keyframe navigator existed only in the timeline,
 * so removing a property's animation meant crossing to the other panel to find
 * the control that could do it.
 *
 * Deliberately PRESENTATIONAL. It knows nothing about the scene graph or the
 * animation engine; every call site keeps its own wiring. That is what lets the
 * timeline (virtualized rows, absolute positioning) and the inspector (flow
 * layout) share it without either bending to the other's constraints.
 *
 * Layout notes live in PropertyRow.module.css — the short version is that the
 * columns are a real grid, so a row with an extra control (the rotation dial)
 * can no longer push its value out of the column every other row shares.
 *
 * TWO LAYOUTS, one component (2026-09-15). The timeline and Effect Controls
 * keep the AE column set — stopwatch, navigator, name, value, reset — because
 * they list hundreds of rows where a fixed control column IS the scanning aid.
 * The Properties inspector opts into `'inspector'`: `Label [field] [field] ◀◆▶`,
 * with the stopwatch and expression controls revealed on hover and reset moved
 * to the right-click menu. Users read the old inspector rows as "too many
 * buttons": five controls per property, times seven transform groups, at a
 * 280px panel width that already truncated "X" and "Y". The opt-in is a prop
 * or a context so no timeline row can change by accident.
 */

import { createContext, useContext, type ReactNode } from 'react';
import { cn } from '@utils/cn';
import { Icon } from '@components/Icon';
import styles from './PropertyRow.module.css';

/** `'default'` = the timeline / Effect Controls grid; `'inspector'` = the compact Properties row. */
export type PropertyRowLayout = 'default' | 'inspector';

/**
 * The layout every `PropertyRow` below uses unless it passes `layout` itself.
 * A context rather than a prop threaded through every section, because the
 * inspector's rows are built several components deep (section → pair row →
 * row) and each hop would otherwise have to remember to forward it.
 */
export const PropertyRowLayoutContext = createContext<PropertyRowLayout>('default');

/**
 * Registry labels are Title Case ("Skew Axis", "Anchor Point") because the
 * timeline and menus use them as names. The inspector shows them in sentence
 * case like the rest of a form, WITHOUT lower-casing axis letters or acronyms:
 * only a capitalised ordinary word after the first is folded, so "Position X"
 * and "3D Layer" survive as "Position X" and "3D layer". Display only — the
 * accessible name keeps the registry spelling.
 */
export function sentenceCaseLabel(label: string): string {
  return label
    .split(' ')
    .map((word, i) => (i > 0 && /^[A-Z][a-z]+$/.test(word) ? word.toLowerCase() : word))
    .join(' ');
}

export interface StopwatchButtonProps {
  /** True when the property has keyframes (or an expression). */
  animated: boolean;
  /** Property name, for the accessible label. */
  label: string;
  onToggle: () => void;
  className?: string;
}

/**
 * The stopwatch: one click enables animation and writes a keyframe at the
 * playhead; clicking it again removes the property's animation entirely.
 *
 * Lit when animated. Same glyph, same size, same position on every row in the
 * app — that consistency is most of its value, because it is the control users
 * reach for without looking.
 */
export function StopwatchButton({ animated, label, onToggle, className }: StopwatchButtonProps): JSX.Element {
  return (
    <button
      type="button"
      className={cn(styles.stopwatch, className)}
      data-on={animated || undefined}
      aria-pressed={animated}
      aria-label={`${animated ? 'Disable' : 'Enable'} ${label} animation`}
      title={
        animated
          ? `Disable ${label} animation (removes its keyframes)`
          : `Enable ${label} animation (create first keyframe at playhead)`
      }
      onClick={(e) => {
        e.stopPropagation();
        onToggle();
      }}
    >
      <Icon name="stopwatch" size="sm" />
    </button>
  );
}

export interface KeyframeNavigatorProps {
  label: string;
  /** Whether a keyframe exists before / after the playhead. */
  hasPrev: boolean;
  hasNext: boolean;
  /** True when the playhead sits exactly on a keyframe. */
  atKeyframe: boolean;
  onPrev: () => void;
  onNext: () => void;
  /** Add a keyframe at the playhead, or remove the one already there. */
  onToggleKeyframe: () => void;
}

/**
 * AE's `◀ ◆ ▶`. Small, used constantly.
 *
 * The centre diamond is filled when the playhead is exactly on a keyframe, and
 * clicking it adds or removes one WITHOUT changing the value — which is the
 * only way to anchor a property before animating away from it.
 */
export function KeyframeNavigator({
  label,
  hasPrev,
  hasNext,
  atKeyframe,
  onPrev,
  onNext,
  onToggleKeyframe,
}: KeyframeNavigatorProps): JSX.Element {
  return (
    <div className={styles.nav}>
      <button
        type="button"
        className={styles.navBtn}
        disabled={!hasPrev}
        aria-label={`Previous ${label} keyframe`}
        title="Previous keyframe"
        onClick={(e) => { e.stopPropagation(); onPrev(); }}
      >
        <Icon name="chevron-left" size="sm" />
      </button>
      <button
        type="button"
        className={styles.navBtn}
        data-on={atKeyframe || undefined}
        aria-pressed={atKeyframe}
        aria-label={atKeyframe ? `Remove ${label} keyframe at playhead` : `Add ${label} keyframe at playhead`}
        title={atKeyframe ? 'Remove keyframe at playhead' : 'Add keyframe at playhead'}
        onClick={(e) => { e.stopPropagation(); onToggleKeyframe(); }}
      >
        <Icon name="keyframe" size="sm" />
      </button>
      <button
        type="button"
        className={styles.navBtn}
        disabled={!hasNext}
        aria-label={`Next ${label} keyframe`}
        title="Next keyframe"
        onClick={(e) => { e.stopPropagation(); onNext(); }}
      >
        <Icon name="chevron-right" size="sm" />
      </button>
    </div>
  );
}

export interface PropertyRowProps {
  /** What the row DISPLAYS. Often abbreviated under a group header ("X"). */
  label: string;
  /**
   * The property's full, unambiguous name, used for every accessible label and
   * tooltip on the row's controls.
   *
   * These differ on purpose. Under a "Position" header the row reads "X", which
   * is right visually and useless to a screen reader — Anchor X, Position X and
   * Scale X would all announce as "Enable X animation". Defaults to `label`.
   */
  srLabel?: string;
  /** The value control(s) — a ValueField, a colour swatch, a dial + field… */
  children: ReactNode;
  animated?: boolean;
  onStopwatch?: () => void;
  /** Navigator wiring. Omitted → the navigator column stays empty (reserved). */
  navigator?: Omit<KeyframeNavigatorProps, 'label'>;
  /** Restore the property's default. Omitted → no reset affordance. */
  onReset?: () => void;
  /** Right-click menu for this property. */
  onContextMenu?: (e: React.MouseEvent) => void;
  /** Denser rows, for panels that show many parameters at once. */
  compact?: boolean;
  className?: string;
  /** Extra leading indent, in levels (16px each), for nested property groups. */
  depth?: number;
  /**
   * The row describes a multi-selection whose values disagree. Draws a
   * "mixed" mark after the name; the value control itself is expected to be a
   * `ValueField` in `mixed` mode (or a swatch drawn as mixed).
   */
  mixed?: boolean;
  /** A muted note after the name — "2 of 3" when only some layers have it. */
  hint?: string;
  /** Pinned to the Pinned tab — a push-pin glyph before the name. */
  pinned?: boolean;
  /**
   * An expression error, shown as a dashed underline on the name with the
   * message on hover. `null`/undefined = no error.
   */
  error?: string | null;
  /**
   * Small controls that belong to the NAME cell's right edge — the `=`
   * expression toggle, the pick-whip, modifier chips. In the name cell rather
   * than a column of their own so the value column every row shares does not
   * move by the width of controls only some rows have.
   */
  trailing?: ReactNode;
  /**
   * Full-width content under the row — the keyframe lane, an inline expression
   * editor. Spans every grid column so it aligns with the row above it.
   */
  below?: ReactNode;
  /** Focus entering / leaving the row — lets a shortcut act on "the focused property". */
  onFocusCapture?: (e: React.FocusEvent<HTMLDivElement>) => void;
  onBlurCapture?: (e: React.FocusEvent<HTMLDivElement>) => void;
  /**
   * Which grid to draw. Omitted → `PropertyRowLayoutContext` (default
   * `'default'`). In `'inspector'` the stopwatch joins `trailing` in the name
   * cell's hover tray, the navigator takes the right-hand cell, and `onReset`
   * draws nothing — reset is the row menu's "Reset …" entry there.
   */
  layout?: PropertyRowLayout;
}

/**
 * One animatable property, laid out as:
 *
 *     [stopwatch] [◀ ◆ ▶] Name............ [value] [value] [reset]
 *
 * The navigator only renders once the property is animated, but its COLUMN is
 * always reserved — otherwise enabling animation shifts the name and value
 * sideways, which reads as the panel twitching under the cursor.
 */
export function PropertyRow({
  label,
  srLabel,
  children,
  animated = false,
  onStopwatch,
  navigator,
  onReset,
  onContextMenu,
  compact = false,
  className,
  depth = 0,
  mixed = false,
  hint,
  pinned = false,
  error,
  trailing,
  below,
  onFocusCapture,
  onBlurCapture,
  layout: layoutProp,
}: PropertyRowProps): JSX.Element {
  const contextLayout = useContext(PropertyRowLayoutContext);
  const layout = layoutProp ?? contextLayout;
  const a11yLabel = srLabel ?? label;

  if (layout === 'inspector') {
    /*
     *     [⏱] Label····[tray]  [ field ][ field ]  [◀ ◆ ▶]
     *
     * The STOPWATCH leads the label and is always there, as in After Effects:
     * it is how a property becomes an animation, and hidden-until-hover meant a
     * new user looking at a camera's Position saw no way to keyframe it at all.
     * It also used to arrive in the tray on hover and crush the label beside it
     * ("Rotation X" read "F").
     *
     * The tray (`=`, whip, caller extras) stays in the label cell and is
     * revealed on hover/focus, so revealing it can only truncate the label
     * under the cursor — never move a field. Children marked
     * `data-persist` stay visible at rest: that is how an attached expression
     * keeps its `=` mark. The right-hand cell is reserved even when empty for
     * the reason the default grid reserves its navigator column.
     */
    return (
      <div
        className={cn(
          styles.row,
          styles.inspector,
          compact && styles.compact,
          below !== undefined && styles.withBelow,
          className,
        )}
        onContextMenu={onContextMenu}
        onFocusCapture={onFocusCapture}
        onBlurCapture={onBlurCapture}
        style={depth > 0 ? { paddingLeft: depth * 16 } : undefined}
        data-property-row
        data-layout="inspector"
        data-mixed={mixed || undefined}
      >
        <span className={cn(styles.name, animated && styles.nameAnimated)} title={error ?? a11yLabel}>
          {onStopwatch && <StopwatchButton animated={animated} label={a11yLabel} onToggle={onStopwatch} className={styles.leadStopwatch} />}
          {pinned && <Icon name="push-pin" size="sm" className={styles.pin} title="Pinned" />}
          <span className={cn(styles.nameText, error && styles.nameError)} data-error={error ? '' : undefined}>
            {sentenceCaseLabel(label)}
          </span>
          {mixed && (
            <span className={styles.mixedMark} title="Mixed — the selected layers disagree" aria-label="Mixed values">
              mixed
            </span>
          )}
          {hint && <span className={styles.hint}>{hint}</span>}
          {trailing && <span className={styles.trailing}>{trailing}</span>}
        </span>
        <div className={styles.values}>{children}</div>
        <span className={styles.anim}>
          {animated && navigator ? <KeyframeNavigator label={a11yLabel} {...navigator} /> : null}
        </span>
        {below !== undefined && <div className={styles.below}>{below}</div>}
      </div>
    );
  }

  return (
    <div
      className={cn(styles.row, compact && styles.compact, below !== undefined && styles.withBelow, className)}
      onContextMenu={onContextMenu}
      onFocusCapture={onFocusCapture}
      onBlurCapture={onBlurCapture}
      style={depth > 0 ? { paddingLeft: depth * 16 } : undefined}
      data-property-row
      data-mixed={mixed || undefined}
    >
      {onStopwatch ? (
        <StopwatchButton animated={animated} label={a11yLabel} onToggle={onStopwatch} />
      ) : (
        <span />
      )}
      {animated && navigator ? <KeyframeNavigator label={a11yLabel} {...navigator} /> : <span />}
      <span className={cn(styles.name, animated && styles.nameAnimated)} title={error ?? a11yLabel}>
        {pinned && <Icon name="push-pin" size="sm" className={styles.pin} title="Pinned" />}
        <span className={cn(styles.nameText, error && styles.nameError)} data-error={error ? '' : undefined}>
          {label}
        </span>
        {mixed && (
          <span className={styles.mixedMark} title="Mixed — the selected layers disagree" aria-label="Mixed values">
            mixed
          </span>
        )}
        {hint && <span className={styles.hint}>{hint}</span>}
        {trailing && <span className={styles.trailing}>{trailing}</span>}
      </span>
      <div className={styles.values}>{children}</div>
      {onReset ? (
        <button
          type="button"
          className={styles.reset}
          aria-label={`Reset ${a11yLabel}`}
          title={`Reset ${a11yLabel}`}
          onClick={(e) => { e.stopPropagation(); onReset(); }}
        >
          <Icon name="rotate" size="sm" />
        </button>
      ) : (
        <span />
      )}
      {below !== undefined && <div className={styles.below}>{below}</div>}
    </div>
  );
}

export default PropertyRow;
