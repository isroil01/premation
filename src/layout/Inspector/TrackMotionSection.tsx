/**
 * Track Motion — AE's tracker family, on the exact decoder.
 *
 * The section is arranged around the one thing most people want: point at an
 * object, get keyframes. That is the card at the top, and it is the whole
 * interface until you need more. Everything the panel used to open with —
 * six modes, two window-size dropdowns, nine buttons — still exists, one
 * disclosure down, because the people who need it need all of it.
 *
 * The split is a claim about the work, not a decoration: choosing a feature,
 * sizing the windows and choosing a direction are decisions the FOOTAGE can
 * answer (core/tracking/autoTrack.ts measures them), while choosing between a
 * planar pin and a mesh warp is a decision only the shot's author can make.
 * The first kind belongs in a button; the second belongs in controls.
 *
 * Points are placed by dragging the handles TrackPointOverlay draws on the
 * canvas — this panel reports them, because a coordinate you can see on the
 * footage beats a number field you have to guess into.
 *
 * Modes (advanced):
 *   Follow     — one point; apply as position keyframes on any layer.
 *   Transform  — two points; adds rotation and scale.
 *   Stabilize  — one point; apply INVERSE motion to this layer.
 *   Smooth     — dense optical flow; Warp Stabilizer-class.
 *   Corner pin — four points; keyframe a Corner Pin effect (screen replacement).
 *   Track mask — this layer's mask vertices are the points.
 *
 * Tracking runs on the ORIGINAL media through ExactVideoSource, never the
 * proxy and never a seeked <video> — the samples are measured on the frames
 * the renderer will actually show (see trackVideoLayer.ts).
 */

import { useEffect, useMemo, useState } from 'react';
import { flicksToSeconds, type LayerInfo } from '@motion/engine-api';
import { Button } from '@components/Button';
import { documentMirror } from '@stores/documentMirror';
import { useTrackerStore } from '@stores/trackerStore';
import { useActiveWorkspace } from '@stores/projectStore';
import {
  compFps,
  useActiveMirrorComp,
  useMirrorComp,
  useMirrorItem,
  useMirrorKeys,
  useMirrorLayer,
  useMirrorLayers,
  useMirrorTree,
} from '@hooks/useMirror';
import { canParentTo, footageDisplaySize, maskVertexCount, siblingSourceIds } from '@core/mirror/tracking';
import { webCodecsAvailable } from '@core/video/exactVideoSource';
import { qualityOf } from './trackMotion/trackMotionCopy';
import { trackMotionActions, type StabVariant, type TrackComp, type TrackMotionContext } from './trackMotion/trackMotionActions';
import { AdvancedTracking } from './trackMotion/AdvancedTracking';
import styles from './TrackMotionSection.module.css';

/*
 * Split (2026-09-04): this file is the SECTION — its hooks, the one-click
 * card, and the disclosure below it. The window presets and mode copy are
 * `trackMotion/trackMotionCopy.ts`, every button's work is
 * `trackMotion/trackMotionActions.ts`, and the advanced controls are
 * `trackMotion/AdvancedTracking.tsx`. Nothing moved changed.
 */

export function TrackMotionSection({ nodeId }: { nodeId: string }): JSX.Element | null {
  const mode = useTrackerStore((s) => s.mode);
  const points = useTrackerStore((s) => s.points);
  const featureHalf = useTrackerStore((s) => s.featureHalf);
  const searchHalf = useTrackerStore((s) => s.searchHalf);
  const dense = useTrackerStore((s) => s.dense);
  const tracking = useTrackerStore((s) => s.tracking);
  const progress = useTrackerStore((s) => s.progress);
  const result = useTrackerStore((s) => s.result);
  const note = useTrackerStore((s) => s.note);
  const autoPhase = useTrackerStore((s) => s.autoPhase);
  const pickIntent = useTrackerStore((s) => s.pickIntent);
  const autoPlan = useTrackerStore((s) => s.autoPlan);
  const store = useTrackerStore;
  const time = useActiveWorkspace()?.time ?? 0;
  const m = documentMirror();
  const layer = useMirrorLayer(nodeId);
  // The active composition's settings (the mirror, B4) — the layer's own
  // composition when the tab shows something the document does not list as one.
  const activeComp = useActiveMirrorComp();
  const ownComp = useMirrorComp(layer?.comp);
  const settings = (activeComp ?? ownComp)?.settings;
  const fps = compFps(activeComp ?? ownComp);
  const durationSeconds = settings ? flicksToSeconds(settings.duration) : 0;
  const compWidth = settings?.width ?? 0;
  const compHeight = settings?.height ?? 0;
  const comp = useMemo<TrackComp>(() => ({ width: compWidth, height: compHeight }), [compWidth, compHeight]);
  const [targetId, setTargetId] = useState(nodeId);
  const [stabVariant, setStabVariant] = useState<StabVariant>('similarity');
  // The null the LAST "Create null & apply" made — while it exists, the card
  // offers to parent a layer to it instead of a note asking the user to.
  // A new run replaces `result` (a fresh object), which clears the offer;
  // apply/attach re-use the same result reference, which keeps it.
  const [createdNullId, setCreatedNullId] = useState<string | null>(null);
  const [attachId, setAttachId] = useState<string | null>(null);
  useEffect(() => {
    setCreatedNullId(null);
    setAttachId(null);
  }, [result, nodeId]);

  // The footage item (its size and pixel aspect) and the layer's property
  // tree (its masks) — each hook re-renders on its own record's change.
  useMirrorItem(layer?.source);
  const tree = useMirrorTree(nodeId);
  const src = footageDisplaySize(m, nodeId);
  const maskPoints = tree ? maskVertexCount(m, nodeId) : 0;

  // Opening the section for a layer arms the overlay for it and seeds the
  // mode's points so there are handles to grab at all. The section is mounted
  // only while OPEN (`mountOnOpen` on its accordion item), so closing it
  // disarms — the overlay leaves the canvas but keeps points and any result.
  useEffect(() => {
    store.getState().activate(nodeId);
    if (src) store.getState().seedPoints(src.width, src.height);
  }, [nodeId, src?.width, src?.height, mode]);
  useEffect(() => () => store.getState().disarm(), []);

  // Escape leaves the pick without tracking.
  //
  // stopIMMEDIATEPropagation, and in the capture phase: the app's own Escape
  // handler is also on `window`, and plain stopPropagation does not stop
  // listeners on the SAME node — so cancelling a pick ALSO cleared the
  // selection, which unmounted this very section. While the pick is armed,
  // Escape means one thing.
  useEffect(() => {
    if (autoPhase !== 'picking') return;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return;
      e.stopImmediatePropagation();
      e.preventDefault();
      store.getState().setAutoPhase('idle');
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [autoPhase, store]);

  // The layers under the same parent (the composition's top layers when it
  // has none), this one among them, top of the stack first. The parent's
  // header carries its children; a comp's top layers are its stack order.
  useMirrorKeys(layer?.parent ? [`layer:${layer.parent}`] : layer ? [`order:${layer.comp}`, `comp:${layer.comp}`] : []);
  const siblingInfos = useMirrorLayers(siblingSourceIds(m, nodeId));
  const targets = useMemo<readonly LayerInfo[]>(() => {
    if (!layer) return [];
    const sameParent = siblingInfos.filter((l): l is LayerInfo => !!l && l.parent === layer.parent);
    return sameParent.length > 0 ? sameParent : [layer];
  }, [siblingInfos, layer]);

  if (!layer || !src) return null;

  if (!webCodecsAvailable()) {
    return <p className={styles.cardHint}>Tracking needs WebCodecs, which this runtime does not have.</p>;
  }

  const endCompTime = Math.max(time, durationSeconds - 1 / fps);

  const ctx: TrackMotionContext = {
    nodeId, targetId, setTargetId, mode, points, featureHalf, searchHalf, tracking, result, autoPhase,
    time, endCompTime, fps, durationSeconds, comp, src, stabVariant, targets,
    onNullCreated: setCreatedNullId,
  };
  const actions = trackMotionActions(ctx);
  const { onArmPick, onTrackAgain, onCancel, onCreateNullAndApply, onApply, onAttachToNull } = actions;

  // Layers a person can attach to the created null. The tracked video is
  // deliberately absent: its content is where the motion CAME from, so
  // parenting it to the null plays that motion twice.
  const attachCandidates = createdNullId
    ? targets.filter((t) => t.id !== createdNullId && t.id !== nodeId && canParentTo(m, t.id, createdNullId))
    : [];
  const attachValue = attachId ?? attachCandidates[0]?.id ?? '';

  const canTrack = mode === 'mask' ? maskPoints > 0 : mode === 'smooth' ? true : points.length > 0;
  const applyLabel =
    mode === 'follow'
      ? 'Apply as position keyframes'
      : mode === 'transform'
        ? 'Apply position, rotation & scale'
        : mode === 'stabilize'
          ? 'Stabilize this layer'
          : 'Pin target to corners';
  const analyzing = autoPhase === 'analyzing';
  const picking = autoPhase === 'picking';
  const quality = autoPlan ? qualityOf(autoPlan) : null;
  const autoResult = autoPlan && result && (result.tracks[0]?.length ?? 0) > 1;

  return (
    <div className={styles.root}>
      <section className={styles.card} data-armed={picking}>
        <div className={styles.cardTitle}>
          <span>Track an object</span>
          {quality && (
            <span className={styles.quality} data-level={quality.level}>
              {quality.label}
            </span>
          )}
        </div>

        {analyzing ? (
          <>
            <div className={styles.progressRow}>
              <div
                className={styles.progressTrack}
                role="progressbar"
                aria-label="Tracking progress"
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={Math.round(progress * 100)}
              >
                {/* scaleX, not width — see the module CSS: this repaints on
                    every tracked frame and must not relayout the panel. */}
                <div className={styles.progressFill} style={{ transform: `scaleX(${progress})` }} />
              </div>
              <span className={styles.progressValue}>{Math.round(progress * 100)}%</span>
            </div>
            <Button size="sm" variant="secondary" onClick={onCancel} fullWidth>
              Cancel
            </Button>
          </>
        ) : (
          <>
            <p className={styles.cardHint}>
              {picking
                ? pickIntent === 'object'
                  ? 'Draw a box around the object (or click it) and it becomes a mask path — cut from this exact frame. Esc to cancel.'
                  : 'Click the thing to follow — or drag a box around it. It locks onto the best trackable detail there, then tracks the whole clip both ways from the playhead. Esc to cancel. Spinning objects (wheels, fans): pick the hub — details on the rim rotate away mid-track.'
                : 'Point at anything in the shot, or draw a box around it. The feature, both window sizes and the direction are measured from the footage.'}
            </p>
            <Button size="sm" variant={picking && pickIntent === 'track' ? 'secondary' : 'primary'} onClick={onArmPick} fullWidth>
              {picking && pickIntent === 'track' ? 'Cancel pick (Esc)' : 'Pick target in viewport'}
            </Button>
            <Button
              size="sm"
              variant="secondary"
              onClick={() => store.getState().setAutoPhase(
                picking && pickIntent === 'object' ? 'idle' : 'picking',
                'object',
              )}
              fullWidth
              title="Draw a box around (or click) an object; the bundled segmentation model traces it into a mask path. Track mask makes the path follow; Write-on and Vegas can draw along it via their Path option."
            >
              {picking && pickIntent === 'object' ? 'Cancel object mask (Esc)' : 'Draw around object → mask'}
            </Button>
            {autoPlan && (
              <Button size="sm" variant="secondary" onClick={onTrackAgain} fullWidth>
                Track again from this feature
              </Button>
            )}
          </>
        )}

        {note && !analyzing && (
          <p
            className={styles.note}
            role="status"
            data-tone={
              result || note.startsWith('Applied') || note.startsWith('Created')
                ? quality?.level === 'poor'
                  ? 'warn'
                  : undefined
                : 'error'
            }
          >
            {note}
          </p>
        )}

        {autoPlan && !analyzing && (
          <p className={styles.stats}>
            <span className={styles.stat}>
              feature <b>{Math.round(autoPlan.featureHalf) * 2 + 1}px</b>
            </span>
            <span className={styles.stat}>
              search <b>±{Math.round(autoPlan.searchHalf)}px</b>
            </span>
            {autoPlan.motionPerFrame !== null && (
              <span className={styles.stat}>
                motion <b>{autoPlan.motionPerFrame.toFixed(1)}px/f</b>
              </span>
            )}
          </p>
        )}

        {autoResult && (
          <div className={styles.actions}>
            <Button size="sm" variant="primary" onClick={() => onCreateNullAndApply()} fullWidth>
              Create null &amp; apply
            </Button>
            {result.tracks.length > 1 && (
              <Button
                size="sm"
                variant="secondary"
                onClick={() => onCreateNullAndApply(true)}
                fullWidth
                title="Uses the second feature tracked alongside the first: the angle and length of the line between them carry rotation and scale."
              >
                &hellip; with rotation &amp; scale
              </Button>
            )}
            <div className={styles.actionRow}>
              <select
                className={styles.select}
                value={targetId}
                aria-label="Layer to receive the track"
                onChange={(e) => setTargetId(e.target.value)}
              >
                {targets.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.id === nodeId ? `${t.name || 'this layer'} (this layer)` : t.name || t.id}
                  </option>
                ))}
              </select>
              <Button size="sm" variant="secondary" onClick={onApply}>
                Apply
              </Button>
            </div>
            {createdNullId && attachCandidates.length > 0 && (
              // The step the result note used to ask for. Same-parent layers
              // only (the dropdown above already established that scope), the
              // tracked video excluded — see attachCandidates.
              <div className={styles.actionRow}>
                <select
                  className={styles.select}
                  value={attachValue}
                  aria-label="Layer to parent to the tracked null"
                  onChange={(e) => setAttachId(e.target.value)}
                >
                  {attachCandidates.map((t) => (
                    <option key={t.id} value={t.id}>
                      {t.name || t.id}
                    </option>
                  ))}
                </select>
                <Button
                  size="sm"
                  variant="secondary"
                  onClick={() => attachValue && onAttachToNull(attachValue, createdNullId)}
                  title="Parents the chosen layer to the tracked null without moving it — it starts following the motion from here on."
                >
                  Parent to null
                </Button>
              </div>
            )}
            {/* The overlay deliberately draws only ~1s of path around the
                playhead (TrackPointOverlay: a full walk read as corruption).
                Deliberate still needs SAYING, or the short squiggle reads as
                a track that quit after a second. */}
            <p className={styles.cardHint}>
              The viewport shows the path near the playhead — scrub to review it. Applying writes every frame.
            </p>
          </div>
        )}
      </section>

      <AdvancedTracking
        nodeId={nodeId}
        src={src}
        mode={mode}
        points={points}
        featureHalf={featureHalf}
        searchHalf={searchHalf}
        dense={dense}
        stabVariant={stabVariant}
        setStabVariant={setStabVariant}
        targetId={targetId}
        setTargetId={setTargetId}
        targets={targets}
        result={result}
        tracking={tracking}
        progress={progress}
        canTrack={canTrack}
        applyLabel={applyLabel}
        maskPoints={maskPoints}
        actions={actions}
      />
    </div>
  );
}

export default TrackMotionSection;
