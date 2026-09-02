/**
 * The Assemble from Footage dialog.
 *
 * Three numbers, because the operation has exactly three decisions and every
 * one of them is wrong by default on some footage:
 *
 *   • how eager the cut detector should be,
 *   • how long a dissolve to lay on each cut, and
 *   • how short a "shot" has to be before it is debris rather than a shot.
 *
 * A `customPrompt` chain was the alternative — three modals in a row, each of
 * which discards the previous answers if you cancel it — and the numbers are
 * related enough (a high sensitivity produces the runts the third field
 * removes) that they belong on one surface where you can see them together.
 *
 * Deliberately NOT previewing, unlike the assistant dialogs it resembles: the
 * answer costs a full decode pass over the clip, so a preview would run the
 * expensive half on every keystroke. The footer says so rather than leaving the
 * user to discover it.
 */

import { useState } from 'react';
import { Button } from '@components/Button';
import { ValueField } from '@components/ValueField';
import { openModal } from '@stores/modalStore';
import type { AssembleOptions } from '@core/composition/assembleFromFootage';
import styles from './AssembleDialog.module.css';

/** `SceneEditOptions.sensitivity`'s own default, restated so the field opens on it. */
const DEFAULT_SENSITIVITY = 5;

interface BodyProps {
  clipName: string;
  fps: number;
  close: () => void;
  onDone: (opts: AssembleOptions | null) => void;
}

function AssembleBody({ clipName, fps, close, onDone }: BodyProps): JSX.Element {
  const [sensitivity, setSensitivity] = useState(DEFAULT_SENSITIVITY);
  const [dissolveFrames, setDissolveFrames] = useState(0);
  const [minShotFrames, setMinShotFrames] = useState(0);

  const cancel = (): void => {
    onDone(null);
    close();
  };
  const confirm = (): void => {
    onDone({
      sensitivity,
      dissolveFrames: Math.max(0, Math.round(dissolveFrames)),
      minShotFrames: Math.max(0, Math.round(minShotFrames)),
    });
    close();
  };

  const secs = (frames: number): string => (frames / fps).toFixed(2);

  return (
    <div className={styles.body}>
      <p className={styles.blurb}>
        Find the cuts in “{clipName}”, split it into one clip per shot, then lay the shots back
        end-to-end. Runs one decode pass over the clip’s visible span, and lands as a single undo
        step.
      </p>

      <div className={styles.fields}>
        <div className={styles.field}>
          <span className={styles.label}>Cut sensitivity</span>
          <ValueField
            value={sensitivity}
            onChange={setSensitivity}
            min={1}
            step={0.5}
            precision={2}
            aria-label="Cut sensitivity"
          />
        </div>
        <div className={styles.field}>
          <span className={styles.label}>Dissolve on cuts (frames)</span>
          <ValueField
            value={dissolveFrames}
            onChange={(v) => setDissolveFrames(Math.max(0, Math.round(v)))}
            min={0}
            step={1}
            precision={0}
            aria-label="Dissolve on cuts, in frames"
          />
        </div>
        <div className={styles.field}>
          <span className={styles.label}>Drop shots shorter than (frames)</span>
          <ValueField
            value={minShotFrames}
            onChange={(v) => setMinShotFrames(Math.max(0, Math.round(v)))}
            min={0}
            step={1}
            precision={0}
            aria-label="Drop shots shorter than, in frames"
          />
        </div>
        <p className={`${styles.hint} ${styles.fieldWide}`}>
          Higher sensitivity finds fewer cuts — it is a multiple of the local median frame
          difference, so 5 means “five times more different than this footage usually is”. At{' '}
          {fps.toFixed(2)} fps a {Math.max(0, Math.round(dissolveFrames))}-frame dissolve is{' '}
          {secs(Math.max(0, Math.round(dissolveFrames)))}s, and shots under{' '}
          {Math.max(0, Math.round(minShotFrames))} frames are{' '}
          {minShotFrames > 0 ? `under ${secs(Math.max(0, Math.round(minShotFrames)))}s` : 'all kept'}
          . The last remaining shot is never dropped.
        </p>
      </div>

      <div className={styles.footer}>
        <span className={styles.footerNote}>Detection reads every frame of the clip</span>
        <Button variant="ghost" onClick={cancel}>
          Cancel
        </Button>
        <Button variant="primary" onClick={confirm}>
          Assemble
        </Button>
      </div>
    </div>
  );
}

/**
 * Ask for the assembly settings. Resolves to `null` when the user cancelled —
 * which must leave the footage untouched, so the caller runs nothing until this
 * resolves with options.
 */
export function openAssembleDialog(clipName: string, fps: number): Promise<AssembleOptions | null> {
  return new Promise((resolve) => {
    let done = false;
    const finish = (opts: AssembleOptions | null): void => {
      if (done) return;
      done = true;
      resolve(opts);
    };
    openModal({
      title: 'Assemble from Footage',
      size: 'sm',
      onClose: () => finish(null),
      render: (close) => (
        <AssembleBody clipName={clipName} fps={fps > 0 ? fps : 30} close={close} onDone={finish} />
      ),
    });
  });
}
