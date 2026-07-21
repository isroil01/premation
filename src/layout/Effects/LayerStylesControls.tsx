/**
 * LayerStylesControls (Prompt E8) — Photoshop-style layer styles for a layer:
 * Drop Shadow + Outer Glow. Both compile to the CSS-filter render path, so
 * edits repaint live and are captured by History / autosave / export.
 */

import { ValueField } from '@components/ValueField';
import { ColorPicker } from '@components/ColorPicker';
import { Checkbox } from '@components/Checkbox';
import {
  getNodeLayerStyles,
  toggleDropShadow,
  toggleOuterGlow,
  updateDropShadow,
  updateOuterGlow,
} from '@core/effects/layerStyles';
import styles from './EffectsPanel.module.css';

export function LayerStylesControls({ nodeId }: { nodeId: string }): JSX.Element {
  const ls = getNodeLayerStyles(nodeId);
  const ds = ls.dropShadow;
  const og = ls.outerGlow;

  return (
    <>
      <div className={styles.sectionTitle}>Layer styles</div>

      <div className={styles.blendRow}>
        <Checkbox 
          checked={!!ds} 
          onChange={() => toggleDropShadow(nodeId)} 
          label={<span className={styles.blendLabel} style={{ marginLeft: 6 }}>Drop shadow</span>} 
          aria-label="Drop shadow" 
        />
      </div>
      {ds ? (
        <>
          <div className={styles.blendRow}>
            <span className={styles.blendLabel}>Color</span>
            <ColorPicker value={ds.color} onChange={(color) => updateDropShadow(nodeId, { color })} aria-label="Shadow color" />
          </div>
          <div className={styles.maskControls}>
            <label className={styles.maskField}>
              <span>Distance</span>
              <ValueField value={ds.distance} min={0} max={200} precision={0} unit="px"
                onChange={(v) => updateDropShadow(nodeId, { distance: v })} aria-label="Shadow distance" />
            </label>
            <label className={styles.maskField}>
              <span>Angle</span>
              <ValueField value={ds.angle} precision={0} unit="°"
                onChange={(v) => updateDropShadow(nodeId, { angle: v })} aria-label="Shadow angle" />
            </label>
          </div>
          <div className={styles.maskControls}>
            <label className={styles.maskField}>
              <span>Blur</span>
              <ValueField value={ds.blur} min={0} max={200} precision={0} unit="px"
                onChange={(v) => updateDropShadow(nodeId, { blur: v })} aria-label="Shadow blur" />
            </label>
            <label className={styles.maskField}>
              <span>Opacity</span>
              <ValueField value={Math.round(ds.opacity * 100)} min={0} max={100} precision={0} unit="%"
                onChange={(v) => updateDropShadow(nodeId, { opacity: v / 100 })} aria-label="Shadow opacity" />
            </label>
          </div>
        </>
      ) : null}

      <div className={styles.blendRow}>
        <Checkbox 
          checked={!!og} 
          onChange={() => toggleOuterGlow(nodeId)} 
          label={<span className={styles.blendLabel} style={{ marginLeft: 6 }}>Outer glow</span>} 
          aria-label="Outer glow" 
        />
      </div>
      {og ? (
        <>
          <div className={styles.blendRow}>
            <span className={styles.blendLabel}>Color</span>
            <ColorPicker value={og.color} onChange={(color) => updateOuterGlow(nodeId, { color })} aria-label="Glow color" />
          </div>
          <div className={styles.maskControls}>
            <label className={styles.maskField}>
              <span>Size</span>
              <ValueField value={og.size} min={0} max={200} precision={0} unit="px"
                onChange={(v) => updateOuterGlow(nodeId, { size: v })} aria-label="Glow size" />
            </label>
            <label className={styles.maskField}>
              <span>Opacity</span>
              <ValueField value={Math.round(og.opacity * 100)} min={0} max={100} precision={0} unit="%"
                onChange={(v) => updateOuterGlow(nodeId, { opacity: v / 100 })} aria-label="Glow opacity" />
            </label>
          </div>
        </>
      ) : null}
    </>
  );
}

export default LayerStylesControls;
