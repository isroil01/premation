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
import { useDialogPrimaryAction } from '@components/Modal';
import { ValueField } from '@components/ValueField';
import { openModal } from '@stores/modalStore';
import type { AssembleOptions } from '@core/composition/assembleFromFootage';
import styles from './AssembleDialog.module.css';
import { t } from '@core/i18n';

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
  useDialogPrimaryAction(confirm);

  const secs = (frames: number): string => (frames / fps).toFixed(2);

  return (
    <div className={styles.body}>
      <p className={styles.blurb}>
        {t(
          'assets.assemble.blurb',
          'Find the cuts in “{name}”, split it into one clip per shot, then lay the shots back end-to-end. Runs one decode pass over the clip’s visible span, and lands as a single undo step.',
          { name: clipName },
        )}
      </p>

      <div className={styles.fields}>
        <div className={styles.field}>
          <span className={styles.label}>{t('assets.assemble.sensitivity', 'Cut sensitivity')}</span>
          <ValueField
            value={sensitivity}
            onChange={setSensitivity}
            min={1}
            step={0.5}
            precision={2}
            aria-label={t('assets.assemble.sensitivity', 'Cut sensitivity')}
          />
        </div>
        <div className={styles.field}>
          <span className={styles.label}>{t('assets.assemble.dissolve', 'Dissolve on cuts (frames)')}</span>
          <ValueField
            value={dissolveFrames}
            onChange={(v) => setDissolveFrames(Math.max(0, Math.round(v)))}
            min={0}
            step={1}
            precision={0}
            aria-label={t('assets.assemble.dissolveAria', 'Dissolve on cuts, in frames')}
          />
        </div>
        <div className={styles.field}>
          <span className={styles.label}>{t('assets.assemble.minShot', 'Drop shots shorter than (frames)')}</span>
          <ValueField
            value={minShotFrames}
            onChange={(v) => setMinShotFrames(Math.max(0, Math.round(v)))}
            min={0}
            step={1}
            precision={0}
            aria-label={t('assets.assemble.minShotAria', 'Drop shots shorter than, in frames')}
          />
        </div>
        <p className={`${styles.hint} ${styles.fieldWide}`}>
          {t(
            'assets.assemble.hintSensitivity',
            'Higher sensitivity finds fewer cuts — it is a multiple of the local median frame difference, so 5 means “five times more different than this footage usually is”.',
          )}{' '}
          {minShotFrames > 0
            ? t(
              'assets.assemble.hintTimingUnder',
              'At {fps} fps a {dissolve}-frame dissolve is {dissolveSecs}s, and shots under {minShot} frames are under {minShotSecs}s.',
              {
                fps: fps.toFixed(2),
                dissolve: Math.max(0, Math.round(dissolveFrames)),
                dissolveSecs: secs(Math.max(0, Math.round(dissolveFrames))),
                minShot: Math.max(0, Math.round(minShotFrames)),
                minShotSecs: secs(Math.max(0, Math.round(minShotFrames))),
              },
            )
            : t(
              'assets.assemble.hintTimingKept',
              'At {fps} fps a {dissolve}-frame dissolve is {dissolveSecs}s, and shots under {minShot} frames are all kept.',
              {
                fps: fps.toFixed(2),
                dissolve: Math.max(0, Math.round(dissolveFrames)),
                dissolveSecs: secs(Math.max(0, Math.round(dissolveFrames))),
                minShot: Math.max(0, Math.round(minShotFrames)),
              },
            )}{' '}
          {t('assets.assemble.hintLast', 'The last remaining shot is never dropped.')}
        </p>
      </div>

      <div className={styles.footer}>
        <span className={styles.footerNote}>{t('assets.assemble.footerNote', 'Detection reads every frame of the clip')}</span>
        <Button variant="ghost" onClick={cancel}>
          {t('assets.assemble.cancel', 'Cancel')}
        </Button>
        <Button variant="primary" onClick={confirm}>
          {t('assets.assemble.assemble', 'Assemble')}
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
      title: t('assets.assemble.title', 'Assemble from Footage'),
      size: 'sm',
      onClose: () => finish(null),
      render: (close) => (
        <AssembleBody clipName={clipName} fps={fps > 0 ? fps : 30} close={close} onDone={finish} />
      ),
    });
  });
}
