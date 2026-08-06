/**
 * EffectsPanel — per-layer visual effects (blur, glow, color grades). Add from
 * the palette of effect types; each applied effect gets a scrubbable amount and
 * a remove control. Effects render live on the canvas and are captured by
 * History / autosave / export.
 */

import { useState, useMemo } from 'react';
import { Icon, type IconName } from '@components/Icon';
import { Input } from '@components/Input';
import { ValueField } from '@components/ValueField';
import { Checkbox } from '@components/Checkbox';
import { PropertyRow } from '@components/PropertyRow';
import { EmptyState } from '@components/EmptyState';
import { Dropdown } from '@components/Dropdown';
import { BrowserTree, BrowserFolder, BrowserRow, BrowserTag, BrowserEmpty } from '@components/BrowserTree';
import { useSelectionStore } from '@stores/selectionStore';
import { useSceneRevision } from '@stores/sceneStore';
import { useActiveWorkspace } from '@stores/projectStore';
import defaultSceneGraph from '@core/scene/DefaultSceneGraph';
import { EFFECT_DEFS, addEffect, getNodeEffects, type EffectType } from '@core/effects/effects';
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
import { EffectStack } from './EffectStack';
import {
  getNodeMask,
  addMaskPath,
  updateMaskPath,
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
import { customPrompt } from '@components/Modal/Dialogs';
import styles from './EffectsPanel.module.css';

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

/**
 * Browser folders, following After Effects' own grouping so the names are the
 * ones users already know.
 *
 * A `Record` keyed by `EffectType`, NOT an if-chain with a catch-all: the
 * previous version routed two named lists and dropped EVERYTHING else into a
 * single "Stylize, Keying & Utility" bucket — 24 of the 38 effects in one
 * accordion, which is the folder users open most. Typing it this way means a
 * new effect type is a compile error until it is filed somewhere.
 */
const EFFECT_CATEGORY: Record<EffectType, string> = {
  // Blur & Sharpen
  blur: 'Blur & Sharpen',
  sharpen: 'Blur & Sharpen',
  'directional-blur': 'Blur & Sharpen',
  'gaussian-blur': 'Blur & Sharpen',
  'fast-box-blur': 'Blur & Sharpen',
  'radial-blur': 'Blur & Sharpen',
  mosaic: 'Stylize',
  'find-edges': 'Stylize',
  'roughen-edges': 'Stylize',
  exposure: 'Color Correction',
  vibrance: 'Color Correction',
  colorama: 'Color Correction',
  lumetri: 'Color Correction',
  'selective-color': 'Color Correction',
  'shadow-highlight': 'Color Correction',
  'set-matte': 'Keying',
  'simple-choker': 'Keying',
  'linear-color-key': 'Keying',
  'shift-channels': 'Keying',
  'venetian-blinds': 'Transition',
  'gradient-wipe': 'Transition',
  'card-wipe': 'Transition',
  'lens-flare': 'Generate',
  numbers: 'Generate',
  timecode: 'Generate',
  'audio-spectrum': 'Generate',
  // Color Correction
  brightness: 'Color Correction',
  contrast: 'Color Correction',
  saturate: 'Color Correction',
  grayscale: 'Color Correction',
  sepia: 'Color Correction',
  'hue-rotate': 'Color Correction',
  'hue-saturation': 'Color Correction',
  invert: 'Color Correction',
  levels: 'Color Correction',
  curves: 'Color Correction',
  posterize: 'Color Correction',
  tint: 'Color Correction',
  'channel-mixer': 'Color Correction',
  // Generate
  checkerboard: 'Generate',
  grid: 'Generate',
  'cell-pattern': 'Generate',
  vegas: 'Generate',
  // Noise — filed under Stylize beside the existing `noise`, which is where AE
  // puts Add Grain and Median too.
  'turbulent-noise': 'Stylize',
  'add-grain': 'Stylize',
  median: 'Stylize',
  fill: 'Generate',
  stroke: 'Generate',
  beam: 'Generate',
  'four-color-gradient': 'Generate',
  'gradient-ramp': 'Generate',
  'fractal-noise': 'Generate',
  // Stylize (incl. the Photoshop-style layer styles)
  glow: 'Stylize',
  'drop-shadow': 'Stylize',
  'inner-shadow': 'Stylize',
  'inner-glow': 'Stylize',
  satin: 'Stylize',
  bevel: 'Stylize',
  noise: 'Stylize',
  // Distort
  transform: 'Distort',
  bulge: 'Distort',
  twirl: 'Distort',
  spherize: 'Distort',
  'corner-pin': 'Distort',
  'bezier-warp': 'Distort',
  'wave-warp': 'Distort',
  'turbulent-displace': 'Distort',
  'displacement-map': 'Distort',
  'motion-tile': 'Distort',
  // Keying / Time / Transition
  keylight: 'Keying',
  echo: 'Time',
  'posterize-time': 'Time',
  'linear-wipe': 'Transition',
};

/** Folder order in the browser — most-reached-for first. */
const EFFECT_CATEGORY_ORDER: readonly string[] = [
  'Blur & Sharpen', 'Color Correction', 'Stylize', 'Generate',
  'Distort', 'Keying', 'Time', 'Transition',
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
  Generate: 'gradient',
  Distort: 'waves',
  Keying: 'eraser',
  Time: 'clock',
  Transition: 'wipe',
};

export function EffectsPanel(): JSX.Element {
  const primary = useSelectionStore((s) => s.primary);
  useSceneRevision((s) => s.rev);
  const maskTime = useActiveWorkspace()?.time ?? 0;
  const [effectQuery, setEffectQuery] = useState('');
  // The clipboard and the preset list live outside React (module state and
  // localStorage), so a counter is what tells this panel they changed.
  const [clipboardRev, bumpClipboard] = useState(0);
  const presets = useMemo(() => listEffectPresets(), [clipboardRev]);


  // NOTE: the empty-state early return must come AFTER every hook — the
  // browser-accordion useMemos below run on every render, and returning before
  // them changed the hook count the moment a layer was selected, which is a
  // Rules-of-Hooks crash that took the whole editor down with it.
  const hasSelection = !!(primary && defaultSceneGraph.getNode(primary));

  const q = effectQuery.trim().toLowerCase();
  const browserDefs = q ? EFFECT_DEFS.filter((d) => d.label.toLowerCase().includes(q)) : EFFECT_DEFS;
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

  const effectGroups = useMemo(() => {
    const groups: Record<string, typeof browserDefs> = {};
    for (const cat of EFFECT_CATEGORY_ORDER) groups[cat] = [];
    browserDefs.forEach((d) => {
      const cat = EFFECT_CATEGORY[d.type];
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
      {/* Active Applied Effects — front and center at the top for easy access */}
      <div className={styles.sectionTitle}>Active Layer Effects</div>
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
          onClick={() => { pasteEffects([primary]); bumpClipboard((n) => n + 1); }}
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
      {presets.length > 0 && (
        <div className={styles.addRow}>
          {presets.map((p) => (
            <button
              key={p.name}
              type="button"
              className={styles.addChip}
              title={`Apply "${p.name}" (${p.items.length} effect(s)) — Alt-click to delete`}
              onClick={(e) => {
                if (e.altKey) deleteEffectPreset(p.name);
                else applyEffectPreset(p.name, [primary]);
                bumpClipboard((n) => n + 1);
              }}
            >
              <Icon name="sparkles" size="sm" /> {p.name}
            </button>
          ))}
        </div>
      )}
      <EffectStack nodeId={primary} />

      {/* Effects & Presets browser — the AE library tree of effect types. */}
      <div className={styles.sectionTitle}>Effects &amp; Presets</div>
      <div className={styles.browser}>
        <Input
          value={effectQuery}
          placeholder="Search effects…"
          size="sm"
          fullWidth
          leftIcon="search"
          clearable
          onClear={() => setEffectQuery('')}
          onChange={(e) => setEffectQuery(e.currentTarget.value)}
        />
        {browserFolders.length > 0 ? (
          <BrowserTree>
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
                {items.map((d) => (
                  <BrowserRow
                    key={d.type}
                    label={d.label}
                    fx
                    right={d.gpuOnly ? <BrowserTag>GPU</BrowserTag> : undefined}
                    title={`Add ${d.label} — or drag onto a layer`}
                    draggable
                    onDragStart={(e) => setCanvasDrag(e, { kind: 'effect', effectType: d.type })}
                    onClick={() => { if (primary) addEffect(primary, d.type); }}
                  />
                ))}
              </BrowserFolder>
            ))}
          </BrowserTree>
        ) : (
          <BrowserEmpty>No effects match “{effectQuery}”.</BrowserEmpty>
        )}
      </div>

      <div className={styles.sectionTitle}>Masks</div>
      <div className={styles.addRow}>
        <button type="button" className={styles.addChip} onClick={() => addMaskPath(primary, rectangleMask(maskW, maskH))}>
          <Icon name="plus" size="sm" /> Rectangle
        </button>
        <button type="button" className={styles.addChip} onClick={() => addMaskPath(primary, ellipseMask(maskW, maskH))}>
          <Icon name="plus" size="sm" /> Ellipse
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
                <span className={styles.itemLabel}>Mask {i + 1}</span>
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
                {/* One PropertyRow per value, so a mask's Feather sits in the
                    same column as an effect's Softness rather than in a
                    three-up strip of its own. */}
                <PropertyRow label="Feather" compact>
                  <ValueField value={m.feather} min={0} max={200} precision={0} unit="px"
                    onChange={(v) => updateMaskPath(primary, m.id, { feather: v }, maskTime)} aria-label="Mask feather" />
                </PropertyRow>
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
