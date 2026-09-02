/**
 * EffectsPanel — the right-inspector library of effect types (AE's Effects &
 * Presets). Click a row to add it to the selected layer; the applied stack
 * itself lives in the left-sidebar Effect Controls panel, because keeping both
 * in this tab buried the browser under every effect you applied.
 *
 * Masks stay here: they are added from this palette (rectangle / ellipse /
 * pen), the same way AE adds them from a tool rather than from Effect Controls.
 */

import { useState, useMemo, useSyncExternalStore } from 'react';
import { Icon, type IconName } from '@components/Icon';
import { SearchField } from '@components/SearchField';
import { ValueField } from '@components/ValueField';
import { Checkbox } from '@components/Checkbox';
import { PropertyRow } from '@components/PropertyRow';
import { EmptyState } from '@components/EmptyState';
import { Dropdown } from '@components/Dropdown';
import { BrowserTree, BrowserFolder, BrowserRow, BrowserTag, BrowserEmpty } from '@components/BrowserTree';
import { useSelectionStore } from '@stores/selectionStore';
import { useSceneRevision } from '@stores/sceneStore';
import { useActiveWorkspace } from '@stores/projectStore';
import { useUIStore } from '@stores/uiStore';
import { usePreferenceStore } from '@stores/preferenceStore';
import defaultSceneGraph from '@core/scene/DefaultSceneGraph';
import { EFFECT_DEFS, getNodeEffects } from '@core/effects/effects';
import { pluginEffectDefs, pluginEffectsCanRender, PLUGIN_EFFECT_CATEGORY } from '@core/effects/pluginEffectDefs';
import { subscribeToEffects, pluginEffectRevision } from '@core/plugins/pluginEffects';
import { addEffectAndReveal, revealEffectControls } from './revealEffectControls';
import {
  copyAllEffects,
  pasteEffects,
  hasEffectClipboard,
  effectClipboardSize,
  saveEffectPreset,
  applyEffectPreset,
  deleteEffectPreset,
  listEffectPresets,
} from '@core/effects/effectClipboard';
import { BUILTIN_EFFECT_PRESETS } from '@core/effects/builtinEffectPresets';
import { customPrompt } from '@components/Modal/Dialogs';
import {
  PATH_OP_CATALOG,
  addPathOp,
  defaultPathOpOf,
  readTrimOp,
  readRepeaterOp,
} from '@core/scene/pathOps';
import {
  getNodeMask,
  addMaskPath,
  updateMaskPath,
  setMaskPointFeather,
  removeMaskPath,
  rectangleMask,
  ellipseMask,
  keyframeMask,
  clearMaskAnim,
  hasMaskAnim,
  type MaskMode,
} from '@core/effects/mask';
import { SIZE } from '@core/rendering/buildSnapshot';
import { readNodeKind } from '@core/scene/sceneDerive';
import { setCanvasDrag } from '@core/dnd/canvasDrag';
import { enableNodeCloner, readNodeCloner } from '@core/scene/clonerExpand';
import { enableNodePhysics, readNodePhysics } from '@core/simulation/physicsBodies';
import { EFFECT_CATEGORY } from './effectCategory';
import styles from './EffectsPanel.module.css';

export { EFFECT_CATEGORY };

/** Starred effect type ids — preference, same rationale as library favourites. */
function useEffectFavorites(): {
  favorites: ReadonlySet<string>;
  toggle: (id: string) => void;
  isFavorite: (id: string) => boolean;
} {
  const list = usePreferenceStore((s) => s.effectFavorites);
  const setPref = usePreferenceStore((s) => s.set);
  const favorites = useMemo(() => new Set(list), [list]);
  return {
    favorites,
    isFavorite: (id) => favorites.has(id),
    toggle: (id) =>
      setPref('effectFavorites', favorites.has(id) ? list.filter((x) => x !== id) : [...list, id]),
  };
}

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

export function EffectsPanel(): JSX.Element {
  const primary = useSelectionStore((s) => s.primary);
  useSceneRevision((s) => s.rev);
  const maskTime = useActiveWorkspace()?.time ?? 0;
  const [effectQuery, setEffectQuery] = useState('');
  const [starredOnly, setStarredOnly] = useState(false);
  const { favorites: effectFavorites } = useEffectFavorites();
  // The clipboard and the preset list live outside React (module state and
  // localStorage), so a counter is what tells this panel they changed.
  const [clipboardRev, bumpClipboard] = useState(0);
  const presets = useMemo(() => listEffectPresets(), [clipboardRev]);
  const builtinPresetNames = useMemo(
    () => new Set(BUILTIN_EFFECT_PRESETS.map((p) => p.name)),
    [],
  );

  // NOTE: the empty-state early return must come AFTER every hook — the
  // browser-accordion useMemos below run on every render, and returning before
  // them changed the hook count the moment a layer was selected, which is a
  // Rules-of-Hooks crash that took the whole editor down with it.
  const hasSelection = !!(primary && defaultSceneGraph.getNode(primary));

  /*
    Plugin effects are appended to the built-ins, not merged into them.

    `EFFECT_DEFS` is a module-level constant; the plugin set changes while the
    app runs — a plugin is enabled, disabled, updated, or turned off after a
    device loss. So it is read through the store's revision, which is what makes
    this list re-render rather than showing whatever was installed at load.
  */
  const pluginRev = useSyncExternalStore(subscribeToEffects, () => pluginEffectRevision());
  const allDefs = useMemo(
    () => [...EFFECT_DEFS, ...pluginEffectDefs()],
    // `pluginRev` is the dependency that matters; `pluginEffectDefs()` reads
    // module state and would otherwise be memoised against nothing.
    [pluginRev],
  );

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
  const node = hasSelection ? defaultSceneGraph.getNode(primary!) : undefined;
  const kind = node ? readNodeKind(node) : 'shape';
  const layerKind = kind === 'text' || kind === 'image' || kind === 'video' ? kind : 'shape';
  const { w: maskW, h: maskH } = SIZE[layerKind];
  const masks = hasSelection ? getNodeMask(primary!).paths : [];
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
  ).filter((item) => !q || item.label.toLowerCase().includes(q));

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

  // Every hook above has run — returning here is now hook-count-stable.
  if (!hasSelection || !primary) {
    return (
      <EmptyState
        icon="zap"
        title="No selection"
        message="Select a layer to add blurs, colour effects and masks to it."
      />
    );
  }

  return (
    <div className={styles.root}>
      {/* Effects & Presets browser — the AE library tree of effect types. */}
      <div className={styles.sectionTitle}>Effects &amp; Presets</div>
      <div className={styles.addRow}>
        <button
          type="button"
          className={styles.addChip}
          disabled={getNodeEffects(primary).length === 0}
          title="Copy this layer's whole effect stack"
          onClick={() => { copyAllEffects(primary); bumpClipboard((n) => n + 1); }}
        >
          <Icon name="copy" size="sm" /> Copy Stack
        </button>
        <button
          type="button"
          className={styles.addChip}
          disabled={!hasEffectClipboard()}
          title={hasEffectClipboard() ? `Paste ${effectClipboardSize()} effect(s) onto this layer` : 'Nothing copied yet'}
          onClick={() => {
            pasteEffects([primary]);
            bumpClipboard((n) => n + 1);
            revealEffectControls();
          }}
        >
          <Icon name="plus" size="sm" /> Paste
        </button>
        <button
          type="button"
          className={styles.addChip}
          disabled={getNodeEffects(primary).length === 0}
          title="Save this stack as a reusable preset"
          onClick={() => {
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
        {browserFolders.length > 0 || (!starredOnly && (shapeOps.length > 0 || browserPresets.length > 0 || simulationItems.length > 0)) ? (
          <BrowserTree>
            {!starredOnly && browserPresets.length > 0 && (
              <BrowserFolder
                key="presets"
                label="Effect Presets"
                icon="sparkles"
                count={browserPresets.length}
                defaultOpen={false}
                forceOpen={!!q}
              >
                {browserPresets.map((p) => {
                  const userSaved = !builtinPresetNames.has(p.name);
                  return (
                    <BrowserRow
                      key={p.name}
                      label={p.name}
                      icon="sparkles"
                      title={
                        userSaved
                          ? `Apply "${p.name}" (${p.items.length} effect(s)) — Alt-click deletes`
                          : `Apply "${p.name}" (${p.items.length} effect(s))`
                      }
                      onClick={(e) => {
                        if (userSaved && e.altKey) {
                          deleteEffectPreset(p.name);
                          bumpClipboard((n) => n + 1);
                          return;
                        }
                        applyEffectPreset(p.name, [primary]);
                        bumpClipboard((n) => n + 1);
                        revealEffectControls();
                      }}
                    />
                  );
                })}
              </BrowserFolder>
            )}
            {browserFolders.map(([cat, items], index) => (
              <BrowserFolder
                key={cat}
                label={cat}
                icon={EFFECT_CATEGORY_ICON[cat]}
                count={items.length}
                defaultOpen={index === 0}
                // Typing is hunting, not browsing: every folder still holding a
                // match opens, and stays open for as long as the query does.
                forceOpen={!!q}
              >
                {items.map((d) => {
                  const pluginNoGpu = cat === PLUGIN_EFFECT_CATEGORY && !pluginEffectsCanRender();
                  const tag = pluginNoGpu
                    ? <BrowserTag>No WebGPU</BrowserTag>
                    : d.gpuOnly ? <BrowserTag>GPU</BrowserTag> : null;
                  return (
                    <BrowserRow
                      key={d.type}
                      label={d.label}
                      fx
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
                          {tag}
                        </>
                      }
                      title={
                        pluginNoGpu
                          ? `${d.label} needs WebGPU — this machine is on the WebGL2 fallback. `
                            + 'It is saved with your project and renders on a machine that has it.'
                          : `Add ${d.label} — or drag onto a layer`
                      }
                      draggable
                      onDragStart={(e) => setCanvasDrag(e, { kind: 'effect', effectType: d.type })}
                      onClick={() => { if (primary) addEffectAndReveal(primary, d.type); }}
                    />
                  );
                })}
              </BrowserFolder>
            ))}
            {!starredOnly && shapeOps.length > 0 && node && (
              <BrowserFolder
                key="Shape"
                label="Shape"
                icon={EFFECT_CATEGORY_ICON.Shape}
                count={shapeOps.length}
                defaultOpen={browserFolders.length === 0}
                forceOpen={!!q}
              >
                {shapeOps.map((op) => {
                  const taken = (op.type === 'trim' && !!readTrimOp(node))
                    || (op.type === 'repeater' && !!readRepeaterOp(node));
                  return (
                    <BrowserRow
                      key={op.type}
                      label={op.label}
                      fx
                      title={taken ? `${op.label} is already on this layer` : `Add ${op.label}`}
                      onClick={() => {
                        if (!primary || taken) return;
                        addPathOp(primary, defaultPathOpOf(op.type));
                        revealEffectControls();
                      }}
                    />
                  );
                })}
              </BrowserFolder>
            )}
            {!starredOnly && simulationItems.length > 0 && (
              <BrowserFolder
                key="Simulation"
                label="Simulation"
                icon="zap"
                count={simulationItems.length}
                defaultOpen={false}
                forceOpen={!!q}
              >
                {simulationItems.map((item) => {
                  const on = item.id === 'cloner' ? clonerOn : physicsOn;
                  return (
                    <BrowserRow
                      key={item.id}
                      label={item.label}
                      icon={item.icon}
                      right={on ? <BrowserTag>On</BrowserTag> : undefined}
                      title={on ? `Edit ${item.label} in Effect Controls` : `Add ${item.label}`}
                      onClick={() => {
                        if (!primary) return;
                        if (item.id === 'cloner') enableNodeCloner(primary);
                        else enableNodePhysics(primary);
                        revealEffectControls();
                      }}
                    />
                  );
                })}
              </BrowserFolder>
            )}
          </BrowserTree>
        ) : (
          <BrowserEmpty>
            {starredOnly && effectFavorites.size === 0
              ? 'No favourite effects yet — star one to pin it here.'
              : starredOnly
                ? 'No favourite effects match this search.'
                : `No effects match “${effectQuery}”.`}
          </BrowserEmpty>
        )}
      </div>

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
          onClick={() => primary && addMaskPath(primary, rectangleMask(maskW, maskH))}
        >
          <Icon name="plus" size="sm" /> Rectangle
        </button>
        <button
          type="button"
          className={styles.addChip}
          disabled={!hasSelection}
          title={hasSelection ? 'Add an ellipse mask' : 'Select a layer first'}
          onClick={() => primary && addMaskPath(primary, ellipseMask(maskW, maskH))}
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
            title={node && hasMaskAnim(node) ? 'Remove mask animation' : 'Keyframe the mask shape at the playhead (animate the mask)'}
            onClick={() => (node && hasMaskAnim(node) ? clearMaskAnim(primary) : keyframeMask(primary, maskTime))}
          >
            <Icon name="keyframe" size="sm" /> {node && hasMaskAnim(node) ? 'Un-animate' : 'Keyframe shape'}
          </button>
        )}
      </div>

      {masks.length > 0 && (
        <div className={styles.stackList}>
          {masks.map((m, i) => (
            // Same card as an applied effect: header band, then the parameters
            // under it. A mask IS a per-layer item with a mode and a handful of
            // values, exactly like an effect, and the panel showing the two in
            // two different shapes was the only reason they read as unrelated.
            <div key={m.id} className={styles.effectCardItem}>
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
                    onSelect: () => updateMaskPath(primary, m.id, { mode: x.mode }, maskTime),
                  }))}
                />
                <div className={styles.itemActions}>
                  <button
                    type="button"
                    className={styles.remove}
                    aria-label={`Remove Mask ${i + 1}`}
                    title={`Remove Mask ${i + 1}`}
                    onClick={() => removeMaskPath(primary, m.id)}
                  >
                    <Icon name="close" size="sm" />
                  </button>
                </div>
              </div>
              <div className={styles.effectParamsBody}>
                <PropertyRow label="Name" compact>
                  <input
                    value={m.name ?? ''}
                    placeholder={`Mask ${i + 1}`}
                    aria-label={`Mask ${i + 1} name`}
                    onChange={(e) =>
                      updateMaskPath(primary, m.id, { name: e.target.value || undefined }, maskTime)
                    }
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
                  <ValueField value={m.feather} min={0} max={200} precision={0} unit="px"
                    onChange={(v) => updateMaskPath(primary, m.id, { feather: v }, maskTime)} aria-label="Mask feather" />
                </PropertyRow>
                {/* Variable-width feather: one row per vertex. A vertex with
                    its own value overrides the uniform Feather above and the
                    softness interpolates along the outline between vertices
                    (the distance-field renderer in maskFeather.ts). Right-side
                    clear button drops the override — every override cleared
                    returns the path to the plain blur renderer. */}
                <PropertyRow label="Per-Vertex" compact>
                  <Checkbox
                    checked={m.points.some((pt) => typeof pt.feather === 'number')}
                    onChange={() => {
                      const on = m.points.some((pt) => typeof pt.feather === 'number');
                      // Toggle ON seeds every vertex at the uniform value (so
                      // nothing visibly changes until a vertex is edited);
                      // toggle OFF clears every override.
                      m.points.forEach((_, i) =>
                        setMaskPointFeather(primary, m.id, i, on ? undefined : m.feather, maskTime));
                    }}
                    aria-label={`Variable feather for Mask ${i + 1}`}
                    style={{ width: 14, height: 14 }}
                  />
                </PropertyRow>
                {m.points.some((pt) => typeof pt.feather === 'number') &&
                  m.points.map((pt, vi) => (
                    <PropertyRow key={vi} label={`  V${vi + 1}`} compact>
                      <ValueField
                        value={Math.round(pt.feather ?? m.feather)}
                        min={0} max={200} precision={0} unit="px"
                        onChange={(v) => setMaskPointFeather(primary, m.id, vi, v, maskTime)}
                        aria-label={`Mask ${i + 1} vertex ${vi + 1} feather`}
                      />
                    </PropertyRow>
                  ))}
                <PropertyRow label="Opacity" compact>
                  <ValueField value={Math.round(m.opacity * 100)} min={0} max={100} precision={0} unit="%"
                    onChange={(v) => updateMaskPath(primary, m.id, { opacity: v / 100 }, maskTime)} aria-label="Mask opacity" />
                </PropertyRow>
                <PropertyRow label="Expansion" compact>
                  <ValueField value={Math.round(m.expansion ?? 0)} min={-500} max={500} precision={0} unit="px"
                    onChange={(v) => updateMaskPath(primary, m.id, { expansion: v }, maskTime)} aria-label="Mask expansion" />
                </PropertyRow>
                <PropertyRow label="Inverted" compact>
                  <Checkbox
                    checked={!!m.inverted}
                    onChange={() => updateMaskPath(primary, m.id, { inverted: !m.inverted }, maskTime)}
                    aria-label={`Invert Mask ${i + 1}`}
                    style={{ width: 14, height: 14 }}
                  />
                </PropertyRow>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export default EffectsPanel;
