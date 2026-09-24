/**
 * Pre-compose dialog — After Effects' Layer ▸ Pre-compose (Ctrl+Shift+C).
 *
 * The same four decisions AE asks for, in the same order: the new comp's name,
 * Leave vs Move all attributes, trim the new comp to the layers' span, and
 * whether to open it. "Leave" greys out with its reason when the selection
 * cannot be split that way (more than one layer, a text or shape layer), which
 * is how AE presents it. Choices are remembered for the session, as AE does.
 */

import { useMemo, useState } from 'react';
import { Button } from '@components/Button';
import { Input } from '@components/Input';
import { Checkbox } from '@components/Checkbox';
import { DialogFooter, useDialogPrimaryAction } from '@components/Modal';
import { openModal } from '@stores/modalStore';
import { useSelectionStore } from '@stores/selectionStore';
import { useUIStore } from '@stores/uiStore';
import { documentMirror } from '@stores/documentMirror';
import { useActiveMirrorComp } from '@hooks/useMirror';
import { defaultPrecompNameIn } from '@core/mirror/compNames';
import {
  leaveAttributesUnavailableReason,
  precomposeTargets,
  type PrecomposeMode,
} from '@core/composition/precompose';
import { precomposeEdit } from './compositionEdits';
import { cn } from '@utils/cn';
import styles from './PrecomposeDialog.module.css';

/** The last choices, reused next time within the session. */
const remembered: { mode: PrecomposeMode; adjustDuration: boolean; openNew: boolean } = {
  mode: 'move',
  adjustDuration: false,
  openNew: true,
};

function PrecomposeDialog({ ids, close }: { ids: string[]; close: () => void }): JSX.Element {
  // B4: names from the document mirror.
  const hostName = useActiveMirrorComp()?.settings.name ?? 'this composition';
  const leaveBlocked = useMemo(() => leaveAttributesUnavailableReason(ids), [ids]);
  const [name, setName] = useState(() => defaultPrecompNameIn(documentMirror()));
  const [mode, setMode] = useState<PrecomposeMode>(
    remembered.mode === 'leave' && !leaveBlocked ? 'leave' : 'move',
  );
  const [adjustDuration, setAdjustDuration] = useState(remembered.adjustDuration);
  const [openNew, setOpenNew] = useState(remembered.openNew);
  const [busy, setBusy] = useState(false);

  const layerName = ids.length === 1 ? documentMirror().layer(ids[0]!)?.name ?? 'the layer' : '';
  const count = ids.length;

  const submit = (): void => {
    if (busy) return;
    setBusy(true);
    Object.assign(remembered, { mode, adjustDuration, openNew });
    const notify = useUIStore.getState().notify;
    // One engine entry (`precompose`): undo restores the layers exactly. The
    // selection and "Open New Composition" are the dialog's (editor state).
    precomposeEdit(ids, {
      name: name.trim() || defaultPrecompNameIn(documentMirror()),
      mode,
      adjustDuration: mode === 'move' && adjustDuration,
      openNew,
    })
      .then((result) => {
        if ('error' in result) notify({ level: 'warning', message: `Pre-compose: ${result.error}`, durationMs: 5000 });
      })
      .catch((err: unknown) => {
        notify({ level: 'error', message: `Pre-compose failed: ${err instanceof Error ? err.message : String(err)}`, durationMs: 8000 });
      })
      .finally(close);
  };
  useDialogPrimaryAction(submit);

  return (
    <div className={styles.root}>
      <label className={styles.field}>
        <span className={styles.label}>New composition name</span>
        <Input
          value={name}
          onChange={(e) => setName(e.target.value)}
          aria-label="New composition name"
          autoFocus
          onFocus={(e) => e.currentTarget.select()}
        />
      </label>

      <fieldset className={styles.modes}>
        <legend className={styles.srOnly}>Attributes</legend>
        <label className={cn(styles.option, leaveBlocked && styles.optionDisabled)}>
          <input
            type="radio"
            name="precompose-mode"
            className={styles.radio}
            checked={mode === 'leave'}
            disabled={!!leaveBlocked}
            onChange={() => setMode('leave')}
          />
          <span className={styles.optionText}>
            <span className={styles.optionTitle}>Leave all attributes in “{hostName}”</span>
            <span className={styles.optionHint}>
              {leaveBlocked
                ?? `Only the content of “${layerName}” moves into the new composition, which is sized to it. Its transform, effects, masks and keyframes stay on the layer here.`}
            </span>
          </span>
        </label>
        <label className={styles.option}>
          <input
            type="radio"
            name="precompose-mode"
            className={styles.radio}
            checked={mode === 'move'}
            onChange={() => setMode('move')}
          />
          <span className={styles.optionText}>
            <span className={styles.optionTitle}>Move all attributes into the new composition</span>
            <span className={styles.optionHint}>
              {count === 1 ? 'The selected layer moves' : `The ${count} selected layers move`} into the new
              composition with everything on them. It is the same size as “{hostName}”, so nothing moves on screen.
            </span>
          </span>
        </label>
      </fieldset>

      <div className={styles.checks}>
        <Checkbox
          checked={mode === 'move' && adjustDuration}
          disabled={mode !== 'move'}
          onChange={(e) => setAdjustDuration(e.target.checked)}
          label="Adjust composition duration to the time span of the selected layers"
        />
        <Checkbox
          checked={openNew}
          onChange={(e) => setOpenNew(e.target.checked)}
          label="Open New Composition"
        />
      </div>

      <DialogFooter
        secondary={
          <Button variant="secondary" size="md" onClick={close}>
            Cancel
          </Button>
        }
        primary={
          <Button variant="primary" size="md" onClick={submit} disabled={busy}>
            OK
          </Button>
        }
      />
    </div>
  );
}

/** Open Pre-compose for `ids` (default: the selection). */
export function openPrecomposeDialog(ids: ReadonlyArray<string> = useSelectionStore.getState().ids): void {
  // A READ (which selected layers the pre-compose moves); the ratchet's verb
  // pattern flags `precompose…` names — see the B3 report's false positives.
  const targets = precomposeTargets(ids);
  if (targets.length === 0) {
    useUIStore.getState().notify({ level: 'info', message: 'Select the layers to pre-compose first.', durationMs: 4000 });
    return;
  }
  openModal({
    id: 'precompose',
    title: 'Pre-compose',
    render: (close) => <PrecomposeDialog ids={targets} close={close} />,
  });
}
