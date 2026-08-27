/**
 * Effect Controls — the left-sidebar editor for effects already on the
 * selected layer, designed authentically after Adobe After Effects.
 */

import { useState } from 'react';
import { useSelectionStore } from '@stores/selectionStore';
import { useSceneRevision } from '@stores/sceneStore';
import { useLayoutStore } from '@stores/layoutStore';
import defaultSceneGraph from '@core/scene/DefaultSceneGraph';
import { getNodeEffects } from '@core/effects/effects';
import { readPathOps } from '@core/scene/pathOps';
import { nodeHasCloner } from '@core/scene/clonerExpand';
import { nodeHasPhysics } from '@core/simulation/physicsBodies';
import { PathOpControls } from '@layout/Inspector/PathOpControls';
import { ClonerSection } from '@layout/Inspector/ClonerSection';
import { PhysicsSection } from '@layout/Inspector/PhysicsSection';
import { EffectStack } from './EffectStack';
import { Icon } from '@components/Icon';
import { Button } from '@components/Button';
import styles from './EffectsPanel.module.css';

const QUICK_CATEGORIES = [
  { name: 'Blur & Sharpen', icon: 'blur' as const, effectId: 'gaussian-blur' },
  { name: 'Color Correction', icon: 'palette' as const, effectId: 'brightness-contrast' },
  { name: 'Distort', icon: 'waves' as const, effectId: 'turbulent-displace' },
  { name: 'Generate', icon: 'gradient' as const, effectId: 'glow' },
  { name: 'Stylize', icon: 'sparkles' as const, effectId: 'drop-shadow' },
];

export function EffectControlsPanel(): JSX.Element {
  const primary = useSelectionStore((s) => s.primary);
  useSceneRevision((s) => s.rev);

  const [locked, setLocked] = useState(false);
  const [masterFx, setMasterFx] = useState(true);

  const node = primary ? defaultSceneGraph.getNode(primary) : undefined;
  const count = primary ? getNodeEffects(primary).length : 0;
  const layerName = node?.name?.trim() || (primary ? `Layer: ${primary}` : 'No Layer Selected');
  const hasPathOps = node ? readPathOps(node).length > 0 : false;
  const hasCloner = node ? nodeHasCloner(node) : false;
  const hasPhysics = node ? nodeHasPhysics(node) : false;
  const hasAnything = count > 0 || hasPathOps || hasCloner || hasPhysics;

  return (
    <div className={styles.controlsRoot}>
      {/* ── AE Effect Controls Header ── */}
      <div className={styles.layerHead}>
        <button
          type="button"
          className={`${styles.fxMark}`}
          style={{ background: masterFx ? 'var(--color-selection, #2988ff)' : '#444444', color: '#ffffff', cursor: 'pointer', border: 'none' }}
          onClick={() => setMasterFx(!masterFx)}
          title={masterFx ? 'Master FX: Enabled (Click to disable all layer effects)' : 'Master FX: Disabled'}
        >
          fx
        </button>
        <span className={styles.layerName} title={layerName}>{layerName}</span>
        
        <button
          type="button"
          style={{ border: 'none', background: 'transparent', color: locked ? 'var(--color-selection, #2988ff)' : 'var(--color-text-muted)', cursor: 'pointer', padding: 0 }}
          onClick={() => setLocked(!locked)}
          title={locked ? 'Unlock Effect Controls' : 'Lock Effect Controls to current layer'}
        >
          <Icon name={locked ? 'lock' : 'unlock'} size="sm" />
        </button>
      </div>

      <div className={styles.controlsBody}>
        {!primary || !node ? (
          <div style={{ padding: 12, display: 'flex', flexDirection: 'column', gap: 10 }}>
            <p style={{ margin: 0, fontSize: 'var(--font-size-xs)', color: 'var(--color-text-secondary)', lineHeight: 1.4 }}>
              Select a layer in the Timeline or Composition to view and keyframe its applied effects stack.
            </p>
            <div style={{ fontSize: 'var(--font-size-micro)', fontWeight: 700, color: 'var(--color-text-tertiary)', textTransform: 'uppercase', letterSpacing: '0.06em', marginTop: 4 }}>
              Quick Add Effects
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
              {QUICK_CATEGORIES.map((cat) => (
                <button
                  key={cat.name}
                  type="button"
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    padding: '6px 10px',
                    background: 'var(--color-surface-2, #161616)',
                    border: '1px solid var(--color-field-border, rgba(255,255,255,0.08))',
                    borderRadius: 4,
                    color: 'var(--color-text-primary, #e1e1e1)',
                    fontSize: 'var(--font-size-xs)',
                    cursor: 'pointer',
                    textAlign: 'left',
                  }}
                  onClick={() => useLayoutStore.getState().openPanel('effects')}
                >
                  <span style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <Icon name={cat.icon} size="sm" />
                    <span>{cat.name}</span>
                  </span>
                  <Icon name="chevron-right" size="sm" />
                </button>
              ))}
            </div>
          </div>
        ) : !hasAnything ? (
          <div style={{ padding: 12, display: 'flex', flexDirection: 'column', gap: 10, textAlign: 'center' }}>
            <p style={{ margin: 0, fontSize: 'var(--font-size-xs)', color: 'var(--color-text-secondary)', lineHeight: 1.4 }}>
              No effects currently applied to “{layerName}”.
            </p>
            <Button
              size="sm"
              variant="primary"
              onClick={() => useLayoutStore.getState().openPanel('effects')}
              style={{ alignSelf: 'center' }}
            >
              Browse Effects &amp; Presets
            </Button>
          </div>
        ) : (
          <>
            {count > 0 && <EffectStack nodeId={primary} />}
            <PathOpControls nodeId={primary} />
            {hasCloner && <ClonerSection nodeId={primary} />}
            {hasPhysics && <PhysicsSection nodeId={primary} />}
          </>
        )}
      </div>
    </div>
  );
}

export default EffectControlsPanel;
