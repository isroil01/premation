/**
 * TimeControls (Prompt E6) — per-layer time: stretch %, reverse, freeze frame,
 * and frame blending. Writes route through the layerTime module → SceneGraph
 * `fx` component → AnimationChanged, so the render re-samples the layer at its
 * new source time (and History / autosave capture it).
 */

import { Icon } from '@components/Icon';
import { ValueField } from '@components/ValueField';
import { Dropdown, type DropdownItem } from '@components/Dropdown';
import {
  getNodeLayerTime,
  updateNodeLayerTime,
  FRAME_BLENDS,
} from '@core/scene/layerTime';
import styles from './EffectsPanel.module.css';

export function TimeControls({ nodeId }: { nodeId: string }): JSX.Element {
  const time = getNodeLayerTime(nodeId);

  const blendItems: DropdownItem[] = FRAME_BLENDS.map((b) => ({
    type: 'item',
    id: b.value,
    label: b.label,
    icon: b.value === time.frameBlend ? 'check' : undefined,
    onSelect: () => updateNodeLayerTime(nodeId, { frameBlend: b.value }),
  }));

  return (
    <>
      <div className={styles.sectionTitle}>Time</div>

      <div className={styles.maskControls}>
        <label className={styles.maskField}>
          <span>Stretch</span>
          <ValueField
            value={time.stretch}
            min={1}
            max={1000}
            precision={0}
            unit="%"
            onChange={(v) => updateNodeLayerTime(nodeId, { stretch: v })}
            aria-label="Time stretch"
          />
        </label>
        <button
          type="button"
          className={time.reverse ? styles.invertOn : styles.blendTrigger}
          aria-pressed={time.reverse}
          onClick={() => updateNodeLayerTime(nodeId, { reverse: !time.reverse })}
        >
          Reverse
        </button>
      </div>

      <div className={styles.blendRow}>
        <span className={styles.blendLabel}>Freeze frame</span>
        <button
          type="button"
          className={time.freeze ? styles.invertOn : styles.blendTrigger}
          aria-pressed={time.freeze}
          onClick={() => updateNodeLayerTime(nodeId, { freeze: !time.freeze })}
        >
          {time.freeze ? 'On' : 'Off'}
        </button>
      </div>

      {time.freeze ? (
        <div className={styles.maskControls}>
          <label className={styles.maskField}>
            <span>Freeze at</span>
            <ValueField
              value={time.freezeTime}
              min={0}
              precision={2}
              unit="s"
              onChange={(v) => updateNodeLayerTime(nodeId, { freezeTime: v })}
              aria-label="Freeze time"
            />
          </label>
        </div>
      ) : null}

      <div className={styles.blendRow}>
        <span className={styles.blendLabel}>Frame blend</span>
        <Dropdown
          placement="bottom-end"
          trigger={
            <button type="button" className={styles.blendTrigger}>
              {FRAME_BLENDS.find((b) => b.value === time.frameBlend)?.label ?? 'Off'}
              <Icon name="chevron-down" size={12} />
            </button>
          }
          items={blendItems}
        />
      </div>
    </>
  );
}

export default TimeControls;
