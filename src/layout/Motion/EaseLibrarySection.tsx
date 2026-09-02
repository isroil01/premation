/**
 * The ease library — 24 named curves plus your own saved ones, one click each.
 *
 * ── Why this is not the interpolation-KIND selector ──────────────────────────
 *
 * The kind selector in the graph toolbar picks what sort of thing a segment is
 * (linear / bezier / hold / step / …). This picks the SHAPE of a bezier one.
 * They look similar and are different axes: choosing "Expo Out" here
 * necessarily sets the kind to `bezier`, but choosing `bezier` there says
 * nothing about which curve. Merging them into one strip would offer thirty-odd
 * chips of which some are modes and some are shapes, with no way to tell which
 * is which. The two vocabularies are reconciled in `easingVocabulary.ts`.
 *
 * ── Why it takes keyframe IDS ────────────────────────────────────────────────
 *
 * It used to take one (nodeId, prop, t) — the Motion panel's single focused
 * keyframe. The graph editor's selection is a SET, spanning tracks and layers,
 * and "apply Expo Out to the eight keyframes I selected" is the whole reason to
 * have a library. So the caller hands over the ids and this applies to all of
 * them, through `applyEasingToKeyframes` — the same entry point as F9 and the
 * timeline pills, which is what makes a click on a Position row ease x/y/z
 * together, reach data tracks (puppet pins, gradient stops), and land as ONE
 * undo step labelled with the curve's name.
 */

import { useMemo, useState } from 'react';
import { cn } from '@utils/cn';
import type { BezierHandles } from '@motion/animation';
import { applyEasingToKeyframes } from '@core/animation/keyframeAssistants';
import { easePresetsByFamily, type EasePreset } from '@core/animation/easePresets';
import { useCustomEaseStore, type CustomEase } from '@stores/customEaseStore';
import { useEaseClipboardStore } from '@stores/easeClipboardStore';
import { bumpScene } from '@stores/sceneStore';
import { easeCurvePath, easeCurveGuides, EASE_THUMB } from './easeCurvePath';
import styles from './EaseLibrarySection.module.css';

export interface EaseLibrarySectionProps {
  /** Every keyframe a click applies to — the caller's current selection. */
  keyframeIds: ReadonlyArray<string>;
  /** The focused keyframe's current handles, for the active highlight and for
   *  "save this curve". Absent when the focused keyframe carries no bezier. */
  bezier?: BezierHandles;
}

/** Curves match when every handle agrees — the id is not stored on a keyframe,
 *  so "which preset is this?" can only be answered by comparing geometry. */
function sameCurve(a: BezierHandles | undefined, b: BezierHandles): boolean {
  if (!a) return false;
  return a.every((v, i) => Math.abs(v - b[i]!) < 1e-6);
}

export function EaseLibrarySection({ keyframeIds, bezier }: EaseLibrarySectionProps): React.ReactElement {
  const families = useMemo(() => easePresetsByFamily(), []);
  const guides = useMemo(() => easeCurveGuides(), []);
  const curves = useCustomEaseStore((s) => s.curves);
  const addCurve = useCustomEaseStore((s) => s.addCurve);
  const removeCurve = useCustomEaseStore((s) => s.removeCurve);
  const applyCustomBezier = useEaseClipboardStore((s) => s.applyCustomBezier);
  const [name, setName] = useState('');

  const apply = (preset: EasePreset): void => {
    if (keyframeIds.length === 0) return;
    applyEasingToKeyframes([...keyframeIds], preset.id);
    bumpScene();
  };

  // A saved curve has no preset id, so it goes through the raw-handles write —
  // the same one the ease clipboard's paste uses, and undoable the same way.
  const applyCustom = (curve: CustomEase): void => {
    if (keyframeIds.length === 0) return;
    applyCustomBezier([...keyframeIds], curve.bezier);
    bumpScene();
  };

  const saveCurrent = (): void => {
    if (!bezier) return;
    if (addCurve(name, bezier)) setName('');
  };

  return (
    <>
      <h3 className={styles.sectionLabel}>Ease Curves</h3>
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
                    <CurveThumb bezier={preset.bezier} guides={guides} />
                    <span className={styles.curveName}>{DIRECTION_SHORT[preset.direction]}</span>
                  </button>
                );
              })}
            </div>
          </div>
        ))}

        {curves.length > 0 && (
          <div className={styles.family}>
            <span className={styles.familyLabel}>Saved</span>
            <div className={styles.curves} role="group" aria-label="Saved easing curves">
              {curves.map((curve) => {
                const active = sameCurve(bezier, curve.bezier);
                return (
                  <button
                    key={curve.id}
                    type="button"
                    aria-pressed={active}
                    aria-label={curve.label}
                    className={cn(styles.curveChip, active && styles.curveChipOn)}
                    onClick={() => applyCustom(curve)}
                    // Right-click to forget: a delete button on every chip
                    // would double the row's width for an action taken once.
                    onContextMenu={(e) => {
                      e.preventDefault();
                      removeCurve(curve.id);
                    }}
                    title={`${curve.label} — right-click to remove`}
                  >
                    <CurveThumb bezier={curve.bezier} guides={guides} />
                    <span className={styles.curveName}>{curve.label}</span>
                  </button>
                );
              })}
            </div>
          </div>
        )}
      </div>

      {/* Saving is only offered when there IS a curve to save: a keyframe with
          no bezier has no shape worth naming, and a disabled-looking field
          that never explains itself is worse than an absent one. */}
      {bezier && (
        <div className={styles.saveRow}>
          <input
            className={styles.saveInput}
            type="text"
            value={name}
            placeholder="Name this curve"
            aria-label="New ease curve name"
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                saveCurrent();
              }
            }}
          />
          <button
            type="button"
            className={styles.saveButton}
            disabled={name.trim().length === 0}
            onClick={saveCurrent}
            title="Save the selected keyframe's curve to the library"
          >
            Save
          </button>
        </div>
      )}

      <p className={styles.note}>
        Elastic and Bounce are generators, not curves — find them in the Bounce tab.
      </p>
    </>
  );
}

/** The thumbnail, SAMPLED from the curve it applies (see `easeCurvePath`). */
function CurveThumb({
  bezier,
  guides,
}: {
  bezier: BezierHandles;
  guides: ReturnType<typeof easeCurveGuides>;
}): React.ReactElement {
  return (
    <svg
      className={styles.curveThumb}
      viewBox={`0 0 ${EASE_THUMB.width} ${EASE_THUMB.height}`}
      aria-hidden
    >
      {/* Drawn first so the curve reads on top of them. They are what makes an
          overshoot legible as one. */}
      <line className={styles.guide} x1={guides.x0} y1={guides.y0} x2={guides.x1} y2={guides.y0} />
      <line className={styles.guide} x1={guides.x0} y1={guides.y1} x2={guides.x1} y2={guides.y1} />
      <path className={styles.curve} d={easeCurvePath(bezier)} />
    </svg>
  );
}

/** The family name is already on the row, so the chip only needs the direction. */
const DIRECTION_SHORT: Record<EasePreset['direction'], string> = {
  in: 'In',
  out: 'Out',
  inOut: 'InOut',
};
