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
import { usePhysicsStore } from '@stores/physicsStore';
import { DEFAULT_PHYSICS_BODY } from '@core/simulation/physicsBodies';
import { useMirrorLayer } from '@hooks/useMirror';
import { useMirrorJson } from '@hooks/useMirrorFields';
import { edit } from '@core/engine/uiEdits';
import { useEngineEdit } from './useEngineEdit';
import { jsonFieldCommands } from './layerFieldEdits';
import type { BodyKind, ColliderShape, PhysicsBodyConfig } from '@core/simulation/rigidBody';
// Importing this module is what REGISTERS `dynamics.bakePhysics` /
// `dynamics.bakeParticles`. It has to be imported from somewhere that runs at
// boot, and the Inspector is the surface that owns the feature — so the
// commands need no entry in the boot sequence to exist.
import { runPhysicsBake } from '@core/simulation/bakeCommands';
import { BakeDialog } from './BakeDialog';
import panel from '@layout/Effects/EffectsPanel.module.css';

const PHYSICS_PATH = 'layer/physics';
const EDIT_LABEL = 'Edit Physics';

export function PhysicsSection({ nodeId }: { nodeId: string }): JSX.Element | null {
  const eng = useEngineEdit();
  // B4: the layer header and its `layer/physics` json field from the document mirror.
  const layer = useMirrorLayer(nodeId);
  const stored = useMirrorJson<Partial<PhysicsBodyConfig>>(nodeId, PHYSICS_PATH);
  const w = usePhysicsStore();
  const [isCollapsed, setIsCollapsed] = useState(false);
  const [worldCollapsed, setWorldCollapsed] = useState(false);
  const [bakeOpen, setBakeOpen] = useState(false);

  if (!layer) return null;

  // The stored config including a disabled one, over the defaults (readNodePhysicsRaw's rule).
  const cfg: PhysicsBodyConfig = stored && typeof stored === 'object' ? { ...DEFAULT_PHYSICS_BODY, ...stored } : DEFAULT_PHYSICS_BODY;
  const off = !cfg.enabled;

  // `layer/physics` (json, fx.__physics): the whole next config per write; a
  // scrub is one gesture, a typed value / pick / checkbox one entry.
  const write = (patch: Partial<PhysicsBodyConfig>, label = EDIT_LABEL): void => {
    eng.send(label, jsonFieldCommands(nodeId, PHYSICS_PATH, { ...cfg, ...patch }));
  };

  const removePhysics = (): void => {
    void edit('Remove Physics', jsonFieldCommands(nodeId, PHYSICS_PATH, null));
  };

  // AE's Reset restores the parameters, not the effect switch: `enabled` is kept.
  const resetPhysics = (): void => {
    void edit('Reset Physics', jsonFieldCommands(nodeId, PHYSICS_PATH, { ...DEFAULT_PHYSICS_BODY, enabled: cfg.enabled }));
  };
  const scrub = eng.scrub(EDIT_LABEL);

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
          onChange={(ev) => write({ enabled: ev.target.checked }, ev.target.checked ? 'Enable Physics' : 'Disable Physics')}
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
                <ValueField value={cfg.mass} min={0.01} precision={2} {...scrub} onChange={(v) => write({ mass: v })} aria-label="Mass" />
              </PropertyRow>
              <PropertyRow label="Bounce" compact>
                <ValueField value={cfg.restitution} min={0} max={1} precision={2} {...scrub} onChange={(v) => write({ restitution: v })} aria-label="Restitution" />
              </PropertyRow>
              <PropertyRow label="Friction" compact>
                <ValueField value={cfg.friction} min={0} max={1} precision={2} {...scrub} onChange={(v) => write({ friction: v })} aria-label="Friction" />
              </PropertyRow>
              <PropertyRow label="Damping" compact>
                <ValueField value={cfg.damping} min={0} max={1} precision={3} {...scrub} onChange={(v) => write({ damping: v })} aria-label="Damping" />
              </PropertyRow>
            </>
          )}

          {/* Bake — the escape hatch out of live solve, for DYNAMIC bodies only:
              a static body's pose is its own transform and the solver never
              overrides it, so there is nothing of it to write down. */}
          {cfg.kind === 'dynamic' && (
            <PropertyRow label="Bake" compact>
              <button
                type="button"
                className={panel.paramSelect}
                style={{ width: '100%', textAlign: 'left', cursor: 'pointer' }}
                onClick={() => setBakeOpen(true)}
                title="Convert this simulation into editable keyframes and switch physics off"
              >
                Bake to keyframes…
              </button>
            </PropertyRow>
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

      {bakeOpen && (
        <BakeDialog
          open
          onClose={() => setBakeOpen(false)}
          title="Bake Physics to Keyframes"
          onBake={(opts) => runPhysicsBake([nodeId], opts)}
        />
      )}
    </div>
  );
}

export default PhysicsSection;

