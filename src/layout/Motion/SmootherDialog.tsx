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
import { DialogFooter, useDialogPrimaryAction } from '@components/Modal';
import type { Keyframe, PropPath } from '@motion/animation';
import { fetchMemberTracks, memberTracksNow, type MemberKeys } from '@stores/memberTracks';
import { smoothTrackKeyframes } from '@core/animation/keyframeAssistants';
import { mirrorPropertyMeta } from '@core/mirror/metaFacts';
import { documentMirror } from '@stores/documentMirror';
import { beginTrackPreview } from './assistantPreview';
import styles from './AssistantDialog.module.css';

/** Fewer than three keyframes is a straight line; there is nothing to simplify. */
const MIN_KEYFRAMES = 3;

export interface SmootherTrack {
  prop: PropPath;
  label: string;
  count: number;
  /** The track's keyframes as stored (the engine's `getMemberKeyframes`): the preview's "before". */
  keyframes: ReadonlyArray<Keyframe>;
}

/**
 * The tracks The Smoother can act on — every MEMBER track with enough keys
 * (x and y of an unseparated Position are keyed and smoothed independently),
 * in the engine's own order, from `members` (the engine's member key lists).
 */
export function smootherTracksOf(nodeId: string, members: ReadonlyArray<MemberKeys>): SmootherTrack[] {
  const m = documentMirror();
  const layer = m.layer(nodeId);
  const tree = m.tree(nodeId);
  return members
    .filter((t) => t.keyframes.length >= MIN_KEYFRAMES)
    .map((t) => ({ prop: t.member, label: mirrorPropertyMeta(t.member, layer, tree).label, count: t.keyframes.length, keyframes: t.keyframes }));
}

/** `smootherTracksOf` over the last known member lists (menus: fetched on first ask, re-asked per revision). */
export function smootherTracks(nodeId: string): SmootherTrack[] {
  return smootherTracksOf(nodeId, memberTracksNow(nodeId) ?? []);
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

  const [preview] = useState(() => ({ current: beginTrackPreview(nodeId, new Map(tracks.map((t) => [t.prop, t.keyframes])), 'The Smoother') }));
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
      if (!settled.current) void preview.current.restore();
    },
    [],
  );

  // `close` is the host's doClose, which fires the modal's own `onClose` — so
  // the outcome has to be reported BEFORE closing, or the `onClose` path
  // resolves the promise with null first and the summary is lost.
  const cancel = (): void => {
    settled.current = true;
    void preview.current.restore();
    onDone(null);
    close();
  };

  const confirm = (): void => {
    settled.current = true;
    const p = preview.current;
    if (chosen.size === 0) {
      // Nothing changed — `commit` would return null anyway, but saying so is
      // better than a success toast for a no-op.
      void p.restore();
      onDone(null);
      close();
      return;
    }
    void p.commit();
    onDone(
      `Smoothed ${chosen.size} track${chosen.size === 1 ? '' : 's'}: ${before} → ${after} keyframes`,
    );
    close();
  };

  // Enter smooths, once there is something to smooth.
  useDialogPrimaryAction(chosen.size > 0 ? confirm : null);

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

      <DialogFooter
        note="Previewing on the composition"
        secondary={
          <Button variant="ghost" onClick={cancel}>
            Cancel
          </Button>
        }
        primary={
          <Button variant="primary" onClick={confirm} disabled={chosen.size === 0}>
            Smooth
          </Button>
        }
      />
    </div>
  );
}

/**
 * Open The Smoother for `nodeId`. Returns the summary line for the caller's
 * notification, or `null` when the user cancelled or nothing changed.
 */
export async function openSmootherDialog(nodeId: string): Promise<string | null> {
  // The exact member lists at open (the preview's "before"), asked of the engine.
  const tracks = smootherTracksOf(nodeId, await fetchMemberTracks(nodeId));
  if (tracks.length === 0) return null;
  return new Promise((resolve) => {
    let done = false;
    const finish = (summary: string | null): void => {
      if (done) return;
      done = true;
      resolve(summary);
    };
    openModal({
      id: 'smoother',
      title: 'The Smoother',
      size: 'sm',
      // A tool window: the preview is ON the comp, so the comp must stay
      // reachable — scrub the playhead to judge the result before committing.
      variant: 'floating',
      onClose: () => finish(null),
      render: (close) => (
        <SmootherBody nodeId={nodeId} tracks={tracks} close={close} onDone={finish} />
      ),
    });
  });
}
