/**
 * Effect Controls — the left-sidebar editor for effects already on the
 * selected layer, designed authentically after Adobe After Effects.
 */

import { useState, type ReactNode } from 'react';
import { useSelectionStore } from '@stores/selectionStore';
import { useLayoutStore } from '@stores/layoutStore';
import { documentMirror } from '@stores/documentMirror';
import { useMirrorLayer, useMirrorTree } from '@hooks/useMirror';
import { mirrorPathOps } from '@core/mirror/layerFacts';
import { jsonField } from '@core/mirror/layerFields';
import { PathOpControls } from '@layout/Inspector/PathOpControls';
import { ClonerSection } from '@layout/Inspector/ClonerSection';
import { PhysicsSection } from '@layout/Inspector/PhysicsSection';
import { EffectStack } from './EffectStack';
import { setLayerEffectsEnabledEdit } from './effectEdits';
import { Icon } from '@components/Icon';
import { Button } from '@components/Button';
import styles from './EffectsPanel.module.css';

const isObject = (v: unknown): boolean => !!v && typeof v === 'object';

const QUICK_CATEGORIES = [
  { name: 'Blur & Sharpen', icon: 'blur' as const, effectId: 'gaussian-blur' },
  { name: 'Color Correction', icon: 'palette' as const, effectId: 'brightness-contrast' },
  { name: 'Distort', icon: 'waves' as const, effectId: 'turbulent-displace' },
  { name: 'Generate', icon: 'gradient' as const, effectId: 'glow' },
  { name: 'Stylize', icon: 'sparkles' as const, effectId: 'drop-shadow' },
];

/**
 * What Effect Controls lists for one layer: its applied effects, then the path
 * operators, Cloner and Physics attached from Effects ▸ Shape / Simulation.
 *
 * Shared with the Properties panel's Effects section, so the stack has ONE
 * implementation whichever surface draws it. `empty` is the host's own
 * nothing-here line — a panel has room for a call to action, a section does not.
 */
export function EffectControlsBody({ nodeId, empty }: { nodeId: string; empty: ReactNode }): JSX.Element {
  // `primary`: the layer Effect Controls is showing — the selection's, or the
  // locked one. Named so here too; clonerExpand.test follows it by that name.
  const primary = nodeId;
  // B4: the layer's header (effect count) and property tree (path operators,
  // `layer/cloner`, `layer/physics`) from the document mirror.
  const tree = useMirrorTree(primary);
  const m = documentMirror();
  const layer = m.layer(primary);
  const count = layer?.effectCount ?? 0;
  const hasPathOps = layer ? mirrorPathOps(tree).length > 0 : false;
  const hasCloner = layer ? isObject(jsonField(m, primary, 'layer/cloner')) : false;
  const hasPhysics = layer ? isObject(jsonField(m, primary, 'layer/physics')) : false;
  if (!layer || !(count > 0 || hasPathOps || hasCloner || hasPhysics)) return <>{empty}</>;
  return (
    <>
      {count > 0 && <EffectStack nodeId={primary} />}
      {hasPathOps && <PathOpControls nodeId={primary} />}
      {hasCloner && <ClonerSection nodeId={primary} />}
      {hasPhysics && <PhysicsSection nodeId={primary} />}
    </>
  );
}

export function EffectControlsPanel(): JSX.Element {
  const selected = useSelectionStore((s) => s.primary);

  // Lock (AE's padlock): the panel stays on the layer it was locked to while
  // the selection moves on — so an effect can be tuned while picking other
  // layers as its map/matte source. A locked layer that is deleted unlocks.
  const [lockedId, setLockedId] = useState<string | null>(null);
  // B4: layer headers from the document mirror.
  const lockedLayer = useMirrorLayer(lockedId);
  const locked = lockedId !== null && !!lockedLayer;
  const primary = locked ? lockedId : selected;
  const node = useMirrorLayer(primary);

  // Master "fx" switch: the layer's own fxEnabled flag — the same switch the
  // timeline's fx column flips — not local state that changed nothing.
  const masterFx = primary ? node?.switches.effectsEnabled ?? true : true;
  const setMasterFx = (on: boolean): void => {
    if (primary) void setLayerEffectsEnabledEdit(primary, on);
  };
  const setLocked = (on: boolean): void => setLockedId(on && selected ? selected : null);

  const layerName = node?.name?.trim() || (primary ? `Layer: ${primary}` : 'No Layer Selected');

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
        ) : (
          <EffectControlsBody
            nodeId={primary}
            empty={
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
            }
          />
        )}
      </div>
    </div>
  );
}

export default EffectControlsPanel;
