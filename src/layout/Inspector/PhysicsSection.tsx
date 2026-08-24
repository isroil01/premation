/**
 * Physics controls — per-layer body settings, plus the shared world.
 *
 * Lives in Effect Controls once attached from Effects → Simulation. The world
 * (gravity, walls, solver passes) is shown here rather than in a separate panel
 * because it is meaningless on its own and nobody would go looking for it: you
 * reach for gravity the moment the first body falls the wrong way. It is
 * labelled as shared, so it is clear that changing it here changes it for every
 * body in the composition.
 *
 * The "no rotation" limit is stated in the panel rather than left to be
 * discovered. A solver that translates but never spins is a reasonable tool; a
 * solver that silently fails to spin looks broken the first time someone drops
 * a domino.
 */

import { ValueField } from '@components/ValueField';
import { Checkbox } from '@components/Checkbox';
import { InspectorRow } from '@components/Inspector';
import { useSceneRevision, bumpScene } from '@stores/sceneStore';
import { usePhysicsStore } from '@stores/physicsStore';
import defaultSceneGraph from '@core/scene/DefaultSceneGraph';
import { readNodePhysicsRaw, PHYSICS_PROP } from '@core/simulation/physicsBodies';
import type { BodyKind, ColliderShape, PhysicsBodyConfig } from '@core/simulation/rigidBody';
import styles from './TransformSection.module.css';

export function PhysicsSection({ nodeId }: { nodeId: string }): JSX.Element | null {
  useSceneRevision((s) => s.rev);
  const node = defaultSceneGraph.getNode(nodeId);
  const w = usePhysicsStore();
  if (!node) return null;

  const cfg = readNodePhysicsRaw(node);

  const write = (patch: Partial<PhysicsBodyConfig>): void => {
    defaultSceneGraph.setFxKey(nodeId, PHYSICS_PROP, { ...cfg, ...patch });
    bumpScene();
  };

  return (
    <>
      <InspectorRow label="Physics" align="center">
        <div className={styles.control}>
          <Checkbox
            checked={cfg.enabled}
            onChange={(e) => write({ enabled: e.target.checked })}
            aria-label="Enable physics"
          />
        </div>
      </InspectorRow>

      {cfg.enabled && (
        <>
          <InspectorRow label="Type" align="center">
            <select
              className={styles.select}
              style={{ width: 110 }}
              value={cfg.kind}
              onChange={(e) => write({ kind: e.target.value as BodyKind })}
              aria-label="Body type"
            >
              <option value="dynamic">Dynamic</option>
              <option value="static">Static</option>
            </select>
          </InspectorRow>

          <InspectorRow label="Collider" align="center">
            <select
              className={styles.select}
              style={{ width: 110 }}
              value={cfg.shape}
              onChange={(e) => write({ shape: e.target.value as ColliderShape })}
              aria-label="Collider shape"
            >
              <option value="box">Box</option>
              <option value="circle">Circle</option>
            </select>
          </InspectorRow>

          {cfg.kind === 'dynamic' && (
            <>
              <InspectorRow label="Spin" align="center">
                <div className={styles.control}>
                  <Checkbox
                    checked={cfg.rotate}
                    onChange={(e) => write({ rotate: e.target.checked })}
                    aria-label="Allow rotation"
                  />
                  <span style={{ marginLeft: 8, fontSize: 'var(--font-size-micro)', color: 'var(--color-text-tertiary)' }}>
                    {cfg.rotate ? 'Tumbles and rolls' : 'Translates only'}
                  </span>
                </div>
              </InspectorRow>
              <InspectorRow label="Mass">
                <ValueField value={cfg.mass} min={0.01} precision={2} onChange={(v) => write({ mass: v })} aria-label="Mass" />
              </InspectorRow>
              <InspectorRow label="Bounce">
                <ValueField value={cfg.restitution} min={0} max={1} precision={2} onChange={(v) => write({ restitution: v })} aria-label="Restitution" />
              </InspectorRow>
              <InspectorRow label="Friction">
                <ValueField value={cfg.friction} min={0} max={1} precision={2} onChange={(v) => write({ friction: v })} aria-label="Friction" />
              </InspectorRow>
              <InspectorRow label="Damping">
                <ValueField value={cfg.damping} min={0} max={1} precision={3} onChange={(v) => write({ damping: v })} aria-label="Damping" />
              </InspectorRow>
            </>
          )}

          <h4 className={styles.sectionNote} style={{ margin: '8px 0 2px' }}>World (shared)</h4>
          <InspectorRow label="Gravity X">
            <ValueField value={w.gravityX} precision={0} onChange={(v) => w.set({ gravityX: v })} aria-label="Gravity X" />
          </InspectorRow>
          <InspectorRow label="Gravity Y">
            <ValueField value={w.gravityY} precision={0} onChange={(v) => w.set({ gravityY: v })} aria-label="Gravity Y" />
          </InspectorRow>
          <InspectorRow label="Walls" align="center">
            <div className={styles.control}>
              <Checkbox
                checked={w.useCompBounds}
                onChange={(e) => w.set({ useCompBounds: e.target.checked })}
                aria-label="Use composition bounds"
              />
              <span style={{ marginLeft: 8, fontSize: 'var(--font-size-micro)', color: 'var(--color-text-tertiary)' }}>
                {w.useCompBounds ? 'Comp edges' : 'Open — bodies leave frame'}
              </span>
            </div>
          </InspectorRow>
          <InspectorRow label="Solver">
            <ValueField value={w.iterations} min={1} max={20} precision={0} onChange={(v) => w.set({ iterations: v })} aria-label="Solver iterations" />
          </InspectorRow>

          <p className={styles.sectionNote} style={{ marginTop: 6 }}>
            Physics replaces a dynamic layer’s keyframed position — and its
            rotation too, once Spin is on. Spin is off by default so scenes
            simulated before it existed replay identically.
          </p>
        </>
      )}
    </>
  );
}

export default PhysicsSection;
