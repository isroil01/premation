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
import { ValueField } from '@components/ValueField/ValueField';
import { useMirrorTreeGroups } from '@hooks/useMirror';
import { useActiveWorkspace } from '@stores/projectStore';
import { useTrackerStore, type TrackerMode, type TrackerResult, type WarpSettings } from '@stores/trackerStore';
import { mirrorEffectHeaders, mirrorMaskHeaders } from '@core/mirror/effects';
import { useCameraTrackStore } from '@stores/cameraTrackStore';
import { effectPointTargets } from '@core/tracking/effectPointTargets';
import { TrackConfidenceGraph } from './TrackConfidenceGraph';
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

const EFFECTS_ROOT: readonly string[] = ['effects'];
const MASKS_ROOT: readonly string[] = ['masks'];

export function AdvancedTracking({
  nodeId, src, mode, points, featureHalf, searchHalf, dense, stabVariant, setStabVariant,
  targetId, setTargetId, targets, result, tracking, progress, canTrack, applyLabel, maskPoints, actions,
}: AdvancedTrackingProps): JSX.Element {
  const store = useTrackerStore;
  const time = useActiveWorkspace()?.time ?? 0;
  const fullResolution = useTrackerStore((s) => s.fullResolution);
  const stabRotation = useTrackerStore((s) => s.stabRotation);
  const stabScale = useTrackerStore((s) => s.stabScale);
  const warp = useTrackerStore((s) => s.warp);
  const attach = useTrackerStore((s) => s.attach);
  const applyPath = useTrackerStore((s) => s.applyPath);
  const corrections = useTrackerStore((s) => s.corrections);
  const planarSurface = useTrackerStore((s) => s.planarSurface);
  const excludeMasks = useTrackerStore((s) => s.excludeMasks);
  const faceMode = useTrackerStore((s) => s.faceMode);
  const faceMask = useTrackerStore((s) => s.faceMask);
  const solve = useCameraTrackStore((s) => (s.layer === nodeId ? s.solve : null));
  const selectedPoints = useCameraTrackStore((s) => s.selected);
  const focalLength = useCameraTrackStore((s) => s.focalLength);
  // The layer's masks (planar exclusions, the face mask).
  const ownTree = useMirrorTreeGroups(mode === 'planar' || mode === 'face' ? nodeId : null, MASKS_ROOT);
  const masks = mode === 'planar' || mode === 'face' ? mirrorMaskHeaders(ownTree) : [];
  // The target's effect points (AE: Apply To ▸ any effect point).
  const targetTree = useMirrorTreeGroups(mode === 'follow' ? targetId : null, EFFECTS_ROOT);
  const effectPoints = mode === 'follow' ? effectPointTargets(mirrorEffectHeaders(targetTree)) : [];
  const oneFrameOk = mode !== 'mask' && mode !== 'smooth' && mode !== 'camera';
  const directional = mode !== 'camera';
  const runTrack = (direction: 'forward' | 'backward' | 'both', oneFrame = false) => () => void onTrack(direction, oneFrame);
  const {
    onTrack, onApply, onApplyMesh, onSolveCamera, onCreateNullsForPlanes, onCreateNullAndApply,
    onRotoBrush, onSeedMatte, onSegmentSam, onContentAwareFill, onCameraPoints,
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
      {mode === 'planar' && (
        <>
          <InspectorRow label="Surface Adjust">
            <input
              type="checkbox"
              aria-label="Surface Adjust"
              checked={planarSurface}
              onChange={(e) => store.getState().setPlanarSurface(e.target.checked, src.width, src.height)}
              title="Four more corners: where the insert goes on the tracked plane, independent of the region tracked."
            />
          </InspectorRow>
          {masks.length > 0 && (
            <InspectorRow label="Exclude">
              <div className={styles.group} role="group" aria-label="Exclude masks">
                {masks.map((m) => (
                  <label key={m.id} className={styles.cardHint}>
                    <input
                      type="checkbox"
                      checked={excludeMasks.includes(m.id)}
                      onChange={(e) => store.getState().setExcludeMasks(e.target.checked ? [...excludeMasks, m.id] : excludeMasks.filter((x) => x !== m.id))}
                    />{' '}
                    {m.name || m.id}
                  </label>
                ))}
              </div>
            </InspectorRow>
          )}
        </>
      )}
      {mode === 'face' && (
        <>
          <InspectorRow label="Method">
            <select
              aria-label="Face tracking method"
              className={styles.select}
              value={faceMode}
              onChange={(e) => store.getState().setFace({ faceMode: e.target.value as 'outline' | 'detailed' })}
            >
              <option value="outline">Outline Only</option>
              <option value="detailed">Detailed Features</option>
            </select>
          </InspectorRow>
          {masks.length > 1 && (
            <InspectorRow label="Face mask">
              <select aria-label="Face mask" className={styles.select} value={faceMask} onChange={(e) => store.getState().setFace({ faceMask: e.target.value })}>
                <option value="">{masks[0]?.name || 'First mask'}</option>
                {masks.slice(1).map((m) => <option key={m.id} value={m.id}>{m.name || m.id}</option>)}
              </select>
            </InspectorRow>
          )}
          {masks.length === 0 && <p className={styles.cardHint} role="status">Draw a mask around the face first.</p>}
        </>
      )}
      {mode === 'camera' && (
        <InspectorRow label="Lens">
          <ValueField
            aria-label="Focal length (0 = solve)"
            value={focalLength}
            min={0}
            step={10}
            unit="px"
            onChange={(v) => useCameraTrackStore.getState().setFocalLength(v)}
          />
        </InspectorRow>
      )}
      {mode === 'stabilize' && (
        <InspectorRow label="Stabilize">
          <label className={styles.cardHint}>
            <input type="checkbox" checked disabled /> Position
          </label>
          <label className={styles.cardHint}>
            <input
              type="checkbox"
              checked={stabRotation}
              onChange={(e) => store.getState().setStabilize(e.target.checked, stabScale, src.width, src.height)}
            />{' '}
            Rotation
          </label>
          <label className={styles.cardHint}>
            <input
              type="checkbox"
              checked={stabScale}
              onChange={(e) => store.getState().setStabilize(stabRotation, e.target.checked, src.width, src.height)}
            />{' '}
            Scale
          </label>
        </InspectorRow>
      )}
      {mode === 'smooth' && (
        <>
          <InspectorRow label="Smoothness">
            <ValueField aria-label="Smoothness" value={warp.smoothness} min={0} max={100} step={1} unit="%" onChange={(v) => store.getState().setWarp({ smoothness: v })} />
          </InspectorRow>
          <InspectorRow label="Method">
            <select
              aria-label="Stabilize method"
              className={styles.select}
              value={warp.method}
              onChange={(e) => store.getState().setWarp({ method: e.target.value as WarpSettings['method'] })}
            >
              <option value="position">Position</option>
              <option value="positionRotation">Position, Rotation</option>
              <option value="positionRotationScale">Position, Scale, Rotation</option>
            </select>
          </InspectorRow>
          <InspectorRow label="Framing">
            <select
              aria-label="Framing"
              className={styles.select}
              value={stabVariant === 'similarity' ? warp.framing : 'stabilizeOnly'}
              disabled={stabVariant !== 'similarity'}
              title={stabVariant !== 'similarity' ? 'The mesh variants keep the frame' : undefined}
              onChange={(e) => store.getState().setWarp({ framing: e.target.value as WarpSettings['framing'] })}
            >
              <option value="stabilizeOnly">Stabilize Only</option>
              <option value="stabilizeCrop">Stabilize, Crop</option>
              <option value="cropAutoScale">Stabilize, Crop, Auto-scale</option>
            </select>
          </InspectorRow>
          {stabVariant === 'similarity' && warp.framing !== 'stabilizeOnly' && (
            <InspectorRow label="Maximum scale">
              <ValueField aria-label="Maximum scale" value={warp.maxScale} min={100} max={400} step={1} unit="%" onChange={(v) => store.getState().setWarp({ maxScale: Math.max(100, v) })} />
            </InspectorRow>
          )}
        </>
      )}
      {(mode === 'follow' || mode === 'transform' || mode === 'stabilize') && points.length > 0 && (
        <InspectorRow label="Attach offset">
          <ValueField aria-label="Attach offset X" value={attach[0]?.x ?? 0} step={1} unit="px" onChange={(v) => store.getState().setAttach(0, v, attach[0]?.y ?? 0)} />
          <ValueField aria-label="Attach offset Y" value={attach[0]?.y ?? 0} step={1} unit="px" onChange={(v) => store.getState().setAttach(0, attach[0]?.x ?? 0, v)} />
        </InspectorRow>
      )}
      <InspectorRow label="Full resolution">
        <input
          type="checkbox"
          aria-label="Track at full resolution"
          checked={fullResolution}
          onChange={(e) => store.getState().setFullResolution(e.target.checked)}
          title="Analyse every pixel of the footage instead of a 960 px copy: slower, steadier on fine detail."
        />
      </InspectorRow>
      {tracking ? (
        <Button size="sm" disabled fullWidth>{`Tracking… ${Math.round(progress * 100)}%`}</Button>
      ) : (
        !directional ? (
          <Button size="sm" onClick={runTrack('both')} disabled={!canTrack} fullWidth>
            {solve ? 'Analyze again' : 'Analyze'}
          </Button>
        ) : (
        <div className={styles.trackRow} role="group" aria-label="Track">
          {oneFrameOk && (
            <Button size="sm" variant="secondary" onClick={runTrack('backward', true)} disabled={!canTrack} aria-label="Track 1 frame backward" title="Track 1 frame backward">
              ◀︎1
            </Button>
          )}
          <Button size="sm" variant="secondary" onClick={runTrack('backward')} disabled={!canTrack} aria-label="Track backward" title="Track backward from the playhead to the layer's start">
            ◀︎◀︎
          </Button>
          <Button size="sm" variant="secondary" onClick={runTrack('both')} disabled={!canTrack} aria-label="Track both ways" title="Track both ways from the playhead over the layer">
            ◀︎▶︎
          </Button>
          <Button size="sm" onClick={runTrack('forward')} disabled={!canTrack} aria-label="Track forward" title="Track forward from the playhead to the end">
            ▶︎▶︎
          </Button>
          {oneFrameOk && (
            <Button size="sm" variant="secondary" onClick={runTrack('forward', true)} disabled={!canTrack} aria-label="Track 1 frame forward" title="Track 1 frame forward">
              1▶︎
            </Button>
          )}
        </div>
        )
      )}
      {mode === 'camera' && solve && (
        <div className={styles.group}>
          <span className={styles.groupLabel}>
            {`Track points: ${solve.points.length} · selected ${selectedPoints.length}`}
          </span>
          <p className={styles.cardHint}>Click track points in the viewer (Shift adds, drag selects an area).</p>
          <Button size="sm" variant="secondary" onClick={() => void onCameraPoints('ground')} disabled={tracking || selectedPoints.length < 3} fullWidth>
            Set Ground Plane and Origin
          </Button>
          <div className={styles.trackRow} role="group" aria-label="Create from track points">
            <Button size="sm" variant="secondary" onClick={() => void onCameraPoints('text')} disabled={tracking || selectedPoints.length === 0}>Text</Button>
            <Button size="sm" variant="secondary" onClick={() => void onCameraPoints('solid')} disabled={tracking || selectedPoints.length === 0}>Solid</Button>
            <Button size="sm" variant="secondary" onClick={() => void onCameraPoints('null')} disabled={tracking || selectedPoints.length === 0}>Null</Button>
            <Button size="sm" variant="secondary" onClick={() => void onCameraPoints('shadowCatcher')} disabled={tracking || selectedPoints.length < 3} title="A floor that shows only the shadows it receives">
              Shadow
            </Button>
          </div>
        </div>
      )}
      {result && mode !== 'mask' && (result.tracks[0]?.length ?? 0) > 1 && (
        <TrackConfidenceGraph result={result} time={time} corrections={corrections} />
      )}

      {result && mode !== 'mask' && (result.tracks[0]?.length ?? 0) > 1 && (
        <div className={styles.group}>
          <span className={styles.groupLabel}>Apply</span>
          {(mode === 'follow' || mode === 'transform' || mode === 'corner' || mode === 'planar') && (
            <InspectorRow label={mode === 'corner' || mode === 'planar' ? 'Pin layer' : 'Apply to'}>
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
          {mode === 'follow' && (
            <InspectorRow label="Property">
              <select
                aria-label="Apply to property"
                className={styles.select}
                value={effectPoints.some((p) => p.path === applyPath) ? applyPath : ''}
                onChange={(e) => store.getState().setApplyPath(e.target.value)}
              >
                <option value="">Position</option>
                {effectPoints.map((p) => <option key={p.path} value={p.path}>{p.label}</option>)}
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
          Seed Matte
        </Button>
        <Button
          size="sm"
          variant="secondary"
          onClick={onSegmentSam}
          disabled={tracking}
          fullWidth
          title="Segments the object under the track point (or the box between two points) with the SAM model in the engine, and writes an Add mask."
        >
          Segment (SAM-class)
        </Button>
        <Button size="sm" variant="secondary" onClick={() => void onContentAwareFill()} fullWidth title="Opens the Content-Aware Fill panel">
          Content-Aware Fill…
        </Button>
      </div>
    </div>
  </details>
  );
}

export default AdvancedTracking;
