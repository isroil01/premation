/**
 * TimeControls (Prompt E6) — per-layer time: stretch %, reverse, freeze frame,
 * and frame blending. Writes route through the layerTime module → SceneGraph
 * `fx` component → AnimationChanged, so the render re-samples the layer at its
 * new source time (and History / autosave capture it).
 */

import { Icon } from '@components/Icon';
import { ValueField } from '@components/ValueField';
import { Dropdown, type DropdownItem } from '@components/Dropdown';
import { Switch } from '@components/Switch';
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
      </div>

      <div className={styles.blendRow}>
        <span className={styles.blendLabel}>Reverse</span>
        <Switch
          checked={time.reverse}
          onChange={(e) => updateNodeLayerTime(nodeId, { reverse: e.currentTarget.checked })}
          aria-label="Reverse playback"
        />
      </div>

      <div className={styles.blendRow}>
        <span className={styles.blendLabel}>Freeze frame</span>
        <Switch
          checked={time.freeze}
          onChange={(e) => updateNodeLayerTime(nodeId, { freeze: e.currentTarget.checked })}
          aria-label="Freeze frame"
        />
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
          placement="left-start"
          trigger={
            <button type="button" className={styles.blendTrigger}>
              {FRAME_BLENDS.find((b) => b.value === time.frameBlend)?.label ?? 'Off'}
              <Icon name="chevron-down" size="sm" />
            </button>
          }
          items={blendItems}
        />
      </div>
    </>
  );
}

export default TimeControls;
