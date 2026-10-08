/**
 * EffectsPanel — the right-inspector library of effect types (AE's Effects &
 * Presets). Click a row to add it to the selected layer, or drag it onto one;
 * the applied stack itself lives in the left-sidebar Effect Controls panel,
 * because keeping both in this tab buried the browser under every effect you
 * applied.
 *
 * The panel grammar (typography.css, "Panel type roles", 2026-10): the tab is
 * the only title, so there is no heading in here; one toolbar row (search +
 * favourites); then the tree as After Effects draws it — the presets folder
 * first, then the effect folders A–Z. What acts on the selected layer's
 * STACK (Copy Stack, Paste, Save Preset) is in Effect Controls' ≡ menu, beside
 * the stack it acts on; masks are in Properties ▸ Masks.
 */

import { useEffect, useRef, useState, useMemo, useSyncExternalStore } from 'react';
import { Icon, type IconName } from '@components/Icon';
import { IconButton } from '@components/IconButton';
import { SearchField } from '@components/SearchField';
import { VirtualList } from '@components/VirtualList';
import { BrowserRow, BrowserTag } from '@components/BrowserTree';
import { useSelectionStore } from '@stores/selectionStore';
import { useUIStore } from '@stores/uiStore';
import type { EffectDef } from '@core/inspector/effectCatalog';
import { addEffectAndReveal, revealEffectsInProperties } from './revealEffectControls';
import { useAllEffectDefs, useEffectFavorites } from './effectCatalog';
import { deleteEffectPreset, listEffectPresets, type EffectPreset } from '@core/effects/effectClipboard';
import { BUILTIN_EFFECT_PRESETS } from '@core/effects/builtinEffectPresets';
import { PATH_OP_CATALOG } from '@core/scene/pathOps';
import { documentMirror } from '@stores/documentMirror';
import { useMirrorLayer, useMirrorTree } from '@hooks/useMirror';
import { uiKindOf } from '@core/mirror/layerKinds';
import { mirrorPathOps } from '@core/mirror/layerFacts';
import { jsonField } from '@core/mirror/layerFields';
import { edit } from '@core/engine/uiEdits';
import { setCanvasDrag } from '@core/dnd/canvasDrag';
import { applyEffectPresetEdit, enableSimulationEdit } from './effectEdits';
import { EFFECT_CATEGORY, PLUGIN_EFFECTS_CATEGORY, effectCategoryOf } from './effectCategory';
import { effectPreviewFor, EFFECT_PREVIEW_H, EFFECT_PREVIEW_W } from './effectPreviewThumbs';
import {
  flattenFxGroups,
  fxRowHeight,
  stepFxFocus,
  FX_LEAF_ROW_H,
  type FxGroup,
  type FxRow,
} from './EffectsPanelRows';
import styles from './EffectsPanel.module.css';

export { EFFECT_CATEGORY };

/**
 * The presets folder's name. AE's own is "* Animation Presets" — the asterisk
 * is how AE sorts it above the A–Z folders. Here the folder holds EFFECT
 * stacks, and "Animation Presets" already names a different panel (the motion
 * presets), so it keeps the asterisk and says what it lists.
 */
export const EFFECT_PRESETS_FOLDER = '* Effect Presets';

/*
  The effect presets live outside React (the built-ins plus localStorage) and
  now change from two panels: this browser deletes one (Alt-click), Effect
  Controls' ≡ menu saves one. A revision every mounted browser reads keeps
  them all in step with whichever panel made the change.
*/
let presetsRevision = 0;
const presetListeners = new Set<() => void>();
const subscribePresets = (listener: () => void): (() => void) => {
  presetListeners.add(listener);
  return () => { presetListeners.delete(listener); };
};
const presetsRevisionNow = (): number => presetsRevision;

/** Tell every effects browser that the preset list changed (a save or a delete). */
export function notifyEffectPresetsChanged(): void {
  presetsRevision += 1;
  for (const listener of [...presetListeners]) listener();
}

/** The preset list as of revision `_rev` — the revision is what the memo keys on. */
const presetsAt = (_rev: number): EffectPreset[] => listEffectPresets();

/**
 * Star toggle on an effect browser row. Not a `<button>` — the row is already
 * one (same invalid-nesting escape as LibraryBrowser's FavoriteStar). Drawn on
 * the row's hover / focus, or always once starred (EffectsPanel.module.css).
 */
function EffectFavoriteStar({ id, label }: { id: string; label: string }): JSX.Element {
  const { isFavorite, toggle } = useEffectFavorites();
  const on = isFavorite(id);
  const description = on ? `Remove ${label} from favourites` : `Add ${label} to favourites`;
  const activate = (e: { stopPropagation: () => void; preventDefault: () => void }): void => {
    e.stopPropagation();
    e.preventDefault();
    toggle(id);
  };
  return (
    <span
      role="button"
      tabIndex={0}
      className={on ? styles.fxStarOn : styles.fxStar}
      title={description}
      aria-label={description}
      aria-pressed={on}
      onClick={activate}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') activate(e);
      }}
      draggable={false}
      onDragStart={(e) => {
        e.preventDefault();
        e.stopPropagation();
      }}
    >
      <Icon name="star" size="sm" />
    </span>
  );
}

/**
 * One glyph per folder, naming what the folder DOES.
 *
 * Eight rows carrying the same mark is a label repeated eight times, not a set
 * of distinctions — and the row you are scanning for is found by shape long
 * before it is found by reading.
 */
const EFFECT_CATEGORY_ICON: Record<string, IconName> = {
  'Blur & Sharpen': 'blur',
  'Color Correction': 'palette',
  Stylize: 'brush',
  Generate: 'gradient',
  Shape: 'shape',
  Distort: 'waves',
  Perspective: 'cube',
  Channel: 'layers',
  Keying: 'eraser',
  Time: 'clock',
  Transition: 'wipe',
};

/** Folder order: A–Z, as After Effects lists its effect categories. */
const byLabel = (a: FxGroup, b: FxGroup): number => a.label.localeCompare(b.label, 'en');

/** How long the pointer must rest on a row before its preview appears. */
const PREVIEW_DELAY_MS = 250;

/** What the floating preview card is showing, and where. */
interface FxPreview {
  label: string;
  category: string;
  icon: IconName;
  /** A data URL, or null when the effect has no cheap preview path. */
  url: string | null;
  x: number;
  y: number;
}

/**
 * The effect library tree for one target layer: search, favourites, the
 * presets folder, the effect folders, shape operators and simulation.
 *
 * Its own component so another surface can host the SAME browser this panel
 * does. `nodeId` may be null there — the tree still browses and still drags
 * onto a layer; a click says a layer is needed.
 */
export function EffectBrowser({ nodeId }: { nodeId: string | null }): JSX.Element {
  // B4: the target layer's header and property tree (kind, path operators,
  // Cloner / Physics) from the document mirror.
  const tree = useMirrorTree(nodeId);
  const m = documentMirror();
  // A stale id (the layer deleted under an open panel) browses like no
  // selection rather than writing to a node that is gone. A composition's row
  // stays a target, so a click says why it takes no effects.
  const primary = nodeId && (m.layer(nodeId) || m.comp(nodeId)) ? nodeId : null;
  const [effectQuery, setEffectQuery] = useState('');
  const [starredOnly, setStarredOnly] = useState(false);
  /*
    Browser state: which folders the user has toggled away from their default,
    where the keyboard is, and the hover preview.

    The folder map holds OVERRIDES rather than the open set, so "the first
    folder starts open" survives a search that rebuilds the folder list — and
    a folder the user shut stays shut when it comes back.
  */
  const [folderOverride, setFolderOverride] = useState<Record<string, boolean>>({});
  const [focusIndex, setFocusIndex] = useState(0);
  const [preview, setPreview] = useState<FxPreview | null>(null);
  const previewTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const cancelPreview = (): void => {
    if (previewTimer.current !== null) clearTimeout(previewTimer.current);
    previewTimer.current = null;
    setPreview(null);
  };
  // A row unmounted mid-hover (scrolled out of the window, or the panel
  // closed) must not leave a timer that fires into a dead component.
  useEffect(() => () => { if (previewTimer.current !== null) clearTimeout(previewTimer.current); }, []);
  const { favorites: effectFavorites } = useEffectFavorites();
  const presetsRev = useSyncExternalStore(subscribePresets, presetsRevisionNow);
  const presets = useMemo(() => presetsAt(presetsRev), [presetsRev]);
  const builtinPresetNames = useMemo(
    () => new Set(BUILTIN_EFFECT_PRESETS.map((p) => p.name)),
    [],
  );

  // Built-ins then plugin effects, re-read when the plugin set changes — see
  // `useAllEffectDefs`.
  const allDefs = useAllEffectDefs();

  const q = effectQuery.trim().toLowerCase();
  const browserDefs = allDefs.filter((d) => {
    if (starredOnly && !effectFavorites.has(d.type)) return false;
    if (!q) return true;
    return d.label.toLowerCase().includes(q);
  });
  const browserPresets = q
    ? presets.filter((p) => p.name.toLowerCase().includes(q))
    : presets;
  // Every effect in EFFECT_DEFS renders on the unified GPU engine, so nothing
  // is locked. The availability check that used to gate this returned a constant
  // `{ ok: true }`, which left the lock icon, the `disabled` attribute and the
  // unavailable styling permanently unreachable — dead branches that read as if
  // a real capability check were still running. Removed rather than kept as a
  // stub; reinstate a real predicate here if a backend ever stops supporting an
  // effect again.
  const node = primary ? m.layer(primary) : undefined;
  const kind = uiKindOf(node);
  const pathOps = node ? mirrorPathOps(tree) : [];
  const shapeOps = kind === 'shape'
    ? PATH_OP_CATALOG.filter((op) => !q || op.label.toLowerCase().includes(q))
    : [];

  // Simulation modifiers (Cloner / Physics) — not EffectType entries; same
  // browser chrome as Shape ops, enabled on click and edited in Effect Controls.
  const simulationItems = (
    [
      { id: 'cloner' as const, label: 'Cloner', icon: 'grid' as IconName },
      { id: 'physics' as const, label: 'Physics', icon: 'zap' as IconName },
    ] as const
  ).filter((item) => !!primary && (!q || item.label.toLowerCase().includes(q)));

  // A stored config that is switched on (the defaults are off).
  const clonerOn = !!(node && jsonField<{ enabled?: boolean }>(m, node.id, 'layer/cloner')?.enabled);
  const physicsOn = !!(node && jsonField<{ enabled?: boolean }>(m, node.id, 'layer/physics')?.enabled);

  const effectGroups = useMemo(() => {
    const groups: Record<string, typeof browserDefs> = {};
    browserDefs.forEach((d) => {
      const cat = effectCategoryOf(d);
      if (cat) (groups[cat] ??= []).push(d);
    });
    return groups;
  }, [browserDefs]);

  /*
    The browser, as ONE flat array of rows.

    Folders, effects, presets, shape operators and the simulation modifiers all
    become rows of two heights, which is what `VirtualList` needs: a library of
    ninety-odd effects used to mount ninety-odd buttons — each with a star, a
    tag and a drag handler — the moment a folder opened.

    The order is After Effects': the presets folder first, then every other
    folder A–Z (effect categories, Shape, Simulation, Plugins alike).
  */
  const folders: FxGroup[] = [];
  for (const [cat, items] of Object.entries(effectGroups)) {
    if (items.length === 0) continue;
    folders.push({
      id: cat,
      label: cat,
      icon: cat === PLUGIN_EFFECTS_CATEGORY ? 'plugin' : EFFECT_CATEGORY_ICON[cat],
      defaultOpen: false,
      items: items.map((d) => ({
        kind: 'effect' as const,
        id: d.type,
        def: d,
        gpuTag: d.gpuOnly ? ('gpu' as const) : null,
      })),
    });
  }
  if (!starredOnly && shapeOps.length > 0 && node) {
    folders.push({
      id: 'Shape',
      label: 'Shape',
      icon: EFFECT_CATEGORY_ICON.Shape,
      defaultOpen: false,
      items: shapeOps.map((op) => ({
        kind: 'shapeOp' as const,
        id: op.type,
        opType: op.type,
        label: op.label,
        taken: (op.type === 'trim' || op.type === 'repeater') && pathOps.some((o) => o.type === op.type),
      })),
    });
  }
  if (!starredOnly && simulationItems.length > 0) {
    // Simulation — Cloner and Physics, enabled here and edited in Effect
    // Controls. Not EffectType entries, same browser chrome.
    folders.push({
      id: 'Simulation',
      label: 'Simulation',
      icon: 'zap',
      defaultOpen: false,
      items: simulationItems.map((item) => ({
        kind: 'sim' as const,
        id: item.id,
        label: item.label,
        icon: item.icon,
        on: item.id === 'cloner' ? clonerOn : physicsOn,
      })),
    });
  }
  folders.sort(byLabel);
  // The first folder starts open, so the panel never opens on a wall of shut rows.
  if (folders[0]) folders[0] = { ...folders[0], defaultOpen: true };

  const groups: FxGroup[] = [];
  if (!starredOnly && browserPresets.length > 0) {
    groups.push({
      id: 'presets',
      label: EFFECT_PRESETS_FOLDER,
      icon: 'sparkles',
      defaultOpen: false,
      items: browserPresets.map((p) => ({
        kind: 'preset' as const,
        id: p.name,
        name: p.name,
        effectCount: p.items.length,
        userSaved: !builtinPresetNames.has(p.name),
      })),
    });
  }
  groups.push(...folders);

  // Typing is hunting, not browsing: every folder still holding a match opens,
  // and stays open for as long as the query does.
  const rows = flattenFxGroups(groups, (g) => (q ? true : folderOverride[g.id] ?? g.defaultOpen));
  const focus = rows.length === 0 ? 0 : Math.min(focusIndex, rows.length - 1);

  const toggleFolder = (id: string, open: boolean): void => {
    // While a search forces folders open, collapsing would flip invisible
    // state and appear to do nothing — so it is simply not offered.
    if (q) return;
    setFolderOverride((cur) => ({ ...cur, [id]: !open }));
  };

  const activateRow = (row: FxRow): void => {
    if (row.kind === 'folder') {
      toggleFolder(row.id, row.open);
      return;
    }
    // Browsable with nothing selected, so a click names what is missing
    // rather than silently doing nothing.
    if (!primary) {
      useUIStore.getState().notify({ level: 'warning', message: 'Select a layer to add this to', durationMs: 2000 });
      return;
    }
    switch (row.kind) {
      case 'effect':
        addEffectAndReveal(primary, row.def.type);
        break;
      case 'preset':
        void applyEffectPresetEdit(row.name, [primary]);
        revealEffectsInProperties();
        break;
      case 'shapeOp':
        if (row.taken) return;
        void edit(`Add ${row.label}`, {
          type: 'addPropertyGroup', layer: primary, parent: 'contents', matchName: `pathop:${row.opType}`, init: [],
        });
        revealEffectsInProperties();
        break;
      case 'sim':
        void enableSimulationEdit(primary, row.id === 'cloner' ? 'cloner' : 'physics');
        revealEffectsInProperties();
        break;
    }
  };

  const onBrowserKeyDown = (e: React.KeyboardEvent<HTMLDivElement>): void => {
    if (rows.length === 0) return;
    const row = rows[focus];
    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault();
        setFocusIndex(stepFxFocus(rows.length, focus, 1));
        break;
      case 'ArrowUp':
        e.preventDefault();
        setFocusIndex(stepFxFocus(rows.length, focus, -1));
        break;
      case 'ArrowRight':
        if (row?.kind === 'folder' && !row.open) { e.preventDefault(); toggleFolder(row.id, row.open); }
        break;
      case 'ArrowLeft':
        if (row?.kind === 'folder' && row.open) { e.preventDefault(); toggleFolder(row.id, row.open); }
        break;
      case 'Home':
        e.preventDefault();
        setFocusIndex(0);
        break;
      case 'End':
        e.preventDefault();
        setFocusIndex(rows.length - 1);
        break;
      case 'Enter':
      case ' ':
        if (!row) return;
        e.preventDefault();
        activateRow(row);
        break;
      default:
    }
  };

  /**
   * Arm the hover preview. The picture itself is made synchronously from a
   * CSS filter (`effectPreviewThumbs`) and cached for the session, so this
   * costs one `drawImage` per effect per run — but only after the pointer has
   * rested, so scanning down the list makes none at all.
   */
  const armPreview = (e: React.MouseEvent<HTMLElement>, def: EffectDef, category: string): void => {
    if (previewTimer.current !== null) clearTimeout(previewTimer.current);
    const rect = e.currentTarget.getBoundingClientRect();
    previewTimer.current = setTimeout(() => {
      previewTimer.current = null;
      setPreview({
        label: def.label,
        category,
        icon: EFFECT_CATEGORY_ICON[category] ?? 'zap',
        // Null when the effect is GPU-only or its filter cannot be built —
        // the card then shows its icon and folder instead of pretending.
        url: effectPreviewFor(def),
        x: Math.max(8, rect.left - EFFECT_PREVIEW_W - 20),
        y: Math.max(8, rect.top - 6),
      });
    }, PREVIEW_DELAY_MS);
  };

  const favouritesLabel = starredOnly ? 'Show all effects' : 'Show favourites only';

  return (
    <div className={styles.browser}>
      {/* The toolbar: one row — the search, then the favourites filter. */}
      <div className={styles.searchRow} role="toolbar" aria-label="Effects and presets tools">
        <SearchField
          value={effectQuery}
          placeholder="Search effects and presets"
          ariaLabel="Search effects and presets"
          size="sm"
          onChange={setEffectQuery}
        />
        <IconButton
          size="sm"
          variant="ghost"
          active={starredOnly}
          aria-label={favouritesLabel}
          aria-pressed={starredOnly}
          tooltip={favouritesLabel}
          onClick={() => setStarredOnly((v) => !v)}
        >
          <Icon name="star" size="sm" />
        </IconButton>
      </div>
      {rows.length > 0 ? (
        <div
          className={styles.browserList}
          role="tree"
          aria-label="Effects and presets"
          tabIndex={0}
          onKeyDown={onBrowserKeyDown}
          onMouseLeave={cancelPreview}
        >
          <VirtualList
            items={rows}
            itemHeight={FX_LEAF_ROW_H}
            getItemHeight={fxRowHeight}
            itemKey={(r) => r.key}
            scrollToIndex={focus}
            onScroll={cancelPreview}
            renderItem={(row, i) => {
              const active = i === focus;
              if (row.kind === 'folder') {
                return (
                  <button
                    type="button"
                    className={styles.fxFolderRow}
                    data-active={active || undefined}
                    aria-expanded={row.open}
                    title={row.label}
                    onClick={() => { setFocusIndex(i); toggleFolder(row.id, row.open); }}
                  >
                    <Icon name={row.open ? 'chevron-down' : 'chevron-right'} size="sm" className={styles.fxFolderTwisty} />
                    {row.icon ? <Icon name={row.icon} size="md" className={styles.fxFolderIcon} /> : null}
                    <span className={styles.fxFolderName}>{row.label}</span>
                    <span className={styles.fxFolderCount}>{row.count}</span>
                  </button>
                );
              }
              if (row.kind === 'preset') {
                return (
                  <BrowserRow
                    className={styles.fxLeafRow}
                    label={row.name}
                    icon="sparkles"
                    selected={active}
                    title={
                      row.userSaved
                        ? `Apply "${row.name}" (${row.effectCount} effect(s)) — Alt-click deletes`
                        : `Apply "${row.name}" (${row.effectCount} effect(s))`
                    }
                    onClick={(e) => {
                      // A double-click is two clicks; applying on both
                      // stacked the preset twice.
                      if (e.detail > 1) return;
                      setFocusIndex(i);
                      if (row.userSaved && e.altKey) {
                        deleteEffectPreset(row.name);
                        notifyEffectPresetsChanged();
                        return;
                      }
                      activateRow(row);
                    }}
                  />
                );
              }
              if (row.kind === 'shapeOp') {
                return (
                  <BrowserRow
                    className={styles.fxLeafRow}
                    label={row.label}
                    fx
                    selected={active}
                    title={row.taken ? `${row.label} is already on this layer` : `Add ${row.label}`}
                    onClick={(e) => { if (e.detail > 1) return; setFocusIndex(i); activateRow(row); }}
                  />
                );
              }
              if (row.kind === 'sim') {
                return (
                  <BrowserRow
                    className={styles.fxLeafRow}
                    label={row.label}
                    icon={row.icon}
                    selected={active}
                    right={row.on ? <BrowserTag>On</BrowserTag> : undefined}
                    title={row.on ? `Edit ${row.label} in Effect Controls` : `Add ${row.label}`}
                    onClick={(e) => { if (e.detail > 1) return; setFocusIndex(i); activateRow(row); }}
                  />
                );
              }
              const d = row.def;
              return (
                /*
                  The hover host, not the row: `BrowserRow` is a shared
                  presentational button and teaching it about previews would
                  push effect-specific knowledge into a component the library
                  browser also uses.
                */
                <div
                  className={styles.fxRowHost}
                  onMouseEnter={(e) => armPreview(e, d, row.folder)}
                  onMouseLeave={cancelPreview}
                >
                  <BrowserRow
                    className={styles.fxLeafRow}
                    label={d.label}
                    fx
                    selected={active}
                    /*
                      A plugin effect on the WebGL2 tier is WGSL with no
                      pipeline to compile it, so it renders its input unchanged.
                      Tagged here rather than left to be discovered: otherwise
                      it adds cleanly, shows its parameters, and changes no
                      pixels — which reads as a broken plugin.

                      Still listed, still addable. It is saved with the project
                      and draws on a machine that has WebGPU, so hiding it would
                      make a document depend on which laptop authored it.
                    */
                    right={
                      <>
                        <EffectFavoriteStar id={d.type} label={d.label} />
                        {row.gpuTag === 'no-webgpu' ? <BrowserTag>No WebGPU</BrowserTag> : null}
                        {row.gpuTag === 'gpu' ? <BrowserTag>GPU</BrowserTag> : null}
                      </>
                    }
                    title={
                      row.gpuTag === 'no-webgpu'
                        ? `${d.label} needs WebGPU — this machine is on the WebGL2 fallback. `
                          + 'It is saved with your project and renders on a machine that has it.'
                        : `Add ${d.label} — or drag onto a layer`
                    }
                    draggable
                    onDragStart={(e) => { cancelPreview(); setCanvasDrag(e, { kind: 'effect', effectType: d.type }); }}
                    onClick={(e) => { if (e.detail > 1) return; setFocusIndex(i); activateRow(row); }}
                  />
                </div>
              );
            }}
          />
        </div>
      ) : (
        <p className={styles.help} role="status">
          {starredOnly && effectFavorites.size === 0
            ? 'No favourite effects yet — star one to pin it here.'
            : starredOnly
              ? 'No favourite effects match this search.'
              : `No effects match “${effectQuery}”.`}
        </p>
      )}
      {preview && (
        <div className={styles.fxPreviewCard} style={{ top: preview.y, left: preview.x }} role="presentation">
          {preview.url ? (
            <img
              className={styles.fxPreviewImg}
              src={preview.url}
              alt=""
              width={EFFECT_PREVIEW_W}
              height={EFFECT_PREVIEW_H}
            />
          ) : (
            <div className={styles.fxPreviewFallback}>
              <Icon name={preview.icon} size="lg" />
            </div>
          )}
          <div className={styles.fxPreviewCaption}>
            <span className={styles.fxPreviewName}>{preview.label}</span>
            <span className={styles.fxPreviewCat}>{preview.url ? preview.category : `${preview.category} · no preview`}</span>
          </div>
        </div>
      )}
    </div>
  );
}

/**
 * The right-inspector Effects & Presets panel. Needs a layer — with none it
 * says so in one line instead of offering a search box for a library nothing
 * can be added to.
 */
export function EffectsPanel(): JSX.Element {
  const primary = useSelectionStore((s) => s.primary);
  // B4: the selected layer's header from the document mirror.
  const layer = useMirrorLayer(primary);
  const hasSelection = !!(primary && layer);

  // NOTE: the empty-state early return must come AFTER every hook — returning
  // before one changed the hook count the moment a layer was selected, which
  // is a Rules-of-Hooks crash that took the whole editor down with it.
  if (!hasSelection || !primary) {
    return (
      <div className={styles.root}>
        <p className={styles.help}>Select a layer to add effects to it.</p>
      </div>
    );
  }

  return (
    <div className={styles.root}>
      <EffectBrowser nodeId={primary} />
    </div>
  );
}

export default EffectsPanel;
