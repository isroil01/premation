/**
 * PresetsBar (Prompt E8) — save the selected layer's animation as a named
 * preset, and manage (delete) saved presets. APPLYING presets lives in the
 * top-bar Animate menu (one home per action — no duplicate apply here).
 */

import { useState } from 'react';
import { Icon } from '@components/Icon';
import { Input } from '@components/Input';
import { Dropdown, type DropdownItem } from '@components/Dropdown';
import { useSelectionStore } from '@stores/selectionStore';
import { useSceneRevision, bumpScene } from '@stores/sceneStore';
import { useUIStore } from '@stores/uiStore';
import { listPresets, saveCurrentAsPreset, deletePreset } from '@core/animation/animationPresets';
import styles from './PresetsBar.module.css';

export function PresetsBar(): JSX.Element {
  const primary = useSelectionStore((s) => s.primary);
  useSceneRevision((s) => s.rev);
  const notify = useUIStore((s) => s.notify);
  const [saving, setSaving] = useState(false);
  const [name, setName] = useState('');

  // Only saved (user) presets are manageable here; built-ins live in the menu.
  const userPresets = listPresets().filter((p) => !p.builtin);

  const save = (): void => {
    if (!primary) return;
    const n = name.trim();
    if (!n) return;
    const ok = saveCurrentAsPreset(primary, n);
    notify(ok
      ? { level: 'success', message: `Saved preset “${n}”`, durationMs: 2000 }
      : { level: 'warning', message: 'Nothing animated on this layer to save', durationMs: 2600 });
    if (ok) { setName(''); setSaving(false); }
  };

  return (
    <div className={styles.root}>
      <span className={styles.trigger} style={{ opacity: 0.7, cursor: 'default' }}>
        <Icon name="sparkles" size={12} /> Save preset
      </span>
      {saving ? (
        <div className={styles.saveRow}>
          <Input value={name} placeholder="Preset name…" autoFocus onChange={(e) => setName(e.currentTarget.value)} />
          <button type="button" className={styles.saveBtn} onClick={save} disabled={!name.trim()}>Save</button>
          <button type="button" className={styles.cancelBtn} onClick={() => { setSaving(false); setName(''); }}>✕</button>
        </div>
      ) : (
        <button type="button" className={styles.saveTrigger} disabled={!primary} onClick={() => setSaving(true)}>
          <Icon name="plus" size={11} /> Save current
        </button>
      )}
      {userPresets.length > 0 ? (
        <Dropdown
          placement="left-start"
          trigger={<button type="button" className={styles.manageBtn} title="Manage saved presets">⋯</button>}
          items={userPresets.map((p): DropdownItem => ({
            type: 'item', id: `del:${p.name}`, label: `Delete “${p.name}”`, danger: true,
            onSelect: () => {
              // deletePreset only writes localStorage — bump the scene revision
              // (which this bar subscribes to) so the deleted preset disappears.
              deletePreset(p.name);
              notify({ level: 'success', message: `Deleted preset “${p.name}”`, durationMs: 1600 });
              bumpScene();
            },
          }))}
        />
      ) : null}
    </div>
  );
}

export default PresetsBar;
