/**
 * TimeControls (Prompt E6) — per-layer time: stretch %, reverse, freeze frame,
 * and frame blending. Stretch / reverse (one signed `setLayerTiming` stretch)
 * and frame blending (`setLayerSwitches`) go through the engine API (B3); the
 * freeze frame keeps its legacy writer (engine gap, see effectEdits).
 */

import { Icon } from '@components/Icon';
import { ValueField } from '@components/ValueField';
import { Dropdown, type DropdownItem } from '@components/Dropdown';
import { Switch } from '@components/Switch';
import { getNodeLayerTime, FRAME_BLENDS } from '@core/scene/layerTime';
import { useEngineEdit } from '@layout/Inspector/useEngineEdit';
import { layerStretchCommands, legacyPatchLayerTime, setFrameBlendEdit } from './effectEdits';
import styles from './EffectsPanel.module.css';

export function TimeControls({ nodeId }: { nodeId: string }): JSX.Element {
  const time = getNodeLayerTime(nodeId);
  const e = useEngineEdit();

  const blendItems: DropdownItem[] = FRAME_BLENDS.map((b) => ({
    type: 'item',
    id: b.value,
    label: b.label,
    icon: b.value === time.frameBlend ? 'check' : undefined,
    onSelect: () => { void setFrameBlendEdit(nodeId, b.value); },
  }));

  return (
    <>

      <div className={styles.maskControls}>
        <label className={styles.maskField}>
          <span>Stretch</span>
          <ValueField
            {...e.scrub('Time Stretch')}
            value={time.stretch}
            min={1}
            max={1000}
            precision={0}
            unit="%"
            onChange={(v) => e.send('Time Stretch', layerStretchCommands(nodeId, v, time.reverse))}
            aria-label="Time stretch"
          />
        </label>
      </div>

      <div className={styles.blendRow}>
        <span className={styles.blendLabel}>Reverse</span>
        <Switch
          checked={time.reverse}
          onChange={(ev) => e.send('Time-Reverse Layer', layerStretchCommands(nodeId, time.stretch, ev.currentTarget.checked))}
          aria-label="Reverse playback"
        />
      </div>

      <div className={styles.blendRow}>
        <span className={styles.blendLabel}>Freeze frame</span>
        <Switch
          checked={time.freeze}
          onChange={(ev) => legacyPatchLayerTime(nodeId, { freeze: ev.currentTarget.checked })}
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
              onChange={(v) => legacyPatchLayerTime(nodeId, { freezeTime: v })}
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
