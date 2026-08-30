/**
 * CustomizeDialog (Prompt E10) — workspace & UI customization in one place:
 *   • Shortcuts — rebind / disable / reset command keys, with conflict warnings
 *   • Workspaces — apply a layout preset, save the current one, delete user ones
 *   • Appearance — accent colour + theme
 *
 * There is deliberately no AI tab — see the note above the import list, and the
 * assistant's own error copy, which sends people to Dashboard → Settings →
 * Assistant. This docstring used to advertise one, which is why messages
 * elsewhere in the app told users to look for it here.
 *
 * Shortcut rebinds persist via shortcutOverrides and re-apply through the
 * ShortcutManager; layout presets drive the layout store; accent overrides the
 * primary CSS token. Those all ride the existing SettingsManager.
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
import { getWorkspaceManager } from '@core/layout/workspaceManager';
import { getThemeManager } from '@core/services/coreServices';
import { activeViewportDiskCache } from '@core/rendering/frameDiskCache';
import { viewportFrameCache } from '@core/rendering/frameCache';
import { getAccentColor, setAccentColor } from '@core/theme/accent';
import { usePreferenceStore } from '@stores/preferenceStore';
import type { KeyChord } from '@app-types/common';
// AI setup DOES live here, on the tab below, in the editions that have it. The
// note that used to sit on this import said the opposite — "deliberately NOT
// here, it lives on Dashboard → Settings" — and had outlived its own decision by
// a commit: the dashboard is a server-edition route, so that arrangement left
// the OSS build with nowhere to enter a key at all.
import { AiSettingsSection } from './AiSettingsSection';
import { UpdatesControl } from './UpdatesControl';
import { ObjectMatteControl } from './ObjectMatteControl';
import { aiEnabled } from '@core/config/edition';
import styles from './CustomizeDialog.module.css';

type Tab = 'shortcuts' | 'tabs' | 'appearance' | 'ai';

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

/**
 * Reads the SAME workspace list as the TopNav Workspaces dropdown.
 *
 * It used to read `core/layout/workspaceLayouts` — a second, parallel system
 * with its own four presets and its own settings key. A layout saved here never
 * appeared in the toolbar dropdown and vice versa, and both shipped a preset
 * called "Default". That module is gone; anything saved under its key is
 * migrated in by `migrateLegacyLayouts`.
 */
function WorkspacesTab(): JSX.Element {
  const [, force] = useState(0);
  const [name, setName] = useState('');
  const manager = getWorkspaceManager();
  const layouts = manager.listWorkspaces();

  const save = (): void => {
    const n = name.trim();
    if (!n) return;
    manager.saveCurrentWorkspace(n);
    setName('');
    force((v) => v + 1);
  };
  const remove = (id: string): void => { manager.deleteWorkspace(id); force((v) => v + 1); };

  return (
    <div className={styles.tabBody}>
      <div className={styles.list}>
        {layouts.map((l) => (
          <div key={l.id} className={styles.row}>
            <span className={styles.rowLabel}>
              {l.name}{l.builtin ? <span className={styles.badge}>preset</span> : null}
            </span>
            <div className={styles.rowRight}>
              <Button variant="secondary" size="sm" onClick={() => manager.applyWorkspace(l.id)}>Apply</Button>
              {!l.builtin ? (
                <button type="button" className={styles.miniBtn} title="Delete" onClick={() => remove(l.id)}>✕</button>
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

/** The accent the active theme is currently painting with, read from the token. */
function themeAccentColor(): string {
  if (typeof window === 'undefined') return '#2988ff';
  const v = getComputedStyle(document.documentElement)
    .getPropertyValue('--color-primary')
    .trim();
  return v || '#2988ff';
}

function AppearanceTab(): JSX.Element {
  const [accent, setAccent] = useState<string>(() => getAccentColor());
  const applyAccent = (c: string): void => { setAccent(c); setAccentColor(c); };

  const uiScale = usePreferenceStore((s) => s.uiScale ?? 1);
  const buttonSize = usePreferenceStore((s) => s.buttonSize ?? 'md');
  const iconSize = usePreferenceStore((s) => s.iconSize ?? 'md');
  const sidebarDensity = usePreferenceStore((s) => s.sidebarDensity ?? 'default');
  const reduceMotion = usePreferenceStore((s) => s.editorReduceMotion);
  const autoKeyframe = usePreferenceStore((s) => s.timelineAutoKeyframe);
  const confirmOnClose = usePreferenceStore((s) => s.confirmOnClose);
  const retainOriginalSvg = usePreferenceStore((s) => s.retainOriginalSvg);
  const idleCacheWorkArea = usePreferenceStore((s) => s.idleCacheWorkArea);
  const setPref = usePreferenceStore((s) => s.set);

  const leftSidebarPos = useLayoutStore((s) => s.leftSidebarPosition);
  const rightInspectorPos = useLayoutStore((s) => s.rightInspectorPosition);
  const timelinePos = useLayoutStore((s) => s.timelinePosition);

  const leftSidebarWidth = useLayoutStore((s) => s.regions.leftSidebar?.size ?? 340);
  const setRegionSize = useLayoutStore((s) => s.setRegionSize);

  const setLeftSidebarPos = useLayoutStore((s) => s.setLeftSidebarPosition);
  const setRightInspectorPos = useLayoutStore((s) => s.setRightInspectorPosition);
  const setTimelinePos = useLayoutStore((s) => s.setTimelinePosition);

  return (
    <div className={styles.tabBody}>
      <div className={styles.row}>
        <span className={styles.rowLabel}>Accent color</span>
        <div className={styles.rowRight}>
          {/*
            With no custom accent set the swatch must show the accent actually
            in force, which is the active theme's --color-primary. This used to
            fall back to a hardcoded #2b7eff — a blue the app uses nowhere — so
            the picker opened misreporting the current colour. Read the token
            rather than keeping a second, drifting copy of the value here.
          */}
          <ColorPicker value={accent || themeAccentColor()} onChange={applyAccent} aria-label="Accent color" />
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
        <span className={styles.rowLabel}>Button Size</span>
        <div className={styles.rowRight}>
          <Button variant={buttonSize === 'sm' ? 'primary' : 'secondary'} size="sm" onClick={() => setPref('buttonSize', 'sm')}>Small</Button>
          <Button variant={buttonSize === 'md' ? 'primary' : 'secondary'} size="sm" onClick={() => setPref('buttonSize', 'md')}>Medium</Button>
          <Button variant={buttonSize === 'lg' ? 'primary' : 'secondary'} size="sm" onClick={() => setPref('buttonSize', 'lg')}>Large</Button>
        </div>
      </div>

      <div className={styles.row}>
        <span className={styles.rowLabel}>Icon Size</span>
        <div className={styles.rowRight}>
          <Button variant={iconSize === 'sm' ? 'primary' : 'secondary'} size="sm" onClick={() => setPref('iconSize', 'sm')}>Small</Button>
          <Button variant={iconSize === 'md' ? 'primary' : 'secondary'} size="sm" onClick={() => setPref('iconSize', 'md')}>Medium</Button>
          <Button variant={iconSize === 'lg' ? 'primary' : 'secondary'} size="sm" onClick={() => setPref('iconSize', 'lg')}>Large</Button>
        </div>
      </div>

      {/*
        Whole-UI zoom.
        `uiScale` was fully implemented and completely unreachable: the store
        held it, `applyUiPreferences` pushed it onto `document.zoom`, and
        useResponsiveLayout divided by it so breakpoints stayed honest — but no
        surface anywhere let anyone change it from 1. This is that surface. It
        belongs next to the other size controls, not buried in a menu.
      */}
      <div className={styles.row}>
        <span className={styles.rowLabel}>Interface Scale</span>
        <div className={styles.rowRight}>
          <input
            type="range"
            min={75}
            max={150}
            step={5}
            value={Math.round(uiScale * 100)}
            onChange={(e) => setPref('uiScale', Number(e.target.value) / 100)}
            aria-label="Interface scale"
          />
          <span style={{ minWidth: 46, textAlign: 'right' }}>{Math.round(uiScale * 100)}%</span>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setPref('uiScale', 1)}
            disabled={uiScale === 1}
          >
            Reset
          </Button>
        </div>
      </div>

      {/*
        Named for what it actually does. It was "Sidebar Items Density", which
        promises the whole sidebar; the two CSS variables it sets are read by
        exactly one stylesheet — the Library's item grid. Widening it to every
        panel's rows is a real change to a lot of untested CSS; renaming it to
        the truth costs nothing and stops the control lying about its reach.
      */}
      <div className={styles.row}>
        <span className={styles.rowLabel}>Library Item Density</span>
        <div className={styles.rowRight}>
          <Button variant={sidebarDensity === 'compact' ? 'primary' : 'secondary'} size="sm" onClick={() => setPref('sidebarDensity', 'compact')}>Compact</Button>
          <Button variant={sidebarDensity === 'default' ? 'primary' : 'secondary'} size="sm" onClick={() => setPref('sidebarDensity', 'default')}>Default</Button>
          <Button variant={sidebarDensity === 'comfortable' ? 'primary' : 'secondary'} size="sm" onClick={() => setPref('sidebarDensity', 'comfortable')}>Comfortable</Button>
        </div>
      </div>

      <div className={styles.row}>
        <span className={styles.rowLabel}>Sidebar Width Resizer</span>
        <div className={styles.rowRight}>
          <input
            type="range"
            min={260}
            max={540}
            step={10}
            value={leftSidebarWidth}
            onChange={(e) => setRegionSize('leftSidebar', Number(e.target.value))}
            aria-label="Left sidebar width resizer"
          />
          <span style={{ minWidth: 46, textAlign: 'right' }}>{leftSidebarWidth}px</span>
          <Button variant="ghost" size="sm" onClick={() => setRegionSize('leftSidebar', 340)} disabled={leftSidebarWidth === 340}>
            Reset
          </Button>
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

      {/*
        Auto-keyframe used to live only on the dashboard's settings tab, which
        is the one screen you cannot see while editing — the exact moment you
        want to turn it on or off. Moved here with the other editing behaviour.
      */}
      <div className={styles.row}>
        <span className={styles.rowLabel}>Auto-keyframe</span>
        <div className={styles.rowRight}>
          <input
            type="checkbox"
            checked={autoKeyframe}
            onChange={(e) => setPref('timelineAutoKeyframe', e.target.checked)}
            aria-label="Record a keyframe automatically when a property changes with the playhead parked"
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

      <div className={styles.row}>
        <span className={styles.rowLabel}>Retain original SVG data after conversion</span>
        <div className={styles.rowRight}>
          <input
            type="checkbox"
            checked={retainOriginalSvg}
            onChange={(e) => setPref('retainOriginalSvg', e.target.checked)}
            aria-label="Keep the original SVG on a layer after Convert to Editable Shapes, so it can be reverted"
          />
        </div>
      </div>

      <div className={styles.row}>
        <span className={styles.rowLabel}>Cache the work area while idle</span>
        <div className={styles.rowRight}>
          <input
            type="checkbox"
            checked={idleCacheWorkArea}
            onChange={(e) => setPref('idleCacheWorkArea', e.target.checked)}
            aria-label="While paused, pre-render the whole work area instead of a few seconds ahead"
          />
        </div>
      </div>

      <div className={styles.row}>
        <span className={styles.rowLabel}>Preview disk cache</span>
        <div className={styles.rowRight}>
          <PreviewCacheControl />
        </div>
      </div>

      <div className={styles.row}>
        <span className={styles.rowLabel}>Object Matte</span>
        <div className={styles.rowRight}>
          <ObjectMatteControl />
        </div>
      </div>

      {/* Renders nothing in a browser build — there is no shell to update. */}
      <UpdatesControl />

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

/**
 * The dialog's tabs, as a FUNCTION rather than a constant.
 *
 * A module-level array would be built when this module is first imported, which
 * happens before `main.tsx` calls `setEdition()` — so an edition-gated entry
 * would capture the default ('server') and the gate would never fire. Same
 * reason `panelDefs` takes a predicate instead of a boolean.
 */
function tabsForEdition(): ReadonlyArray<{ id: Tab; label: string }> {
  return [
    { id: 'shortcuts', label: 'Shortcuts' },
    { id: 'tabs', label: 'Workspaces' },
    { id: 'appearance', label: 'Appearance' },
    // Both editions. AI setup used to live ONLY on the dashboard settings page,
    // and the assistant panel linked to it with `#/dashboard?tab=settings` —
    // a route the local edition does not register. The editor owns the surface
    // now so BYOK works without an account.
    ...(aiEnabled() ? ([{ id: 'ai' as const, label: 'AI' }]) : []),
  ];
}

/**
 * Size readout + Purge for the preview disk tier.
 *
 * This is `FrameDiskCache.purge()`'s ONE caller — the export existed for a
 * dialog that had not been built, which is the dead-export shape this repo's
 * working agreements flag. The readout counts parked generations too, because
 * they are exactly the bytes a user wondering "why is this app holding 3 GB"
 * is looking at. Purge also clears the RAM tier: AE's purge does, and a purge
 * that leaves the green bar lit reads as a button that did nothing.
 */
function PreviewCacheControl(): JSX.Element {
  const [, bump] = useState(0);
  const disk = activeViewportDiskCache();
  if (!disk) {
    return <span className={styles.hint}>Unavailable in this environment.</span>;
  }
  const mb = disk.totalBytes / (1024 * 1024);
  const parked = disk.retainedGenerations;
  return (
    <>
      <span style={{ fontSize: 'var(--font-size-xs)', color: 'var(--color-text-tertiary)' }}>
        {mb < 1 ? '< 1' : Math.round(mb)} MB
        {parked > 0 ? ` · ${parked} parked state${parked === 1 ? '' : 's'}` : ''}
      </span>
      <Button
        variant="ghost"
        size="sm"
        onClick={() => {
          void disk.purge().then(() => {
            viewportFrameCache.clear();
            bump((n) => n + 1);
          });
        }}
      >
        Purge
      </Button>
    </>
  );
}

function Customize({ initialTab = 'shortcuts' }: { initialTab?: Tab }): JSX.Element {
  const tabs = tabsForEdition();
  // A persisted or deep-linked 'ai' tab must not survive into an edition that
  // has no such tab — it would render the panel with no way to leave it.
  const [tab, setTab] = useState<Tab>(
    tabs.some((t) => t.id === initialTab) ? initialTab : 'shortcuts',
  );
  return (
    <div className={styles.root}>
      <div className={styles.tabs} role="tablist">
        {tabs.map((t) => (
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
        : tab === 'ai' ? <div className={styles.section}><AiSettingsSection /></div>
        : <AppearanceTab />}
    </div>
  );
}

/**
 * Open the Customize dialog, optionally on a specific tab.
 *
 * The fixed modal id means a second call REPLACES the open dialog rather than
 * stacking one — so "Open AI settings" from the assistant panel switches tabs
 * even when Customize is already up.
 */
export function openCustomizeDialog(initialTab?: Tab): void {
  openModal({
    id: 'customize',
    title: 'Customize',
    size: 'lg',
    render: () => <Customize {...(initialTab ? { initialTab } : {})} />,
  });
}

/**
 * Deep link for the assistant's "Connect an AI provider" banner.
 *
 * A no-op when the edition has no assistant. The only caller is the assistant
 * panel itself, which that edition never mounts — but this is the kind of
 * function that acquires a second caller later, and opening Customize on a tab
 * that does not exist would silently land the user on Shortcuts.
 */
export function openAiSettings(): void {
  if (!aiEnabled()) return;
  openCustomizeDialog('ai');
}
