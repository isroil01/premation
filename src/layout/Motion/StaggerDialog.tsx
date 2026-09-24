/**
 * Stagger Layers — offset a multi-row selection in time, in a chosen pattern.
 *
 * ## What it is for
 *
 * The reason anyone selects twenty layers is almost never to move them all by
 * the same amount. It is to make them fire in sequence: a trail, an alternating
 * beat, a fan out of the middle. Before this the only tools for that were
 * Sequence Layers — which lays bars strictly end-to-end and destroys whatever
 * spacing you had — and dragging each row by hand.
 *
 * ## Why bars AND animation are one dialog
 *
 * They are the same edit at two altitudes. "Make these come in one after
 * another" means moving the BARS when the layers are cuts on a timeline, and
 * moving the KEYFRAMES when they are animated graphics that all start at zero.
 * Which one you want depends on the comp, not on the intent, and two dialogs
 * with the same four controls would make the user pick a mechanism before
 * stating a goal. So the target is a control, and the patterns, the amount,
 * the order and the balance are shared.
 *
 * ## Why the mode persists
 *
 * Whatever pattern is chosen here is also what the timeline's Ctrl-drag on a
 * group of selected bars uses. That gesture has no room for a mode picker — it
 * is one axis of pointer travel — so it reads the one set here. Pick Zigzag
 * once and both entry points zigzag.
 */

import { useMemo, useState } from 'react';
import { Button } from '@components/Button';
import { ValueField } from '@components/ValueField';
import { openModal } from '@stores/modalStore';
import { DialogFooter, useDialogPrimaryAction } from '@components/Modal';
import { flicksToSeconds } from '@motion/engine-api';
import { documentMirror } from '@stores/documentMirror';
import { useActiveCompFps } from '@hooks/useMirror';
import { moveBars } from '@layout/Timeline/timelineEdits';
import { staggerKeyframesEdit } from '@layout/Menu/appEdits';
import {
  clampOffsetsToStart,
  quantizeOffsets,
  staggerOffsets,
  STAGGER_MODES,
  type StaggerMode,
} from '@core/animation/staggerOffsets';
import { useStaggerStore } from '@layout/Timeline/staggerStore';
import styles from './AssistantDialog.module.css';

/** What the offsets are applied to. */
type StaggerTarget = 'bars' | 'animation';

const TARGETS: ReadonlyArray<{ id: StaggerTarget; label: string; hint: string }> = [
  { id: 'bars', label: 'Layer Bars', hint: 'Move when each layer starts' },
  { id: 'animation', label: 'Animation', hint: 'Shift each layer’s keyframes in place' },
];

interface StaggerBodyProps {
  nodeIds: ReadonlyArray<string>;
  close: () => void;
  onDone: (summary: string | null) => void;
}

function StaggerBody({ nodeIds, close, onDone }: StaggerBodyProps): JSX.Element {
  const mode = useStaggerStore((s) => s.mode);
  const setMode = useStaggerStore((s) => s.setMode);
  const reverse = useStaggerStore((s) => s.reverse);
  const setReverse = useStaggerStore((s) => s.setReverse);

  const [target, setTarget] = useState<StaggerTarget>('bars');
  const [frames, setFrames] = useState(4);
  const [balance, setBalance] = useState(false);
  const [seed, setSeed] = useState(1);

  const fps = useActiveCompFps();
  const step = frames / fps;

  /**
   * The shape, previewed as the spread it will produce. Shown as a frame range
   * rather than as a list because the useful question is "how much of the
   * timeline does this rearrange", and with twenty rows a list is unreadable.
   */
  const preview = useMemo(() => {
    const offsets = quantizeOffsets(
      staggerOffsets(nodeIds.length, { mode, step, reverse, balance, seed }),
      1 / fps,
    );
    const inFrames = offsets.map((t) => Math.round(t * fps));
    return { min: Math.min(...inFrames), max: Math.max(...inFrames) };
  }, [nodeIds.length, mode, step, reverse, balance, seed, fps]);

  const valid = nodeIds.length >= 2 && frames !== 0;

  const cancel = (): void => {
    onDone(null);
    close();
  };

  const confirm = (): void => {
    if (!valid) {
      onDone(null);
      close();
      return;
    }
    if (target === 'animation') {
      // The same pattern on each layer's keyframes, one undo entry:
      // `shiftLayerKeyframes` (B3z) moves whole tracks in LAYER time — sub-frame
      // offsets and times before 0 included, as the assistant always did.
      void staggerKeyframesEdit(nodeIds, { mode, step, reverse, balance, seed }).then((res) => {
        onDone(res === true ? `Animation staggered across ${nodeIds.length} layers` : null);
      });
      close();
      return;
    }

    // Bars. The offsets are resolved against each layer's CURRENT start, so a
    // stagger applied twice compounds rather than snapping back to a fresh
    // ladder — which is what makes it usable as a nudge.
    // One bar per layer in the document (the mirror's `timing`; a split makes
    // a new layer), addressed as the timeline addresses it: `clip:<layer>`.
    const m = documentMirror();
    const bars = nodeIds.map((id) => {
      const layer = m.layer(id);
      return layer ? [{ layerId: `clip:${id}`, startSeconds: flicksToSeconds(layer.timing.inPoint) }] : [];
    });
    // A row's position for the clamp is its EARLIEST bar: that is the one that
    // reaches t=0 first, and a split layer must not have its head pushed
    // through zero because a later fragment cleared it.
    const starts = bars.map((rows) =>
      rows.length ? Math.min(...rows.map((r) => r.startSeconds)) : 0,
    );
    const raw = quantizeOffsets(
      staggerOffsets(nodeIds.length, { mode, step, reverse, balance, seed }),
      1 / fps,
    );
    // One shift for the whole set if any row would land before t=0, so the
    // pattern survives being aimed at the head of the comp.
    const offsets = clampOffsetsToStart(starts, raw, 0);

    const moves: Array<{ layerId: string; startSeconds: number }> = [];
    bars.forEach((rows, i) => {
      const delta = offsets[i] ?? 0;
      if (Math.abs(delta) < 1e-9) return;
      for (const bar of rows) {
        moves.push({ layerId: bar.layerId, startSeconds: Math.max(0, bar.startSeconds + delta) });
      }
    });

    if (moves.length === 0) {
      onDone(null);
      close();
      return;
    }
    void moveBars(moves.map((m) => ({ clipId: m.layerId, start: m.startSeconds })), 'Stagger Layers');
    onDone(`${nodeIds.length} layers staggered — ${preview.min} to ${preview.max}f`);
    close();
  };

  useDialogPrimaryAction(valid ? confirm : null);

  return (
    <div className={styles.body}>
      <p className={styles.blurb}>
        Offset the {nodeIds.length} selected layers in time, top to bottom, in a pattern. Relative
        spacing inside each layer is kept — this moves when things happen, never how long they last.
      </p>

      <div className={styles.fields}>
        <div className={styles.field}>
          <span className={styles.label}>Apply to</span>
          <div className={styles.segmented} role="group" aria-label="Apply to">
            {TARGETS.map((t) => (
              <Button
                key={t.id}
                size="sm"
                variant={target === t.id ? 'primary' : 'secondary'}
                title={t.hint}
                onClick={() => setTarget(t.id)}
              >
                {t.label}
              </Button>
            ))}
          </div>
        </div>

        <div className={styles.fieldWide}>
          <span className={styles.label}>Pattern</span>
          <div className={styles.segmented} role="group" aria-label="Pattern">
            {STAGGER_MODES.map((m) => (
              <Button
                key={m.id}
                size="sm"
                variant={mode === m.id ? 'primary' : 'secondary'}
                title={m.hint}
                onClick={() => setMode(m.id as StaggerMode)}
              >
                {m.label}
              </Button>
            ))}
          </div>
        </div>

        <div className={styles.field}>
          <span className={styles.label}>Step (frames)</span>
          <ValueField
            value={frames}
            onChange={setFrames}
            step={1}
            precision={0}
            aria-label="Step in frames between adjacent layers"
          />
        </div>

        {mode === 'random' ? (
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
        ) : null}

        <div className={styles.field}>
          <span className={styles.label}>Order</span>
          <div className={styles.segmented} role="group" aria-label="Order">
            <Button size="sm" variant={reverse ? 'secondary' : 'primary'} onClick={() => setReverse(false)}>
              Top first
            </Button>
            <Button size="sm" variant={reverse ? 'primary' : 'secondary'} onClick={() => setReverse(true)}>
              Bottom first
            </Button>
          </div>
        </div>

        <div className={styles.field}>
          <span className={styles.label}>Anchor</span>
          <div className={styles.segmented} role="group" aria-label="Anchor">
            <Button
              size="sm"
              variant={balance ? 'secondary' : 'primary'}
              title="The first layer stays put and the rest trail after it"
              onClick={() => setBalance(false)}
            >
              First stays
            </Button>
            <Button
              size="sm"
              variant={balance ? 'primary' : 'secondary'}
              title="Spread around where the selection already sits"
              onClick={() => setBalance(true)}
            >
              Centred
            </Button>
          </div>
        </div>
      </div>

      <p className={styles.result}>
        {valid
          ? `Spread ${preview.min} to ${preview.max} frames across ${nodeIds.length} layers.`
          : 'Select two or more layers and set a non-zero step.'}
      </p>

      <DialogFooter
        secondary={
          <Button variant="ghost" onClick={cancel}>
            Cancel
          </Button>
        }
        primary={
          <Button variant="primary" onClick={confirm} disabled={!valid}>
            Stagger
          </Button>
        }
      />
    </div>
  );
}

/**
 * Open Stagger Layers for the selection. Resolves to the summary line for the
 * caller's notification, or `null` when the user cancelled or nothing moved.
 */
export function openStaggerDialog(nodeIds: ReadonlyArray<string>): Promise<string | null> {
  if (nodeIds.length < 2) return Promise.resolve(null);
  return new Promise((resolve) => {
    let done = false;
    const finish = (summary: string | null): void => {
      if (done) return;
      done = true;
      resolve(summary);
    };
    openModal({
      id: 'stagger-layers',
      title: 'Stagger Layers',
      size: 'sm',
      variant: 'floating',
      onClose: () => finish(null),
      render: (close) => <StaggerBody nodeIds={nodeIds} close={close} onDone={finish} />,
    });
  });
}
