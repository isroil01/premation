/**
 * SelectionAlignRow — align and distribute as ONE compact row at the top of
 * the Properties panel, shown whenever two or more layers are selected.
 *
 * Align otherwise lives only in its own dock panel, which nobody opens for a
 * two-click job. Selecting several layers is exactly the moment you want it,
 * so the inspector offers it then, and only then.
 *
 * Same `alignNodes` / `distributeMinimum` as `AlignPanel`, so the maths, the
 * enablement rule and the undo entry are shared. The "relative to" choice is a
 * single toggle at the end of the row rather than a segmented control, which
 * keeps the whole thing one line at the panel's narrowest width; the full
 * distribute-by-edge set stays in the Align panel.
 */

import { useState } from 'react';
import { useCompositionStore } from '@stores/compositionStore';
import { distributeMinimum, type AlignMode } from '@core/scene/alignNodes';
import { alignLayers } from './inspectorEdits';
import { Icon, type IconName } from '@components/Icon';
import { IconButton } from '@components/IconButton';
import styles from './SelectionAlignRow.module.css';

const ALIGN: ReadonlyArray<{ id: AlignMode; icon: IconName; label: string }> = [
  { id: 'left', icon: 'align-left', label: 'Align left' },
  { id: 'center-h', icon: 'align-center', label: 'Align horizontal centers' },
  { id: 'right', icon: 'align-right', label: 'Align right' },
  { id: 'top', icon: 'align-top', label: 'Align top' },
  { id: 'middle-v', icon: 'align-middle', label: 'Align vertical centers' },
  { id: 'bottom', icon: 'align-bottom', label: 'Align bottom' },
];

const DISTRIBUTE: ReadonlyArray<{ id: AlignMode; icon: IconName; label: string }> = [
  { id: 'distribute-space-h', icon: 'distribute-horizontal', label: 'Distribute horizontal spacing' },
  { id: 'distribute-space-v', icon: 'distribute-vertical', label: 'Distribute vertical spacing' },
];

export function SelectionAlignRow({ nodeIds = [] }: { nodeIds?: ReadonlyArray<string> }): JSX.Element | null {
  const [alignTo, setAlignTo] = useState<'selection' | 'composition'>('selection');
  const compWidth = useCompositionStore((s) => s.width);
  const compHeight = useCompositionStore((s) => s.height);
  if (nodeIds.length < 2) return null;

  const count = nodeIds.length;
  const button = (a: { id: AlignMode; icon: IconName; label: string }, min: number): JSX.Element => {
    const disabled = count < min;
    return (
      <IconButton
        key={a.id}
        size="sm"
        aria-label={a.label}
        tooltip={disabled ? `${a.label} — select ${min}+ layers` : a.label}
        disabled={disabled}
        onClick={() => alignLayers(nodeIds, a.id, alignTo, compWidth, compHeight)}
      >
        <Icon name={a.icon} size="sm" />
      </IconButton>
    );
  };

  const toComp = alignTo === 'composition';
  return (
    <div className={styles.row} role="toolbar" aria-label="Align selected layers">
      {ALIGN.map((a) => button(a, toComp ? 1 : 2))}
      <span className={styles.divider} aria-hidden="true" />
      {/* B3-legacy: not a write — `distributeMinimum` is a pure count the ratchet's verb match flags (rule false positive). */}
      {DISTRIBUTE.map((a) => button(a, distributeMinimum(alignTo)))}
      <span className={styles.divider} aria-hidden="true" />
      <IconButton
        size="sm"
        active={toComp}
        aria-pressed={toComp}
        aria-label="Align to composition"
        tooltip={toComp ? 'Aligning to the composition frame' : 'Aligning to the selection — click to align to the composition'}
        onClick={() => setAlignTo(toComp ? 'selection' : 'composition')}
      >
        <Icon name={toComp ? 'solid' : 'select-all'} size="sm" />
      </IconButton>
    </div>
  );
}

export default SelectionAlignRow;
