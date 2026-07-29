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
 */

import type { ReactNode } from 'react';
import { cn } from '@utils/cn';
import { Icon } from '@components/Icon';
import styles from './PropertyRow.module.css';

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
      <Icon name="stopwatch" size={11} />
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
        <Icon name="chevron-left" size={11} />
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
        <Icon name="keyframe" size={11} />
      </button>
      <button
        type="button"
        className={styles.navBtn}
        disabled={!hasNext}
        aria-label={`Next ${label} keyframe`}
        title="Next keyframe"
        onClick={(e) => { e.stopPropagation(); onNext(); }}
      >
        <Icon name="chevron-right" size={11} />
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
}: PropertyRowProps): JSX.Element {
  const a11yLabel = srLabel ?? label;
  return (
    <div
      className={cn(styles.row, compact && styles.compact, className)}
      onContextMenu={onContextMenu}
      style={depth > 0 ? { paddingLeft: depth * 16 } : undefined}
      data-property-row
    >
      {onStopwatch ? (
        <StopwatchButton animated={animated} label={a11yLabel} onToggle={onStopwatch} />
      ) : (
        <span />
      )}
      {animated && navigator ? <KeyframeNavigator label={a11yLabel} {...navigator} /> : <span />}
      <span className={cn(styles.name, animated && styles.nameAnimated)} title={a11yLabel}>
        {label}
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
          <Icon name="rotate" size={10} />
        </button>
      ) : (
        <span />
      )}
    </div>
  );
}

export default PropertyRow;
