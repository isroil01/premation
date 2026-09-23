/**
 * Auto-Orient dialog — After Effects' Layer ▸ Transform ▸ Auto-Orient
 * (Ctrl/Cmd+Alt+O): Off, Orient Along Path, Orient Towards Camera.
 *
 * Writes through the engine (`setLayerSwitches{autoOrient}`, one undo entry),
 * as the inspector's dropdown (MotionControls) does, and offers each mode under the same rules the
 * dropdown uses: Along Path only where the renderer applies it (2D layers),
 * Towards Camera only on a 3D layer. A mode no selected layer can use is
 * disabled with its reason rather than silently doing nothing.
 */

import { useState } from 'react';
import { Button } from '@components/Button';
import { DialogFooter, useDialogPrimaryAction } from '@components/Modal';
import { openModal } from '@stores/modalStore';
import { useUIStore } from '@stores/uiStore';
import { useSelectionStore } from '@stores/selectionStore';
import defaultSceneGraph from '@core/scene/DefaultSceneGraph';
import { readAutoOrientMode, type AutoOrientMode } from '@core/scene/autoOrient';
import { cn } from '@utils/cn';
import { autoOrientModesFor, setAutoOrientEdit } from './compositionEdits';
import styles from './PrecomposeDialog.module.css';

export { autoOrientModesFor };

/** Layers in `ids` that auto-orient can act on at all. */
export function autoOrientTargets(ids: ReadonlyArray<string>): string[] {
  return ids.filter((id) => autoOrientModesFor(id).size > 0);
}

const MODES: ReadonlyArray<{ id: AutoOrientMode; title: string; hint: string; unavailable: string }> = [
  { id: 'off', title: 'Off', hint: 'The layer keeps its own rotation.', unavailable: '' },
  {
    id: 'path',
    title: 'Orient Along Path',
    hint: 'The layer rotates to face its direction of travel. Needs position keyframes.',
    unavailable: 'Applies to 2D layers only.',
  },
  {
    id: 'camera',
    title: 'Orient Towards Camera',
    hint: 'A 3D layer always faces the active camera.',
    unavailable: 'Needs a 3D layer.',
  },
];

function AutoOrientDialog({ ids, close }: { ids: string[]; close: () => void }): JSX.Element {
  const first = defaultSceneGraph.getNode(ids[0]!);
  const [mode, setMode] = useState<AutoOrientMode>(first ? readAutoOrientMode(first) : 'off');
  const available = (m: AutoOrientMode): boolean => ids.some((id) => autoOrientModesFor(id).has(m));

  const submit = (): void => {
    // One engine entry: `setLayerSwitches{autoOrient}` on each layer that can take the mode.
    void setAutoOrientEdit(ids, mode);
    close();
  };
  useDialogPrimaryAction(submit);

  return (
    <div className={styles.root}>
      <fieldset className={styles.modes}>
        <legend className={styles.srOnly}>Auto-Orientation</legend>
        {MODES.map((m) => {
          const ok = available(m.id);
          return (
            <label key={m.id} className={cn(styles.option, !ok && styles.optionDisabled)}>
              <input
                type="radio"
                name="auto-orient-mode"
                className={styles.radio}
                checked={mode === m.id}
                disabled={!ok}
                onChange={() => setMode(m.id)}
              />
              <span className={styles.optionText}>
                <span className={styles.optionTitle}>{m.title}</span>
                <span className={styles.optionHint}>{ok ? m.hint : m.unavailable}</span>
              </span>
            </label>
          );
        })}
      </fieldset>
      <DialogFooter
        secondary={<Button variant="secondary" size="md" onClick={close}>Cancel</Button>}
        primary={<Button variant="primary" size="md" onClick={submit}>OK</Button>}
      />
    </div>
  );
}

export function openAutoOrientDialog(ids: ReadonlyArray<string> = useSelectionStore.getState().ids): void {
  const targets = autoOrientTargets(ids);
  if (targets.length === 0) {
    useUIStore.getState().notify({
      level: 'info',
      message: 'Auto-Orient applies to visible layers — not cameras, lights, nulls, groups or audio.',
      durationMs: 4000,
    });
    return;
  }
  openModal({
    id: 'auto-orient',
    title: 'Auto-Orientation',
    render: (close) => <AutoOrientDialog ids={targets} close={close} />,
  });
}

export { AutoOrientDialog };
