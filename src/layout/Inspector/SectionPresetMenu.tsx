/**
 * SectionPresetMenu — Save / Apply / Delete presets for one inspector section.
 *
 * In the Properties panel (inside a `SectionMenuSlot`, 2026-10-08) it draws
 * NOTHING: its rows go to the panel's ≡ menu as one submenu named for the
 * section — "Transform Presets ▸" — because a section header never holds a
 * button (see `sectionMenu.tsx`). "Save Current as Preset…" there asks for the
 * name in the app's prompt dialog. Anywhere else (the Text panel's head) it is
 * the small dropdown with an inline name field it always was.
 *
 * The section supplies two functions: `capture()` returns the values a
 * preset should hold, and `apply(values)` writes them back. The menu owns
 * nothing about what those values mean, which is what lets Transform, Text,
 * Appearance and Material share it without sharing a schema.
 */

import { useState } from 'react';
import { Dropdown, type DropdownItem } from '@components/Dropdown';
import { Icon } from '@components/Icon';
import { customPrompt } from '@components/Modal';
import { useSectionPresetStore, type PresetValues, type SectionPreset } from '@stores/sectionPresetStore';
import { useSectionMenuRows } from './sectionMenu';
import styles from './SectionPresetMenu.module.css';

export interface SectionPresetMenuProps {
  /** Preset namespace — `transform`, `text`, `appearance`, `material`. */
  sectionId: string;
  /** The values to save. */
  capture?: () => PresetValues;
  /** Apply a saved preset's values to the section's subject. */
  apply?: (values: PresetValues) => void;
  /**
   * What the presets are called ("Transform presets"): the trigger's
   * accessible name, and — in menu casing — the ≡ submenu's name.
   */
  label?: string;
}

const NO_PRESETS: ReadonlyArray<SectionPreset> = [];

/** "Transform presets" → "Transform Presets": a menu row, in After Effects' menu casing. */
export function presetMenuTitle(label: string): string {
  return label.replace(/(^|\s)([a-z])/g, (_m, space: string, c: string) => space + c.toUpperCase());
}

export function SectionPresetMenu({ sectionId, capture, apply, label }: SectionPresetMenuProps): JSX.Element | null {
  const presets = useSectionPresetStore((s) => s.presets[sectionId] ?? NO_PRESETS);
  const save = useSectionPresetStore((s) => s.save);
  const remove = useSectionPresetStore((s) => s.remove);
  const [naming, setNaming] = useState(false);
  const [name, setName] = useState('');

  const title = presetMenuTitle(label ?? `${sectionId} presets`);
  const fallbackName = `Preset ${presets.length + 1}`;

  const commitSave = (): void => {
    if (!capture) return;
    save(sectionId, name || fallbackName, capture());
    setName('');
    setNaming(false);
  };

  /** The ≡-menu Save: what is on screen when Save is chosen, named in a prompt. */
  const saveViaPrompt = (): void => {
    if (!capture) return;
    const values = capture();
    void customPrompt(
      `Save ${title.replace(/Presets$/, 'Preset')}`,
      'Name the preset. It is kept on this computer, for every project.',
      fallbackName,
      { placeholder: fallbackName, confirmLabel: 'Save' },
    ).then((picked) => {
      if (picked !== null) save(sectionId, picked.trim() || fallbackName, values);
    });
  };

  const rows = (onSave: () => void): DropdownItem[] => {
    const out: DropdownItem[] = [
      { type: 'item', id: 'save', label: 'Save Current as Preset…', icon: 'plus', disabled: !capture, onSelect: onSave },
    ];
    if (presets.length === 0) return out;
    out.push({ type: 'separator' }, { type: 'label', label: 'Apply' });
    for (const p of presets) {
      out.push({ type: 'item', id: `apply-${p.id}`, label: p.name, disabled: !apply, onSelect: () => apply?.(p.values) });
    }
    out.push({ type: 'separator' }, {
      type: 'item',
      id: 'delete',
      label: 'Delete Preset',
      icon: 'trash',
      danger: true,
      submenu: presets.map((p): DropdownItem => ({
        type: 'item',
        id: `delete-${p.id}`,
        label: p.name,
        danger: true,
        onSelect: () => remove(sectionId, p.id),
      })),
    });
    return out;
  };

  // Inside the Properties panel's slot the rows ARE the control.
  const inPanelMenu = useSectionMenuRows([
    { type: 'item', id: `presets-${sectionId}`, label: title, submenu: rows(saveViaPrompt) },
  ]);
  if (inPanelMenu) return null;

  return (
    <span className={styles.root}>
      {naming ? (
        <span className={styles.nameRow}>
          <input
            className={styles.nameInput}
            value={name}
            placeholder="Preset name"
            aria-label="Preset name"
            autoFocus
            onChange={(e) => setName(e.currentTarget.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') commitSave();
              if (e.key === 'Escape') setNaming(false);
            }}
          />
          <button type="button" className={styles.nameBtn} onClick={commitSave} aria-label="Save preset">
            <Icon name="check" size="sm" />
          </button>
          <button type="button" className={styles.nameBtn} onClick={() => setNaming(false)} aria-label="Cancel">
            <Icon name="close" size="sm" />
          </button>
        </span>
      ) : (
        <Dropdown
          placement="bottom-end"
          items={rows(() => setNaming(true))}
          trigger={
            <button type="button" className={styles.trigger} aria-label={label ?? 'Section presets'} title="Presets">
              <Icon name="sliders-h" size="sm" />
              <span className={styles.triggerText}>Presets</span>
              <Icon name="chevron-down" size="sm" />
            </button>
          }
        />
      )}
    </span>
  );
}

export default SectionPresetMenu;
