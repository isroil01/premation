/**
 * EffectsPanel — per-layer visual effects (blur, glow, color grades). Add from
 * the palette of effect types; each applied effect gets a scrubbable amount and
 * a remove control. Effects render live on the canvas and are captured by
 * History / autosave / export.
 */

import { useState } from 'react';
import { Icon } from '@components/Icon';
import { Input } from '@components/Input';
import { ValueField } from '@components/ValueField';
import { EmptyState } from '@components/EmptyState';
import { Dropdown, type DropdownItem } from '@components/Dropdown';
import { Switch } from '@components/Switch';
import { useSelectionStore } from '@stores/selectionStore';
import { useSceneRevision } from '@stores/sceneStore';
import defaultSceneGraph from '@core/scene/DefaultSceneGraph';
import { EFFECT_DEFS, addEffect } from '@core/effects/effects';
import { EffectStack } from './EffectStack';
import { BLEND_MODES, getNodeBlend, setNodeBlend } from '@core/effects/blendMode';
import { MATTE_OPTIONS, getNodeMatte, setNodeMatte } from '@core/effects/matte';
import { getNodeAdjustment, setNodeAdjustment } from '@core/effects/adjustment';
import { getNodeMotionBlur, setNodeMotionBlur } from '@core/effects/motionBlur';
import { useMotionBlurStore } from '@stores/motionBlurStore';
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
import { useActiveWorkspace } from '@stores/projectStore';
import { SIZE } from '@core/rendering/buildSnapshot';
import { readNodeKind } from '@core/scene/sceneDerive';
import { TimeControls } from './TimeControls';
import { LayerStylesControls } from './LayerStylesControls';
import styles from './EffectsPanel.module.css';

const MASK_MODES: ReadonlyArray<{ mode: MaskMode; label: string }> = [
  { mode: 'add', label: 'Add' },
  { mode: 'subtract', label: 'Subtract' },
  { mode: 'intersect', label: 'Intersect' },
];

export function EffectsPanel(): JSX.Element {
  const primary = useSelectionStore((s) => s.primary);
  useSceneRevision((s) => s.rev);
  const maskTime = useActiveWorkspace()?.time ?? 0;
  const mb = useMotionBlurStore();
  const [effectQuery, setEffectQuery] = useState('');

  if (!primary || !defaultSceneGraph.getNode(primary)) {
    return <EmptyState icon="settings" message="Select a layer to add visual effects." />;
  }

  const q = effectQuery.trim().toLowerCase();
  const browserDefs = q ? EFFECT_DEFS.filter((d) => d.label.toLowerCase().includes(q)) : EFFECT_DEFS;

  const blend = getNodeBlend(primary);
  const blendLabel = BLEND_MODES.find((b) => b.mode === blend)?.label ?? 'Normal';
  const blendItems: DropdownItem[] = BLEND_MODES.map((b) => ({
    type: 'item',
    id: b.mode,
    label: b.label,
    icon: b.mode === blend ? 'check' : undefined,
    onSelect: () => setNodeBlend(primary, b.mode),
  }));

  const matte = getNodeMatte(primary);
  const matteLabel = MATTE_OPTIONS.find((m) => m.value === matte)?.label ?? 'No matte';
  const matteItems: DropdownItem[] = MATTE_OPTIONS.map((m) => ({
    type: 'item',
    id: m.value,
    label: m.label,
    icon: m.value === matte ? 'check' : undefined,
    onSelect: () => setNodeMatte(primary, m.value),
  }));

  // Mask presets are built at the layer's rendered size (matches buildSnapshot).
  const node = defaultSceneGraph.getNode(primary);
  const kind = node ? readNodeKind(node) : 'shape';
  const layerKind = kind === 'text' || kind === 'image' || kind === 'video' ? kind : 'shape';
  const { w: maskW, h: maskH } = SIZE[layerKind];
  const masks = getNodeMask(primary).paths;
  const isAdjustment = getNodeAdjustment(primary);
  const motionBlur = getNodeMotionBlur(primary);

  return (
    <div className={styles.root}>
      <TimeControls nodeId={primary} />

      <LayerStylesControls nodeId={primary} />

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

      <div className={styles.blendRow}>
        <span className={styles.blendLabel}>Track matte</span>
        <Dropdown
          placement="bottom-end"
          trigger={
            <button type="button" className={styles.blendTrigger}>
              {matteLabel}
              <Icon name="chevron-down" size={12} />
            </button>
          }
          items={matteItems}
        />
      </div>

      <div className={styles.blendRow}>
        <span className={styles.blendLabel}>Adjustment layer</span>
        <Switch
          checked={isAdjustment}
          onChange={(e) => setNodeAdjustment(primary, e.currentTarget.checked)}
          aria-label="Adjustment layer"
        />
      </div>

      <div className={styles.blendRow}>
        <span className={styles.blendLabel}>Motion blur</span>
        <Switch
          checked={motionBlur}
          onChange={(e) => setNodeMotionBlur(primary, e.currentTarget.checked)}
          aria-label="Motion blur"
        />
      </div>

      {motionBlur && (
        <div className={styles.maskControls}>
          <label className={styles.blendLabel} style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <input type="checkbox" checked={mb.enabled} onChange={(e) => mb.setEnabled(e.currentTarget.checked)} />
            Comp enabled
          </label>
          <label className={styles.maskField}>
            <span>Shutter°</span>
            <ValueField value={mb.shutterAngle} min={0} max={360} precision={0} unit="°"
              onChange={mb.setShutterAngle} aria-label="Shutter angle" />
          </label>
          <label className={styles.maskField}>
            <span>Phase°</span>
            <ValueField value={mb.shutterPhase ?? -90} min={-360} max={360} precision={0} unit="°"
              onChange={mb.setShutterPhase} aria-label="Shutter phase" />
          </label>
          <label className={styles.maskField}>
            <span>Samples</span>
            <ValueField value={mb.samples} min={2} max={32} precision={0}
              onChange={mb.setSamples} aria-label="Motion blur samples" />
          </label>
          <label className={styles.maskField}>
            <span>Limit</span>
            <ValueField value={mb.adaptiveSampleLimit ?? 128} min={2} max={128} precision={0}
              onChange={mb.setAdaptiveSampleLimit} aria-label="Adaptive sample limit" />
          </label>
        </div>
      )}

      {/* Effects browser — searchable list of effect types to add. */}
      <div className={styles.sectionTitle}>Effects &amp; presets</div>
      <div className={styles.browser}>
        <Input
          value={effectQuery}
          placeholder="Search effects…"
          size="sm"
          fullWidth
          leftIcon="search"
          onChange={(e) => setEffectQuery(e.currentTarget.value)}
        />
        <div className={styles.addRow}>
          {browserDefs.map((d) => (
            <button key={d.type} type="button" className={styles.addChip} onClick={() => addEffect(primary, d.type)}>
              <Icon name="plus" size={11} /> {d.label}
            </button>
          ))}
          {browserDefs.length === 0 ? <span className={styles.hint}>No effects match “{effectQuery}”.</span> : null}
        </div>
      </div>

      <EffectStack nodeId={primary} />

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
                <label className={styles.maskField}>
                  <span>Expansion</span>
                  <ValueField value={Math.round(m.expansion ?? 0)} min={-500} max={500} precision={0} unit="px"
                    onChange={(v) => updateMaskPath(primary, m.id, { expansion: v })} aria-label="Mask expansion" />
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
