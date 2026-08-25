/**
 * Physics controls — per-layer body settings, plus the shared world.
 *
 * Rendered authentically as an AE Effect Card inside Effect Controls.
 */

import { useState } from 'react';
import { ValueField } from '@components/ValueField';
import { Checkbox } from '@components/Checkbox';
import { PropertyRow } from '@components/PropertyRow';
import { Icon } from '@components/Icon';
import { useSceneRevision, bumpScene } from '@stores/sceneStore';
import { usePhysicsStore } from '@stores/physicsStore';
import defaultSceneGraph from '@core/scene/DefaultSceneGraph';
import { readNodePhysicsRaw, PHYSICS_PROP, DEFAULT_PHYSICS_BODY } from '@core/simulation/physicsBodies';
import type { BodyKind, ColliderShape, PhysicsBodyConfig } from '@core/simulation/rigidBody';
import panel from '@layout/Effects/EffectsPanel.module.css';

export function PhysicsSection({ nodeId }: { nodeId: string }): JSX.Element | null {
  useSceneRevision((s) => s.rev);
  const node = defaultSceneGraph.getNode(nodeId);
  const w = usePhysicsStore();
  const [isCollapsed, setIsCollapsed] = useState(false);
  const [worldCollapsed, setWorldCollapsed] = useState(false);

  if (!node) return null;

  const cfg = readNodePhysicsRaw(node);
  const off = !cfg.enabled;

  const write = (patch: Partial<PhysicsBodyConfig>): void => {
    defaultSceneGraph.setFxKey(nodeId, PHYSICS_PROP, { ...cfg, ...patch });
    bumpScene();
  };

  const removePhysics = (): void => {
    defaultSceneGraph.setFxKey(nodeId, PHYSICS_PROP, undefined);
    bumpScene();
  };

  const resetPhysics = (): void => {
    defaultSceneGraph.setFxKey(nodeId, PHYSICS_PROP, DEFAULT_PHYSICS_BODY);
    bumpScene();
  };

  return (
    <div className={panel.effectCardItem}>
      {/* AE Effect Controls header: ▾ fx Physics (Rigid Body) .......... Reset */}
      <div className={panel.effectCardHead}>
        <span className={panel.dragGrip} aria-hidden title="Drag to reorder">
          <Icon name="grip-vertical" size="sm" />
        </span>
        <button
          type="button"
          className={panel.disclosureBtn}
          onClick={() => setIsCollapsed(!isCollapsed)}
          title={isCollapsed ? 'Expand effect parameters' : 'Collapse effect parameters'}
        >
          <Icon name={isCollapsed ? 'chevron-right' : 'chevron-down'} size="sm" />
        </button>

        <Checkbox
          checked={!off}
          onChange={(e) => write({ enabled: e.target.checked })}
          title={off ? 'Enable physics' : 'Disable physics'}
          style={{ width: 15, height: 15, flexShrink: 0 }}
        />

        <span className={panel.fxMark} aria-hidden>fx</span>

        <span
          className={off ? panel.itemLabelOff : panel.itemLabel}
          onClick={() => setIsCollapsed(!isCollapsed)}
        >
          Physics (Rigid Body)
        </span>

        <div className={panel.itemActions}>
          <button
            type="button"
            className={panel.remove}
            aria-label="Remove Physics"
            title="Remove Physics effect"
            onClick={removePhysics}
          >
            <Icon name="close" size="sm" />
          </button>
        </div>

        <button
          type="button"
          className={panel.resetLink}
          title="Restore physics parameters to default"
          onClick={resetPhysics}
        >
          Reset
        </button>
      </div>

      {/* Parameters Accordion Body */}
      {!isCollapsed && !off && (
        <div className={panel.effectParamsBody}>
          <PropertyRow label="Body Type" compact>
            <select
              className={panel.paramSelect}
              value={cfg.kind}
              onChange={(e) => write({ kind: e.target.value as BodyKind })}
              aria-label="Body type"
            >
              <option value="dynamic">Dynamic</option>
              <option value="static">Static</option>
            </select>
          </PropertyRow>

          <PropertyRow label="Collider" compact>
            <select
              className={panel.paramSelect}
              value={cfg.shape}
              onChange={(e) => write({ shape: e.target.value as ColliderShape })}
              aria-label="Collider shape"
            >
              <option value="box">Box</option>
              <option value="circle">Circle</option>
            </select>
          </PropertyRow>

          {cfg.kind === 'dynamic' && (
            <>
              <PropertyRow label="Allow Spin" compact>
                <div style={{ display: 'flex', alignItems: 'center', gap: 6, width: '100%' }}>
                  <Checkbox
                    checked={cfg.rotate}
                    onChange={(e) => write({ rotate: e.target.checked })}
                    aria-label="Allow rotation"
                  />
                  <span style={{ fontSize: 'var(--font-size-micro)', color: 'var(--color-text-tertiary)' }}>
                    {cfg.rotate ? 'Tumbles & rolls' : 'Translates only'}
                  </span>
                </div>
              </PropertyRow>
              <PropertyRow label="Mass" compact>
                <ValueField value={cfg.mass} min={0.01} precision={2} onChange={(v) => write({ mass: v })} aria-label="Mass" />
              </PropertyRow>
              <PropertyRow label="Bounce" compact>
                <ValueField value={cfg.restitution} min={0} max={1} precision={2} onChange={(v) => write({ restitution: v })} aria-label="Restitution" />
              </PropertyRow>
              <PropertyRow label="Friction" compact>
                <ValueField value={cfg.friction} min={0} max={1} precision={2} onChange={(v) => write({ friction: v })} aria-label="Friction" />
              </PropertyRow>
              <PropertyRow label="Damping" compact>
                <ValueField value={cfg.damping} min={0} max={1} precision={3} onChange={(v) => write({ damping: v })} aria-label="Damping" />
              </PropertyRow>
            </>
          )}

          {/* Simulation World (shared across composition) */}
          <div className={panel.paramGroup}>
            <button
              type="button"
              className={panel.paramGroupHead}
              onClick={() => setWorldCollapsed(!worldCollapsed)}
            >
              <Icon name={worldCollapsed ? 'chevron-right' : 'chevron-down'} size="sm" />
              <span>World (Simulation Scope)</span>
            </button>
            {!worldCollapsed && (
              <div className={panel.paramGroupBody}>
                <PropertyRow label="Gravity X" compact>
                  <ValueField value={w.gravityX} precision={0} onChange={(v) => w.set({ gravityX: v })} aria-label="Gravity X" />
                </PropertyRow>
                <PropertyRow label="Gravity Y" compact>
                  <ValueField value={w.gravityY} precision={0} onChange={(v) => w.set({ gravityY: v })} aria-label="Gravity Y" />
                </PropertyRow>
                <PropertyRow label="Comp Bounds" compact>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6, width: '100%' }}>
                    <Checkbox
                      checked={w.useCompBounds}
                      onChange={(e) => w.set({ useCompBounds: e.target.checked })}
                      aria-label="Use composition bounds"
                    />
                    <span style={{ fontSize: 'var(--font-size-micro)', color: 'var(--color-text-tertiary)' }}>
                      {w.useCompBounds ? 'Comp edges' : 'Open (leaves frame)'}
                    </span>
                  </div>
                </PropertyRow>
                <PropertyRow label="Solver Steps" compact>
                  <ValueField value={w.iterations} min={1} max={20} precision={0} onChange={(v) => w.set({ iterations: v })} aria-label="Solver iterations" />
                </PropertyRow>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

export default PhysicsSection;

