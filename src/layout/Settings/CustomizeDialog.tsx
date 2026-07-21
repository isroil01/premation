/**
 * CustomizeDialog (Prompt E10) — workspace & UI customization in one place:
 *   • Shortcuts  — rebind / disable / reset command keys, with conflict warnings
 *   • Workspaces — apply a layout preset, save the current one, delete user ones
 *   • Appearance — accent colour + theme
 *   • AI         — connect your own OpenAI / Claude / Gemini account
 *
 * Shortcut rebinds persist via shortcutOverrides and re-apply through the
 * ShortcutManager; layout presets drive the layout store; accent overrides the
 * primary CSS token. Those all ride the existing SettingsManager — the AI tab
 * is the exception: API keys go to the OS keychain instead, because
 * SettingsManager is synchronous localStorage and secrets don't belong there.
 */

import { useState } from 'react';
import { cn } from '@utils/cn';
import { Button } from '@components/Button';
import { Input } from '@components/Input';
import { ColorPicker } from '@components/ColorPicker';
import { useLayoutStore } from '@stores/layoutStore';
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
import { usePreferenceStore } from '@stores/preferenceStore';
import type { KeyChord } from '@app-types/common';
// NOTE: AI setup is deliberately NOT here. Connecting an account is a
// once-per-machine errand that needs room to explain the options, so it lives
// on the Settings page (Dashboard → Settings → Assistant), not in a dialog
// you have to dismiss to get back to your work.
import styles from './CustomizeDialog.module.css';

type Tab = 'shortcuts' | 'tabs' | 'appearance';

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

  const uiScale = usePreferenceStore((s) => s.uiScale);
  const reduceMotion = usePreferenceStore((s) => s.editorReduceMotion);
  const confirmOnClose = usePreferenceStore((s) => s.confirmOnClose);
  const setPref = usePreferenceStore((s) => s.set);



  const leftSidebarPos = useLayoutStore((s) => s.leftSidebarPosition);
  const rightInspectorPos = useLayoutStore((s) => s.rightInspectorPosition);
  const timelinePos = useLayoutStore((s) => s.timelinePosition);

  const setLeftSidebarPos = useLayoutStore((s) => s.setLeftSidebarPosition);
  const setRightInspectorPos = useLayoutStore((s) => s.setRightInspectorPosition);
  const setTimelinePos = useLayoutStore((s) => s.setTimelinePosition);

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
        <span className={styles.rowLabel}>Left Sidebar Position</span>
        <div className={styles.rowRight}>
          <Button
            variant={leftSidebarPos === 'left' ? 'primary' : 'secondary'}
            size="sm"
            onClick={() => setLeftSidebarPos('left')}
          >
            Left
          </Button>
          <Button
            variant={leftSidebarPos === 'right' ? 'primary' : 'secondary'}
            size="sm"
            onClick={() => setLeftSidebarPos('right')}
          >
            Right
          </Button>
        </div>
      </div>

      <div className={styles.row}>
        <span className={styles.rowLabel}>Right Inspector Position</span>
        <div className={styles.rowRight}>
          <Button
            variant={rightInspectorPos === 'left' ? 'primary' : 'secondary'}
            size="sm"
            onClick={() => setRightInspectorPos('left')}
          >
            Left
          </Button>
          <Button
            variant={rightInspectorPos === 'right' ? 'primary' : 'secondary'}
            size="sm"
            onClick={() => setRightInspectorPos('right')}
          >
            Right
          </Button>
        </div>
      </div>

      <div className={styles.row}>
        <span className={styles.rowLabel}>Timeline Position</span>
        <div className={styles.rowRight}>
          <Button
            variant={timelinePos === 'bottom' ? 'primary' : 'secondary'}
            size="sm"
            onClick={() => setTimelinePos('bottom')}
          >
            Bottom
          </Button>
          <Button
            variant={timelinePos === 'top' ? 'primary' : 'secondary'}
            size="sm"
            onClick={() => setTimelinePos('top')}
          >
            Top
          </Button>
        </div>
      </div>

      <div className={styles.row}>
        <span className={styles.rowLabel}>UI Scale</span>
        <div className={styles.rowRight}>
          <input
            type="range"
            min={0.75}
            max={1.5}
            step={0.05}
            value={uiScale}
            onChange={(e) => setPref('uiScale', Number(e.target.value))}
            aria-label="UI scale"
          />
          <span style={{ minWidth: 42, textAlign: 'right' }}>{Math.round(uiScale * 100)}%</span>
          <Button variant="ghost" size="sm" onClick={() => setPref('uiScale', 1)} disabled={uiScale === 1}>
            Reset
          </Button>
        </div>
      </div>

      <div className={styles.row}>
        <span className={styles.rowLabel}>Reduce motion</span>
        <div className={styles.rowRight}>
          <input
            type="checkbox"
            checked={reduceMotion}
            onChange={(e) => setPref('editorReduceMotion', e.target.checked)}
            aria-label="Reduce UI motion (disables chrome transitions; playback unaffected)"
          />
        </div>
      </div>

      <div className={styles.row}>
        <span className={styles.rowLabel}>Confirm before discarding unsaved changes</span>
        <div className={styles.rowRight}>
          <input
            type="checkbox"
            checked={confirmOnClose}
            onChange={(e) => setPref('confirmOnClose', e.target.checked)}
            aria-label="Ask before New/Open/Close discards unsaved changes"
          />
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
  { id: 'tabs', label: 'Workspaces' },
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
      {tab === 'shortcuts' ? <ShortcutsTab />
        : tab === 'tabs' ? <WorkspacesTab />
        : <AppearanceTab />}
    </div>
  );
}

/** Open the Customize dialog. */
export function openCustomizeDialog(): void {
  openModal({ id: 'customize', title: 'Customize', size: 'lg', render: () => <Customize /> });
}
