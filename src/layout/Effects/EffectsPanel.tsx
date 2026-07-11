/**
 * EffectsPanel — per-layer visual effects (blur, glow, color grades). Add from
 * the palette of effect types; each applied effect gets a scrubbable amount and
 * a remove control. Effects render live on the canvas and are captured by
 * History / autosave / export.
 */

import { Icon } from '@components/Icon';
import { ValueField } from '@components/ValueField';
import { EmptyState } from '@components/EmptyState';
import { Dropdown, type DropdownItem } from '@components/Dropdown';
import { useSelectionStore } from '@stores/selectionStore';
import { useSceneRevision } from '@stores/sceneStore';
import defaultSceneGraph from '@core/scene/DefaultSceneGraph';
import {
  EFFECT_DEFS,
  getNodeEffects,
  addEffect,
  updateEffect,
  removeEffect,
} from '@core/effects/effects';
import { BLEND_MODES, getNodeBlend, setNodeBlend } from '@core/effects/blendMode';
import {
  getNodeMask,
  addMaskPath,
  updateMaskPath,
  removeMaskPath,
  rectangleMask,
  ellipseMask,
  type MaskMode,
} from '@core/effects/mask';
import { SIZE } from '@core/rendering/buildSnapshot';
import { readNodeKind } from '@core/scene/sceneDerive';
import styles from './EffectsPanel.module.css';

const MASK_MODES: ReadonlyArray<{ mode: MaskMode; label: string }> = [
  { mode: 'add', label: 'Add' },
  { mode: 'subtract', label: 'Subtract' },
  { mode: 'intersect', label: 'Intersect' },
];

export function EffectsPanel(): JSX.Element {
  const primary = useSelectionStore((s) => s.primary);
  useSceneRevision((s) => s.rev);

  if (!primary || !defaultSceneGraph.getNode(primary)) {
    return <EmptyState icon="settings" message="Select a layer to add visual effects." />;
  }

  const effects = getNodeEffects(primary);
  const defByType = new Map(EFFECT_DEFS.map((d) => [d.type, d]));

  const blend = getNodeBlend(primary);
  const blendLabel = BLEND_MODES.find((b) => b.mode === blend)?.label ?? 'Normal';
  const blendItems: DropdownItem[] = BLEND_MODES.map((b) => ({
    type: 'item',
    id: b.mode,
    label: b.label,
    icon: b.mode === blend ? 'check' : undefined,
    onSelect: () => setNodeBlend(primary, b.mode),
  }));

  // Mask presets are built at the layer's rendered size (matches buildSnapshot).
  const node = defaultSceneGraph.getNode(primary);
  const kind = node ? readNodeKind(node) : 'shape';
  const layerKind = kind === 'text' || kind === 'image' || kind === 'video' ? kind : 'shape';
  const { w: maskW, h: maskH } = SIZE[layerKind];
  const masks = getNodeMask(primary).paths;

  return (
    <div className={styles.root}>
      <div className={styles.blendRow}>
        <span className={styles.blendLabel}>Blend</span>
        <Dropdown
          placement="bottom-end"
          trigger={
            <button type="button" className={styles.blendTrigger}>
              {blendLabel}
              <Icon name="chevron-down" size={12} />
            </button>
          }
          items={blendItems}
        />
      </div>

      <div className={styles.addRow}>
        {EFFECT_DEFS.map((d) => (
          <button key={d.type} type="button" className={styles.addChip} onClick={() => addEffect(primary, d.type)}>
            <Icon name="plus" size={11} /> {d.label}
          </button>
        ))}
      </div>

      {effects.length === 0 ? (
        <EmptyState icon="sparkles" message="No effects — add one above to grade or blur this layer." />
      ) : (
        <div className={styles.list}>
          {effects.map((e) => {
            const def = defByType.get(e.type);
            if (!def) return null;
            return (
              <div key={e.id} className={styles.item}>
                <div className={styles.itemHead}>
                  <span className={styles.itemLabel}>{def.label}</span>
                  <button
                    type="button"
                    className={styles.remove}
                    aria-label={`Remove ${def.label}`}
                    onClick={() => removeEffect(primary, e.id)}
                  >
                    <Icon name="close" size={12} />
                  </button>
                </div>
                <ValueField
                  value={e.amount}
                  min={def.min}
                  max={def.max}
                  unit={def.unit}
                  precision={0}
                  onChange={(v) => updateEffect(primary, e.id, v)}
                  aria-label={`${def.label} amount`}
                />
              </div>
            );
          })}
        </div>
      )}

      <div className={styles.sectionTitle}>Masks</div>
      <div className={styles.addRow}>
        <button type="button" className={styles.addChip} onClick={() => addMaskPath(primary, rectangleMask(maskW, maskH))}>
          <Icon name="plus" size={11} /> Rectangle
        </button>
        <button type="button" className={styles.addChip} onClick={() => addMaskPath(primary, ellipseMask(maskW, maskH))}>
          <Icon name="plus" size={11} /> Ellipse
        </button>
      </div>

      {masks.length > 0 && (
        <div className={styles.list}>
          {masks.map((m, i) => (
            <div key={m.id} className={styles.item}>
              <div className={styles.itemHead}>
                <span className={styles.itemLabel}>Mask {i + 1}</span>
                <Dropdown
                  placement="bottom-end"
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
                    onSelect: () => updateMaskPath(primary, m.id, { mode: x.mode }),
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
                    onChange={(v) => updateMaskPath(primary, m.id, { feather: v })} aria-label="Mask feather" />
                </label>
                <label className={styles.maskField}>
                  <span>Opacity</span>
                  <ValueField value={Math.round(m.opacity * 100)} min={0} max={100} precision={0} unit="%"
                    onChange={(v) => updateMaskPath(primary, m.id, { opacity: v / 100 })} aria-label="Mask opacity" />
                </label>
                <button
                  type="button"
                  className={m.inverted ? styles.invertOn : styles.addChip}
                  onClick={() => updateMaskPath(primary, m.id, { inverted: !m.inverted })}
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
