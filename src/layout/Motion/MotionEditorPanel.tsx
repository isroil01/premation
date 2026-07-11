/**
 * MotionEditorPanel — the large, direct-manipulation curve editor (spec §Motion
 * Editor). Sequencing lives in the Timeline; this panel owns *how* a value
 * moves: the interpolation curve, keyframe values/timing, and easing — shown
 * big and directly manipulable instead of a cramped graph editor.
 *
 * For the selected layer it lists animated properties; picking one draws its
 * value-over-time curve with large draggable keyframes. Selecting a keyframe
 * exposes easing presets (which reshape the curve live) and exact numeric
 * value/time inputs.
 */

import { useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import { cn } from '@utils/cn';
import { ValueField } from '@components/ValueField';
import { EmptyState } from '@components/EmptyState';
import { useSelectionStore } from '@stores/selectionStore';
import { useSceneRevision } from '@stores/sceneStore';
import defaultAnimation from '@core/animation/AnimationEngine';
import { beginAnimEdit, recordAnimEdit, runAnimEdit } from '@core/animation/animationCommands';
import { sampleTrack } from '@core/animation/interpolate';
import type { EasingKind, PropertyTrack } from '@core/animation/types';
import { ExpressionEditor } from './ExpressionEditor';
import styles from './MotionEditorPanel.module.css';

const VIEW_W = 320;
const VIEW_H = 200;
const PAD = 18;
const SAMPLES = 64;

const EASINGS: { kind: EasingKind; label: string }[] = [
  { kind: 'linear', label: 'Linear' },
  { kind: 'easeIn', label: 'Ease In' },
  { kind: 'easeOut', label: 'Ease Out' },
  { kind: 'easeInOut', label: 'In-Out' },
  { kind: 'ease', label: 'Smooth' },
  { kind: 'step', label: 'Hold' },
  { kind: 'bezier', label: 'Custom' },
];

/** Tiny curve-shape preview for each easing (24×16 box, y-down). */
const EASE_PREVIEW: Record<EasingKind, string> = {
  linear: 'M2,14 L22,2',
  easeIn: 'M2,14 C12,14 18,8 22,2',
  easeOut: 'M2,14 C6,8 12,2 22,2',
  easeInOut: 'M2,14 C10,14 14,2 22,2',
  ease: 'M2,14 C8,13 12,3 22,2',
  step: 'M2,14 L12,14 L12,2 L22,2',
  bezier: 'M2,14 C8,2 16,14 22,2',
};

const DEFAULT_BEZIER: [number, number, number, number] = [0.25, 0.1, 0.25, 1];

interface Bounds {
  t0: number; t1: number; vmin: number; vmax: number;
}

function computeBounds(track: PropertyTrack): Bounds {
  const kfs = track.keyframes;
  const t0 = kfs[0]?.t ?? 0;
  const t1 = kfs[kfs.length - 1]?.t ?? t0 + 1;
  let vmin = Infinity;
  let vmax = -Infinity;
  for (const k of kfs) { vmin = Math.min(vmin, k.value); vmax = Math.max(vmax, k.value); }
  if (!Number.isFinite(vmin)) { vmin = 0; vmax = 1; }
  if (vmin === vmax) { vmin -= 1; vmax += 1; }
  const padV = (vmax - vmin) * 0.12;
  return { t0, t1: t1 > t0 ? t1 : t0 + 1, vmin: vmin - padV, vmax: vmax + padV };
}

export function MotionEditorPanel(): JSX.Element {
  const primary = useSelectionStore((s) => s.primary);
  // The engine mutates keyframes in place, so `track` keeps the same reference.
  // Bump-driven `rev` is what tells the curve/bounds memos to recompute.
  const rev = useSceneRevision((s) => s.rev);

  const propList = primary ? defaultAnimation.animatedProps(primary) : [];
  const tracks = primary ? defaultAnimation.tracksFor(primary) : [];
  const [propState, setProp] = useState<string | null>(null);
  const prop = propState && propList.includes(propState) ? propState : propList[0] ?? null;
  const track = tracks.find((t) => t.prop === prop) ?? null;

  const [selT, setSelT] = useState<number | null>(null);
  const svgRef = useRef<SVGSVGElement | null>(null);
  const drag = useRef<{ oldT: number; tx: ReturnType<typeof beginAnimEdit> } | null>(null);

  const bounds = useMemo(() => (track ? computeBounds(track) : null), [track, rev]);

  const xOf = (t: number): number =>
    bounds ? PAD + ((t - bounds.t0) / (bounds.t1 - bounds.t0)) * (VIEW_W - 2 * PAD) : 0;
  const yOf = (v: number): number =>
    bounds ? VIEW_H - PAD - ((v - bounds.vmin) / (bounds.vmax - bounds.vmin)) * (VIEW_H - 2 * PAD) : 0;

  // Sampled curve path.
  const path = useMemo(() => {
    if (!track || !bounds || track.keyframes.length < 2) return '';
    const pts: string[] = [];
    for (let i = 0; i <= SAMPLES; i++) {
      const t = bounds.t0 + (i / SAMPLES) * (bounds.t1 - bounds.t0);
      const v = sampleTrack(track, t) ?? 0;
      pts.push(`${i === 0 ? 'M' : 'L'}${xOf(t).toFixed(2)},${yOf(v).toFixed(2)}`);
    }
    return pts.join(' ');
  }, [track, bounds, rev]);

  const selectedKf = track?.keyframes.find((k) => k.t === selT) ?? null;

  // ── Keyframe drag (value = vertical, time = horizontal) ──────────
  const onPointGrab = (t: number, e: ReactPointerEvent<SVGCircleElement>): void => {
    e.stopPropagation();
    setSelT(t);
    // Capture the track state at grab; the pointer moves mutate live and we
    // record a single reversible command on release.
    drag.current = { oldT: t, tx: beginAnimEdit() };
    const onMove = (ev: PointerEvent): void => {
      const d = drag.current;
      if (!d || !svgRef.current || !bounds || !prop || !primary) return;
      const rect = svgRef.current.getBoundingClientRect();
      const px = ((ev.clientX - rect.left) / rect.width) * VIEW_W;
      const py = ((ev.clientY - rect.top) / rect.height) * VIEW_H;
      const nt = bounds.t0 + ((px - PAD) / (VIEW_W - 2 * PAD)) * (bounds.t1 - bounds.t0);
      const nv = bounds.vmin + ((VIEW_H - PAD - py) / (VIEW_H - 2 * PAD)) * (bounds.vmax - bounds.vmin);
      const clampedT = Math.max(bounds.t0, Math.min(bounds.t1, nt));
      defaultAnimation.updateKeyframe(primary, prop, d.oldT, { t: clampedT, value: nv });
      d.oldT = clampedT;
      setSelT(clampedT);
    };
    const onUp = (): void => {
      const d = drag.current;
      drag.current = null;
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      if (d) recordAnimEdit(d.tx.commit('Edit keyframe'));
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  };

  const setEasing = (kind: EasingKind): void => {
    if (primary && prop && selectedKf) {
      runAnimEdit(`Easing: ${kind}`, () =>
        defaultAnimation.setEasing(primary, prop, selectedKf.t, kind),
      );
    }
  };

  // ── Bezier handle drag (custom easing) ──────────────────────────
  const selIdx = track ? track.keyframes.findIndex((k) => k.t === selT) : -1;
  const segEnd = selIdx >= 0 && track ? track.keyframes[selIdx + 1] : undefined;
  const showBezier = !!selectedKf && selectedKf.easing === 'bezier' && !!segEnd && !!bounds;
  const bez = selectedKf?.bezier ?? DEFAULT_BEZIER;

  const onHandleGrab = (which: 0 | 1, e: ReactPointerEvent<SVGCircleElement>): void => {
    e.stopPropagation();
    const a = selectedKf;
    const b = segEnd;
    if (!a || !b || !prop || !primary) return;
    const dt = b.t - a.t;
    const dv = b.value - a.value;
    const tx = beginAnimEdit();
    const onMove = (ev: PointerEvent): void => {
      if (!svgRef.current) return;
      const rect = svgRef.current.getBoundingClientRect();
      const px = ((ev.clientX - rect.left) / rect.width) * VIEW_W;
      const py = ((ev.clientY - rect.top) / rect.height) * VIEW_H;
      const t = bounds!.t0 + ((px - PAD) / (VIEW_W - 2 * PAD)) * (bounds!.t1 - bounds!.t0);
      const v = bounds!.vmin + ((VIEW_H - PAD - py) / (VIEW_H - 2 * PAD)) * (bounds!.vmax - bounds!.vmin);
      const nx = dt === 0 ? 0 : Math.max(0, Math.min(1, (t - a.t) / dt));
      const ny = dv === 0 ? 0 : Math.max(-1, Math.min(2, (v - a.value) / dv));
      const next: [number, number, number, number] = [...(a.bezier ?? DEFAULT_BEZIER)] as [number, number, number, number];
      next[which * 2] = nx;
      next[which * 2 + 1] = ny;
      defaultAnimation.updateKeyframe(primary, prop, a.t, { bezier: next });
    };
    const onUp = (): void => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      recordAnimEdit(tx.commit('Adjust easing curve'));
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  };

  // Handle positions in curve space (only when a bezier segment is selected).
  const handlePts = showBezier && selectedKf && segEnd
    ? {
        a: { x: xOf(selectedKf.t), y: yOf(selectedKf.value) },
        b: { x: xOf(segEnd.t), y: yOf(segEnd.value) },
        h1: { x: xOf(selectedKf.t + (segEnd.t - selectedKf.t) * bez[0]), y: yOf(selectedKf.value + (segEnd.value - selectedKf.value) * bez[1]) },
        h2: { x: xOf(selectedKf.t + (segEnd.t - selectedKf.t) * bez[2]), y: yOf(selectedKf.value + (segEnd.value - selectedKf.value) * bez[3]) },
      }
    : null;

  if (!primary) {
    return <EmptyState icon="keyframe" message="Select a layer to edit its motion." />;
  }
  if (!prop) {
    return <EmptyState icon="keyframe" message="No animation on this layer yet. Add a keyframe or an AI motion." />;
  }

  return (
    <div className={styles.root}>
      {/* Property picker */}
      <div className={styles.props}>
        {propList.map((p) => (
          <button
            key={p}
            type="button"
            className={cn(styles.propChip, p === prop && styles.propChipOn)}
            onClick={() => { setProp(p); setSelT(null); }}
          >
            {p}
          </button>
        ))}
      </div>

      {track && bounds ? (
      <>
      {/* Curve */}
      <svg
        ref={svgRef}
        className={styles.graph}
        viewBox={`0 0 ${VIEW_W} ${VIEW_H}`}
        preserveAspectRatio="none"
        onPointerDown={() => setSelT(null)}
      >
        {/* grid — faint value/time divisions (graph paper) */}
        <g className={styles.grid}>
          {[0.25, 0.5, 0.75].map((f) => {
            const y = PAD + f * (VIEW_H - 2 * PAD);
            return <line key={`h${f}`} x1={PAD} y1={y} x2={VIEW_W - PAD} y2={y} />;
          })}
          {[0.25, 0.5, 0.75].map((f) => {
            const x = PAD + f * (VIEW_W - 2 * PAD);
            return <line key={`v${f}`} x1={x} y1={PAD} x2={x} y2={VIEW_H - PAD} />;
          })}
        </g>
        {/* frame */}
        <rect x={PAD} y={PAD} width={VIEW_W - 2 * PAD} height={VIEW_H - 2 * PAD} className={styles.frame} />
        {/* curve */}
        {path ? <path d={path} className={styles.curve} /> : null}
        {/* Bezier handles for the selected segment (custom easing) */}
        {handlePts ? (
          <g className={styles.bezier}>
            <line className={styles.bezierLine} x1={handlePts.a.x} y1={handlePts.a.y} x2={handlePts.h1.x} y2={handlePts.h1.y} />
            <line className={styles.bezierLine} x1={handlePts.b.x} y1={handlePts.b.y} x2={handlePts.h2.x} y2={handlePts.h2.y} />
            <circle className={styles.bezierHandle} cx={handlePts.h1.x} cy={handlePts.h1.y} r={5} onPointerDown={(e) => onHandleGrab(0, e)} />
            <circle className={styles.bezierHandle} cx={handlePts.h2.x} cy={handlePts.h2.y} r={5} onPointerDown={(e) => onHandleGrab(1, e)} />
          </g>
        ) : null}
        {/* keyframes */}
        {track.keyframes.map((k) => (
          <circle
            key={k.t}
            cx={xOf(k.t)}
            cy={yOf(k.value)}
            r={k.t === selT ? 6 : 5}
            className={cn(styles.point, k.t === selT && styles.pointSel)}
            onPointerDown={(e) => onPointGrab(k.t, e)}
          />
        ))}
      </svg>

      {/* Selected keyframe controls */}
      {selectedKf ? (
        <div className={styles.controls}>
          <div className={styles.numeric}>
            <label className={styles.field}>
              <span className={styles.fieldLabel}>Value</span>
              <ValueField
                value={selectedKf.value}
                precision={2}
                onChange={(v) =>
                  runAnimEdit(
                    'Set keyframe value',
                    () => defaultAnimation.updateKeyframe(primary, prop, selectedKf.t, { value: v }),
                    `kf-value:${primary}:${prop}:${selectedKf.t}`,
                  )
                }
                aria-label="keyframe value"
              />
            </label>
            <label className={styles.field}>
              <span className={styles.fieldLabel}>Time</span>
              <ValueField
                value={selectedKf.t}
                precision={2}
                unit="s"
                min={0}
                onChange={(t) => {
                  // Time drifts as the field scrubs, so key the merge on the
                  // track (not t) to keep the scrub one undo step.
                  runAnimEdit(
                    'Set keyframe time',
                    () => defaultAnimation.updateKeyframe(primary, prop, selectedKf.t, { t }),
                    `kf-time:${primary}:${prop}`,
                  );
                  setSelT(t);
                }}
                aria-label="keyframe time"
              />
            </label>
          </div>
          <div className={styles.easings} role="radiogroup" aria-label="Easing">
            {EASINGS.map((e) => (
              <button
                key={e.kind}
                type="button"
                role="radio"
                aria-checked={(selectedKf.easing ?? 'linear') === e.kind}
                className={cn(styles.easeChip, (selectedKf.easing ?? 'linear') === e.kind && styles.easeChipOn)}
                onClick={() => setEasing(e.kind)}
              >
                <svg className={styles.easePreview} viewBox="0 0 24 16" aria-hidden>
                  <path d={EASE_PREVIEW[e.kind]} />
                </svg>
                <span>{e.label}</span>
              </button>
            ))}
          </div>
        </div>
      ) : (
        <div className={styles.hint}>Click a keyframe to shape its easing.</div>
      )}
      </>
      ) : (
        <div className={styles.hint}>No keyframes on “{prop}” — drive it with an expression below.</div>
      )}

      {/* Expression editor — drives this property with a formula each frame. */}
      <ExpressionEditor nodeId={primary} prop={prop} />
    </div>
  );
}

export default MotionEditorPanel;
