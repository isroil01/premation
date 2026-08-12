/**
 * Bounce — the panel section, in the Graph tab beside the rest of a layer's
 * motion.
 *
 * It replaces a single menu item that applied one hardcoded shape and refused
 * to run on a layer with no keyframes. What that item could not express, and
 * this does:
 *
 *  • **From zero.** "Drop In & Bounce" generates the fall as well as the
 *    rebounds, so a static layer is one click from arriving. The old assistant
 *    could only append to motion you had already authored — which is the
 *    opposite of how anyone asks for a bounce.
 *  • **Live parameters.** bounces / decay / elasticity were in the type and
 *    hardcoded at the call site. They are controls now, with a preview drawn
 *    from the SAME generator the buttons run, so what you see is what applies.
 *  • **Styles.** Drop, Elastic, Rubber, Spring — named starting points over
 *    those parameters, because "bounce" is not one shape.
 *  • **Squash & stretch**, opt-in and separate, because it writes scale rather
 *    than position.
 *
 * The settings live in `bounceStore` so the Animate menu's one-click item and
 * this panel cannot disagree about what a bounce is.
 */

import { useMemo } from 'react';
import { cn } from '@utils/cn';
import { Icon } from '@components/Icon';
import { Switch } from '@components/Switch';
import { ValueField } from '@components/ValueField';
import { useAnimationRevision } from '@hooks/useAnimationRevision';
import { useWorkspaceStore } from '@stores/projectStore';
import { useUIStore } from '@stores/uiStore';
import { bumpScene } from '@stores/sceneStore';
import { useBounceStore } from '@stores/bounceStore';
import { defaultAnimation, sampleTrack, type Keyframe } from '@motion/animation';
import {
  BOUNCE_STYLES,
  applyBounce,
  bounceInTracks,
  describeBounce,
  matchBounceStyle,
  revealBounce,
  type DropDirection,
} from '@core/animation/bounce';
import panel from './MotionEditorPanel.module.css';
import styles from './BounceSection.module.css';

const DIRECTIONS: ReadonlyArray<{ id: DropDirection; label: string; icon: 'arrow-down' | 'arrow-up' | 'arrow-right' | 'arrow-left' }> = [
  { id: 'top', label: 'From top', icon: 'arrow-down' },
  { id: 'bottom', label: 'From bottom', icon: 'arrow-up' },
  { id: 'left', label: 'From left', icon: 'arrow-right' },
  { id: 'right', label: 'From right', icon: 'arrow-left' },
];

const PREVIEW_W = 280;
const PREVIEW_H = 76;
const PREVIEW_PAD = 8;
const PREVIEW_SAMPLES = 160;

/**
 * The curve the buttons will draw, from the generator the buttons will run.
 *
 * A preview computed a second way is a preview that can be wrong; this one
 * samples the actual position track, easing and all, so an elasticity that
 * overshoots the frame looks like it overshoots.
 */
function BouncePreview({ keyframes }: { keyframes: ReadonlyArray<Keyframe> }): JSX.Element {
  const { path, restY } = useMemo(() => {
    if (keyframes.length < 2) return { path: '', restY: PREVIEW_H / 2 };
    const track = { nodeId: 'bounce-preview', prop: 'y', keyframes: [...keyframes] };
    const t0 = keyframes[0]!.t;
    const t1 = keyframes[keyframes.length - 1]!.t;
    let lo = Infinity;
    let hi = -Infinity;
    const vals: number[] = [];
    for (let i = 0; i <= PREVIEW_SAMPLES; i++) {
      const v = sampleTrack(track, t0 + (i / PREVIEW_SAMPLES) * (t1 - t0)) ?? 0;
      vals.push(v);
      lo = Math.min(lo, v);
      hi = Math.max(hi, v);
    }
    if (hi - lo < 1e-6) hi = lo + 1;
    // Values are OFFSETS from the resting position, and y grows downward, so
    // the curve reads the way the motion looks: a drop from the top starts high
    // and the overshoot is the part that crosses back over the resting line.
    const x = (i: number): number => PREVIEW_PAD + (i / PREVIEW_SAMPLES) * (PREVIEW_W - 2 * PREVIEW_PAD);
    const y = (v: number): number =>
      PREVIEW_PAD + ((v - lo) / (hi - lo)) * (PREVIEW_H - 2 * PREVIEW_PAD);
    return {
      path: vals.map((v, i) => `${i === 0 ? 'M' : 'L'}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(' '),
      // The resting value is 0 (the track is relative); place its gridline by
      // the same mapping the curve uses.
      restY: y(0),
    };
  }, [keyframes]);

  return (
    <svg
      className={styles.preview}
      viewBox={`0 0 ${PREVIEW_W} ${PREVIEW_H}`}
      preserveAspectRatio="none"
      aria-label="Bounce curve preview"
      role="img"
    >
      <line className={styles.previewRest} x1={0} y1={restY} x2={PREVIEW_W} y2={restY} />
      {path ? <path className={styles.previewCurve} d={path} /> : null}
    </svg>
  );
}

export function BounceSection({ nodeId }: { nodeId: string }): JSX.Element {
  const notify = useUIStore((s) => s.notify);
  // Keyframes live in the engine, not in a store: without this, "Add to
  // Existing" would stay greyed out after the user animated the layer from
  // anywhere else, and light up only when something unrelated re-rendered.
  useAnimationRevision();
  const activeTabId = useWorkspaceStore((s) => s.activeTabId);
  const playhead = useWorkspaceStore((s) => (activeTabId ? s.tabs[activeTabId]?.time : 0) ?? 0);

  const bounce = useBounceStore((s) => s.bounce);
  const drop = useBounceStore((s) => s.drop);
  const squash = useBounceStore((s) => s.squash);
  const squashEnabled = useBounceStore((s) => s.squashEnabled);
  const setBounce = useBounceStore((s) => s.setBounce);
  const setDrop = useBounceStore((s) => s.setDrop);
  const setSquash = useBounceStore((s) => s.setSquash);
  const setSquashEnabled = useBounceStore((s) => s.setSquashEnabled);
  const applyStyle = useBounceStore((s) => s.applyStyle);

  const activeStyle = matchBounceStyle(bounce);
  const squashOpts = squashEnabled ? squash : null;

  /** The position track the settings currently describe — drives the preview. */
  const previewKeys = useMemo(() => {
    const tracks = bounceInTracks(drop, bounce, null);
    return tracks[0]?.keyframes ?? [];
  }, [drop, bounce]);

  /** Can "Add to Existing" do anything? It needs two keys that actually move. */
  const hasAnimation = defaultAnimation.animatedProps(nodeId).length > 0;

  /**
   * Both buttons go through `applyBounce` so they report and reveal identically
   * — the keyframes land in the user's own Position row, so being told what was
   * written is the only thing that distinguishes a bounce from nothing.
   */
  const run = (mode: 'append' | 'drop', ifNothing: string): void => {
    const result = applyBounce(nodeId, { atTime: playhead, mode, drop, bounce, squash: squashOpts });
    if (result) {
      revealBounce(nodeId);
      notify({ level: 'success', message: describeBounce(result), durationMs: 3200 });
    } else {
      notify({ level: 'warning', message: ifNothing, durationMs: 2800 });
    }
    bumpScene();
  };

  const dropIn = (): void => run('drop', 'Set a distance and a fall time first');

  const addToExisting = (): void =>
    run('append', 'No keyframes that move on this layer — use Drop In & Bounce');

  return (
    <div className={styles.root}>
      {/* The panel's own section label, not a second one. */}
      <h3 className={panel.sectionLabel}>
        Bounce
        {/* The one thing worth saying up front on a static layer, because the
            old assistant refused to run on exactly this case. */}
        {!hasAnimation && <span className={panel.sectionNote}>no keyframes needed</span>}
      </h3>

      <BouncePreview keyframes={previewKeys} />

      {/* Styles — starting points, not modes. */}
      <div className={styles.styles} role="radiogroup" aria-label="Bounce style">
        {BOUNCE_STYLES.map((s) => (
          <button
            key={s.id}
            type="button"
            role="radio"
            aria-checked={activeStyle === s.id}
            className={cn(styles.styleChip, activeStyle === s.id && styles.styleChipOn)}
            title={s.description}
            onClick={() => applyStyle(s.options)}
          >
            {s.label}
          </button>
        ))}
      </div>

      {/* The three knobs every bounce expression exposes, plus the one that
          decides whether this is gravity or a spring. */}
      <div className={styles.grid}>
        <label className={styles.field}>
          <span className={styles.fieldLabel}>Bounces</span>
          <ValueField
            value={bounce.bounces}
            min={0}
            max={12}
            step={1}
            precision={0}
            onChange={(v) => setBounce({ bounces: Math.round(v) })}
            aria-label="Number of bounces"
          />
        </label>
        <label className={styles.field}>
          <span className={styles.fieldLabel}>Decay</span>
          <ValueField
            value={bounce.decay}
            min={0.05}
            max={0.95}
            step={0.01}
            precision={2}
            onChange={(v) => setBounce({ decay: v })}
            aria-label="Decay per bounce"
          />
        </label>
        <label className={styles.field}>
          <span className={styles.fieldLabel}>Elasticity</span>
          <ValueField
            value={bounce.elasticity}
            min={0}
            max={1.5}
            step={0.01}
            precision={2}
            onChange={(v) => setBounce({ elasticity: v })}
            aria-label="Elasticity"
          />
        </label>
      </div>

      <div className={styles.row}>
        <span className={styles.rowLabel} title="Overshoot both ways around the resting value, like a spring, instead of only rebounding back the way it came">
          Oscillate
        </span>
        <Switch
          checked={!!bounce.oscillate}
          onChange={(e) => setBounce({ oscillate: e.currentTarget.checked })}
          aria-label="Oscillate around the resting value"
        />
      </div>

      {/* Squash & stretch — scale, not position, so it is its own switch. */}
      <div className={styles.row}>
        <span className={styles.rowLabel} title="Counter-scale on each impact: flatter along the direction of travel, wider across it">
          Squash &amp; stretch
        </span>
        <Switch
          checked={squashEnabled}
          onChange={(e) => setSquashEnabled(e.currentTarget.checked)}
          aria-label="Squash and stretch"
        />
      </div>
      {squashEnabled && (
        <div className={styles.grid}>
          <label className={styles.field}>
            <span className={styles.fieldLabel}>Amount</span>
            <ValueField
              value={Math.round(squash.amount * 100)}
              min={0}
              max={90}
              step={1}
              precision={0}
              unit="%"
              onChange={(v) => setSquash({ amount: v / 100 })}
              aria-label="Squash amount"
            />
          </label>
          <label className={styles.field}>
            <span className={styles.fieldLabel}>Recover</span>
            <ValueField
              value={squash.duration}
              min={0.02}
              max={1}
              step={0.01}
              precision={2}
              unit="s"
              onChange={(v) => setSquash({ duration: v })}
              aria-label="Squash recovery time"
            />
          </label>
        </div>
      )}

      {/* From zero — the half that did not exist. */}
      <h4 className={panel.sectionLabel}>Drop in from</h4>
      <div className={styles.styles} role="radiogroup" aria-label="Drop direction">
        {DIRECTIONS.map((d) => (
          <button
            key={d.id}
            type="button"
            role="radio"
            aria-checked={drop.direction === d.id}
            className={cn(styles.styleChip, drop.direction === d.id && styles.styleChipOn)}
            title={d.label}
            onClick={() => setDrop({ direction: d.id })}
          >
            <Icon name={d.icon} size="sm" />
            <span>{d.label.replace('From ', '')}</span>
          </button>
        ))}
      </div>
      <div className={styles.grid}>
        <label className={styles.field}>
          <span className={styles.fieldLabel}>Distance</span>
          <ValueField
            value={drop.distance}
            min={0}
            max={4000}
            step={1}
            precision={0}
            unit="px"
            onChange={(v) => setDrop({ distance: v })}
            aria-label="Drop distance"
          />
        </label>
        <label className={styles.field}>
          <span className={styles.fieldLabel}>Fall</span>
          <ValueField
            value={drop.duration}
            min={0.05}
            max={5}
            step={0.01}
            precision={2}
            unit="s"
            onChange={(v) => setDrop({ duration: v })}
            aria-label="Fall duration"
          />
        </label>
        <label className={styles.fieldInline}>
          <span className={styles.fieldLabel}>Fade in</span>
          <Switch
            checked={drop.fade}
            onChange={(e) => setDrop({ fade: e.currentTarget.checked })}
            aria-label="Fade in over the fall"
          />
        </label>
      </div>

      <div className={styles.actions}>
        <button
          type="button"
          className={cn(styles.action, styles.actionPrimary)}
          onClick={dropIn}
          title="Generate the fall and the bounce at the playhead — no keyframes needed"
        >
          Drop In &amp; Bounce
        </button>
        <button
          type="button"
          className={styles.action}
          onClick={addToExisting}
          disabled={!hasAnimation}
          title={
            hasAnimation
              ? "Append a bounce after this layer's last keyframe"
              : 'This layer has no keyframes yet'
          }
        >
          Add to Existing
        </button>
      </div>
    </div>
  );
}

export default BounceSection;
