import { Switch } from '@components/Switch';
import { ValueField } from '@components/ValueField';
import { useSceneRevision } from '@stores/sceneStore';
import { useMotionBlurStore } from '@stores/motionBlurStore';

import { getNodeAdjustment, setNodeAdjustment } from '@core/effects/adjustment';
import { getNodeMotionBlur, setNodeMotionBlur } from '@core/effects/motionBlur';
import { getNodeQuality, setNodeQuality } from '@core/effects/layerQuality';
import styles from '../Effects/EffectsPanel.module.css';

export function LayerSwitchesControls({ nodeId }: { nodeId: string }): JSX.Element {
  useSceneRevision((s) => s.rev);
  const mb = useMotionBlurStore();

  const isAdjustment = getNodeAdjustment(nodeId);
  const motionBlur = getNodeMotionBlur(nodeId);
  const quality = getNodeQuality(nodeId);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
      <div className={styles.blendRow}>
        <span className={styles.blendLabel}>Adjustment Layer</span>
        <Switch
          checked={isAdjustment}
          onChange={(e) => setNodeAdjustment(nodeId, e.currentTarget.checked)}
          aria-label="Adjustment layer"
        />
      </div>

      <div className={styles.blendRow}>
        <span className={styles.blendLabel}>Motion Blur</span>
        <Switch
          checked={motionBlur}
          onChange={(e) => setNodeMotionBlur(nodeId, e.currentTarget.checked)}
          aria-label="Motion blur"
        />
      </div>

      {motionBlur && (
        <div className={styles.maskControls} style={{ padding: '8px', background: 'var(--color-surface-1)', borderRadius: 4, display: 'flex', flexDirection: 'column', gap: '8px', alignItems: 'stretch' }}>
          <label className={styles.blendLabel} style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <input type="checkbox" checked={mb.enabled} onChange={(e) => mb.setEnabled(e.currentTarget.checked)} />
            Comp enabled
          </label>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '8px' }}>
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
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '8px' }}>
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
        </div>
      )}

      <div className={styles.blendRow}>
        <span className={styles.blendLabel} title="Draft: nearest-neighbour sampling for this layer (faster, rougher)">Draft Quality</span>
        <Switch
          checked={quality === 'draft'}
          onChange={(e) => setNodeQuality(nodeId, e.currentTarget.checked ? 'draft' : 'best')}
          aria-label="Draft quality"
        />
      </div>

      {/* "Casts Shadows" is NOT here. It is an AE Material Option and lives with
          the rest of them in ThreeDControl — having a second switch for the same
          value in a different tab meant two controls could visibly disagree
          until one was re-rendered. One property, one owner. */}
    </div>
  );
}
