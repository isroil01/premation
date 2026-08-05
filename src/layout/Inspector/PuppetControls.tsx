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
import { readNodePuppet, type PinKind } from '@core/rig/puppet';
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

export function PuppetControls({ nodeId }: { nodeId: string }): JSX.Element | null {
  useSceneRevision((s) => s.rev);
  const node = defaultSceneGraph.getNode(nodeId);
  if (!node) return null;

  const rig = readNodePuppet(node);
  const density = rig?.meshDensity ?? 15;
  const expansion = rig?.meshExpansion ?? 8;
  const solver = rig?.solver ?? 'arap';
  const pins = rig?.pins ?? [];

  // Solver quality disclosure (§12.11). Past this density ARAP drops from the
  // exact dense Cholesky solve to fixed-sweep Gauss-Seidel — deterministic and
  // stable, but softer. It used to happen silently with the slider running on
  // to 50 and no indication anywhere.
  const hasStiffness = pins.some((p) => (p.stiffness ?? 0) > 0);
  const exactMax = maxExactMeshDensity(hasStiffness);
  const pastExact = solver === 'arap' && density > exactMax;

  // Cost disclosure — SEPARATE from the exactness one, because the two
  // thresholds are different and conflating them misleads. Measured: density 33
  // (the last EXACT density) already costs ~36 ms/frame and stalls ~673 ms on
  // the first solve. Labelling 33 as "exact" without this reads as a
  // recommendation to go there. See SMOOTH_PLAYBACK_MAX_DENSITY for the table.
  const costly = solver === 'arap' && density > SMOOTH_PLAYBACK_MAX_DENSITY;

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
            style={selectStyle}
          >
            <option value="arap">ARAP (Rigid / Elastic)</option>
            <option value="lbs">Linear Blend (LBS)</option>
          </select>
        </div>

        <div className={styles.paramRow}>
          <span className={styles.paramLabel}>
            Mesh Density
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
          <div className={styles.paramRow} style={{ display: 'block' }}>
            <span className={styles.subText} role="note">
              Density {density} is heavy to solve — roughly{' '}
              {density >= 33 ? '35–45 ms' : '10–20 ms'} per frame for this layer, paid again
              for every rigged layer. Around {SMOOTH_PLAYBACK_MAX_DENSITY} keeps playback
              smooth; higher is best reserved for a final look.
            </span>
          </div>
        )}

        {pastExact && (
          <div className={styles.paramRow} style={{ display: 'block' }}>
            <span className={styles.subText} role="note">
              Density {density} is above {exactMax}
              {hasStiffness ? ' (lowered because a pin has stiffness)' : ''} — ARAP falls
              back from the exact solve to an approximate one. Still deterministic and
              stable, but deformation is softer. Lower the density for maximum fidelity.
            </span>
          </div>
        )}

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

        <div className={styles.paramRow}>
          <span className={styles.paramLabel} title="Grid culls a uniform mesh against the artwork; Silhouette triangulates the outline itself — better on thin diagonal shapes.">
            Mesh Shape
          </span>
          <select
            value={rig?.meshMode ?? 'grid'}
            aria-label="Puppet mesh mode"
            onChange={(e) =>
              updatePuppetSettings(nodeId, { meshMode: e.target.value as 'grid' | 'silhouette' })
            }
            style={selectStyle}
          >
            <option value="grid">Grid (culled)</option>
            <option value="silhouette">Silhouette (outline)</option>
          </select>
        </div>

        <div className={styles.paramRow}>
          <span className={styles.paramLabel} title="Caps how far any one pin may rotate the mesh. Suppresses twisting on sparse pin sets.">
            Rotation Refinement
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
        {(rig?.maxRotationDeg ?? 0) <= 0 && (
          <div className={styles.paramRow} style={{ display: 'block' }}>
            <span className={styles.subText}>0 = unlimited (no clamping).</span>
          </div>
        )}
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
            <span className={styles.paramLabel}>Pin Type</span>
            <select
              value={pin.kind ?? 'advanced'}
              aria-label={`${pin.name || pin.id} pin type`}
              onChange={(e) =>
                updatePuppetPin(nodeId, pin.id, { kind: e.target.value as PinKind })
              }
              style={selectStyle}
            >
              <option value="advanced">Advanced (owns position)</option>
              <option value="bend">Bend (derives position)</option>
            </select>
          </div>

          {pin.kind === 'bend' && (
            <div className={styles.subText} style={{ margin: '2px 0 6px' }}>
              Position is derived from the advanced pins around it. Rotation and
              scale act on the motion they already produce — at 0° and 1× this
              pin does nothing.
            </div>
          )}

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

          <div className={styles.paramRow}>
            <span className={styles.paramLabel}>Scale</span>
            <ValueField
              value={pin.scale ?? 1}
              min={0.01}
              onChange={(v) => updatePuppetPin(nodeId, pin.id, { scale: Math.max(0.01, v) })}
              aria-label={`${pin.name || pin.id} scale`}
            />
          </div>

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

          {(pin.overlap ?? 0) !== 0 && (
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
      ))}
    </div>
  );
}

export default PuppetControls;
