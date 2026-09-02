/**
 * The Wiggler (AE Animation ▸ Keyframe Assistant ▸ The Wiggler).
 *
 * Was a `customPrompt` that asked for the string "5, 25" and split it on a
 * comma — two numbers with different units, no labels, and a parse that
 * rejected the whole thing if either half was mistyped. Frequency and
 * amplitude are both look-at-it controls, so this previews live.
 *
 * DIMENSION is the third control, and it is not decoration: `applyWiggler`
 * wiggles x and y with independent seeds because a shared seed produces a
 * diagonal wobble rather than a 2D one. Restricting to one axis is the other
 * thing people actually want (a horizontal camera shake), and the prompt had
 * no way to say it.
 *
 * NOISE TYPE is deliberately absent — the engine has exactly one generator
 * (`wiggleHash01`, deterministic by seed), and offering a menu with one real
 * entry would be advertising a choice the core cannot make. `Random Seed` is
 * what varies the wobble, so that is what the dialog exposes.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import { Button } from '@components/Button';
import { ValueField } from '@components/ValueField';
import { openModal } from '@stores/modalStore';
import { defaultAnimation, type Keyframe, type PropPath } from '@motion/animation';
import { wiggleTrackKeyframes } from '@core/animation/keyframeAssistants';
import { beginTrackPreview } from './assistantPreview';
import styles from './AssistantDialog.module.css';

/** A wobble needs a segment to live in, so a track needs two keyframes. */
const MIN_KEYFRAMES = 2;

export type WiggleDimension = 'both' | 'x' | 'y';

const DIMENSIONS: ReadonlyArray<{ id: WiggleDimension; label: string }> = [
  { id: 'both', label: 'X and Y' },
  { id: 'x', label: 'X only' },
  { id: 'y', label: 'Y only' },
];

/** The position axes The Wiggler can act on. */
export function wigglerTracks(nodeId: string): PropPath[] {
  return (['x', 'y'] as const).filter(
    (p) => (defaultAnimation.getTrackKeyframes(nodeId, p)?.length ?? 0) >= MIN_KEYFRAMES,
  );
}

interface WigglerBodyProps {
  nodeId: string;
  tracks: ReadonlyArray<PropPath>;
  close: () => void;
  onDone: (summary: string | null) => void;
}

function WigglerBody({ nodeId, tracks, close, onDone }: WigglerBodyProps): JSX.Element {
  const [frequency, setFrequency] = useState(5);
  const [amplitude, setAmplitude] = useState(25);
  const [seed, setSeed] = useState(1);
  const [dimension, setDimension] = useState<WiggleDimension>('both');
  const [added, setAdded] = useState(0);

  const preview = useRef(beginTrackPreview(nodeId, tracks));
  const settled = useRef(false);

  const targets = useMemo(
    () => tracks.filter((p) => dimension === 'both' || p === dimension),
    [tracks, dimension],
  );

  useEffect(() => {
    const p = preview.current;
    const next = new Map<PropPath, Keyframe[]>();
    let delta = 0;
    // Frequency 0 or amplitude 0 is a no-op inside `wiggleTrackKeyframes`
    // itself, so the preview simply shows the original curve — which is the
    // honest answer while the field is mid-edit rather than an error toast.
    tracks.forEach((prop, i) => {
      if (!targets.includes(prop)) return;
      const original = p.original(prop);
      // Per-AXIS seed, as `applyWiggler` does it: a shared seed gives both
      // axes the same offsets, which is a diagonal wobble rather than a 2D
      // one. Indexed over `tracks` (not the filtered targets) so switching
      // dimension does not reshuffle the wobble the other axis already had.
      const wiggled = wiggleTrackKeyframes(original, {
        frequency,
        amplitude,
        seed: seed * 31 + i * 101,
      });
      next.set(prop, wiggled);
      delta += wiggled.length - original.length;
    });
    p.apply(next);
    setAdded(delta);
  }, [tracks, targets, frequency, amplitude, seed]);

  useEffect(
    () => () => {
      if (!settled.current) preview.current.restore();
    },
    [],
  );

  // Report before closing: `close` fires the modal's own `onClose`, which
  // resolves the promise.
  const cancel = (): void => {
    settled.current = true;
    preview.current.restore();
    onDone(null);
    close();
  };

  const confirm = (): void => {
    settled.current = true;
    const p = preview.current;
    if (targets.length === 0 || !(frequency > 0) || amplitude === 0) {
      p.restore();
      onDone(null);
      close();
      return;
    }
    p.commit('The Wiggler');
    const what = targets.length === 2 ? 'x and y' : `${targets[0]}`;
    onDone(`Wiggled ${what} — ${added} keyframes added`);
    close();
  };

  const valid = targets.length > 0 && frequency > 0 && amplitude !== 0;

  return (
    <div className={styles.body}>
      <p className={styles.blurb}>
        Bake a deterministic wobble into the animated position. Authored keyframes keep their times
        and values, and the endpoints never move — the motion still departs and lands exactly where
        it did.
      </p>

      <div className={styles.fields}>
        <div className={styles.field}>
          <span className={styles.label}>Frequency (per second)</span>
          <ValueField
            value={frequency}
            onChange={setFrequency}
            min={0.1}
            step={0.5}
            precision={2}
            aria-label="Frequency in wobbles per second"
          />
        </div>
        <div className={styles.field}>
          <span className={styles.label}>Amplitude (px)</span>
          <ValueField
            value={amplitude}
            onChange={setAmplitude}
            step={1}
            precision={2}
            aria-label="Amplitude in pixels"
          />
        </div>
        <div className={styles.field}>
          <span className={styles.label}>Dimension</span>
          <div className={styles.segmented} role="group" aria-label="Dimension">
            {DIMENSIONS.map((d) => (
              <Button
                key={d.id}
                size="sm"
                variant={dimension === d.id ? 'primary' : 'secondary'}
                // An axis the layer does not animate cannot be wiggled: there
                // is no curve to offset from.
                disabled={d.id !== 'both' && !tracks.includes(d.id)}
                onClick={() => setDimension(d.id)}
              >
                {d.label}
              </Button>
            ))}
          </div>
        </div>
        <div className={styles.field}>
          <span className={styles.label}>Random Seed</span>
          <ValueField
            value={seed}
            onChange={(v) => setSeed(Math.max(1, Math.round(v)))}
            min={1}
            step={1}
            precision={0}
            aria-label="Random seed"
          />
        </div>
      </div>

      <p className={styles.result}>
        {valid
          ? `${added} keyframes added across ${targets.length} track${targets.length === 1 ? '' : 's'}.`
          : 'Frequency must be above 0 and amplitude must not be 0.'}
      </p>

      <div className={styles.footer}>
        <span className={styles.footerNote}>Previewing on the composition</span>
        <Button variant="ghost" onClick={cancel}>
          Cancel
        </Button>
        <Button variant="primary" onClick={confirm} disabled={!valid}>
          Wiggle
        </Button>
      </div>
    </div>
  );
}

/**
 * Open The Wiggler for `nodeId`. Resolves to the summary line for the caller's
 * notification, or `null` when the user cancelled.
 */
export function openWigglerDialog(nodeId: string): Promise<string | null> {
  const tracks = wigglerTracks(nodeId);
  if (tracks.length === 0) return Promise.resolve(null);
  return new Promise((resolve) => {
    let done = false;
    const finish = (summary: string | null): void => {
      if (done) return;
      done = true;
      resolve(summary);
    };
    openModal({
      title: 'The Wiggler',
      size: 'sm',
      onClose: () => finish(null),
      render: (close) => (
        <WigglerBody nodeId={nodeId} tracks={tracks} close={close} onDone={finish} />
      ),
    });
  });
}
