/**
 * PuppetControls — inspector for a layer's puppet rig.
 *
 * After Effects' Puppet panel is short: mesh density, then the pins you placed,
 * each showing only the properties its tool owns. Solver / rotation refinement
 * stay available but are not the first thing you see.
 */

import { Slider } from '@components/Slider';
import { ValueField } from '@components/ValueField';
import { Button } from '@components/Button';
import { Icon } from '@components/Icon';
import { useSceneRevision } from '@stores/sceneStore';
import { useUIStore } from '@stores/uiStore';
import defaultSceneGraph from '@core/scene/DefaultSceneGraph';
import {
  readNodePuppet,
  PIN_KIND_CATALOG,
  pinKindOf,
  pinColor,
  type PinKind,
} from '@core/rig/puppet';
import { maxExactMeshDensity, SMOOTH_PLAYBACK_MAX_DENSITY } from '@core/rig/arap';
import { updatePuppetSettings, updatePuppetPin, deletePuppetPin } from '@core/rig/puppetCommands';
import styles from './BoneControls.module.css';

/** Shared <select> chrome — every dropdown here must look identical. */
const selectStyle: React.CSSProperties = {
  padding: '3px 8px',
  fontSize: 11,
  borderRadius: 4,
  background: 'var(--color-surface, #1e1e1e)',
  color: 'var(--color-text-primary, #fff)',
  border: '1px solid var(--color-border, #333)',
};

function pinCountLabel(n: number): string {
  return n === 1 ? '1 pin' : `${n} pins`;
}

export function PuppetControls({ nodeId }: { nodeId: string }): JSX.Element | null {
  useSceneRevision((s) => s.rev);
  const node = defaultSceneGraph.getNode(nodeId);
  if (!node) return null;

  const rig = readNodePuppet(node);
  const density = rig?.meshDensity ?? 22;
  const expansion = rig?.meshExpansion ?? 0;
  const solver = rig?.solver ?? 'arap';
  const pins = rig?.pins ?? [];

  const hasStiffness = pins.some((p) => (p.stiffness ?? 0) > 0);
  const exactMax = maxExactMeshDensity(hasStiffness);
  const pastExact = solver === 'arap' && density > exactMax;
  const costly = solver === 'arap' && density > SMOOTH_PLAYBACK_MAX_DENSITY;

  return (
    <div className={styles.root}>
      <div className={styles.headerCard}>
        <div className={styles.headerTitle}>
          <Icon name="puppet-pin" size={14} />
          <span>Puppet</span>
          <span className={styles.badge}>{pinCountLabel(pins.length)}</span>
        </div>
        <Button
          size="sm"
          variant="secondary"
          onClick={() => useUIStore.getState().setActiveTool('puppet-pin')}
        >
          <Icon name="plus" size={12} /> Add Pin
        </Button>
      </div>

      <div className={styles.card}>
        <div className={styles.paramRow} style={{ height: 'auto', marginBottom: 2 }}>
          <div className={styles.presetGroup}>
            <button
              type="button"
              className={`${styles.presetButton} ${expansion === 0 ? styles.presetButtonActive : ''}`}
              title="Tight mesh with zero expansion — prevents limbs from pulling the torso"
              onClick={() =>
                // Density 20, not 22: the ⚓ Anchor toggle gives a pin stiffness
                // 10, and any stiffness lowers the ARAP exact-solve cap to 21 —
                // a 22 preset silently landed every anchored character in the
                // approximate Gauss–Seidel solve.
                updatePuppetSettings(nodeId, {
                  meshExpansion: 0,
                  meshDensity: 20,
                  meshMode: 'silhouette',
                })
              }
            >
              <Icon name="user" size={12} />
              <span>Character (Tight)</span>
            </button>
            <button
              type="button"
              className={`${styles.presetButton} ${expansion > 0 ? styles.presetButtonActive : ''}`}
              title="Softer mesh with padding — ideal for shapes and banners"
              onClick={() =>
                updatePuppetSettings(nodeId, {
                  meshExpansion: 6,
                  meshDensity: 16,
                  meshMode: 'grid',
                })
              }
            >
              <Icon name="shape" size={12} />
              <span>Graphic (Smooth)</span>
            </button>
          </div>
        </div>

        <div className={styles.paramRow}>
          <span className={styles.paramLabel}>
            Density
            {solver === 'arap' && (
              <span
                className={styles.subText}
                style={{ marginLeft: 6 }}
                title={`Exact solve up to ${exactMax}. Smooth playback up to ${SMOOTH_PLAYBACK_MAX_DENSITY} — beyond that the solve cost per frame climbs steeply.`}
              >
                (exact ≤ {exactMax} · fast ≤ {SMOOTH_PLAYBACK_MAX_DENSITY})
              </span>
            )}
          </span>
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

        {costly && (
          <div className={styles.warningBox} role="note">
            Density {density} is heavy to solve — roughly{' '}
            {density >= 33 ? '35–45 ms' : '10–20 ms'} per frame. Around {SMOOTH_PLAYBACK_MAX_DENSITY} keeps playback smooth.
          </div>
        )}

        {pastExact && (
          <div className={styles.warningBox} role="note">
            Density {density} is above {exactMax}
            {hasStiffness ? ' (lowered because a pin has stiffness)' : ''} — ARAP falls
            back from exact solve to an approximate one. Lower density for maximum fidelity.
          </div>
        )}

        <div className={styles.paramRow}>
          <span className={styles.paramLabel} title="Grid culls a uniform mesh against the artwork; Silhouette triangulates the outline (or a PNG's alpha).">
            Mesh
          </span>
          <select
            value={rig?.meshMode ?? 'grid'}
            aria-label="Puppet mesh mode"
            onChange={(e) =>
              updatePuppetSettings(nodeId, { meshMode: e.target.value as 'grid' | 'silhouette' })
            }
            style={selectStyle}
          >
            <option value="grid">Grid</option>
            <option value="silhouette">Outline</option>
          </select>
        </div>

        <div className={styles.paramRow}>
          <span className={styles.paramLabel}>Expansion</span>
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

        <div className={styles.paramRow}>
          <span className={styles.paramLabel}>Solver</span>
          <select
            value={solver}
            aria-label="Puppet deform solver"
            onChange={(e) =>
              updatePuppetSettings(nodeId, { solver: e.target.value as 'lbs' | 'arap' })
            }
            style={selectStyle}
          >
            <option value="arap">ARAP</option>
            <option value="lbs">LBS</option>
          </select>
        </div>

        <div className={styles.paramRow}>
          <span className={styles.paramLabel} title="Caps how far any one pin may rotate the mesh. 0 = unlimited.">
            Rotation Limit
          </span>
          <ValueField
            value={rig?.maxRotationDeg ?? 0}
            min={0}
            unit="°"
            onChange={(v) =>
              updatePuppetSettings(nodeId, {
                maxRotationDeg: v <= 0 ? undefined : Math.max(0, v),
              })
            }
            aria-label="Mesh rotation refinement"
          />
        </div>
      </div>

      {pins.length > 0 && pins.length < 3 && (
        <div className={styles.tipCard}>
          <Icon name="info" size="sm" style={{ flexShrink: 0, marginTop: 1, color: '#60a5fa' }} />
          <span>
            <strong>Tip:</strong> Add anchor pins to the <em>chest</em> & <em>shoulders</em> to keep the body in place when moving limbs.
          </span>
        </div>
      )}

      {pins.length === 0 && (
        <div className={styles.card} style={{ textAlign: 'center', padding: '16px 12px' }}>
          <span className={styles.subText}>Click the layer to place pins.</span>
          <Button
            size="sm"
            variant="primary"
            onClick={() => useUIStore.getState().setActiveTool('puppet-pin')}
            style={{ marginTop: 8 }}
          >
            <Icon name="puppet-pin" size="sm" style={{ color: '#ffffff' }} /> Puppet Pin Tool (Ctrl+P)
          </Button>
        </div>
      )}

      {pins.map((pin) => {
        const kind = pinKindOf(pin);
        const showRotate = kind === 'advanced' || kind === 'bend';
        const showScale = kind === 'advanced' || kind === 'bend';
        const showStiffness = kind === 'starch' || kind === 'advanced' || (pin.stiffness ?? 0) > 0;
        const showOverlap = kind === 'overlap' || (pin.overlap ?? 0) !== 0;
        const isAnchored = (pin.stiffness ?? 0) >= 5;
        return (
          <div key={pin.id} className={styles.card}>
            <div className={styles.cardHeader}>
              <div className={styles.cardTitle}>
                <span
                  aria-hidden
                  style={{
                    width: 8,
                    height: 8,
                    borderRadius: '50%',
                    background: kind === 'bend' ? 'transparent' : pinColor(kind),
                    border: `2px solid ${pinColor(kind)}`,
                    flexShrink: 0,
                  }}
                />
                <span>{pin.name || pin.id}</span>
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                <button
                  type="button"
                  className={`${styles.anchorToggle} ${isAnchored ? styles.anchorToggleActive : ''}`}
                  title={isAnchored ? 'Anchor lock active (body stays rigid)' : 'Lock as rigid anchor (Stiffness: 10)'}
                  onClick={() =>
                    updatePuppetPin(nodeId, pin.id, {
                      stiffness: isAnchored ? 0 : 10,
                    })
                  }
                >
                  <Icon
                    name={isAnchored ? 'lock' : 'anchor'}
                    size={11}
                    style={{ color: isAnchored ? '#f5b041' : 'inherit' }}
                  />
                  <span>{isAnchored ? 'Locked' : 'Anchor'}</span>
                </button>
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
            </div>

            <div className={styles.paramRow}>
              <span className={styles.paramLabel}>Type</span>
              <select
                value={kind}
                aria-label={`${pin.name || pin.id} pin type`}
                onChange={(e) =>
                  updatePuppetPin(nodeId, pin.id, { kind: e.target.value as PinKind })
                }
                style={selectStyle}
              >
                {PIN_KIND_CATALOG.map((k) => (
                  <option key={k.kind} value={k.kind}>{k.short}</option>
                ))}
              </select>
            </div>

            {kind === 'bend' && (
              <div className={styles.subText} style={{ margin: '2px 0 6px' }}>
                Position is derived from the advanced pins around it. Rotation and
                scale act on the motion they already produce — at 0° and 1× this
                pin does nothing.
              </div>
            )}
            {kind === 'starch' && (
              <div className={styles.subText} style={{ margin: '2px 0 6px' }}>
                Keeps this region rigid so nearby pins cannot fold it.
              </div>
            )}
            {kind === 'overlap' && (
              <div className={styles.subText} style={{ margin: '2px 0 6px' }}>
                Sets which part draws in front when the mesh folds over itself.
              </div>
            )}

            {showRotate && (
              <div className={styles.paramRow}>
                <span className={styles.paramLabel}>Rotation</span>
                <ValueField
                  value={pin.rotation ?? 0}
                  unit="°"
                  onChange={(v) => updatePuppetPin(nodeId, pin.id, { rotation: v })}
                  aria-label={`${pin.name || pin.id} rotation`}
                />
              </div>
            )}

            {showStiffness && (
              <div className={styles.paramRow}>
                <span className={styles.paramLabel}>Stiffness</span>
                <ValueField
                  value={pin.stiffness ?? 0}
                  min={0}
                  onChange={(v) => updatePuppetPin(nodeId, pin.id, { stiffness: Math.max(0, v) })}
                  aria-label={`${pin.name || pin.id} stiffness`}
                />
              </div>
            )}

            {showScale && (
              <div className={styles.paramRow}>
                <span className={styles.paramLabel}>Scale</span>
                <ValueField
                  value={pin.scale ?? 1}
                  min={0.01}
                  onChange={(v) => updatePuppetPin(nodeId, pin.id, { scale: Math.max(0.01, v) })}
                  aria-label={`${pin.name || pin.id} scale`}
                />
              </div>
            )}

            {showOverlap && (
              <div className={styles.paramRow}>
                <span
                  className={styles.paramLabel}
                  title="Depth ordering where the mesh folds over itself — positive draws this region in front."
                >
                  Overlap
                </span>
                <ValueField
                  value={pin.overlap ?? 0}
                  min={-100}
                  max={100}
                  onChange={(v) =>
                    updatePuppetPin(nodeId, pin.id, {
                      overlap: v === 0 ? undefined : Math.max(-100, Math.min(100, v)),
                    })
                  }
                  aria-label={`${pin.name || pin.id} overlap`}
                />
              </div>
            )}

            {showOverlap && (pin.overlap ?? 0) !== 0 && (
              <div className={styles.paramRow}>
                <span className={styles.paramLabel}>Overlap Extent</span>
                <ValueField
                  value={pin.overlapExtent ?? 1}
                  min={0.05}
                  onChange={(v) =>
                    updatePuppetPin(nodeId, pin.id, { overlapExtent: Math.max(0.05, v) })
                  }
                  aria-label={`${pin.name || pin.id} overlap extent`}
                />
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

export default PuppetControls;
