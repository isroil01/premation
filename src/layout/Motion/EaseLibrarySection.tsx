/**
 * The ease library — 24 named curves, one click each, in the Graph panel.
 *
 * ── Why this sits BELOW the Easing row and not inside it ────────────────────
 *
 * The row above picks an interpolation KIND (linear / bezier / hold / step) —
 * what sort of thing the segment is. This picks the SHAPE of a bezier one. They
 * look similar and are different axes: choosing "Expo Out" here necessarily
 * sets the kind to `bezier`, but choosing `bezier` above says nothing about
 * which curve. Merging them into one strip would offer thirty-odd chips of
 * which some are modes and some are shapes, and no way to tell which is which.
 *
 * Applying goes through `applyEasingToKeyframes` — the same entry point as F9
 * and the timeline pills — rather than `setEasing`+`setBezier` here. That is
 * what makes a click on a Position row ease x/y/z together, reach data tracks
 * (puppet pins, gradient stops), and land as one undo step labelled with the
 * curve's name.
 */

import { useMemo } from 'react';
import { cn } from '@utils/cn';
import { makeKeyframeId } from '@motion/animation';
import type { BezierHandles } from '@motion/animation';
import { applyEasingToKeyframes } from '@core/animation/keyframeAssistants';
import { easePresetsByFamily, type EasePreset } from '@core/animation/easePresets';
import { bumpScene } from '@stores/sceneStore';
import { easeCurvePath, easeCurveGuides, EASE_THUMB } from './easeCurvePath';
import panel from './MotionEditorPanel.module.css';
import styles from './EaseLibrarySection.module.css';

export interface EaseLibrarySectionProps {
  nodeId: string;
  prop: string;
  /** Time of the keyframe the curve applies to. */
  t: number;
  /** The selected keyframe's current handles, for the active highlight. */
  bezier?: BezierHandles;
}

/** Curves match when every handle agrees — the id is not stored on a keyframe,
 *  so "which preset is this?" can only be answered by comparing geometry. */
function sameCurve(a: BezierHandles | undefined, b: BezierHandles): boolean {
  if (!a) return false;
  return a.every((v, i) => Math.abs(v - b[i]!) < 1e-6);
}

export function EaseLibrarySection({ nodeId, prop, t, bezier }: EaseLibrarySectionProps): React.ReactElement {
  const families = useMemo(() => easePresetsByFamily(), []);
  const guides = useMemo(() => easeCurveGuides(), []);

  const apply = (preset: EasePreset): void => {
    applyEasingToKeyframes([makeKeyframeId(nodeId, prop, t)], preset.id);
    bumpScene();
  };

  return (
    <>
      <h3 className={panel.sectionLabel}>Ease Curves</h3>
      <div className={styles.families}>
        {families.map((row) => (
          <div key={row.family} className={styles.family}>
            <span className={styles.familyLabel}>{row.label}</span>
            <div className={styles.curves} role="group" aria-label={`${row.label} easing curves`}>
              {row.presets.map((preset) => {
                const active = sameCurve(bezier, preset.bezier);
                return (
                  <button
                    key={preset.id}
                    type="button"
                    aria-pressed={active}
                    aria-label={preset.label}
                    className={cn(styles.curveChip, active && styles.curveChipOn)}
                    onClick={() => apply(preset)}
                    title={
                      preset.overshoots
                        ? `${preset.label} — passes the target before settling`
                        : preset.label
                    }
                  >
                    <svg
                      className={styles.curveThumb}
                      viewBox={`0 0 ${EASE_THUMB.width} ${EASE_THUMB.height}`}
                      aria-hidden
                    >
                      {/* Drawn first so the curve reads on top of them. They are
                          what makes an overshoot legible as one. */}
                      <line className={styles.guide} x1={guides.x0} y1={guides.y0} x2={guides.x1} y2={guides.y0} />
                      <line className={styles.guide} x1={guides.x0} y1={guides.y1} x2={guides.x1} y2={guides.y1} />
                      <path className={styles.curve} d={easeCurvePath(preset.bezier)} />
                    </svg>
                    <span className={styles.curveName}>{DIRECTION_SHORT[preset.direction]}</span>
                  </button>
                );
              })}
            </div>
          </div>
        ))}
      </div>
      <p className={styles.note}>
        Elastic and Bounce are generators, not curves — find them in the Bounce tab.
      </p>
    </>
  );
}

/** The family name is already on the row, so the chip only needs the direction. */
const DIRECTION_SHORT: Record<EasePreset['direction'], string> = {
  in: 'In',
  out: 'Out',
  inOut: 'InOut',
};
