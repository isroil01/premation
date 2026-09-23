/**
 * EffectsPanel — the right-inspector library of effect types (AE's Effects &
 * Presets). Click a row to add it to the selected layer; the applied stack
 * itself lives in the left-sidebar Effect Controls panel, because keeping both
 * in this tab buried the browser under every effect you applied.
 *
 * Masks stay here: they are added from this palette (rectangle / ellipse /
 * pen), the same way AE adds them from a tool rather than from Effect Controls.
 */

import { useEffect, useRef, useState, useMemo } from 'react';
import { Icon, type IconName } from '@components/Icon';
import { SearchField } from '@components/SearchField';
import { ValueField } from '@components/ValueField';
import { Checkbox } from '@components/Checkbox';
import { PropertyRow } from '@components/PropertyRow';
import { EmptyState } from '@components/EmptyState';
import { Dropdown } from '@components/Dropdown';
import { VirtualList } from '@components/VirtualList';
import { BrowserRow, BrowserTag, BrowserEmpty } from '@components/BrowserTree';
import { useSelectionStore } from '@stores/selectionStore';
import { useSceneRevision } from '@stores/sceneStore';
import { useActiveWorkspace } from '@stores/projectStore';
import { useUIStore } from '@stores/uiStore';
import defaultSceneGraph from '@core/scene/DefaultSceneGraph';
import { getNodeEffects, type EffectDef } from '@core/effects/effects';
import { pluginEffectsCanRender, PLUGIN_EFFECT_CATEGORY } from '@core/effects/pluginEffectDefs';
import { addEffectAndReveal, revealEffectsInProperties } from './revealEffectControls';
import { useAllEffectDefs, useEffectFavorites } from './effectCatalog';
import {
  copyAllEffects,
  hasEffectClipboard,
  effectClipboardSize,
  saveEffectPreset,
  deleteEffectPreset,
  listEffectPresets,
} from '@core/effects/effectClipboard';
import { BUILTIN_EFFECT_PRESETS } from '@core/effects/builtinEffectPresets';
import { customPrompt } from '@components/Modal/Dialogs';
import { PATH_OP_CATALOG, readTrimOp, readRepeaterOp } from '@core/scene/pathOps';
import {
  getNodeMask,
  readNodeMaskAt,
  rectangleMask,
  ellipseMask,
  hasMaskAnim,
  type MaskMode,
  type MaskPath,
} from '@core/effects/mask';
import { layerTimeFor } from '@core/inspector/multiSelection';
import { edit } from '@core/engine/uiEdits';
import { useEngineEdit } from '@layout/Inspector/useEngineEdit';
import { SIZE } from '@core/rendering/buildSnapshot';
import { readNodeKind } from '@core/scene/sceneDerive';
import { setCanvasDrag } from '@core/dnd/canvasDrag';
import { readNodeCloner } from '@core/scene/clonerExpand';
import { readNodePhysics } from '@core/simulation/physicsBodies';
import {
  addMaskEdit,
  applyEffectPresetEdit,
  legacyEnableSimulation,
  legacyPatchAnimatedMask,
  legacySetMaskVertexFeather,
  maskValueCommands,
  pasteEffectsEdit,
  removeMaskEdit,
  renameMaskEdit,
  setMaskInvertedEdit,
  setMaskModeEdit,
  setMaskShapeAnimatedEdit,
} from './effectEdits';
import { EFFECT_CATEGORY } from './effectCategory';
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
 * Star toggle on an effect browser row. Not a `<button>` — the row is already
 * one (same invalid-nesting escape as LibraryBrowser's FavoriteStar).
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

// AE menu order — `None` leads, because it is the "this path does not cut"
// option rather than a variant of the set operations below it.
const MASK_MODES: ReadonlyArray<{ mode: MaskMode; label: string }> = [
  { mode: 'none', label: 'None' },
  { mode: 'add', label: 'Add' },
  { mode: 'subtract', label: 'Subtract' },
  { mode: 'intersect', label: 'Intersect' },
  { mode: 'lighten', label: 'Lighten' },
  { mode: 'darken', label: 'Darken' },
  { mode: 'difference', label: 'Difference' },
];

/** Folder order in the browser — most-reached-for first. */
const EFFECT_CATEGORY_ORDER: readonly string[] = [
  'Blur & Sharpen', 'Color Correction', 'Stylize', 'Generate',
  'Shape',
  'Distort', 'Perspective', 'Channel', 'Keying', 'Time', 'Transition',
  /*
    Last, and its OWN folder rather than sorted into the others by guesswork.

    Someone looking for what a plugin added knows it came from a plugin.
    Scattering them through folders organised by what an effect DOES would make
    them findable only by remembering the name — and two plugins may both ship
    a "Glow", which is why the label carries the plugin's name too.

    Empty for almost everyone; `browserFolders` drops empty groups, so the
    folder simply does not appear until something is installed.
  */
  PLUGIN_EFFECT_CATEGORY,
];

/**
 * One glyph per folder, naming what the folder DOES.
 *
 * Eight rows carrying the same mark is a label repeated eight times, not a set
 * of distinctions — and the row you are scanning for is found by shape long
 * before it is found by reading. Keyed by the same strings as
 * `EFFECT_CATEGORY_ORDER`, so a new folder is a compile error until it has one.
 */
const EFFECT_CATEGORY_ICON: Record<string, IconName> = {
  'Blur & Sharpen': 'blur',
  'Color Correction': 'palette',
  Stylize: 'brush',
  [PLUGIN_EFFECT_CATEGORY]: 'plugin',
  Generate: 'gradient',
  Shape: 'shape',
  Distort: 'waves',
  Perspective: 'cube',
  Channel: 'layers',
  Keying: 'eraser',
  Time: 'clock',
  Transition: 'wipe',
};

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
 * The effect library tree for one target layer: stack clipboard chips, search,
 * folders, favourites, effect presets, shape operators and simulation.
 *
 * Its own component so the Library's Effects section hosts the SAME browser
 * this panel does. `nodeId` may be null there — the tree still browses and
 * still drags onto a layer; a click says a layer is needed.
 */
export function EffectBrowser({ nodeId }: { nodeId: string | null }): JSX.Element {
  useSceneRevision((s) => s.rev);
  // A stale id (the layer deleted under an open Library) browses like no
  // selection rather than writing to a node that is gone.
  const primary = nodeId && defaultSceneGraph.getNode(nodeId) ? nodeId : null;
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
  // The clipboard and the preset list live outside React (module state and
  // localStorage), so a counter is what tells this panel they changed.
  const [clipboardRev, bumpClipboard] = useState(0);
  const presets = useMemo(() => listEffectPresets(), [clipboardRev]);
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
  const node = primary ? defaultSceneGraph.getNode(primary) : undefined;
  const kind = node ? readNodeKind(node) : null;
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

  const clonerOn = !!(node && readNodeCloner(node));
  const physicsOn = !!(node && readNodePhysics(node));

  const effectGroups = useMemo(() => {
    const groups: Record<string, typeof browserDefs> = {};
    for (const cat of EFFECT_CATEGORY_ORDER) groups[cat] = [];
    browserDefs.forEach((d) => {
      // A plugin effect's type is namespaced and so is absent from the
      // built-in `Record`, which would otherwise file it under `undefined` —
      // a group `EFFECT_CATEGORY_ORDER` never renders, so the effect would be
      // installed, listed by `pluginEffectDefs`, and invisible.
      const cat = EFFECT_CATEGORY[d.type] ?? PLUGIN_EFFECT_CATEGORY;
      (groups[cat] ??= []).push(d);
    });
    return groups;
  }, [browserDefs]);

  const browserFolders = useMemo(
    () => Object.entries(effectGroups).filter(([, items]) => items.length > 0),
    [effectGroups],
  );

  /*
    The browser, as ONE flat array of rows.

    Folders, effects, presets, shape operators and the simulation modifiers all
    become rows of two heights, which is what `VirtualList` needs: a library of
    ninety-odd effects used to mount ninety-odd buttons — each with a star, a
    tag and a drag handler — the moment a folder opened.
  */
  const groups: FxGroup[] = [];
  if (!starredOnly && browserPresets.length > 0) {
    groups.push({
      id: 'presets',
      label: 'Effect Presets',
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
  browserFolders.forEach(([cat, items], index) => {
    const pluginNoGpu = cat === PLUGIN_EFFECT_CATEGORY && !pluginEffectsCanRender();
    groups.push({
      id: cat,
      label: cat,
      icon: EFFECT_CATEGORY_ICON[cat],
      defaultOpen: index === 0,
      items: items.map((d) => ({
        kind: 'effect' as const,
        id: d.type,
        def: d,
        gpuTag: pluginNoGpu ? ('no-webgpu' as const) : d.gpuOnly ? ('gpu' as const) : null,
      })),
    });
  });
  if (!starredOnly && shapeOps.length > 0 && node) {
    groups.push({
      id: 'Shape',
      label: 'Shape',
      icon: EFFECT_CATEGORY_ICON.Shape,
      defaultOpen: browserFolders.length === 0,
      items: shapeOps.map((op) => ({
        kind: 'shapeOp' as const,
        id: op.type,
        opType: op.type,
        label: op.label,
        taken: (op.type === 'trim' && !!readTrimOp(node)) || (op.type === 'repeater' && !!readRepeaterOp(node)),
      })),
    });
  }
  if (!starredOnly && simulationItems.length > 0) {
    // Simulation — Cloner and Physics, enabled here and edited in Effect
    // Controls. Not EffectType entries, same browser chrome.
    groups.push({
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
    // Browsable with nothing selected (the Library hosts this tree), so a
    // click names what is missing rather than silently doing nothing.
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
        bumpClipboard((n) => n + 1);
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
        legacyEnableSimulation(primary, row.id === 'cloner' ? 'cloner' : 'physics');
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

  return (
    <>
      <div className={styles.addRow}>
        <button
          type="button"
          className={styles.addChip}
          disabled={!primary || getNodeEffects(primary).length === 0}
          title="Copy this layer's whole effect stack"
          onClick={() => {
            if (!primary) return;
            copyAllEffects(primary);
            bumpClipboard((n) => n + 1);
          }}
        >
          <Icon name="copy" size="sm" /> Copy Stack
        </button>
        <button
          type="button"
          className={styles.addChip}
          disabled={!primary || !hasEffectClipboard()}
          title={hasEffectClipboard() ? `Paste ${effectClipboardSize()} effect(s) onto this layer` : 'Nothing copied yet'}
          onClick={() => {
            if (!primary) return;
            void pasteEffectsEdit([primary]);
            bumpClipboard((n) => n + 1);
            revealEffectsInProperties();
          }}
        >
          <Icon name="plus" size="sm" /> Paste
        </button>
        <button
          type="button"
          className={styles.addChip}
          disabled={!primary || getNodeEffects(primary).length === 0}
          title="Save this stack as a reusable preset"
          onClick={() => {
            if (!primary) return;
            void (async () => {
              const name = await customPrompt(
                'Save Effect Preset',
                'Name this effect stack so you can apply it to other layers.',
                '',
                { placeholder: 'My preset', confirmLabel: 'Save' },
              );
              if (name?.trim()) { saveEffectPreset(primary, name.trim()); bumpClipboard((n) => n + 1); }
            })();
          }}
        >
          <Icon name="star" size="sm" /> Save Preset
        </button>
      </div>
      <div className={styles.browser}>
        <div className={styles.searchRow}>
          <SearchField
            value={effectQuery}
            placeholder="Search effects…"
            ariaLabel="Search effects"
            size="sm"
            onChange={setEffectQuery}
          />
          <button
            type="button"
            className={starredOnly ? styles.fxStarFilterOn : styles.fxStarFilter}
            title={starredOnly ? 'Show all effects' : 'Show favourites only'}
            aria-label={starredOnly ? 'Show all effects' : 'Show favourites only'}
            aria-pressed={starredOnly}
            onClick={() => setStarredOnly((v) => !v)}
          >
            <Icon name="star" size="sm" />
          </button>
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
                          bumpClipboard((n) => n + 1);
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
          <BrowserEmpty>
            {starredOnly && effectFavorites.size === 0
              ? 'No favourite effects yet — star one to pin it here.'
              : starredOnly
                ? 'No favourite effects match this search.'
                : `No effects match “${effectQuery}”.`}
          </BrowserEmpty>
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
    </>
  );
}

/**
 * One mask's card: header band (name, mode, remove), then its values.
 *
 * Every edit is an engine command (B3): Rectangle / Ellipse / Remove / Mode /
 * Inverted / Name are one entry each, a Feather / Opacity / Expansion scrub is
 * one gesture. Two things keep the legacy writer, both engine gaps: values of a
 * mask whose SHAPE is keyframed (they belong in the shape keyframe at the
 * playhead) and per-vertex feather.
 */
function MaskCard({
  nodeId,
  mask: m,
  index: i,
  time,
  shapeKeyed,
}: {
  nodeId: string;
  mask: MaskPath;
  index: number;
  /** The playhead, comp seconds. */
  time: number;
  shapeKeyed: boolean;
}): JSX.Element {
  const e = useEngineEdit();
  // The name commits on blur / Enter — one "Rename Mask" entry, not one per keystroke.
  const [draft, setDraft] = useState<string | null>(null);
  const commitName = (): void => {
    if (draft === null) return;
    const next = draft.trim();
    setDraft(null);
    if (next !== (m.name ?? '')) void renameMaskEdit(nodeId, m.id, next);
  };
  const setValue = (key: 'feather' | 'opacity' | 'expansion', v: number, label: string): void => {
    const cmds = maskValueCommands(nodeId, m.id, key, v, time);
    if (cmds) e.send(label, cmds);
    else legacyPatchAnimatedMask(nodeId, m.id, key === 'opacity' ? { opacity: v / 100 } : { [key]: v }, time);
  };
  const onEngine = (): boolean => !shapeKeyed;
  const variable = m.points.some((pt) => typeof pt.feather === 'number');

  return (
    // Same card as an applied effect: header band, then the parameters
    // under it. A mask IS a per-layer item with a mode and a handful of
    // values, exactly like an effect, and the panel showing the two in
    // two different shapes was the only reason they read as unrelated.
    <div className={styles.effectCardItem}>
      <div className={styles.effectCardHead}>
        <span className={styles.maskMark} aria-hidden>
          <Icon name="mask-square" size="sm" />
        </span>
        <span className={styles.itemLabel}>{m.name?.trim() || `Mask ${i + 1}`}</span>
        <Dropdown
          placement="left-start"
          trigger={
            <button type="button" className={styles.blendTrigger}>
              {MASK_MODES.find((x) => x.mode === m.mode)?.label ?? 'Add'}
              <Icon name="chevron-down" size="sm" />
            </button>
          }
          items={MASK_MODES.map((x) => ({
            type: 'item',
            id: x.mode,
            label: x.label,
            icon: x.mode === m.mode ? 'check' : undefined,
            onSelect: () => { void setMaskModeEdit(nodeId, m.id, x.mode); },
          }))}
        />
        <div className={styles.itemActions}>
          <button
            type="button"
            className={styles.remove}
            aria-label={`Remove Mask ${i + 1}`}
            title={`Remove Mask ${i + 1}`}
            onClick={() => { void removeMaskEdit(nodeId, m.id, `Remove Mask ${i + 1}`); }}
          >
            <Icon name="close" size="sm" />
          </button>
        </div>
      </div>
      <div className={styles.effectParamsBody}>
        <PropertyRow label="Name" compact>
          <input
            value={draft ?? m.name ?? ''}
            placeholder={`Mask ${i + 1}`}
            aria-label={`Mask ${i + 1} name`}
            onChange={(ev) => setDraft(ev.target.value)}
            onBlur={commitName}
            onKeyDown={(ev) => {
              if (ev.key === 'Enter') ev.currentTarget.blur();
              else if (ev.key === 'Escape') { setDraft(null); ev.currentTarget.blur(); }
            }}
            style={{
              width: '100%',
              fontSize: 'var(--font-size-xs)',
              padding: '2px 6px',
              borderRadius: 4,
              border: '1px solid var(--color-border, #333)',
              background: 'var(--color-surface, #1e1e1e)',
              color: 'inherit',
            }}
          />
        </PropertyRow>
        {/* One PropertyRow per value, so a mask's Feather sits in the
            same column as an effect's Softness rather than in a
            three-up strip of its own. */}
        <PropertyRow label="Feather" compact>
          <ValueField {...e.scrub('Set Mask Feather', onEngine)} value={m.feather} min={0} max={200} precision={0} unit="px"
            onChange={(v) => setValue('feather', v, 'Set Mask Feather')} aria-label="Mask feather" />
        </PropertyRow>
        {/* Variable-width feather: one row per vertex. A vertex with
            its own value overrides the uniform Feather above and the
            softness interpolates along the outline between vertices
            (the distance-field renderer in maskFeather.ts). Right-side
            clear button drops the override — every override cleared
            returns the path to the plain blur renderer. */}
        <PropertyRow label="Per-Vertex" compact>
          <Checkbox
            checked={variable}
            onChange={() => {
              // Toggle ON seeds every vertex at the uniform value (so
              // nothing visibly changes until a vertex is edited);
              // toggle OFF clears every override.
              legacySetMaskVertexFeather(nodeId, m.id, m.points.map((_, vi) => ({ index: vi, feather: variable ? undefined : m.feather })), time);
            }}
            aria-label={`Variable feather for Mask ${i + 1}`}
            style={{ width: 14, height: 14 }}
          />
        </PropertyRow>
        {variable &&
          m.points.map((pt, vi) => (
            <PropertyRow key={vi} label={`  V${vi + 1}`} compact>
              <ValueField
                value={Math.round(pt.feather ?? m.feather)}
                min={0} max={200} precision={0} unit="px"
                onChange={(v) => legacySetMaskVertexFeather(nodeId, m.id, [{ index: vi, feather: v }], time)}
                aria-label={`Mask ${i + 1} vertex ${vi + 1} feather`}
              />
            </PropertyRow>
          ))}
        <PropertyRow label="Opacity" compact>
          <ValueField {...e.scrub('Set Mask Opacity', onEngine)} value={Math.round(m.opacity * 100)} min={0} max={100} precision={0} unit="%"
            onChange={(v) => setValue('opacity', v, 'Set Mask Opacity')} aria-label="Mask opacity" />
        </PropertyRow>
        <PropertyRow label="Expansion" compact>
          <ValueField {...e.scrub('Set Mask Expansion', onEngine)} value={Math.round(m.expansion ?? 0)} min={-500} max={500} precision={0} unit="px"
            onChange={(v) => setValue('expansion', v, 'Set Mask Expansion')} aria-label="Mask expansion" />
        </PropertyRow>
        <PropertyRow label="Inverted" compact>
          <Checkbox
            checked={!!m.inverted}
            onChange={() => { void setMaskInvertedEdit(nodeId, m.id, !m.inverted); }}
            aria-label={`Invert Mask ${i + 1}`}
            style={{ width: 14, height: 14 }}
          />
        </PropertyRow>
      </div>
    </div>
  );
}

/**
 * The right-inspector Effects panel: the browser above, the selected layer's
 * masks below. Needs a layer — with none it says so instead of offering a
 * search box for a library nothing can be added to.
 */
export function EffectsPanel(): JSX.Element {
  const primary = useSelectionStore((s) => s.primary);
  useSceneRevision((s) => s.rev);
  // The playhead (comp seconds): engine edits take comp time and the engine
  // maps it onto the layer's keyframe axis. The mask DISPLAY is read on that
  // axis — where the renderer reads the mask — so a moved or trimmed layer
  // shows the shape that actually draws.
  const maskCompTime = useActiveWorkspace()?.time ?? 0;
  const hasSelection = !!(primary && defaultSceneGraph.getNode(primary));

  // NOTE: the empty-state early return must come AFTER every hook — returning
  // before one changed the hook count the moment a layer was selected, which
  // is a Rules-of-Hooks crash that took the whole editor down with it.
  if (!hasSelection || !primary) {
    return (
      <EmptyState
        icon="zap"
        title="No selection"
        message="Select a layer to add blurs, colour effects and masks to it."
      />
    );
  }

  const node = defaultSceneGraph.getNode(primary);
  const kind = node ? readNodeKind(node) : 'shape';
  const layerKind = kind === 'text' || kind === 'image' || kind === 'video' ? kind : 'shape';
  const { w: maskW, h: maskH } = SIZE[layerKind];
  // Display read (B4's mirror replaces it): the playhead on the layer's keyframe axis.
  const maskTime = layerTimeFor(primary, '', maskCompTime);
  // The mask the renderer draws at the playhead — an animated mask's
  // interpolated shape, whose values the edits below patch — not the static
  // shape it stops reading once keyed (same read as the Layer panel).
  const masks = node ? (readNodeMaskAt(node, maskTime) ?? getNodeMask(primary)).paths : [];
  const shapeKeyed = !!node && hasMaskAnim(node);

  return (
    <div className={styles.root}>
      {/* Effects & Presets browser — the AE library tree of effect types. */}
      <div className={styles.sectionTitle}>Effects &amp; Presets</div>
      <EffectBrowser nodeId={primary} />

      <div className={styles.sectionTitle}>Masks</div>
      {!hasSelection && (
        <p className={styles.hint} style={{ margin: '0 0 8px', fontSize: 'var(--font-size-xs)', color: 'var(--color-text-tertiary)' }}>
          Select a layer, then draw with Mask Rectangle / Ellipse / Pen in the toolbar.
        </p>
      )}
      <div className={styles.addRow}>
        <button
          type="button"
          className={styles.addChip}
          disabled={!hasSelection}
          title={hasSelection ? 'Add a rectangle mask' : 'Select a layer first'}
          onClick={() => { if (primary) void addMaskEdit(primary, rectangleMask(maskW, maskH), 'Add Rectangle Mask'); }}
        >
          <Icon name="plus" size="sm" /> Rectangle
        </button>
        <button
          type="button"
          className={styles.addChip}
          disabled={!hasSelection}
          title={hasSelection ? 'Add an ellipse mask' : 'Select a layer first'}
          onClick={() => { if (primary) void addMaskEdit(primary, ellipseMask(maskW, maskH), 'Add Ellipse Mask'); }}
        >
          <Icon name="plus" size="sm" /> Ellipse
        </button>
        <button
          type="button"
          className={styles.addChip}
          disabled={!hasSelection}
          title="Switch to the Mask Pen tool"
          onClick={() => useUIStore.getState().setActiveTool('mask-pen')}
        >
          <Icon name="pen" size="sm" /> Draw
        </button>
        {masks.length > 0 && (
          <button
            type="button"
            className={styles.addChip}
            title={shapeKeyed ? 'Remove mask animation' : 'Keyframe the mask shape at the playhead (animate the mask)'}
            onClick={() => { void setMaskShapeAnimatedEdit(primary, masks[0]!.id, !shapeKeyed, maskCompTime); }}
          >
            <Icon name="keyframe" size="sm" /> {shapeKeyed ? 'Un-animate' : 'Keyframe shape'}
          </button>
        )}
      </div>

      {masks.length > 0 && (
        <div className={styles.stackList}>
          {masks.map((m, i) => (
            <MaskCard key={m.id} nodeId={primary} mask={m} index={i} time={maskCompTime} shapeKeyed={shapeKeyed} />
          ))}
        </div>
      )}
    </div>
  );
}

export default EffectsPanel;
