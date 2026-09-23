/**
 * Time Stretch dialog — After Effects' Layer ▸ Time ▸ Time Stretch.
 *
 * The same three things AE asks: the Stretch Factor, the New Duration it
 * implies (the two are linked both ways — typing either updates the other),
 * and which moment to Hold in Place while the bar changes length. The old
 * command was a one-field percentage prompt that changed the playback rate and
 * left the bar where it was.
 */

import { useMemo, useState } from 'react';
import { Button } from '@components/Button';
import { Input } from '@components/Input';
import { DialogFooter, useDialogPrimaryAction } from '@components/Modal';
import { openModal } from '@stores/modalStore';
import { useUIStore } from '@stores/uiStore';
import { getTimelineController } from '@core/timeline/TimelineController';
import { timeStretchEdit } from '@layout/Timeline/timelineEdits';
import {
  clampSignedStretch,
  isRetimableLayer,
  stretchValueOf,
  type StretchHold,
} from '@core/animation/layerTimeCommands';
import { framesToTimecode } from '@core/time/timecode';
import { parseGoToTime } from '@layout/Timeline/goToTime';
import styles from './PrecomposeDialog.module.css';

/** Remembered for the session, as AE does. */
const remembered: { hold: StretchHold } = { hold: 'in' };

const HOLDS: ReadonlyArray<{ id: StretchHold; title: string; hint: string }> = [
  { id: 'in', title: 'Layer In-point', hint: 'The first frame stays where it is; the out-point moves.' },
  { id: 'current', title: 'Current Frame', hint: 'The frame under the playhead stays put; both ends move around it.' },
  { id: 'out', title: 'Layer Out-point', hint: 'The last frame stays where it is; the in-point moves.' },
];

/**
 * Duration in frames at 100 % for the first layer — the base both fields are
 * computed from. Pure so the dialog's linkage is testable.
 */
export function baseDurationFrames(currentFrames: number, currentStretch: number): number {
  const s = currentStretch > 0 ? currentStretch : 100;
  return currentFrames / (s / 100);
}

export function durationForStretch(baseFrames: number, percent: number): number {
  return Math.max(1, Math.round(baseFrames * (percent / 100)));
}

export function stretchForDuration(baseFrames: number, frames: number): number {
  if (!(baseFrames > 0)) return 100;
  return (frames / baseFrames) * 100;
}

function TimeStretchDialog({ ids, close }: { ids: string[]; close: () => void }): JSX.Element {
  const c = getTimelineController();
  const fps = c.timeline.getFrameRate().fps;
  // Footage stretches its playback rate — the stored factor. Every other layer
  // bakes the stretch into its bar and keyframes, so its factor starts at 100 %
  // and may go negative (AE's backwards stretch); footage may not.
  const allowNegative = !ids.some((id) => isRetimableLayer(id));
  // The layer's CURRENT stretch, absolute: footage's playback rate, or the
  // bookkeeping value a non-footage layer's bake left behind (e.g. 200, −100).
  const initialStretch = stretchValueOf(ids[0]!);
  const base = useMemo(() => {
    const layers = c.getLayersForNode(ids[0]!);
    const frames = layers.length === 0
      ? 0
      : Math.max(...layers.map((l) => l.start + l.duration)) - Math.min(...layers.map((l) => l.start));
    return baseDurationFrames(frames, Math.abs(initialStretch));
  }, [c, ids, initialStretch]);

  const [percentText, setPercentText] = useState(String(initialStretch));
  const [durationText, setDurationText] = useState(() =>
    framesToTimecode(durationForStretch(base, Math.abs(initialStretch)) / fps, fps),
  );
  const [hold, setHold] = useState<StretchHold>(remembered.hold);

  const percent = Number(percentText);
  const valid = Number.isFinite(percent) && (percent > 0 || (allowNegative && percent < 0));
  // A negative factor keeps the length of its magnitude — it reverses, not shrinks.
  const newFrames = valid ? durationForStretch(base, Math.abs(percent)) : null;

  const onPercent = (text: string): void => {
    setPercentText(text);
    const p = Number(text);
    if (Number.isFinite(p) && p !== 0) setDurationText(framesToTimecode(durationForStretch(base, Math.abs(p)) / fps, fps));
  };
  const onDuration = (text: string): void => {
    setDurationText(text);
    const sec = parseGoToTime(text, { currentSeconds: 0, fps });
    if (sec !== null && sec > 0) {
      const p = stretchForDuration(base, Math.round(sec * fps));
      // A duration has no direction: keep the sign the factor already had.
      const sign = allowNegative && Number(percentText) < 0 ? -1 : 1;
      setPercentText(String((sign * Math.round(p * 100)) / 100));
    }
  };

  const submit = (): void => {
    if (!valid) {
      const message = allowNegative ? 'Enter a stretch factor other than 0 %.' : 'Enter a stretch factor above 0 %.';
      useUIStore.getState().notify({ level: 'warning', message, durationMs: 3500 });
      return;
    }
    remembered.hold = hold;
    // One undo entry: `timeStretchLayers` (B3z) — Hold in Place, footage rate
    // or the non-footage bake (bar + keys + layer markers, negative = reversed).
    void timeStretchEdit(ids, clampSignedStretch(percent), hold);
    close();
  };
  useDialogPrimaryAction(submit);

  return (
    <div className={styles.root}>
      <label className={styles.field}>
        <span
          className={styles.label}
          title={allowNegative ? 'A negative factor reverses the layer’s keyframes (−100 % keeps its length)' : undefined}
        >
          Stretch Factor (%)
        </span>
        <Input
          type="number"
          min={allowNegative ? -1000 : 1}
          max={1000}
          value={percentText}
          onChange={(e) => onPercent(e.target.value)}
          aria-label="Stretch factor"
          autoFocus
          onFocus={(e) => e.currentTarget.select()}
        />
      </label>
      <label className={styles.field}>
        <span className={styles.label}>
          New Duration{newFrames !== null ? ` — ${newFrames} frames` : ''}
        </span>
        <Input
          value={durationText}
          onChange={(e) => onDuration(e.target.value)}
          aria-label="New duration"
        />
      </label>

      <fieldset className={styles.modes}>
        <legend className={styles.label}>Hold in Place</legend>
        {HOLDS.map((h) => (
          <label key={h.id} className={styles.option}>
            <input
              type="radio"
              name="time-stretch-hold"
              className={styles.radio}
              checked={hold === h.id}
              onChange={() => setHold(h.id)}
            />
            <span className={styles.optionText}>
              <span className={styles.optionTitle}>{h.title}</span>
              <span className={styles.optionHint}>{h.hint}</span>
            </span>
          </label>
        ))}
      </fieldset>

      <DialogFooter
        secondary={<Button variant="secondary" size="md" onClick={close}>Cancel</Button>}
        primary={<Button variant="primary" size="md" onClick={submit} disabled={!valid}>OK</Button>}
      />
    </div>
  );
}

/** Open Time Stretch for `ids` (the retimable layers of the selection). */
export function openTimeStretchDialog(ids: ReadonlyArray<string>): void {
  if (ids.length === 0) {
    useUIStore.getState().notify({ level: 'info', message: 'Select a layer to time-stretch.', durationMs: 4000 });
    return;
  }
  openModal({
    id: 'time-stretch',
    title: 'Time Stretch',
    render: (close) => <TimeStretchDialog ids={[...ids]} close={close} />,
  });
}

export { TimeStretchDialog };
