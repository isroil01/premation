/**
 * Track Motion — the "Advanced tracking" disclosure: six modes, the window
 * sizes, manual track / apply, and the roto & fill tools.
 *
 * Moved out of `TrackMotionSection.tsx` verbatim (2026-09-04); the props are
 * the names the JSX already used, so the markup is byte-for-byte what the
 * section drew. The one-click card above it stays in the section because it
 * IS the section; this is everything one disclosure down.
 */

import { Button } from '@components/Button';
import { InspectorRow } from '@components/Inspector';
import { useTrackerStore, type TrackerMode, type TrackerResult } from '@stores/trackerStore';
import { FEATURE_SIZES, SEARCH_SIZES, MODE_HINTS, MODE_LABELS, sizeOptions } from './trackMotionCopy';
import type { StabVariant, TrackMotionActions, TrackTarget } from './trackMotionActions';
import styles from '../TrackMotionSection.module.css';

export interface AdvancedTrackingProps {
  nodeId: string;
  src: { width: number; height: number };
  mode: TrackerMode;
  points: ReadonlyArray<{ x: number; y: number }>;
  featureHalf: number;
  searchHalf: number;
  dense: boolean;
  stabVariant: StabVariant;
  setStabVariant: (v: StabVariant) => void;
  targetId: string;
  setTargetId: (id: string) => void;
  targets: ReadonlyArray<TrackTarget>;
  result: TrackerResult | null;
  tracking: boolean;
  progress: number;
  canTrack: boolean;
  applyLabel: string;
  maskPoints: number;
  actions: TrackMotionActions;
}

export function AdvancedTracking({
  nodeId, src, mode, points, featureHalf, searchHalf, dense, stabVariant, setStabVariant,
  targetId, setTargetId, targets, result, tracking, progress, canTrack, applyLabel, maskPoints, actions,
}: AdvancedTrackingProps): JSX.Element {
  const store = useTrackerStore;
  const {
    onTrack, onApply, onApplyMesh, onSolveCamera, onCreateNullsForPlanes, onCreateNullAndApply,
    onRotoBrush, onSeedMatte, onSegmentSam, onContentAwareFill,
  } = actions;
  return (
  <details
    className={styles.advanced}
    // The overlay draws the manual handles and feature/search boxes only
    // while this is open (or after a run) — see trackerStore.advancedOpen.
    onToggle={(e) => store.getState().setAdvancedOpen((e.currentTarget as HTMLDetailsElement).open)}
  >
    <summary className={styles.advancedSummary}>Advanced tracking</summary>
    <div className={styles.advancedBody}>
      <InspectorRow label="Mode">
        <select
          className={styles.select}
          value={mode}
          onChange={(e) => store.getState().setMode(e.target.value as TrackerMode, src.width, src.height)}
        >
          {(Object.keys(MODE_LABELS) as TrackerMode[]).map((m) => (
            <option key={m} value={m}>{MODE_LABELS[m]}</option>
          ))}
        </select>
      </InspectorRow>
      <p className={styles.cardHint}>{MODE_HINTS[mode]}</p>
      {mode === 'mask' && maskPoints === 0 && (
        <p className={styles.cardHint} role="status">
          This layer has no mask — draw one with the mask tools first.
        </p>
      )}
      {mode !== 'mask' && mode !== 'smooth' && (
        <InspectorRow label={points.length > 1 ? 'Points' : 'Point'}>
          <span className={styles.cardHint}>
            {points.map((p) => `${p.x.toFixed(0)},${p.y.toFixed(0)}`).join(' · ') || '—'}
          </span>
        </InspectorRow>
      )}
      <InspectorRow label="Feature size">
        <select
          className={styles.select}
          value={featureHalf}
          onChange={(e) => store.getState().setSizes(Number(e.target.value), searchHalf)}
        >
          {sizeOptions(FEATURE_SIZES, featureHalf).map((v) => (
            <option key={v} value={v}>{v * 2 + 1}×{v * 2 + 1}</option>
          ))}
        </select>
      </InspectorRow>
      {mode === 'smooth' && (
        <InspectorRow label="Variant">
          <select
            className={styles.select}
            value={stabVariant}
            onChange={(e) => setStabVariant(e.target.value as typeof stabVariant)}
          >
            <option value="similarity">Similarity (global)</option>
            <option value="subspace">Subspace warp (mesh)</option>
            <option value="rolling-shutter">Rolling shutter</option>
          </select>
        </InspectorRow>
      )}
      {mode === 'corner' && (
        <InspectorRow label="Dense grid">
          <input
            type="checkbox"
            checked={dense}
            onChange={(e) => store.getState().setDense(e.target.checked)}
            title="Track a lattice of extra features inside the quad — the planar fit then survives partial occlusion (RANSAC keeps the agreeing majority)."
          />
        </InspectorRow>
      )}
      <InspectorRow label="Search size">
        <select
          className={styles.select}
          value={searchHalf}
          onChange={(e) => store.getState().setSizes(featureHalf, Number(e.target.value))}
        >
          {sizeOptions(SEARCH_SIZES, searchHalf).map((v) => (
            <option key={v} value={v}>±{v} px</option>
          ))}
        </select>
      </InspectorRow>
      <Button size="sm" onClick={onTrack} disabled={tracking || !canTrack} fullWidth>
        {tracking
          ? `Tracking… ${Math.round(progress * 100)}%`
          : mode === 'mask'
            ? 'Track mask (playhead → end)'
            : 'Track (playhead → end)'}
      </Button>

      {result && mode !== 'mask' && (result.tracks[0]?.length ?? 0) > 1 && (
        <div className={styles.group}>
          <span className={styles.groupLabel}>Apply</span>
          {(mode === 'follow' || mode === 'transform' || mode === 'corner') && (
            <InspectorRow label={mode === 'corner' ? 'Pin layer' : 'Apply to'}>
              <select
                className={styles.select}
                value={targetId}
                onChange={(e) => setTargetId(e.target.value)}
              >
                {targets.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.id === nodeId ? `${t.name || 'this layer'} (this layer)` : t.name || t.id}
                  </option>
                ))}
              </select>
            </InspectorRow>
          )}
          <Button size="sm" onClick={onApply} fullWidth>
            {applyLabel}
          </Button>
          {mode === 'corner' && (
            <Button size="sm" variant="secondary" onClick={onApplyMesh} fullWidth>
              Apply as Mesh Warp
            </Button>
          )}
          {mode === 'corner' && (
            <Button
              size="sm"
              variant="secondary"
              onClick={onSolveCamera}
              fullWidth
              title="3D Camera Tracker: SfM + bundle adjustment / planar-hybrid pose from tracked features."
            >
              Solve 3D Camera Tracker
            </Button>
          )}
          {mode === 'corner' && result.tracks.length >= 8 && (
            <Button size="sm" variant="secondary" onClick={onCreateNullsForPlanes} fullWidth>
              Create Nulls per Plane
            </Button>
          )}
          {(mode === 'follow' || mode === 'transform' || mode === 'corner') && (
            <Button size="sm" variant="secondary" onClick={() => onCreateNullAndApply()} fullWidth>
              Create Null &amp; Apply
            </Button>
          )}
        </div>
      )}

      {/* Roto / CAF — available without a prior track result (mask mode
          was unreachable before). */}
      <div className={styles.group}>
        <span className={styles.groupLabel}>Roto &amp; fill</span>
        <Button size="sm" variant="secondary" onClick={() => void onRotoBrush()} disabled={!src || tracking} fullWidth>
          Roto Brush (propagate)
        </Button>
        <Button size="sm" variant="secondary" onClick={onSeedMatte} disabled={tracking} fullWidth>
          Seed Matte (GrabCut)
        </Button>
        <Button
          size="sm"
          variant="secondary"
          onClick={onSegmentSam}
          disabled={tracking}
          fullWidth
          title="SAM-class segment from track point (or two points as a box). Writes an Add mask. Register ONNX via registerSamOnnxSession for neural."
        >
          Segment (SAM-class)
        </Button>
        <Button size="sm" variant="secondary" onClick={() => void onContentAwareFill()} disabled={tracking} fullWidth>
          Content-Aware Fill
        </Button>
      </div>
    </div>
  </details>
  );
}

export default AdvancedTracking;
