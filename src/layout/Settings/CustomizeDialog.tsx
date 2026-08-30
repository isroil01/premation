/**
 * CustomizeDialog — workspace, shortcuts & UI customization in one place:
 *   • Shortcuts — search, filter, record, rebind, clear, and reset command keys
 *   • Workspaces — apply layout presets, save current arrangement, manage custom presets
 *   • Appearance — accent color picker with presets, dock alignment, UI zoom, switches
 *   • AI Engine — provider keys and model configuration (when AI edition is active)
 */

import { useMemo, useState } from 'react';
import { cn } from '@utils/cn';
import { Button } from '@components/Button';
import { Input } from '@components/Input';
import { ColorPicker } from '@components/ColorPicker';
import { Switch } from '@components/Switch';
import { Icon, type IconName } from '@components/Icon';
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
import { getThemeManager, getSettingsManager } from '@core/services/coreServices';
import { activeViewportDiskCache } from '@core/rendering/frameDiskCache';
import { viewportFrameCache } from '@core/rendering/frameCache';
import { getAccentColor, setAccentColor } from '@core/theme/accent';
import { usePreferenceStore } from '@stores/preferenceStore';
import type { KeyChord } from '@app-types/common';
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

function getCommandCategory(id: string, label: string): { key: string; label: string } {
  const lowerId = id.toLowerCase();
  const lowerLabel = label.toLowerCase();
  if (lowerId.startsWith('tool.') || lowerId.startsWith('tools.') || lowerLabel.includes('tool')) return { key: 'tools', label: 'Tools' };
  if (lowerId.startsWith('timeline.') || lowerId.startsWith('time.') || lowerId.startsWith('playback.') || lowerLabel.includes('play') || lowerLabel.includes('frame') || lowerLabel.includes('timeline')) return { key: 'timeline', label: 'Timeline' };
  if (lowerId.startsWith('edit.') || lowerId.startsWith('history.') || lowerLabel.includes('undo') || lowerLabel.includes('redo') || lowerLabel.includes('duplicate') || lowerLabel.includes('delete') || lowerLabel.includes('select')) return { key: 'edit', label: 'Edit' };
  if (lowerId.startsWith('layer.') || lowerId.startsWith('scene.') || lowerLabel.includes('layer') || lowerLabel.includes('matte') || lowerLabel.includes('mask')) return { key: 'layer', label: 'Layers' };
  if (lowerId.startsWith('view.') || lowerId.startsWith('canvas.') || lowerId.startsWith('zoom.') || lowerLabel.includes('zoom') || lowerLabel.includes('fit') || lowerLabel.includes('view')) return { key: 'view', label: 'View' };
  if (lowerId.startsWith('file.') || lowerId.startsWith('project.') || lowerLabel.includes('file') || lowerLabel.includes('project') || lowerLabel.includes('save') || lowerLabel.includes('export')) return { key: 'file', label: 'File' };
  if (lowerId.startsWith('animation.') || lowerId.startsWith('keyframe.') || lowerLabel.includes('keyframe') || lowerLabel.includes('ease')) return { key: 'animation', label: 'Animation' };
  return { key: 'general', label: 'General' };
}

function renderChordKeys(chord: KeyChord | undefined): JSX.Element {
  if (!chord) {
    return <span className={styles.unassigned}>Unassigned</span>;
  }
  const isMac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad|iPod/.test(navigator.platform);
  const keys: string[] = [];
  if (chord.ctrl) keys.push(isMac ? '⌃' : 'Ctrl');
  if (chord.alt) keys.push(isMac ? '⌥' : 'Alt');
  if (chord.shift) keys.push(isMac ? '⇧' : 'Shift');
  if (chord.meta) keys.push(isMac ? '⌘' : 'Win');
  keys.push(chord.key.length === 1 ? chord.key.toUpperCase() : chord.key);

  return (
    <div className={styles.keyCombo}>
      {keys.map((k, idx) => (
        <span key={idx} className={styles.keyWrapper}>
          {idx > 0 && <span className={styles.keyPlus}>+</span>}
          <kbd className={styles.kbd}>{k}</kbd>
        </span>
      ))}
    </div>
  );
}

function ShortcutsTab(): JSX.Element {
  const [, force] = useState(0);
  const [recording, setRecording] = useState<string | null>(null);
  const [conflict, setConflict] = useState<{ id: string; withId: string } | null>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [activeCategory, setActiveCategory] = useState<string>('all');

  const overrides = getShortcutOverrides();
  const commands = getCommandRegistry().all();
  const rows: Row[] = useMemo(() => {
    return commands
      .map((c) => ({
        id: c.id as unknown as string,
        label: c.label,
        chord: resolveChord(c.id as unknown as string, c.shortcut, overrides),
        overridden: (c.id as unknown as string) in overrides,
      }))
      .filter((r) => r.chord || r.overridden || commands.find((c) => (c.id as unknown as string) === r.id)?.shortcut);
  }, [commands, overrides]);

  const resolved = useMemo(() => rows.map((r) => ({ commandId: r.id, chord: r.chord })), [rows]);

  const beginRecord = (id: string): void => {
    setConflict(null);
    setRecording(id);
    const onKey = (e: KeyboardEvent): void => {
      e.preventDefault();
      e.stopPropagation();
      if (isModifierKey(e.key)) return;
      window.removeEventListener('keydown', onKey, true);
      setRecording(null);
      if (e.key === 'Escape') return;
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

  const CATEGORIES = [
    { id: 'all', label: 'All Commands' },
    { id: 'tools', label: 'Tools' },
    { id: 'timeline', label: 'Timeline' },
    { id: 'edit', label: 'Edit' },
    { id: 'layer', label: 'Layers' },
    { id: 'view', label: 'View' },
    { id: 'file', label: 'File' },
  ];

  const filteredRows = rows.filter((r) => {
    const cat = getCommandCategory(r.id, r.label);
    const matchesCat = activeCategory === 'all' || cat.key === activeCategory;
    const q = searchQuery.toLowerCase().trim();
    if (!q) return matchesCat;
    const chordStr = r.chord ? formatChord(r.chord).toLowerCase() : '';
    const matchesSearch =
      r.label.toLowerCase().includes(q) ||
      r.id.toLowerCase().includes(q) ||
      chordStr.includes(q);
    return matchesCat && matchesSearch;
  });

  return (
    <div className={styles.tabBody}>
      <div className={styles.shortcutsToolbar}>
        <div className={styles.shortcutsSearchRow}>
          <div className={styles.searchBox}>
            <Icon name="search" size="sm" className={styles.searchIcon} />
            <input
              type="text"
              className={styles.searchInput}
              placeholder="Search by command name, action, or shortcut key…"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
            />
            {searchQuery ? (
              <button
                type="button"
                className={styles.clearSearchBtn}
                onClick={() => setSearchQuery('')}
                title="Clear search"
                aria-label="Clear search"
              >
                <Icon name="close" size="sm" />
              </button>
            ) : null}
          </div>

          <Button variant="ghost" size="sm" onClick={resetAll} title="Reset all custom shortcuts to factory defaults">
            <Icon name="refresh" size="sm" />
            <span>Reset All</span>
          </Button>
        </div>

        <div className={styles.categoryChips}>
          {CATEGORIES.map((cat) => (
            <button
              key={cat.id}
              type="button"
              className={cn(styles.categoryChip, activeCategory === cat.id && styles.categoryChipActive)}
              onClick={() => setActiveCategory(cat.id)}
            >
              {cat.label}
            </button>
          ))}
        </div>
      </div>

      <div className={styles.shortcutsContainer}>
        <div className={styles.tableHeader}>
          <span className={styles.colCommand}>Command Action</span>
          <span className={styles.colCategory}>Category</span>
          <span className={styles.colKey}>Shortcut Binding</span>
          <span className={styles.colActions}>Actions</span>
        </div>

        <div className={styles.shortcutsList}>
          {filteredRows.length === 0 ? (
            <div className={styles.emptyState}>
              <Icon name="search" size="md" />
              <span className={styles.emptyTitle}>No matching shortcuts found</span>
              <span className={styles.hint}>Try a different search query or category filter.</span>
            </div>
          ) : (
            filteredRows.map((r) => {
              const cat = getCommandCategory(r.id, r.label);
              const isRec = recording === r.id;
              const hasConflict = conflict?.id === r.id;

              return (
                <div key={r.id} className={cn(styles.shortcutRow, isRec && styles.shortcutRowRecording)}>
                  <div className={styles.colCommand}>
                    <span className={styles.commandLabel}>{r.label}</span>
                    {hasConflict ? (
                      <span className={styles.conflictBadge}>
                        <Icon name="warning" size="sm" />
                        <span>Conflict with “{labelFor(conflict.withId)}”</span>
                      </span>
                    ) : null}
                  </div>

                  <div className={styles.colCategory}>
                    <span className={styles.categoryTag}>{cat.label}</span>
                  </div>

                  <div className={styles.colKey}>
                    {isRec ? (
                      <div className={cn(styles.shortcutChip, styles.shortcutRecording)}>
                        <span className={styles.recordingPulse} />
                        <span className={styles.recordingText}>Press keys now…</span>
                        <span className={styles.escBadge}>Esc to cancel</span>
                      </div>
                    ) : (
                      <button
                        type="button"
                        className={cn(
                          styles.shortcutChip,
                          r.overridden && styles.shortcutOverridden,
                          !r.chord && styles.shortcutEmpty,
                        )}
                        onClick={() => beginRecord(r.id)}
                        title="Click to assign or rebind shortcut"
                      >
                        {renderChordKeys(r.chord)}
                      </button>
                    )}
                  </div>

                  <div className={styles.colActions}>
                    {r.overridden ? (
                      <button
                        type="button"
                        className={styles.rowActionBtn}
                        title="Reset to default binding"
                        aria-label="Reset to default binding"
                        onClick={() => reset(r.id)}
                      >
                        <Icon name="refresh" size="sm" />
                      </button>
                    ) : null}

                    {r.chord ? (
                      <button
                        type="button"
                        className={styles.rowActionBtn}
                        title="Unassign shortcut"
                        aria-label="Unassign shortcut"
                        onClick={() => disable(r.id)}
                      >
                        <Icon name="close" size="sm" />
                      </button>
                    ) : null}
                  </div>
                </div>
              );
            })
          )}
        </div>
      </div>

      <div className={styles.shortcutsFooter}>
        <span className={styles.hint}>
          Showing <strong>{filteredRows.length}</strong> of {rows.length} commands. Click any shortcut chip to record a new key combination.
        </span>
      </div>
    </div>
  );
}

function WorkspacesTab(): JSX.Element {
  const [, force] = useState(0);
  const [name, setName] = useState('');
  const manager = getWorkspaceManager();
  const layouts = manager.listWorkspaces();
  let currentWorkspaceId = 'default';
  try {
    currentWorkspaceId = getSettingsManager().get<string>('workspace.activeId', 'default');
  } catch {
    currentWorkspaceId = 'default';
  }

  const save = (): void => {
    const n = name.trim();
    if (!n) return;
    manager.saveCurrentWorkspace(n);
    setName('');
    force((v) => v + 1);
  };

  const remove = (id: string): void => {
    manager.deleteWorkspace(id);
    force((v) => v + 1);
  };

  return (
    <div className={styles.tabBody}>
      <div className={styles.workspaceHeader}>
        <div>
          <h4 className={styles.subHeading}>Workspace Layout Presets</h4>
          <p className={styles.hint}>Switch between tailored multi-dock layouts or save your current screen arrangement.</p>
        </div>
      </div>

      <div className={styles.workspaceGrid}>
        {layouts.map((l) => {
          const isActive = l.id === currentWorkspaceId;
          return (
            <div key={l.id} className={cn(styles.workspaceCard, isActive && styles.workspaceCardActive)}>
              <div className={styles.workspaceCardHeader}>
                <div className={styles.workspaceCardIcon}>
                  <Icon name="layout" size="md" />
                </div>
                <div className={styles.workspaceCardMeta}>
                  <div className={styles.workspaceCardTitleRow}>
                    <span className={styles.workspaceCardName}>{l.name}</span>
                    {l.builtin ? (
                      <span className={styles.badge}>Preset</span>
                    ) : (
                      <span className={cn(styles.badge, styles.customBadge)}>Custom</span>
                    )}
                  </div>
                  <span className={styles.workspaceCardSub}>
                    {isActive ? 'Currently active arrangement' : 'Saved docking layout'}
                  </span>
                </div>
              </div>

              <div className={styles.workspaceCardActions}>
                <Button
                  variant={isActive ? 'primary' : 'secondary'}
                  size="sm"
                  onClick={() => {
                    manager.applyWorkspace(l.id);
                    force((v) => v + 1);
                  }}
                >
                  {isActive ? 'Active' : 'Apply Layout'}
                </Button>
                {!l.builtin && (
                  <button
                    type="button"
                    className={styles.rowActionBtn}
                    title={`Delete “${l.name}”`}
                    aria-label={`Delete ${l.name}`}
                    onClick={() => remove(l.id)}
                  >
                    <Icon name="trash" size="sm" />
                  </button>
                )}
              </div>
            </div>
          );
        })}
      </div>

      <div className={styles.saveWorkspaceCard}>
        <div className={styles.saveWorkspaceMeta}>
          <span className={styles.saveWorkspaceTitle}>Save Current Layout as Preset</span>
          <span className={styles.hint}>Capture the exact sizes and dock positions of your open panels.</span>
        </div>
        <div className={styles.saveRow}>
          <Input
            value={name}
            placeholder="e.g. Dual Monitor Animation, Color Grading…"
            onChange={(e) => setName(e.currentTarget.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && name.trim()) save();
            }}
          />
          <Button variant="primary" size="sm" onClick={save} disabled={!name.trim()}>
            <Icon name="plus" size="sm" />
            <span>Save Preset</span>
          </Button>
        </div>
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

  const ACCENT_PRESETS = [
    { name: 'Studio Blue', color: '#2988ff' },
    { name: 'Cyber Violet', color: '#8b5cf6' },
    { name: 'Emerald', color: '#10b981' },
    { name: 'Coral', color: '#f97316' },
    { name: 'Rose', color: '#f43f5e' },
    { name: 'Amber', color: '#f59e0b' },
    { name: 'Cyan', color: '#06b6d4' },
  ];

  return (
    <div className={styles.appearanceScroll}>
      <div className={styles.sectionGroup}>
        <div className={styles.sectionHeading}>
          <span className={styles.sectionTitle}>Theme & Brand Accent</span>
          <span className={styles.hint}>Choose the studio accent highlight and light/dark interface mode.</span>
        </div>

        <div className={styles.settingCard}>
          <div className={styles.settingRow}>
            <div className={styles.settingInfo}>
              <span className={styles.settingTitle}>Accent Color</span>
              <span className={styles.settingDesc}>Controls focus rings, active keyframe markers, and selection bounding boxes.</span>
            </div>
            <div className={styles.accentPickerWrap}>
              <div className={styles.presetSwatches}>
                {ACCENT_PRESETS.map((p) => {
                  const isCur = (accent || themeAccentColor()).toLowerCase() === p.color.toLowerCase();
                  return (
                    <button
                      key={p.color}
                      type="button"
                      className={cn(styles.colorSwatch, isCur && styles.colorSwatchActive)}
                      style={{ backgroundColor: p.color }}
                      title={p.name}
                      onClick={() => applyAccent(p.color)}
                    />
                  );
                })}
              </div>
              <ColorPicker value={accent || themeAccentColor()} onChange={applyAccent} aria-label="Accent color" />
              {accent ? (
                <Button variant="ghost" size="sm" onClick={() => applyAccent('')}>
                  Reset
                </Button>
              ) : null}
            </div>
          </div>

          <div className={styles.settingRow}>
            <div className={styles.settingInfo}>
              <span className={styles.settingTitle}>Interface Theme</span>
              <span className={styles.settingDesc}>Toggle between dark studio mode and high-contrast light mode.</span>
            </div>
            <Button variant="secondary" size="sm" onClick={() => getThemeManager().toggle()}>
              <Icon name="theme" size="sm" />
              <span>Toggle Dark / Light</span>
            </Button>
          </div>
        </div>
      </div>

      <div className={styles.sectionGroup}>
        <div className={styles.sectionHeading}>
          <span className={styles.sectionTitle}>Dock & Panel Alignment</span>
          <span className={styles.hint}>Configure which edge each studio dock pane attaches to.</span>
        </div>

        <div className={styles.settingCard}>
          <div className={styles.settingRow}>
            <div className={styles.settingInfo}>
              <span className={styles.settingTitle}>Left Sidebar Position</span>
              <span className={styles.settingDesc}>Attach Project, Library, and Scene panels to the left or right edge.</span>
            </div>
            <div className={styles.segmented}>
              <button
                type="button"
                className={cn(styles.segItem, leftSidebarPos === 'left' && styles.segItemActive)}
                onClick={() => setLeftSidebarPos('left')}
              >
                Left
              </button>
              <button
                type="button"
                className={cn(styles.segItem, leftSidebarPos === 'right' && styles.segItemActive)}
                onClick={() => setLeftSidebarPos('right')}
              >
                Right
              </button>
            </div>
          </div>

          <div className={styles.settingRow}>
            <div className={styles.settingInfo}>
              <span className={styles.settingTitle}>Inspector Position</span>
              <span className={styles.settingDesc}>Attach Properties and Effects inspectors to the right or left edge.</span>
            </div>
            <div className={styles.segmented}>
              <button
                type="button"
                className={cn(styles.segItem, rightInspectorPos === 'left' && styles.segItemActive)}
                onClick={() => setRightInspectorPos('left')}
              >
                Left
              </button>
              <button
                type="button"
                className={cn(styles.segItem, rightInspectorPos === 'right' && styles.segItemActive)}
                onClick={() => setRightInspectorPos('right')}
              >
                Right
              </button>
            </div>
          </div>

          <div className={styles.settingRow}>
            <div className={styles.settingInfo}>
              <span className={styles.settingTitle}>Timeline Position</span>
              <span className={styles.settingDesc}>Position the layer tracks and graph editor at the bottom or top.</span>
            </div>
            <div className={styles.segmented}>
              <button
                type="button"
                className={cn(styles.segItem, timelinePos === 'bottom' && styles.segItemActive)}
                onClick={() => setTimelinePos('bottom')}
              >
                Bottom
              </button>
              <button
                type="button"
                className={cn(styles.segItem, timelinePos === 'top' && styles.segItemActive)}
                onClick={() => setTimelinePos('top')}
              >
                Top
              </button>
            </div>
          </div>

          <div className={styles.settingRow}>
            <div className={styles.settingInfo}>
              <span className={styles.settingTitle}>Default Sidebar Width</span>
              <span className={styles.settingDesc}>Base width for project and layer inspector sidebars.</span>
            </div>
            <div className={styles.sliderWrap}>
              <input
                type="range"
                min={260}
                max={540}
                step={10}
                value={leftSidebarWidth}
                onChange={(e) => setRegionSize('leftSidebar', Number(e.target.value))}
                aria-label="Left sidebar width resizer"
                className={styles.rangeInput}
              />
              <span className={styles.rangeVal}>{leftSidebarWidth}px</span>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setRegionSize('leftSidebar', 340)}
                disabled={leftSidebarWidth === 340}
              >
                Reset
              </Button>
            </div>
          </div>
        </div>
      </div>

      <div className={styles.sectionGroup}>
        <div className={styles.sectionHeading}>
          <span className={styles.sectionTitle}>Scale & Control Sizing</span>
          <span className={styles.hint}>Fine-tune icon scales, button targets, and whole-canvas zoom.</span>
        </div>

        <div className={styles.settingCard}>
          <div className={styles.settingRow}>
            <div className={styles.settingInfo}>
              <span className={styles.settingTitle}>Interface Zoom Scale</span>
              <span className={styles.settingDesc}>Scales the entire application typography, dialogs, and controls.</span>
            </div>
            <div className={styles.sliderWrap}>
              <input
                type="range"
                min={75}
                max={150}
                step={5}
                value={Math.round(uiScale * 100)}
                onChange={(e) => setPref('uiScale', Number(e.target.value) / 100)}
                aria-label="Interface scale"
                className={styles.rangeInput}
              />
              <span className={styles.rangeVal}>{Math.round(uiScale * 100)}%</span>
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

          <div className={styles.settingRow}>
            <div className={styles.settingInfo}>
              <span className={styles.settingTitle}>Button Target Sizing</span>
              <span className={styles.settingDesc}>Compact rows for precision density or larger targets for high-DPI displays.</span>
            </div>
            <div className={styles.segmented}>
              <button
                type="button"
                className={cn(styles.segItem, buttonSize === 'sm' && styles.segItemActive)}
                onClick={() => setPref('buttonSize', 'sm')}
              >
                Small
              </button>
              <button
                type="button"
                className={cn(styles.segItem, buttonSize === 'md' && styles.segItemActive)}
                onClick={() => setPref('buttonSize', 'md')}
              >
                Medium
              </button>
              <button
                type="button"
                className={cn(styles.segItem, buttonSize === 'lg' && styles.segItemActive)}
                onClick={() => setPref('buttonSize', 'lg')}
              >
                Large
              </button>
            </div>
          </div>

          <div className={styles.settingRow}>
            <div className={styles.settingInfo}>
              <span className={styles.settingTitle}>Toolbar Icon Scale</span>
              <span className={styles.settingDesc}>Scales tool selector and timeline track control glyphs.</span>
            </div>
            <div className={styles.segmented}>
              <button
                type="button"
                className={cn(styles.segItem, iconSize === 'sm' && styles.segItemActive)}
                onClick={() => setPref('iconSize', 'sm')}
              >
                Small
              </button>
              <button
                type="button"
                className={cn(styles.segItem, iconSize === 'md' && styles.segItemActive)}
                onClick={() => setPref('iconSize', 'md')}
              >
                Medium
              </button>
              <button
                type="button"
                className={cn(styles.segItem, iconSize === 'lg' && styles.segItemActive)}
                onClick={() => setPref('iconSize', 'lg')}
              >
                Large
              </button>
            </div>
          </div>

          <div className={styles.settingRow}>
            <div className={styles.settingInfo}>
              <span className={styles.settingTitle}>Library Asset Grid Density</span>
              <span className={styles.settingDesc}>Item spacing inside Footage and Asset browsing galleries.</span>
            </div>
            <div className={styles.segmented}>
              <button
                type="button"
                className={cn(styles.segItem, sidebarDensity === 'compact' && styles.segItemActive)}
                onClick={() => setPref('sidebarDensity', 'compact')}
              >
                Compact
              </button>
              <button
                type="button"
                className={cn(styles.segItem, sidebarDensity === 'default' && styles.segItemActive)}
                onClick={() => setPref('sidebarDensity', 'default')}
              >
                Default
              </button>
              <button
                type="button"
                className={cn(styles.segItem, sidebarDensity === 'comfortable' && styles.segItemActive)}
                onClick={() => setPref('sidebarDensity', 'comfortable')}
              >
                Comfortable
              </button>
            </div>
          </div>
        </div>
      </div>

      <div className={styles.sectionGroup}>
        <div className={styles.sectionHeading}>
          <span className={styles.sectionTitle}>Editor Behaviors & Safeguards</span>
          <span className={styles.hint}>Animation automation, motion comfort, and safety prompts.</span>
        </div>

        <div className={styles.settingCard}>
          <div className={styles.switchRow}>
            <div className={styles.settingInfo}>
              <span className={styles.settingTitle}>Auto-Keyframe Recording</span>
              <span className={styles.settingDesc}>Automatically record a keyframe whenever a property changes while the playhead is parked.</span>
            </div>
            <Switch
              checked={autoKeyframe}
              onChange={(e) => setPref('timelineAutoKeyframe', e.target.checked)}
              aria-label="Auto-keyframe recording"
            />
          </div>

          <div className={styles.switchRow}>
            <div className={styles.settingInfo}>
              <span className={styles.settingTitle}>Confirm Unsaved Changes on Exit</span>
              <span className={styles.settingDesc}>Prompt for confirmation before New, Open, or Close discards project edits.</span>
            </div>
            <Switch
              checked={confirmOnClose}
              onChange={(e) => setPref('confirmOnClose', e.target.checked)}
              aria-label="Confirm before discarding unsaved changes"
            />
          </div>

          <div className={styles.switchRow}>
            <div className={styles.settingInfo}>
              <span className={styles.settingTitle}>Reduce UI Motion & Transitions</span>
              <span className={styles.settingDesc}>Disables non-essential panel animations and transitions (viewport playback unaffected).</span>
            </div>
            <Switch
              checked={reduceMotion}
              onChange={(e) => setPref('editorReduceMotion', e.target.checked)}
              aria-label="Reduce UI motion"
            />
          </div>

          <div className={styles.switchRow}>
            <div className={styles.settingInfo}>
              <span className={styles.settingTitle}>Retain Original Vector SVG Sources</span>
              <span className={styles.settingDesc}>Preserve vector XML structures when importing complex SVG assets.</span>
            </div>
            <Switch
              checked={retainOriginalSvg}
              onChange={(e) => setPref('retainOriginalSvg', e.target.checked)}
              aria-label="Retain original SVG sources"
            />
          </div>

          <div className={styles.switchRow}>
            <div className={styles.settingInfo}>
              <span className={styles.settingTitle}>Background Idle Cache Work Area</span>
              <span className={styles.settingDesc}>Pre-render timeline frames during user idle periods for smoother real-time scrubbing.</span>
            </div>
            <Switch
              checked={idleCacheWorkArea}
              onChange={(e) => setPref('idleCacheWorkArea', e.target.checked)}
              aria-label="Idle cache work area"
            />
          </div>
        </div>
      </div>

      <div className={styles.sectionGroup}>
        <div className={styles.sectionHeading}>
          <span className={styles.sectionTitle}>Storage, Cache & Intelligence</span>
          <span className={styles.hint}>Manage disk cache usage and optional neural segmentation models.</span>
        </div>

        <div className={styles.settingCard}>
          <div className={styles.settingRow}>
            <div className={styles.settingInfo}>
              <span className={styles.settingTitle}>Render Frame Disk Cache</span>
              <span className={styles.settingDesc}>Disk space used for cached frames, onion skins, and parked states.</span>
            </div>
            <div className={styles.settingRight}>
              <PreviewCacheControl />
            </div>
          </div>

          <div className={styles.settingRow}>
            <div className={styles.settingInfo}>
              <span className={styles.settingTitle}>AI Object Matte Model</span>
              <span className={styles.settingDesc}>Local neural model powering one-click Roto subject selection.</span>
            </div>
            <div className={styles.settingRight}>
              <ObjectMatteControl />
            </div>
          </div>

          <UpdatesControl />
        </div>
      </div>
    </div>
  );
}

function tabsForEdition(): ReadonlyArray<{ id: Tab; label: string; icon: IconName }> {
  return [
    { id: 'shortcuts', label: 'Shortcuts', icon: 'keyboard' as IconName },
    { id: 'tabs', label: 'Workspaces', icon: 'layout' as IconName },
    { id: 'appearance', label: 'Appearance', icon: 'palette' as IconName },
    ...(aiEnabled() ? [{ id: 'ai' as const, label: 'AI Engine', icon: 'ai' as IconName }] : []),
  ];
}

function PreviewCacheControl(): JSX.Element {
  const [, bump] = useState(0);
  const disk = activeViewportDiskCache();
  if (!disk) {
    return <span className={styles.hint}>Unavailable in this environment.</span>;
  }
  const mb = disk.totalBytes / (1024 * 1024);
  const parked = disk.retainedGenerations;
  return (
    <div className={styles.cacheControlWrap}>
      <span className={styles.cacheSizeReadout}>
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
        <Icon name="trash" size="sm" />
        <span>Purge Cache</span>
      </Button>
    </div>
  );
}

function Customize({ initialTab = 'shortcuts' }: { initialTab?: Tab }): JSX.Element {
  const tabs = tabsForEdition();
  const [tab, setTab] = useState<Tab>(
    tabs.some((t) => t.id === initialTab) ? initialTab : 'shortcuts',
  );

  return (
    <div className={styles.root}>
      <div className={styles.tabsWrap} role="tablist">
        {tabs.map((t) => (
          <button
            key={t.id}
            type="button"
            role="tab"
            aria-selected={tab === t.id}
            className={cn(styles.tabBtn, tab === t.id && styles.tabBtnActive)}
            onClick={() => setTab(t.id)}
          >
            <Icon name={t.icon} size="sm" />
            <span>{t.label}</span>
          </button>
        ))}
      </div>

      <div className={styles.contentWrap}>
        {tab === 'shortcuts' ? (
          <ShortcutsTab />
        ) : tab === 'tabs' ? (
          <WorkspacesTab />
        ) : tab === 'ai' ? (
          <div className={styles.section}><AiSettingsSection /></div>
        ) : (
          <AppearanceTab />
        )}
      </div>
    </div>
  );
}

export function openCustomizeDialog(initialTab?: Tab): void {
  openModal({
    id: 'customize',
    title: 'Studio Preferences & Customization',
    size: 'lg',
    render: () => <Customize {...(initialTab ? { initialTab } : {})} />,
  });
}

export function openAiSettings(): void {
  if (!aiEnabled()) return;
  openCustomizeDialog('ai');
}
