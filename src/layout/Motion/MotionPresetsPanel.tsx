/**
 * Effects & Presets — the library panel.
 *
 * The requirements this is built to, in rough priority:
 *
 *  1. **Search that filters as you type.** Nobody browses seventeen folders;
 *     experienced users type. The tree exists for discovery, the field for use.
 *  2. **Drag onto a layer, or click with a layer selected.** Both, because both
 *     work in AE and users arrive expecting whichever one they learned.
 *  3. **Animated previews, always looping.** AE has none at all, and gating
 *     them behind a hover means discovering presets one at a time — barely
 *     better than "apply it and undo". One shared clock drives every card on
 *     screen; see PresetPreview.tsx and previewTicker.ts.
 *  4. **Save current settings as a preset**, into a user folder in the same tree.
 *  5. Presets apply at the PLAYHEAD, not at time zero.
 */

import { useMemo, useRef, useState } from 'react';
import { Panel } from '@components/Panel';
import { BrowserTree, BrowserFolder, BrowserRow } from '@components/BrowserTree';
import { Input } from '@components/Input';
import { Icon, type IconName } from '@components/Icon';
import { Dropdown, type DropdownItem } from '@components/Dropdown';
import {
  listPresets,
  applyPreset,
  deletePreset,
  presetFolder,
  saveCurrentAsPreset,
  exportPresets,
  importPresets,
  countUserPresets,
  USER_PRESET_FOLDER,
  type AnimationPreset,
} from '@core/animation/animationPresets';
import { downloadBlob } from '@core/export/exportManager';
import { hasTextComponent } from '@core/text/textAnimators';
import defaultSceneGraph from '@core/scene/DefaultSceneGraph';
import { useSelectionStore } from '@stores/selectionStore';
import { useWorkspaceStore } from '@stores/projectStore';
import { useUIStore } from '@stores/uiStore';
import { useSceneRevision, bumpScene } from '@stores/sceneStore';
import { setCanvasDrag } from '@core/dnd/canvasDrag';
import { getEventBus } from '@core/events/EventBus';
import { PresetPreview } from './PresetPreview';
import styles from './MotionPresetsPanel.module.css';

type SortOrder = 'default' | 'alphabetical-asc' | 'alphabetical-desc';

/** Folders that open on first paint — the ones a user most often wants. */
const OPEN_BY_DEFAULT = new Set(['Entrances', 'Text/Animate In', USER_PRESET_FOLDER]);

/** The row's preview canvas, in CSS px. Must match `.rowPreview` in the
 *  stylesheet: the canvas is sized from these numbers, the box from those, and
 *  a disagreement between them clips the drawing. */
const PREVIEW_W = 48;
const PREVIEW_H = 22;

/**
 * A glyph per folder, matching the Effects tab's folders — the two browsers sit
 * beside each other and one carrying subject icons while the other carries none
 * reads as two different components rather than one library.
 *
 * Folders come from preset DATA (`presetFolder`), not from a closed list, so
 * this is a lookup with a fallback rather than an exhaustive Record: a preset
 * authored into a new folder gets the generic folder glyph, never a crash.
 */
const PRESET_FOLDER_ICON: Record<string, IconName> = {
  Entrances: 'trim-in',
  Exits: 'trim-out',
  'Emphases & Loops': 'loop',
  '3D Motions': '3d',
  Behaviors: 'ease',
  Transitions: 'wipe',
  Backgrounds: 'image',
  [USER_PRESET_FOLDER]: 'user',
};

function folderIcon(folder: string): IconName {
  // Text presets live in five `Text/…` sub-folders; they are all text.
  if (folder.startsWith('Text/')) return 'type';
  return PRESET_FOLDER_ICON[folder] ?? 'folder';
}

export function MotionPresetsPanel(): JSX.Element {
  const selectedIds = useSelectionStore((s) => s.ids);
  const notify = useUIStore((s) => s.notify);
  const activeTabId = useWorkspaceStore((s) => s.activeTabId);
  const playhead = useWorkspaceStore((s) => (activeTabId ? s.tabs[activeTabId]?.time : 0) ?? 0);

  // Re-render when the scene is modified (e.g. the user saves or deletes one).
  const sceneRev = useSceneRevision((s) => s.rev);

  const [search, setSearch] = useState('');
  const [sortOrder, setSortOrder] = useState<SortOrder>('default');
  const [saving, setSaving] = useState(false);
  const [saveName, setSaveName] = useState('');
  const fileRef = useRef<HTMLInputElement>(null);

  const presets = useMemo(() => listPresets(), [sceneRev]);

  /** Does the selected layer support text animators? Used to say so rather
   *  than let a text preset apply to a rectangle and silently do nothing. */
  const selectionIsText = useMemo(() => {
    const id = selectedIds[0];
    if (!id) return false;
    const node = defaultSceneGraph.getNode(id);
    return !!node && hasTextComponent(node);
  }, [selectedIds, sceneRev]);

  const processedPresets = useMemo(() => {
    let result = [...presets];
    const q = search.trim().toLowerCase();
    if (q) {
      result = result.filter(
        (p) =>
          p.name.toLowerCase().includes(q) ||
          (p.description ?? '').toLowerCase().includes(q) ||
          presetFolder(p).toLowerCase().includes(q),
      );
    }
    if (sortOrder === 'alphabetical-asc') result.sort((a, b) => a.name.localeCompare(b.name));
    else if (sortOrder === 'alphabetical-desc') result.sort((a, b) => b.name.localeCompare(a.name));
    return result;
  }, [presets, search, sortOrder]);

  /** Group by folder path, ordered so built-ins keep their authored order and
   *  the user's own presets sit at the bottom where they can be found. */
  const folders = useMemo(() => {
    const groups = new Map<string, AnimationPreset[]>();
    for (const p of processedPresets) {
      const key = presetFolder(p);
      const list = groups.get(key);
      if (list) list.push(p);
      else groups.set(key, [p]);
    }
    return [...groups.entries()].sort(([a], [b]) => {
      const userA = a === USER_PRESET_FOLDER ? 1 : 0;
      const userB = b === USER_PRESET_FOLDER ? 1 : 0;
      return userA - userB || a.localeCompare(b);
    });
  }, [processedPresets]);

  const apply = (preset: AnimationPreset): void => {
    const id = selectedIds[0];
    if (!id) {
      notify({ level: 'warning', message: 'Select a layer first', durationMs: 2000 });
      return;
    }
    if (preset.requires === 'text' && !selectionIsText) {
      // Explicit rather than a silent no-op: this preset animates characters,
      // and the selected layer has none.
      notify({
        level: 'warning',
        message: `"${preset.name}" animates characters — select a text layer`,
        durationMs: 2600,
      });
      return;
    }
    const ok = applyPreset(preset, id, playhead);
    notify(
      ok
        ? { level: 'success', message: `Applied "${preset.name}"`, durationMs: 2000 }
        : { level: 'warning', message: `Failed to apply "${preset.name}"`, durationMs: 2000 },
    );
    bumpScene();
  };

  /**
   * Commit the pending save. Inline rather than `window.prompt`: a modal prompt
   * blocks the whole app, cannot be styled, and cannot show which layer is
   * being captured — and this is the ONE home for saving a preset now that the
   * redundant PresetsBar is gone.
   */
  const commitSave = (): void => {
    const id = selectedIds[0];
    const name = saveName.trim();
    if (!id || !name) return;
    const ok = saveCurrentAsPreset(id, name);
    notify(
      ok
        ? { level: 'success', message: `Saved "${name}" to ${USER_PRESET_FOLDER}`, durationMs: 2200 }
        : { level: 'warning', message: 'Nothing to save — animate the layer first', durationMs: 2400 },
    );
    if (ok) {
      setSaveName('');
      setSaving(false);
    }
    bumpScene();
  };

  const beginSave = (): void => {
    if (!selectedIds[0]) {
      notify({ level: 'warning', message: 'Select an animated layer first', durationMs: 2000 });
      return;
    }
    setSaving(true);
  };

  /** How many presets a bundle would actually carry. Asked of the exporter's
   *  own reader rather than filtering `presets`, so this stays right if a
   *  shipped preset array is ever added without the `builtin` flag. */
  const userPresetCount = useMemo(() => countUserPresets(), [sceneRev]);

  const doExport = (): void => {
    const json = exportPresets();
    downloadBlob(new Blob([json], { type: 'application/json' }), 'premation-presets.json');
    notify({
      level: 'success',
      message: `Exported ${userPresetCount} preset${userPresetCount === 1 ? '' : 's'}`,
      durationMs: 2000,
    });
  };

  const doImport = async (file: File): Promise<void> => {
    const r = importPresets(await file.text());
    if (r.error) {
      notify({ level: 'error', message: r.error, durationMs: 4000 });
      return;
    }
    // Both halves are reported. An import that replaced six presets and said
    // only "imported 6" reads as additive, and the user finds out it was not
    // when a preset they had is gone.
    const parts: string[] = [];
    if (r.added.length) parts.push(`added ${r.added.length}`);
    if (r.replaced.length) parts.push(`replaced ${r.replaced.length}`);
    if (r.rejected) parts.push(`skipped ${r.rejected} unusable`);
    notify({
      level: r.rejected ? 'warning' : 'success',
      message: `Presets: ${parts.join(', ')}`,
      durationMs: r.rejected ? 4000 : 2500,
    });
    bumpScene();
  };

  const sortItems: DropdownItem[] = [
    { type: 'label', label: 'Sort Presets By' },
    {
      type: 'checkbox', id: 'default', label: 'Default Order',
      checked: sortOrder === 'default', onChange: () => setSortOrder('default'),
    },
    {
      type: 'checkbox', id: 'asc', label: 'Alphabetical (A-Z)',
      checked: sortOrder === 'alphabetical-asc', onChange: () => setSortOrder('alphabetical-asc'),
    },
    {
      type: 'checkbox', id: 'desc', label: 'Alphabetical (Z-A)',
      checked: sortOrder === 'alphabetical-desc', onChange: () => setSortOrder('alphabetical-desc'),
    },
    { type: 'separator' },
    { type: 'label', label: 'Share' },
    {
      type: 'item',
      id: 'export',
      label: 'Export Presets…',
      icon: 'download',
      // Built-ins ship with the app, so a library of only built-ins exports an
      // empty bundle. Disabled with the reason rather than handing over a file
      // that imports as "no usable presets".
      disabled: userPresetCount === 0,
      onSelect: doExport,
    },
    {
      type: 'item',
      id: 'import',
      label: 'Import Presets…',
      icon: 'upload',
      onSelect: () => fileRef.current?.click(),
    },
  ];

  const searching = !!search.trim();

  return (
    <Panel
      id="presets"
      title="Presets"
      icon="zap"
      hideHeader
      onClose={() => getEventBus().emit('PanelClosed', { panelId: 'presets' })}
    >
      <div className={styles.panelHeader}>
        <div className={styles.searchRow}>
          <Input
            value={search}
            placeholder="Search presets…"
            size="sm"
            fullWidth
            leftIcon="search"
            clearable
            onClear={() => setSearch('')}
            onChange={(e) => setSearch(e.currentTarget.value)}
          />
          <button
            type="button"
            className={styles.sortBtn}
            title="Save the selected layer's animation as a preset"
            aria-label="Save as preset"
            onClick={beginSave}
          >
            <Icon name="plus" size="sm" />
          </button>
          <Dropdown
            placement="bottom-end"
            trigger={
              <button type="button" className={styles.sortBtn} title="Sort presets">
                <Icon name="settings" size="sm" />
              </button>
            }
            items={sortItems}
          />
          <input
            ref={fileRef}
            type="file"
            accept=".json,application/json"
            style={{ display: 'none' }}
            onChange={(e) => {
              const f = e.currentTarget.files?.[0];
              // Cleared before the import runs, so picking the SAME file twice
              // fires `change` the second time. Without it a failed import
              // cannot be retried after fixing the file.
              e.currentTarget.value = '';
              if (f) void doImport(f);
            }}
          />
        </div>
        {saving && (
          <div className={styles.searchRow} style={{ marginTop: 6 }}>
            <Input
              value={saveName}
              placeholder="Preset name…"
              size="sm"
              fullWidth
              autoFocus
              onChange={(e) => setSaveName(e.currentTarget.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') commitSave();
                if (e.key === 'Escape') { setSaving(false); setSaveName(''); }
              }}
            />
            <button
              type="button"
              className={styles.sortBtn}
              title="Save"
              aria-label="Confirm save preset"
              disabled={!saveName.trim()}
              onClick={commitSave}
            >
              <Icon name="check" size="sm" />
            </button>
            <button
              type="button"
              className={styles.sortBtn}
              title="Cancel"
              aria-label="Cancel save preset"
              onClick={() => { setSaving(false); setSaveName(''); }}
            >
              <Icon name="close" size="sm" />
            </button>
          </div>
        )}
      </div>
      <div className={styles.libBody}>
        {folders.length > 0 ? (
          <BrowserTree>
            {folders.map(([folder, items]) => (
              <BrowserFolder
                key={folder}
                label={folder}
                icon={folderIcon(folder)}
                count={items.length}
                defaultOpen={OPEN_BY_DEFAULT.has(folder)}
                // Searching means the user is hunting, not browsing — open
                // everything that still holds a match, and keep it open for as
                // long as the query stands.
                forceOpen={searching}
              >
                {items.map((preset) => {
                  const unavailable = preset.requires === 'text' && !!selectedIds[0] && !selectionIsText;
                  return (
                    // The delete control is a SIBLING of the row, not a child:
                    // BrowserRow is a <button>, and a button inside a button is
                    // invalid content that browsers resolve by dropping one of
                    // them — which is why this overlay has always been a sibling.
                    <div key={preset.name} className={styles.rowWrapper}>
                      <BrowserRow
                        className={styles.presetRow}
                        label={preset.name}
                        // The looping preview stays — it is the one thing this
                        // browser has that AE's does not, and the reason a
                        // preset can be recognised without applying it. It sets
                        // this row's height: 28px against the browser's 22, and
                        // against ~62px for the card it replaces.
                        //
                        // The size is passed EXPLICITLY. PresetPreview defaults
                        // to a 132×56 canvas and its container clips overflow,
                        // so a smaller slot with no size prop would show the
                        // top-left corner of the drawing and nothing else.
                        leading={
                          <span className={styles.rowPreview}>
                            <PresetPreview preset={preset} width={PREVIEW_W} height={PREVIEW_H} />
                          </span>
                        }
                        title={
                          unavailable
                            ? `${preset.name} — needs a text layer`
                            : `${preset.description ?? preset.name}\nClick to apply, or drag onto a layer.`
                        }
                        disabled={unavailable}
                        draggable
                        onDragStart={(e) => setCanvasDrag(e, { kind: 'motionPreset', name: preset.name })}
                        onClick={() => apply(preset)}
                        // Double-click applies too: AE users reach for it, and a
                        // second apply is undoable, so the duplicate is harmless.
                        onDoubleClick={() => apply(preset)}
                      />
                      {!preset.builtin && (
                        <button
                          type="button"
                          className={styles.deleteBtn}
                          title="Delete custom preset"
                          aria-label={`Delete preset ${preset.name}`}
                          onClick={() => {
                            deletePreset(preset.name);
                            notify({ level: 'success', message: `Deleted preset "${preset.name}"`, durationMs: 2000 });
                            // The panel refreshes off the scene revision.
                            bumpScene();
                          }}
                        >
                          <Icon name="trash" size="sm" />
                        </button>
                      )}
                    </div>
                  );
                })}
              </BrowserFolder>
            ))}
          </BrowserTree>
        ) : (
          <div className={styles.emptyState}>
            <Icon name="sparkles" size="md" className={styles.emptyIcon} />
            <span className={styles.emptyText}>No presets found for "{search}"</span>
          </div>
        )}
      </div>
    </Panel>
  );
}

export default MotionPresetsPanel;
