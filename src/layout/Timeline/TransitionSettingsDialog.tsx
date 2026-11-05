/**
 * Transition Settings — a cut transition's parameters in one place
 * (2026-10-07): its kind (the four, or any Transition effect as a wipe), length,
 * alignment, a wipe's direction and softness, a dip's colour, and the ease of
 * the ramp. Opened from the cut's right-click menu and by double-clicking its
 * bracket. Apply is ONE `setTransition` (one undo entry); a refusal — the
 * handles cannot pay for a longer overlap — is shown in the dialog.
 */

import { useRef, useState } from 'react';
import type { TransitionEase } from '@motion/engine-api';
import { Button } from '@components/Button';
import { useDialogPrimaryAction } from '@components/Modal';
import { ValueField } from '@components/ValueField';
import { openModal } from '@stores/modalStore';
import { documentMirror } from '@stores/documentMirror';
import { compFps } from '@hooks/useMirror';
import { flicksToSeconds } from '@motion/engine-api';
import { DEFAULT_DIP_COLOR, TRANSITION_KINDS, TRANSITION_LABEL, type TransitionAlignment, type TransitionKind } from '@core/timeline/transitionModel';
import { TRANSITION_ALIGNMENTS, TRANSITION_ALIGNMENT_LABEL } from './transitionOverlay';
import { setTransitionEdit } from './transitionEdits';
import { cutTransitionEffect, cutTransitionEffects } from './cutTransitionEffects';
import { t } from '@core/i18n';
import styles from './TransitionSettingsDialog.module.css';

export const TRANSITION_EASE_LABEL: Readonly<Record<TransitionEase, string>> = {
  // Getters: `t()` must run when the picker renders, not at import (the catalogue loads later).
  get linear() { return t('timeline.transitionSettings.easeLinear', 'Linear'); },
  get easeInOut() { return t('timeline.transitionSettings.easeInOut', 'Ease In & Out'); },
  get easeIn() { return t('timeline.transitionSettings.easeIn', 'Ease In'); },
  get easeOut() { return t('timeline.transitionSettings.easeOut', 'Ease Out'); },
};

/** The type picker's value: a kind, or `wipe:<effect>` for an effect wipe. */
function typeValue(kind: TransitionKind, effect: string | undefined): string {
  return kind === 'wipe' && effect ? `wipe:${effect}` : kind;
}

interface BodyProps {
  id: string;
  leftNodeId: string;
  close: () => void;
}

function TransitionSettingsBody({ id, leftNodeId, close }: BodyProps): JSX.Element {
  const m = documentMirror();
  const compId = m.layer(leftNodeId)?.comp ?? '';
  const comp = m.comp(compId);
  const tx = comp?.transitions.find((x) => x.id === id);
  const fps = compFps(comp);
  const [type, setType] = useState(() => (tx ? typeValue(tx.kind, tx.effect) : 'crossDissolve'));
  const [frames, setFrames] = useState(() => (tx ? Math.max(1, Math.round(flicksToSeconds(tx.duration) * fps)) : 12));
  const [alignment, setAlignment] = useState<TransitionAlignment>(() => tx?.alignment ?? 'centred');
  const [angle, setAngle] = useState(() => tx?.angle ?? 90);
  const [softness, setSoftness] = useState(() => tx?.softness ?? 0);
  const [color, setColor] = useState(() => tx?.color ?? DEFAULT_DIP_COLOR);
  const [ease, setEase] = useState<TransitionEase>(() => tx?.ease ?? 'linear');
  const [error, setError] = useState<string | null>(null);
  // Enter runs what Apply runs; while the transition is gone, it closes.
  const applyRef = useRef<() => void>(close);
  useDialogPrimaryAction(() => applyRef.current());

  if (!tx) {
    return (
      <div className={styles.body}>
        <p className={styles.note}>{t('timeline.transitionSettings.gone', 'This transition no longer exists.')}</p>
        <div className={styles.footer}>
          <Button variant="primary" onClick={close}>{t('timeline.transitionSettings.close', 'Close')}</Button>
        </div>
      </div>
    );
  }

  const kind = (type.startsWith('wipe') ? 'wipe' : type) as TransitionKind;
  const effect = type.startsWith('wipe:') ? type.slice(5) : '';
  const fx = cutTransitionEffect(effect);
  const showAngle = kind === 'wipe' && (effect === '' || !!fx?.hasAngle);
  const showSoftness = kind === 'wipe' && (effect === '' || !!fx?.hasSoftness);

  const apply = (): void => {
    void setTransitionEdit(leftNodeId, id, {
      kind,
      durationFrames: frames,
      alignment,
      ease,
      ...(kind === 'wipe' ? { effect } : {}),
      ...(showAngle ? { angle } : {}),
      ...(showSoftness ? { softness } : {}),
      ...(kind === 'dipToWhite' ? { color } : {}),
    }).then((res) => {
      if (res.ok) close();
      else setError(res.reason);
    });
  };
  applyRef.current = apply;

  return (
    <div className={styles.body}>
      <div className={styles.row}>
        <label className={styles.label} htmlFor="tx-type">{t('timeline.transitionSettings.type', 'Type')}</label>
        <select id="tx-type" className={styles.select} value={type} onChange={(e) => setType(e.target.value)}>
          {TRANSITION_KINDS.map((k) => (
            <option key={k} value={k}>{k === 'dipToWhite' ? t('timeline.transitionSettings.dipToColour', 'Dip to Colour') : TRANSITION_LABEL[k]}</option>
          ))}
          <optgroup label={t('timeline.transitionSettings.effectWipes', 'Effect wipes')}>
            {cutTransitionEffects().map((e) => (
              <option key={e.type} value={`wipe:${e.type}`}>{e.label}</option>
            ))}
          </optgroup>
        </select>
      </div>
      <div className={styles.row}>
        <span className={styles.label}>{t('timeline.transitionSettings.duration', 'Duration')}</span>
        <ValueField value={frames} onChange={(v) => setFrames(Math.max(1, Math.round(v)))} min={1} step={1} precision={0} unit="f" aria-label={t('timeline.transitionSettings.durationAria', 'Duration in frames')} />
      </div>
      <div className={styles.row}>
        <label className={styles.label} htmlFor="tx-align">{t('timeline.transitionSettings.alignment', 'Alignment')}</label>
        <select id="tx-align" className={styles.select} value={alignment} onChange={(e) => setAlignment(e.target.value as TransitionAlignment)}>
          {TRANSITION_ALIGNMENTS.map((a) => <option key={a} value={a}>{TRANSITION_ALIGNMENT_LABEL[a]}</option>)}
        </select>
      </div>
      {showAngle && (
        <div className={styles.row}>
          <span className={styles.label}>{t('timeline.transitionSettings.direction', 'Direction')}</span>
          <ValueField value={angle} onChange={setAngle} step={1} precision={0} unit="°" aria-label={t('timeline.transitionSettings.directionAria', 'Wipe direction')} />
        </div>
      )}
      {showSoftness && (
        <div className={styles.row}>
          <span className={styles.label}>{t('timeline.transitionSettings.softness', 'Softness')}</span>
          <ValueField value={softness} onChange={(v) => setSoftness(Math.max(0, v))} min={0} step={1} precision={0} unit="px" aria-label={t('timeline.transitionSettings.softnessAria', 'Edge softness')} />
        </div>
      )}
      {kind === 'dipToWhite' && (
        <div className={styles.row}>
          <label className={styles.label} htmlFor="tx-color">{t('timeline.transitionSettings.colour', 'Colour')}</label>
          <input id="tx-color" type="color" className={styles.color} value={color} onChange={(e) => setColor(e.target.value)} />
        </div>
      )}
      <div className={styles.row}>
        <label className={styles.label} htmlFor="tx-ease">{t('timeline.transitionSettings.ease', 'Ease')}</label>
        <select id="tx-ease" className={styles.select} value={ease} onChange={(e) => setEase(e.target.value as TransitionEase)}>
          {(Object.keys(TRANSITION_EASE_LABEL) as TransitionEase[]).map((k) => <option key={k} value={k}>{TRANSITION_EASE_LABEL[k]}</option>)}
        </select>
      </div>
      {error && <p className={styles.error} role="alert">{error}</p>}
      <div className={styles.footer}>
        <Button variant="ghost" onClick={close}>{t('timeline.transitionSettings.cancel', 'Cancel')}</Button>
        <Button variant="primary" onClick={apply}>{t('timeline.transitionSettings.apply', 'Apply')}</Button>
      </div>
    </div>
  );
}

/** Open Transition Settings for transition `id` (on the cut whose left layer is `leftNodeId`). */
export function openTransitionSettings(id: string, leftNodeId: string): void {
  openModal({
    id: 'transition-settings',
    title: t('timeline.transitionSettings.title', 'Transition Settings'),
    size: 'sm',
    // Floating: the timeline and viewer stay live behind it.
    variant: 'floating',
    render: (close) => <TransitionSettingsBody id={id} leftNodeId={leftNodeId} close={close} />,
  });
}
