/**
 * EffectsPanel — per-layer visual effects (blur, glow, color grades). Add from
 * the palette of effect types; each applied effect gets a scrubbable amount and
 * a remove control. Effects render live on the canvas and are captured by
 * History / autosave / export.
 */

import { useState, useMemo } from 'react';
import { cn } from '@utils/cn';
import { Icon } from '@components/Icon';
import { Input } from '@components/Input';
import { ValueField } from '@components/ValueField';
import { EmptyState } from '@components/EmptyState';
import { Dropdown } from '@components/Dropdown';
import { Accordion, type AccordionItem } from '@components/Accordion';
import { useSelectionStore } from '@stores/selectionStore';
import { useSceneRevision } from '@stores/sceneStore';
import { useActiveWorkspace } from '@stores/projectStore';
import defaultSceneGraph from '@core/scene/DefaultSceneGraph';
import { EFFECT_DEFS, addEffect, getNodeEffects } from '@core/effects/effects';
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
  // Unified GPU engine renders every effect — no locks needed.
  const effectAvailability = (_d: (typeof EFFECT_DEFS)[number]): { ok: true } | { ok: false; reason: string } => {
    return { ok: true };
  };
  const node = hasSelection ? defaultSceneGraph.getNode(primary!) : undefined;
  const kind = node ? readNodeKind(node) : 'shape';
  const layerKind = kind === 'text' || kind === 'image' || kind === 'video' ? kind : 'shape';
  const { w: maskW, h: maskH } = SIZE[layerKind];
  const masks = hasSelection ? getNodeMask(primary!).paths : [];

  const getCategoryForEffect = (type: string): string => {
    if (type === 'blur' || type === 'sharpen') return 'Blur & Sharpen';
    if ([
      'brightness', 'contrast', 'saturate', 'grayscale', 'sepia', 
      'hue-rotate', 'hue-saturation', 'invert', 'levels', 'curves', 
      'posterize', 'tint', 'channel-mixer', 'fill', 'four-color-gradient'
    ].includes(type)) {
      return 'Color Correction';
    }
    return 'Stylize, Keying & Utility';
  };

  const effectGroups = useMemo(() => {
    const groups: Record<string, typeof browserDefs> = {
      'Blur & Sharpen': [],
      'Color Correction': [],
      'Stylize, Keying & Utility': [],
    };
    browserDefs.forEach((d) => {
      const cat = getCategoryForEffect(d.type);
      if (groups[cat]) {
        groups[cat].push(d);
      } else {
        groups[cat] = [d];
      }
    });
    return groups;
  }, [browserDefs]);

  const browserAccordionItems = useMemo((): AccordionItem[] => {
    return Object.entries(effectGroups)
      .filter(([_, items]) => items.length > 0)
      .map(([cat, items], index) => ({
        id: cat,
        title: cat,
        badge: <span className={styles.catBadge}>{items.length}</span>,
        defaultOpen: index === 0,
        content: (
          <div className={styles.effectRowsList}>
            {items.map((d) => {
              const avail = effectAvailability(d);
              const unavailable = !avail.ok;
              return (
                <button
                  key={d.type}
                  type="button"
                  className={cn(styles.effectRowCard, unavailable && styles.effectRowCardUnavailable)}
                  disabled={unavailable}
                  draggable={!unavailable}
                  onDragStart={(e) => setCanvasDrag(e, { kind: 'effect', effectType: d.type })}
                  title={avail.ok ? `Add ${d.label} — or drag onto a layer` : avail.reason}
                  onClick={() => { if (primary) addEffect(primary, d.type); }}
                >
                  <div className={styles.effectIconWrapper}>
                    <Icon name={unavailable ? 'lock' : 'sparkles'} size={12} />
                  </div>
                  <div className={styles.effectInfo}>
                    <span className={styles.effectLabelText}>{d.label}</span>
                    {d.gpuOnly && <span className={styles.gpuBadge}>GPU</span>}
                  </div>
                  <Icon name="plus" size={12} className={styles.effectAddIcon} />
                </button>
              );
            })}
          </div>
        )
      }));
  }, [effectGroups, primary]);

  // Every hook above has run — returning here is now hook-count-stable.
  if (!hasSelection || !primary) {
    return <EmptyState icon="settings" message="Select a layer to add visual effects." />;
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
          <Icon name="copy" size={11} /> Copy Stack
        </button>
        <button
          type="button"
          className={styles.addChip}
          disabled={!hasEffectClipboard()}
          title={hasEffectClipboard() ? `Paste ${effectClipboardSize()} effect(s) onto this layer` : 'Nothing copied yet'}
          onClick={() => { pasteEffects([primary]); bumpClipboard((n) => n + 1); }}
        >
          <Icon name="plus" size={11} /> Paste
        </button>
        <button
          type="button"
          className={styles.addChip}
          disabled={getNodeEffects(primary).length === 0}
          title="Save this stack as a reusable preset"
          onClick={() => {
            const name = window.prompt('Preset name');
            if (name?.trim()) { saveEffectPreset(primary, name.trim()); bumpClipboard((n) => n + 1); }
          }}
        >
          <Icon name="star" size={11} /> Save Preset
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
              <Icon name="sparkles" size={11} /> {p.name}
            </button>
          ))}
        </div>
      )}
      <EffectStack nodeId={primary} />

      {/* Effects & presets browser — list of effect types to add */}
      <div className={styles.sectionTitle}>Add Effect &amp; Presets</div>
      <div className={styles.browser}>
        <Input
          value={effectQuery}
          placeholder="Search effects…"
          size="sm"
          fullWidth
          leftIcon="search"
          onChange={(e) => setEffectQuery(e.currentTarget.value)}
        />
        {browserAccordionItems.length > 0 ? (
          <Accordion items={browserAccordionItems} />
        ) : (
          <div className={styles.hint}>No effects match “{effectQuery}”.</div>
        )}
      </div>

      <div className={styles.sectionTitle}>Masks</div>
      <div className={styles.addRow}>
        <button type="button" className={styles.addChip} onClick={() => addMaskPath(primary, rectangleMask(maskW, maskH))}>
          <Icon name="plus" size={11} /> Rectangle
        </button>
        <button type="button" className={styles.addChip} onClick={() => addMaskPath(primary, ellipseMask(maskW, maskH))}>
          <Icon name="plus" size={11} /> Ellipse
        </button>
        {masks.length > 0 && (
          <button
            type="button"
            className={styles.addChip}
            title={node && hasMaskAnim(node) ? 'Remove mask animation' : 'Keyframe the mask shape at the playhead (animate the mask)'}
            onClick={() => (node && hasMaskAnim(node) ? clearMaskAnim(primary) : keyframeMask(primary, maskTime))}
          >
            <Icon name="keyframe" size={11} /> {node && hasMaskAnim(node) ? 'Un-animate' : 'Keyframe shape'}
          </button>
        )}
      </div>

      {masks.length > 0 && (
        <div className={styles.list}>
          {masks.map((m, i) => (
            <div key={m.id} className={styles.item}>
              <div className={styles.itemHead}>
                <span className={styles.itemLabel}>Mask {i + 1}</span>
                <Dropdown
                  placement="left-start"
                  trigger={
                    <button type="button" className={styles.blendTrigger}>
                      {MASK_MODES.find((x) => x.mode === m.mode)?.label ?? 'Add'}
                      <Icon name="chevron-down" size={12} />
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
                <button
                  type="button"
                  className={styles.remove}
                  aria-label={`Remove Mask ${i + 1}`}
                  onClick={() => removeMaskPath(primary, m.id)}
                >
                  <Icon name="close" size={12} />
                </button>
              </div>
              <div className={styles.maskControls}>
                <label className={styles.maskField}>
                  <span>Feather</span>
                  <ValueField value={m.feather} min={0} max={200} precision={0} unit="px"
                    onChange={(v) => updateMaskPath(primary, m.id, { feather: v }, maskTime)} aria-label="Mask feather" />
                </label>
                <label className={styles.maskField}>
                  <span>Opacity</span>
                  <ValueField value={Math.round(m.opacity * 100)} min={0} max={100} precision={0} unit="%"
                    onChange={(v) => updateMaskPath(primary, m.id, { opacity: v / 100 }, maskTime)} aria-label="Mask opacity" />
                </label>
                <label className={styles.maskField}>
                  <span>Expansion</span>
                  <ValueField value={Math.round(m.expansion ?? 0)} min={-500} max={500} precision={0} unit="px"
                    onChange={(v) => updateMaskPath(primary, m.id, { expansion: v }, maskTime)} aria-label="Mask expansion" />
                </label>
                <button
                  type="button"
                  className={m.inverted ? styles.invertOn : styles.addChip}
                  onClick={() => updateMaskPath(primary, m.id, { inverted: !m.inverted }, maskTime)}
                >
                  Invert
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export default EffectsPanel;
