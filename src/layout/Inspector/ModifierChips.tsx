/**
 * ModifierChips — a property's modifier stack as an ordered row of chips ON
 * THE PROPERTY ROW, where the property is.
 *
 * The Modifiers section lists the same stack as a numbered pipeline with a
 * property picker on top. That is the right surface for reading what a stack
 * adds up to; it is the wrong one for glancing at Position and seeing that a
 * wiggle and a clamp are on it. Chips answer the glance. Drag a chip to
 * reorder (order changes the number), click one to edit its parameters in a
 * popover, × to remove, + to add. Every change is ONE engine batch — the
 * `layer/modifiers` record + the recompiled expression (modifierEdits.ts) — and
 * a parameter scrub is one gesture: one undo entry per change.
 */

import { useState } from 'react';
import { Popover } from '@components/Popover';
import { Dropdown, type DropdownItem } from '@components/Dropdown';
import { Icon } from '@components/Icon';
import { cn } from '@utils/cn';
import defaultSceneGraph from '@core/scene/DefaultSceneGraph';
import {
  MODIFIER_KINDS,
  MODIFIER_LABELS,
  defaultModifier,
  describeModifier,
  moveModifier,
  readModifierStack,
  removeModifier,
  type Modifier,
  type ModifierKind,
} from '@core/animation/modifierStack';
import { modifierCompileError } from '@core/animation/modifierCompile';
import { ModifierParams } from './ModifierStackSection';
import { useEngineEdit } from './useEngineEdit';
import { modifierStackCommands } from './modifierEdits';
import styles from './ModifierChips.module.css';

export interface ModifierChipsProps {
  nodeId: string;
  prop: string;
  /** Draw the "+" even when the property has no stack yet. */
  showAdd?: boolean;
  className?: string;
}

/** The "+" menu: one entry per modifier kind. */
export function AddModifierMenu({ onAdd, label }: { onAdd: (kind: ModifierKind) => void; label?: string }): JSX.Element {
  const items: DropdownItem[] = MODIFIER_KINDS.map((k) => ({
    type: 'item',
    id: k,
    label: MODIFIER_LABELS[k],
    onSelect: () => onAdd(k),
  }));
  return (
    <Dropdown
      items={items}
      placement="bottom-start"
      trigger={
        <button type="button" className={styles.add} aria-label={label ?? 'Add modifier'} title="Add modifier">
          <Icon name="plus" size="sm" />
        </button>
      }
    />
  );
}

export function ModifierChips({ nodeId, prop, showAdd = false, className }: ModifierChipsProps): JSX.Element | null {
  const [open, setOpen] = useState<string | null>(null);
  const [dragFrom, setDragFrom] = useState<number | null>(null);
  const eng = useEngineEdit();
  const node = defaultSceneGraph.getNode(nodeId);
  const stack = node ? readModifierStack(node, prop) : null;
  const modifiers: readonly Modifier[] = stack?.modifiers ?? [];

  if (!node) return null;
  if (modifiers.length === 0 && !showAdd) return null;

  // The last chip removed removes the stack (its previous expression comes back).
  const commit = (next: Modifier[], label = 'Edit Modifier Stack'): void => {
    eng.send(label, modifierStackCommands(nodeId, prop, next.length === 0 ? null : next));
    if (next.length === 0) setOpen(null);
  };
  const scrub = eng.scrub('Edit Modifier Stack');

  const error = modifierCompileError(modifiers);

  return (
    <div className={cn(styles.root, className)} role="list" aria-label={`${prop} modifiers`}>
      {modifiers.map((m, i) => {
        const label = MODIFIER_LABELS[m.kind];
        return (
          <Popover
            key={m.id}
            open={open === m.id}
            onOpenChange={(v) => setOpen(v ? m.id : null)}
            placement="bottom-start"
            trigger={
              <span
                role="listitem"
                className={cn(styles.chip, !m.enabled && styles.chipOff, dragFrom === i && styles.chipDragging)}
                draggable
                onDragStart={() => setDragFrom(i)}
                onDragOver={(e) => e.preventDefault()}
                onDrop={() => {
                  if (dragFrom !== null && dragFrom !== i) commit(moveModifier(modifiers, dragFrom, i), 'Reorder Modifier');
                  setDragFrom(null);
                }}
                onDragEnd={() => setDragFrom(null)}
                title={`${label} — ${describeModifier(m)}. Click to edit, drag to reorder.`}
              >
                <button
                  type="button"
                  className={styles.chipBody}
                  aria-label={`Edit ${label} modifier`}
                  onClick={() => setOpen(open === m.id ? null : m.id)}
                >
                  <span className={styles.chipKind}>{label}</span>
                  <span className={styles.chipSummary}>{describeModifier(m)}</span>
                </button>
                <button
                  type="button"
                  className={styles.chipRemove}
                  aria-label={`Remove ${label} modifier`}
                  onClick={(e) => {
                    e.stopPropagation();
                    commit(removeModifier(modifiers, m.id), 'Remove Modifier');
                  }}
                >
                  <Icon name="close" size="sm" />
                </button>
              </span>
            }
          >
            <div className={styles.editor}>
              <div className={styles.editorHead}>
                <span className={styles.editorTitle}>{label}</span>
                <label className={styles.editorToggle}>
                  <input
                    type="checkbox"
                    checked={m.enabled}
                    aria-label={`Enable ${label}`}
                    onChange={(e) => commit(modifiers.map((x) => (x.id === m.id ? { ...x, enabled: e.target.checked } : x)))}
                  />
                  On
                </label>
              </div>
              <ModifierParams modifier={m} list={modifiers} onPatch={commit} scrub={scrub} />
            </div>
          </Popover>
        );
      })}
      <AddModifierMenu onAdd={(kind) => commit([...modifiers, defaultModifier(kind)], 'Add Modifier')} label={`Add modifier to ${prop}`} />
      {error && <span className={styles.error} title={error}><Icon name="warning" size="sm" /></span>}
    </div>
  );
}

export default ModifierChips;
