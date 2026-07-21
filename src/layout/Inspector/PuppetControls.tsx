/**
 * PuppetControls — inspector section shown when a layer carries a puppet rig
 * (fx.puppet block). Exposes the rig's mesh settings (density / expansion, both
 * triggering a deterministic mesh rebuild via the rest-mesh cache key) and the
 * selected pins' static rotation / stiffness.
 *
 * All edits are single undo steps via puppetCommands (PuppetEditCommand).
 */

import { Slider } from '@components/Slider';
import { ValueField } from '@components/ValueField';
import { Button } from '@components/Button';
import { Icon } from '@components/Icon';
import { useSceneRevision } from '@stores/sceneStore';
import { useUIStore } from '@stores/uiStore';
import defaultSceneGraph from '@core/scene/DefaultSceneGraph';
import { readNodePuppet } from '@core/rig/puppet';
import { updatePuppetSettings, updatePuppetPin, deletePuppetPin } from '@core/rig/puppetCommands';
import styles from './BoneControls.module.css';

export function PuppetControls({ nodeId }: { nodeId: string }): JSX.Element | null {
  useSceneRevision((s) => s.rev);
  const node = defaultSceneGraph.getNode(nodeId);
  if (!node) return null;

  const rig = readNodePuppet(node);
  const density = rig?.meshDensity ?? 15;
  const expansion = rig?.meshExpansion ?? 8;
  const solver = rig?.solver ?? 'arap';
  const pins = rig?.pins ?? [];

  return (
    <div className={styles.root}>
      {/* Puppet summary card */}
      <div className={styles.headerCard}>
        <div className={styles.headerTitle}>
          <Icon name="puppet-pin" size={14} />
          <span>Deformation Mesh</span>
          <span className={styles.badge}>{pins.length} pins</span>
        </div>
        <Button
          size="sm"
          variant="secondary"
          onClick={() => useUIStore.getState().setActiveTool('puppet-pin')}
        >
          <Icon name="plus" size={12} /> Add Pin
        </Button>
      </div>

      {/* Mesh settings card */}
      <div className={styles.card}>
        <div className={styles.cardHeader}>
          <div className={styles.cardTitle}>
            <Icon name="grid" size={13} style={{ opacity: 0.7 }} />
            <span>Mesh Settings</span>
          </div>
        </div>

        <div className={styles.paramRow}>
          <span className={styles.paramLabel}>Deform Solver</span>
          <select
            value={solver}
            aria-label="Puppet deform solver"
            onChange={(e) =>
              updatePuppetSettings(nodeId, { solver: e.target.value as 'lbs' | 'arap' })
            }
            style={{
              padding: '3px 8px',
              fontSize: 11,
              borderRadius: 4,
              background: 'var(--color-surface, #1e1e1e)',
              color: 'var(--color-text-primary, #fff)',
              border: '1px solid var(--color-border, #333)',
            }}
          >
            <option value="arap">ARAP (Rigid / Elastic)</option>
            <option value="lbs">Linear Blend (LBS)</option>
          </select>
        </div>

        <div className={styles.paramRow}>
          <span className={styles.paramLabel}>Mesh Density</span>
          <Slider
            value={density}
            min={2}
            max={50}
            step={1}
            showValue
            size="sm"
            label="Mesh density"
            onChange={(v) => updatePuppetSettings(nodeId, { meshDensity: Math.round(v) })}
          />
        </div>

        <div className={styles.paramRow}>
          <span className={styles.paramLabel}>Mesh Expansion</span>
          <Slider
            value={expansion}
            min={0}
            max={100}
            step={1}
            showValue
            size="sm"
            label="Mesh expansion"
            onChange={(v) => updatePuppetSettings(nodeId, { meshExpansion: Math.round(v) })}
          />
        </div>
      </div>

      {pins.length === 0 && (
        <div className={styles.card} style={{ textAlign: 'center', padding: '16px 12px' }}>
          <span className={styles.subText}>No puppet pins added to this layer.</span>
          <Button
            size="sm"
            variant="primary"
            onClick={() => useUIStore.getState().setActiveTool('puppet-pin')}
            style={{ marginTop: 8 }}
          >
            <Icon name="puppet-pin" size={12} /> Place Pins with Puppet Tool (Ctrl+P)
          </Button>
        </div>
      )}

      {/* Pin list cards */}
      {pins.map((pin) => (
        <div key={pin.id} className={styles.card}>
          <div className={styles.cardHeader}>
            <div className={styles.cardTitle}>
              <Icon name="push-pin" size={13} style={{ opacity: 0.7 }} />
              <span>{pin.name || pin.id}</span>
            </div>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => deletePuppetPin(nodeId, pin.id)}
              aria-label={`Delete pin ${pin.name || pin.id}`}
              title="Delete pin"
            >
              <Icon name="trash" size={12} />
            </Button>
          </div>

          <div className={styles.paramRow}>
            <span className={styles.paramLabel}>Rotation</span>
            <ValueField
              value={pin.rotation ?? 0}
              unit="°"
              onChange={(v) => updatePuppetPin(nodeId, pin.id, { rotation: v })}
              aria-label={`${pin.name || pin.id} rotation`}
            />
          </div>

          <div className={styles.paramRow}>
            <span className={styles.paramLabel}>Stiffness</span>
            <ValueField
              value={pin.stiffness ?? 0}
              min={0}
              onChange={(v) => updatePuppetPin(nodeId, pin.id, { stiffness: Math.max(0, v) })}
              aria-label={`${pin.name || pin.id} stiffness`}
            />
          </div>
        </div>
      ))}
    </div>
  );
}

export default PuppetControls;
