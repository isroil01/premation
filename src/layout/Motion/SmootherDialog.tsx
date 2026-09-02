/**
 * The Smoother (AE Animation ▸ Keyframe Assistant ▸ The Smoother).
 *
 * Was a one-line `customPrompt`: type a tolerance, press Enter, and discover
 * afterwards whether it destroyed the motion. Tolerance is a "turn the knob
 * until it looks right" control — nobody knows that 5 px is the answer until
 * they have watched 5 px happen — so the dialog previews live and lets you
 * choose WHICH tracks it touches, which the prompt could not express at all.
 *
 * Preview/undo mechanics live in `assistantPreview.ts`; see the long comment
 * there for why Cancel restores captured arrays rather than re-running.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import { Button } from '@components/Button';
import { Checkbox } from '@components/Checkbox';
import { ValueField } from '@components/ValueField';
import { openModal } from '@stores/modalStore';
import { defaultAnimation, type Keyframe, type PropPath } from '@motion/animation';
import { smoothTrackKeyframes } from '@core/animation/keyframeAssistants';
import { resolvePropertyMeta } from '@core/inspector/propertyMeta';
import { beginTrackPreview } from './assistantPreview';
import styles from './AssistantDialog.module.css';

/** Fewer than three keyframes is a straight line; there is nothing to simplify. */
const MIN_KEYFRAMES = 3;

export interface SmootherTrack {
  prop: PropPath;
  label: string;
  count: number;
}

/** The tracks The Smoother can act on, in the engine's own property order. */
export function smootherTracks(nodeId: string): SmootherTrack[] {
  const out: SmootherTrack[] = [];
  for (const prop of defaultAnimation.animatedProps(nodeId)) {
    const kfs = defaultAnimation.getTrackKeyframes(nodeId, prop);
    if (!kfs || kfs.length < MIN_KEYFRAMES) continue;
    out.push({ prop, label: resolvePropertyMeta(prop, nodeId).label, count: kfs.length });
  }
  return out;
}

interface SmootherBodyProps {
  nodeId: string;
  tracks: ReadonlyArray<SmootherTrack>;
  close: () => void;
  onDone: (summary: string | null) => void;
}

function SmootherBody({ nodeId, tracks, close, onDone }: SmootherBodyProps): JSX.Element {
  const [tolerance, setTolerance] = useState(5);
  const [chosen, setChosen] = useState<ReadonlySet<PropPath>>(
    () => new Set(tracks.map((t) => t.prop)),
  );
  const [after, setAfter] = useState(0);

  const preview = useRef(beginTrackPreview(nodeId, tracks.map((t) => t.prop)));
  // Set by OK/Cancel so the unmount cleanup knows whether the preview has
  // already been settled. Without it, closing via the scrim would leave the
  // last previewed value applied and unrecorded.
  const settled = useRef(false);

  const before = useMemo(
    () => tracks.filter((t) => chosen.has(t.prop)).reduce((a, t) => a + t.count, 0),
    [tracks, chosen],
  );

  useEffect(() => {
    const p = preview.current;
    const next = new Map<PropPath, Keyframe[]>();
    let total = 0;
    for (const track of tracks) {
      if (!chosen.has(track.prop)) continue;
      const simplified = smoothTrackKeyframes(p.original(track.prop), tolerance);
      next.set(track.prop, simplified);
      total += simplified.length;
    }
    p.apply(next);
    setAfter(total);
  }, [tracks, chosen, tolerance]);

  // Scrim / Escape close — Radix unmounts the body without routing through the
  // buttons, and an abandoned preview must not survive that.
  useEffect(
    () => () => {
      if (!settled.current) preview.current.restore();
    },
    [],
  );

  // `close` is the host's doClose, which fires the modal's own `onClose` — so
  // the outcome has to be reported BEFORE closing, or the `onClose` path
  // resolves the promise with null first and the summary is lost.
  const cancel = (): void => {
    settled.current = true;
    preview.current.restore();
    onDone(null);
    close();
  };

  const confirm = (): void => {
    settled.current = true;
    const p = preview.current;
    if (chosen.size === 0) {
      // Nothing changed — `commit` would return null anyway, but saying so is
      // better than a success toast for a no-op.
      p.restore();
      onDone(null);
      close();
      return;
    }
    p.commit('The Smoother');
    onDone(
      `Smoothed ${chosen.size} track${chosen.size === 1 ? '' : 's'}: ${before} → ${after} keyframes`,
    );
    close();
  };

  const toggle = (prop: PropPath): void => {
    setChosen((prev) => {
      const next = new Set(prev);
      if (next.has(prop)) next.delete(prop);
      else next.add(prop);
      return next;
    });
  };

  return (
    <div className={styles.body}>
      <p className={styles.blurb}>
        Replace dense keyframes with the fewest that keep each curve within the tolerance, then
        smooth the survivors’ tangents. Tolerance is in the property’s own units — px for position,
        degrees for rotation.
      </p>

      <div className={styles.fields}>
        <div className={styles.field}>
          <span className={styles.label}>Tolerance</span>
          <ValueField
            value={tolerance}
            onChange={setTolerance}
            min={0.01}
            step={0.5}
            precision={2}
            aria-label="Tolerance"
          />
        </div>
      </div>

      <div className={styles.field}>
        <span className={styles.label}>Properties</span>
        <div className={styles.tracks}>
          {tracks.map((t) => (
            <div key={t.prop} className={styles.trackRow}>
              <Checkbox
                checked={chosen.has(t.prop)}
                onChange={() => toggle(t.prop)}
                label={t.label}
              />
              <span className={styles.trackCount}>{t.count} keys</span>
            </div>
          ))}
        </div>
      </div>

      <p className={styles.result}>
        {chosen.size === 0
          ? 'No properties selected.'
          : `${before} keyframes → ${after} across ${chosen.size} track${chosen.size === 1 ? '' : 's'}.`}
      </p>

      <div className={styles.footer}>
        <span className={styles.footerNote}>Previewing on the composition</span>
        <Button variant="ghost" onClick={cancel}>
          Cancel
        </Button>
        <Button variant="primary" onClick={confirm} disabled={chosen.size === 0}>
          Smooth
        </Button>
      </div>
    </div>
  );
}

/**
 * Open The Smoother for `nodeId`. Returns the summary line for the caller's
 * notification, or `null` when the user cancelled or nothing changed.
 */
export function openSmootherDialog(nodeId: string): Promise<string | null> {
  const tracks = smootherTracks(nodeId);
  if (tracks.length === 0) return Promise.resolve(null);
  return new Promise((resolve) => {
    let done = false;
    const finish = (summary: string | null): void => {
      if (done) return;
      done = true;
      resolve(summary);
    };
    openModal({
      title: 'The Smoother',
      size: 'sm',
      onClose: () => finish(null),
      render: (close) => (
        <SmootherBody nodeId={nodeId} tracks={tracks} close={close} onDone={finish} />
      ),
    });
  });
}
