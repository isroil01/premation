/**
 * MotionEditorPanel — the large, direct-manipulation curve editor (the spec
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
import { defaultAnimation, sampleTrack, sampleSpeed, makeKeyframeId, EASY_EASE_BEZIER, type EasingKind, type PropertyTrack } from '@motion/animation';
import { useEaseClipboardStore } from '@stores/easeClipboardStore';
import { Icon } from '@components/Icon';
import { beginAnimEdit, recordAnimEdit, runAnimEdit } from '@core/animation/animationCommands';
import { ExpressionEditor } from './ExpressionEditor';
import { MotionControls } from '@layout/Inspector/MotionControls';
import styles from './MotionEditorPanel.module.css';

/**
 * Motion-path options (auto-orient, smooth/straighten, separate dimensions).
 * Moved here from the Properties inspector so the Motion tab is the single home
 * for a layer's motion — Properties now covers style only.
 */
function MotionPathBlock({ nodeId }: { nodeId: string }): JSX.Element {
  return (
    <>
      <div className={styles.sectionTitle} style={{ marginTop: 8, fontSize: 11, fontWeight: 600, textTransform: 'uppercase', color: 'var(--color-text-tertiary)' }}>
        Motion Path &amp; Orientation
      </div>
      <MotionControls nodeId={nodeId} />
    </>
  );
}

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
  { kind: 'autoBezier', label: 'Auto Bezier' },
  { kind: 'continuousBezier', label: 'Continuous Bezier' },
  { kind: 'step', label: 'Step' },
  { kind: 'hold', label: 'Hold' },
  { kind: 'bezier', label: 'Custom' },
];

/** Tiny curve-shape preview for each easing (24×16 box, y-down). */
const EASE_PREVIEW: Record<EasingKind, string> = {
  linear: 'M2,14 L22,2',
  easeIn: 'M2,14 C12,14 18,8 22,2',
  easeOut: 'M2,14 C6,8 12,2 22,2',
  easeInOut: 'M2,14 C10,14 14,2 22,2',
  ease: 'M2,14 C8,13 12,3 22,2',
  autoBezier: 'M2,14 C8,14 16,2 22,2',
  continuousBezier: 'M2,14 C8,14 16,2 22,2',
  step: 'M2,14 L12,14 L12,2 L22,2',
  hold: 'M2,14 L12,14 L12,2 L22,2',
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

/** Bounds for the SPEED graph — sample the derivative across the range. Always
 *  includes 0 so a flat/positive/negative curve reads correctly against it. */
function computeSpeedBounds(track: PropertyTrack): Bounds {
  const kfs = track.keyframes;
  const t0 = kfs[0]?.t ?? 0;
  const t1raw = kfs[kfs.length - 1]?.t ?? t0 + 1;
  const t1 = t1raw > t0 ? t1raw : t0 + 1;
  let smin = 0;
  let smax = 0;
  for (let i = 0; i <= SAMPLES; i++) {
    const t = t0 + (i / SAMPLES) * (t1 - t0);
    const s = sampleSpeed(track, t);
    smin = Math.min(smin, s);
    smax = Math.max(smax, s);
  }
  if (smin === smax) { smin -= 1; smax += 1; }
  const padV = (smax - smin) * 0.12 || 1;
  return { t0, t1, vmin: smin - padV, vmax: smax + padV };
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
  const [graphMode, setGraphMode] = useState<'value' | 'speed'>('value');
  const svgRef = useRef<SVGSVGElement | null>(null);
  const drag = useRef<{ oldT: number; tx: ReturnType<typeof beginAnimEdit> } | null>(null);

  const valueBounds = useMemo(() => (track ? computeBounds(track) : null), [track, rev]);
  const speedBounds = useMemo(() => (track ? computeSpeedBounds(track) : null), [track, rev]);
  const bounds = graphMode === 'speed' ? speedBounds : valueBounds;
  // Sample the value or its speed depending on the active graph mode.
  const sampleAt = (t: number): number =>
    track ? (graphMode === 'speed' ? sampleSpeed(track, t) : sampleTrack(track, t) ?? 0) : 0;
  /** Where a keyframe sits vertically in the current mode. */
  const kfY = (k: { t: number; value: number }): number =>
    graphMode === 'speed' ? sampleAt(k.t) : k.value;

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
      const v = sampleAt(t);
      pts.push(`${i === 0 ? 'M' : 'L'}${xOf(t).toFixed(2)},${yOf(v).toFixed(2)}`);
    }
    return pts.join(' ');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [track, bounds, rev, graphMode]);

  const selectedKf = track?.keyframes.find((k) => k.t === selT) ?? null;
  const { copyEase, pasteEase, copied: hasCopiedEase } = useEaseClipboardStore();

  // ── Keyframe drag (value = vertical, time = horizontal) ──────────
  const onPointGrab = (t: number, e: ReactPointerEvent<SVGCircleElement>): void => {
    e.stopPropagation();
    setSelT(t);
    // The speed graph is a read-only view of the derivative — shape it via the
    // easing / roving / influence controls, not by dragging the point.
    if (graphMode === 'speed') return;
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
      
      const currentTrack = defaultAnimation.tracksFor(primary).find((t) => t.prop === prop);
      const currentKfs = currentTrack?.keyframes ?? [];
      const currentIdx = currentKfs.findIndex((k) => k.t === d.oldT);
      const minT = currentIdx > 0 ? currentKfs[currentIdx - 1]!.t + 0.02 : bounds.t0;
      const maxT = currentIdx < currentKfs.length - 1 ? currentKfs[currentIdx + 1]!.t - 0.02 : bounds.t1;
      
      const clampedT = Math.max(minT, Math.min(maxT, nt));
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

  // Easy Ease (F9): a symmetric 33%-influence bezier on the selected keyframe.
  const applyEasyEase = (): void => {
    if (primary && prop && selectedKf) {
      runAnimEdit('Easy ease', () =>
        defaultAnimation.setBezier(primary, prop, selectedKf.t, EASY_EASE_BEZIER),
      );
    }
  };

  const toggleRoving = (): void => {
    if (primary && prop && selectedKf) {
      runAnimEdit('Toggle roving', () =>
        defaultAnimation.setRoving(primary, prop, selectedKf.t, !selectedKf.roving),
      );
    }
  };

  // Set an ease handle's influence (%) — the horizontal reach of a bezier
  // control point. `side` 'out' moves the start handle, 'in' the end handle.
  const setInfluence = (side: 'out' | 'in', pct: number): void => {
    if (!primary || !prop || !selectedKf) return;
    const b = [...(selectedKf.bezier ?? DEFAULT_BEZIER)] as [number, number, number, number];
    const f = Math.max(0, Math.min(1, pct / 100));
    if (side === 'out') b[0] = f;
    else b[2] = 1 - f;
    runAnimEdit(
      'Ease influence',
      () => defaultAnimation.updateKeyframe(primary, prop, selectedKf.t, { easing: 'bezier', bezier: b }),
      `kf-influence:${primary}:${prop}:${selectedKf.t}:${side}`,
    );
  };

  // F9 / Shift+F9 / Cmd+Shift+F9 (Easy Ease / In / Out) are registry commands —
  // see buildEasingCommands in Providers. They work from anywhere, not just
  // while this panel happens to be mounted.

  // ── Bezier handle drag (custom easing) ──────────────────────────
  const selIdx = track ? track.keyframes.findIndex((k) => k.t === selT) : -1;
  const segEnd = selIdx >= 0 && track ? track.keyframes[selIdx + 1] : undefined;
  const showBezier = graphMode === 'value' && !!selectedKf && selectedKf.easing === 'bezier' && !!segEnd && !!bounds;
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
    return (
      <div className={styles.root}>
        <MotionPathBlock nodeId={primary} />
        {/* "above" used to mean the PresetsBar that sat here. That bar was a
            duplicate of the Presets panel — which also saves, deletes, searches
            and previews — so it was removed and this points at the real home. */}
        <EmptyState icon="keyframe" message="No animation yet — apply one from the Presets panel, or add a keyframe." />
      </div>
    );
  }

  return (
    <div className={styles.root}>
      <MotionPathBlock nodeId={primary} />
      {/* Property picker + graph-mode toggle */}
      <div className={styles.topRow}>
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
        <div className={styles.modeToggle} role="radiogroup" aria-label="Graph mode">
          <button
            type="button"
            role="radio"
            aria-checked={graphMode === 'value'}
            className={cn(styles.modeChip, graphMode === 'value' && styles.modeChipOn)}
            onClick={() => setGraphMode('value')}
          >
            Value
          </button>
          <button
            type="button"
            role="radio"
            aria-checked={graphMode === 'speed'}
            className={cn(styles.modeChip, graphMode === 'speed' && styles.modeChipOn)}
            onClick={() => setGraphMode('speed')}
          >
            Speed
          </button>
        </div>
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
            cy={yOf(kfY(k))}
            r={k.t === selT ? 6 : 5}
            className={cn(styles.point, k.t === selT && styles.pointSel, k.roving && styles.pointRoving)}
            onPointerDown={(e) => onPointGrab(k.t, e)}
          />
        ))}
      </svg>

      {/* Easing Presets (Always Visible) */}
      <div className={styles.sectionTitle} style={{ marginTop: 8, fontSize: 11, fontWeight: 600, textTransform: 'uppercase', color: 'var(--color-text-tertiary)' }}>Easing Presets</div>
      <div className={styles.easings} role="radiogroup" aria-label="Easing">
        {EASINGS.map((e) => {
          const isActive = selectedKf && (selectedKf.easing ?? 'linear') === e.kind;
          return (
            <button
              key={e.kind}
              type="button"
              role="radio"
              aria-checked={!!isActive}
              className={cn(styles.easeChip, isActive && styles.easeChipOn)}
              onClick={() => setEasing(e.kind)}
              disabled={!selectedKf}
              title={selectedKf ? `Apply ${e.label} easing` : "Select a keyframe on the graph above to shape its easing"}
            >
              <svg className={styles.easePreview} viewBox="0 0 24 16" aria-hidden>
                <path d={EASE_PREVIEW[e.kind]} />
              </svg>
              <span>{e.label}</span>
            </button>
          );
        })}
      </div>

      {/* Selected keyframe controls */}
      {selectedKf && (
        <div className={styles.controls} style={{ marginTop: 8 }}>
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

          {/* Quick actions: Easy Ease (F9) + Roving toggle. */}
          <div className={styles.actions}>
            <button type="button" className={styles.actionChip} onClick={applyEasyEase} title="Easy Ease (F9)">
              Easy Ease
            </button>
            <button
              type="button"
              className={cn(styles.actionChip, selectedKf.roving && styles.actionChipOn)}
              aria-pressed={!!selectedKf.roving}
              disabled={selIdx <= 0 || selIdx >= (track?.keyframes.length ?? 0) - 1}
              onClick={toggleRoving}
              title="Rove across time for constant speed"
            >
              Roving
            </button>
          </div>

          {/* Bezier influence (%) — only for custom easing. */}
          {selectedKf.easing === 'bezier' ? (
            <div className={styles.numeric}>
              <label className={styles.field}>
                <span className={styles.fieldLabel}>Ease Out</span>
                <ValueField
                  value={Math.round((selectedKf.bezier?.[0] ?? DEFAULT_BEZIER[0]) * 100)}
                  min={0} max={100} precision={0} unit="%"
                  onChange={(v) => setInfluence('out', v)}
                  aria-label="ease out influence"
                />
              </label>
              <label className={styles.field}>
                <span className={styles.fieldLabel}>Ease In</span>
                <ValueField
                  value={Math.round((1 - (selectedKf.bezier?.[2] ?? DEFAULT_BEZIER[2])) * 100)}
                  min={0} max={100} precision={0} unit="%"
                  onChange={(v) => setInfluence('in', v)}
                  aria-label="ease in influence"
                />
              </label>
            </div>
          ) : null}
        </div>
      )}
      </>
      ) : (
        <div className={styles.hint}>No keyframes on “{prop}” — drive it with an expression below.</div>
      )}

      {/* Copy/paste an easing curve between keyframes. Moved here from the
          left-sidebar Flow panel, which was a SECOND full bezier editor for the
          same keyframes — it wrote through a different path and only re-synced
          its handles when `easing === 'bezier'`, so it showed a stale curve
          after any preset applied from here. This was its one unique action. */}
      {selectedKf && (
        <div className={styles.actions}>
          <button
            type="button"
            className={styles.actionChip}
            onClick={() => copyEase(makeKeyframeId(primary, prop, selectedKf.t))}
            title="Copy this keyframe's easing"
          >
            <Icon name="copy" size={12} /> Copy Ease
          </button>
          <button
            type="button"
            className={styles.actionChip}
            disabled={!hasCopiedEase}
            onClick={() => pasteEase([makeKeyframeId(primary, prop, selectedKf.t)])}
            title={hasCopiedEase ? 'Paste the copied easing here' : 'Nothing copied yet'}
          >
            <Icon name="download" size={12} /> Paste Ease
          </button>
        </div>
      )}

      {/* Expression editor — drives this property with a formula each frame. */}
      <ExpressionEditor nodeId={primary} prop={prop} />
    </div>
  );
}

export default MotionEditorPanel;
