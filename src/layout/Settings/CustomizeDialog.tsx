/**
 * CustomizeDialog (Prompt E10) — workspace & UI customization in one place:
 *   • Shortcuts  — rebind / disable / reset command keys, with conflict warnings
 *   • Workspaces — apply a layout preset, save the current one, delete user ones
 *   • Appearance — accent colour + theme
 *
 * Shortcut rebinds persist via shortcutOverrides and re-apply through the
 * ShortcutManager; layout presets drive the layout store; accent overrides the
 * primary CSS token. All persistence rides the existing SettingsManager.
 */

import { useState } from 'react';
import { cn } from '@utils/cn';
import { Button } from '@components/Button';
import { Input } from '@components/Input';
import { ColorPicker } from '@components/ColorPicker';
import { openModal } from '@stores/modalStore';
import { getCommandRegistry } from '@core/commands/Command';
import { getShortcutManager } from '@core/commands/ShortcutManager';
import { chordFromEvent } from '@core/commands/CommandSystem';
import { formatChord } from '@layout/Menu/formatChord';
import {
  getShortcutOverrides,
  setShortcutOverride,
  clearShortcutOverride,
  clearAllShortcutOverrides,
  resolveChord,
  findChordConflict,
} from '@core/commands/shortcutOverrides';
import {
  listLayouts,
  applyLayout,
  saveCurrentLayout,
  deleteLayout,
} from '@core/layout/workspaceLayouts';
import { getThemeManager } from '@core/services/coreServices';
import { getAccentColor, setAccentColor } from '@core/theme/accent';
import { useRenderBackendStore } from '@stores/renderBackendStore';
import type { BackendChoice } from '@core/rendering/createRenderBackend';
import type { KeyChord } from '@app-types/common';
import styles from './CustomizeDialog.module.css';

type Tab = 'shortcuts' | 'workspaces' | 'appearance';

/** Modifier-only keydowns aren't a chord — keep listening until a real key. */
function isModifierKey(key: string): boolean {
  return key === 'Shift' || key === 'Control' || key === 'Alt' || key === 'Meta';
}

interface Row {
  id: string;
  label: string;
  chord: KeyChord | undefined;
  overridden: boolean;
}

function ShortcutsTab(): JSX.Element {
  const [, force] = useState(0);
  const [recording, setRecording] = useState<string | null>(null);
  const [conflict, setConflict] = useState<{ id: string; withId: string } | null>(null);

  const overrides = getShortcutOverrides();
  const commands = getCommandRegistry().all();
  const rows: Row[] = commands
    .map((c) => ({
      id: c.id as unknown as string,
      label: c.label,
      chord: resolveChord(c.id as unknown as string, c.shortcut, overrides),
      overridden: (c.id as unknown as string) in overrides,
    }))
    // Only commands that have (or had) a binding — the meaningful set to edit.
    .filter((r) => r.chord || r.overridden || commands.find((c) => (c.id as unknown as string) === r.id)?.shortcut);
  const resolved = rows.map((r) => ({ commandId: r.id, chord: r.chord }));

  const beginRecord = (id: string): void => {
    setConflict(null);
    setRecording(id);
    const onKey = (e: KeyboardEvent): void => {
      e.preventDefault();
      e.stopPropagation();
      if (isModifierKey(e.key)) return; // wait for the non-modifier key
      window.removeEventListener('keydown', onKey, true);
      setRecording(null);
      if (e.key === 'Escape') return; // cancel
      const chord = chordFromEvent(e);
      const clash = findChordConflict(chord, id, resolved);
      if (clash) {
        setConflict({ id, withId: clash });
        return;
      }
      setShortcutOverride(id, chord);
      getShortcutManager().applyOverrides();
      force((n) => n + 1);
    };
    window.addEventListener('keydown', onKey, true);
  };

  const disable = (id: string): void => {
    setShortcutOverride(id, null);
    getShortcutManager().applyOverrides();
    force((n) => n + 1);
  };
  const reset = (id: string): void => {
    clearShortcutOverride(id);
    getShortcutManager().applyOverrides();
    force((n) => n + 1);
  };
  const resetAll = (): void => {
    clearAllShortcutOverrides();
    getShortcutManager().applyOverrides();
    setConflict(null);
    force((n) => n + 1);
  };

  const labelFor = (id: string): string =>
    getCommandRegistry().all().find((c) => (c.id as unknown as string) === id)?.label ?? id;

  return (
    <div className={styles.tabBody}>
      <div className={styles.toolbar}>
        <span className={styles.hint}>Click a shortcut, then press the new keys. Esc cancels.</span>
        <Button variant="ghost" size="sm" onClick={resetAll}>Reset all</Button>
      </div>
      <div className={styles.list}>
        {rows.map((r) => (
          <div key={r.id} className={styles.row}>
            <span className={styles.rowLabel}>{r.label}</span>
            <div className={styles.rowRight}>
              {conflict?.id === r.id ? (
                <span className={styles.conflict}>Used by “{labelFor(conflict.withId)}”</span>
              ) : null}
              <button
                type="button"
                className={cn(styles.chip, recording === r.id && styles.chipRecording, r.overridden && styles.chipOn)}
                onClick={() => beginRecord(r.id)}
              >
                {recording === r.id ? 'Press keys…' : r.chord ? formatChord(r.chord) : 'Disabled'}
              </button>
              <button type="button" className={styles.miniBtn} title="Disable" onClick={() => disable(r.id)}>✕</button>
              {r.overridden ? (
                <button type="button" className={styles.miniBtn} title="Reset to default" onClick={() => reset(r.id)}>↺</button>
              ) : null}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function WorkspacesTab(): JSX.Element {
  const [, force] = useState(0);
  const [name, setName] = useState('');
  const layouts = listLayouts();

  const apply = (n: string): void => { applyLayout(n); };
  const save = (): void => {
    const n = name.trim();
    if (!n) return;
    saveCurrentLayout(n);
    setName('');
    force((v) => v + 1);
  };
  const remove = (n: string): void => { deleteLayout(n); force((v) => v + 1); };

  return (
    <div className={styles.tabBody}>
      <div className={styles.list}>
        {layouts.map((l) => (
          <div key={l.name} className={styles.row}>
            <span className={styles.rowLabel}>
              {l.name}{l.builtin ? <span className={styles.badge}>preset</span> : null}
            </span>
            <div className={styles.rowRight}>
              <Button variant="secondary" size="sm" onClick={() => apply(l.name)}>Apply</Button>
              {!l.builtin ? (
                <button type="button" className={styles.miniBtn} title="Delete" onClick={() => remove(l.name)}>✕</button>
              ) : null}
            </div>
          </div>
        ))}
      </div>
      <div className={styles.saveRow}>
        <Input value={name} placeholder="Save current layout as…" onChange={(e) => setName(e.currentTarget.value)} />
        <Button variant="primary" size="sm" onClick={save} disabled={!name.trim()}>Save</Button>
      </div>
    </div>
  );
}

function AppearanceTab(): JSX.Element {
  const [accent, setAccent] = useState<string>(() => getAccentColor());
  const applyAccent = (c: string): void => { setAccent(c); setAccentColor(c); };

  const backend = useRenderBackendStore((s) => s.choice);
  const setBackend = useRenderBackendStore((s) => s.setChoice);

  // Check if WebGPU is supported in the current browser/environment
  const webgpuSupported = typeof navigator !== 'undefined' && 'gpu' in navigator;

  return (
    <div className={styles.tabBody}>
      <div className={styles.row}>
        <span className={styles.rowLabel}>Accent color</span>
        <div className={styles.rowRight}>
          <ColorPicker value={accent || '#2b7eff'} onChange={applyAccent} aria-label="Accent color" />
          <Button variant="ghost" size="sm" onClick={() => applyAccent('')} disabled={!accent}>Reset</Button>
        </div>
      </div>
      <div className={styles.row}>
        <span className={styles.rowLabel}>Theme</span>
        <div className={styles.rowRight}>
          <Button variant="secondary" size="sm" onClick={() => getThemeManager().toggle()}>Switch light / dark</Button>
        </div>
      </div>
      <div className={styles.row}>
        <span className={styles.rowLabel}>Render Backend</span>
        <div className={styles.rowRight}>
          <select
            className={styles.select}
            value={backend}
            onChange={(e) => setBackend(e.target.value as BackendChoice)}
            aria-label="Render Backend"
          >
            <option value="canvas2d">Reference CPU (Canvas2D)</option>
            <option value="webgl2">Experimental GPU (WebGL2)</option>
            <option value="webgpu" disabled={!webgpuSupported}>
              Experimental GPU (WebGPU){!webgpuSupported ? ' (Unsupported)' : ''}
            </option>
          </select>
        </div>
      </div>
      <p className={styles.hint}>
        The accent tints buttons, selection and the playhead. Empty follows the theme.
        <br />
        <span style={{ color: 'var(--color-text-tertiary)', display: 'block', marginTop: 'var(--space-2)' }}>
          Note: GPU backends are experimental. Complex blend modes, masking, and adjustment layers are currently bypassed on the GPU path.
        </span>
      </p>
    </div>
  );
}

const TABS: ReadonlyArray<{ id: Tab; label: string }> = [
  { id: 'shortcuts', label: 'Shortcuts' },
  { id: 'workspaces', label: 'Workspaces' },
  { id: 'appearance', label: 'Appearance' },
];

function Customize(): JSX.Element {
  const [tab, setTab] = useState<Tab>('shortcuts');
  return (
    <div className={styles.root}>
      <div className={styles.tabs} role="tablist">
        {TABS.map((t) => (
          <button
            key={t.id}
            type="button"
            role="tab"
            aria-selected={tab === t.id}
            className={cn(styles.tab, tab === t.id && styles.tabOn)}
            onClick={() => setTab(t.id)}
          >
            {t.label}
          </button>
        ))}
      </div>
      {tab === 'shortcuts' ? <ShortcutsTab /> : tab === 'workspaces' ? <WorkspacesTab /> : <AppearanceTab />}
    </div>
  );
}

/** Open the Customize dialog. */
export function openCustomizeDialog(): void {
  openModal({ id: 'customize', title: 'Customize', size: 'lg', render: () => <Customize /> });
}
