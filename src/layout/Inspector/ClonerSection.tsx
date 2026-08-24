/**
 * Cloner controls.
 *
 * Lives in Effect Controls once attached from Effects → Simulation. The panel
 * deliberately shows the CLONE COUNT next to the toggle rather than burying it:
 * every clone is a real renderable, so the count is the cost, and the
 * difference between a 5×5 grid and a 20×20 one is 25 layers versus 400.
 * A control whose expense is invisible gets dragged to the top of its range
 * once and blamed on the app.
 *
 * Mode-specific rows are shown only for the active mode. A radius field on a
 * grid does nothing, and a panel of controls that silently do nothing is how
 * people learn to distrust the whole section.
 */

import { ValueField } from '@components/ValueField';
import { Checkbox } from '@components/Checkbox';
import { InspectorRow } from '@components/Inspector';
import { useSceneRevision, bumpScene } from '@stores/sceneStore';
import defaultSceneGraph from '@core/scene/DefaultSceneGraph';
import { readNodeClonerRaw, CLONER_PROP } from '@core/scene/clonerExpand';
import {
  cloneCount,
  MAX_CLONES,
  type ClonerConfig,
  type ClonerMode,
  type FalloffShape,
  type FalloffSource,
} from '@core/scene/cloner';
import styles from './TransformSection.module.css';

const MODES: ReadonlyArray<{ value: ClonerMode; label: string }> = [
  { value: 'linear', label: 'Linear' },
  { value: 'grid', label: 'Grid' },
  { value: 'radial', label: 'Radial' },
  { value: 'path', label: 'Path' },
];

const FALLOFFS: ReadonlyArray<{ value: FalloffShape; label: string }> = [
  { value: 'none', label: 'None' },
  { value: 'linear', label: 'Linear' },
  { value: 'radial', label: 'Radial' },
];

export function ClonerSection({ nodeId }: { nodeId: string }): JSX.Element | null {
  useSceneRevision((s) => s.rev);
  const node = defaultSceneGraph.getNode(nodeId);
  // `readNodeCloner` returns null for a DISABLED cloner — correct for the
  // renderer; `readNodeClonerRaw` keeps the toggle + dialled-in settings.
  const cfg = readNodeClonerRaw(node);

  if (!node) return null;

  const write = (patch: Partial<ClonerConfig>): void => {
    defaultSceneGraph.setFxKey(nodeId, CLONER_PROP, { ...cfg, ...patch });
    bumpScene();
  };

  const count = cloneCount({ ...cfg, enabled: true });
  const capped = count >= MAX_CLONES;

  // Candidate field drivers: the cloner's siblings, minus itself. A cloner
  // driven by its own position would move its field with every clone it placed.
  const siblings = (node.parent ? defaultSceneGraph.getChildren(node.parent) : [])
    .filter((s) => s.id !== nodeId);

  return (
    <>
      <InspectorRow label="Cloner" align="center">
        <div className={styles.control}>
          <Checkbox checked={cfg.enabled} onChange={(e) => write({ enabled: e.target.checked })} aria-label="Enable cloner" />
          <span
            style={{
              marginLeft: 8,
              fontSize: 'var(--font-size-micro)',
              color: capped ? 'var(--color-warning)' : 'var(--color-text-tertiary)',
            }}
            title={capped ? `Capped at ${MAX_CLONES} — each clone is a real layer` : 'Clones this layer will draw'}
          >
            {count} clone{count === 1 ? '' : 's'}{capped ? ' (max)' : ''}
          </span>
        </div>
      </InspectorRow>

      {cfg.enabled && (
        <>
          <InspectorRow label="Mode" align="center">
            <select
              className={styles.select}
              style={{ width: 110 }}
              value={cfg.mode}
              onChange={(e) => write({ mode: e.target.value as ClonerMode })}
              aria-label="Cloner mode"
            >
              {MODES.map((m) => <option key={m.value} value={m.value}>{m.label}</option>)}
            </select>
          </InspectorRow>

          {cfg.mode === 'grid' ? (
            <>
              <InspectorRow label="Columns"><ValueField value={cfg.countX} min={0} precision={0} onChange={(v) => write({ countX: v })} aria-label="Columns" /></InspectorRow>
              <InspectorRow label="Rows"><ValueField value={cfg.countY} min={0} precision={0} onChange={(v) => write({ countY: v })} aria-label="Rows" /></InspectorRow>
              <InspectorRow label="Cell X"><ValueField value={cfg.offsetX} precision={1} onChange={(v) => write({ offsetX: v })} aria-label="Cell width" /></InspectorRow>
              <InspectorRow label="Cell Y"><ValueField value={cfg.offsetY} precision={1} onChange={(v) => write({ offsetY: v })} aria-label="Cell height" /></InspectorRow>
            </>
          ) : (
            <InspectorRow label="Count"><ValueField value={cfg.count} min={0} precision={0} onChange={(v) => write({ count: v })} aria-label="Clone count" /></InspectorRow>
          )}

          {cfg.mode === 'linear' && (
            <>
              <InspectorRow label="Offset X"><ValueField value={cfg.offsetX} precision={1} onChange={(v) => write({ offsetX: v })} aria-label="Offset X" /></InspectorRow>
              <InspectorRow label="Offset Y"><ValueField value={cfg.offsetY} precision={1} onChange={(v) => write({ offsetY: v })} aria-label="Offset Y" /></InspectorRow>
            </>
          )}

          {cfg.mode === 'path' && (
            <>
              <InspectorRow label="Path" align="center">
                <select
                  className={styles.select}
                  style={{ width: 110 }}
                  value={cfg.pathLayerId}
                  onChange={(e) => write({ pathLayerId: e.target.value })}
                  aria-label="Path layer"
                >
                  {/* An explicit empty option, same as the field driver: "none
                      chosen" is a state you can see and return to. Without a
                      path the clones fall back to a linear run. */}
                  <option value="">— none —</option>
                  {siblings.map((sib) => <option key={sib.id} value={sib.id}>{sib.name ?? sib.id}</option>)}
                </select>
              </InspectorRow>
              <InspectorRow label="Follow" align="center">
                <div className={styles.control}>
                  <Checkbox checked={cfg.alignToRadius} onChange={(e) => write({ alignToRadius: e.target.checked })} aria-label="Follow path tangent" />
                  <span style={{ marginLeft: 8, fontSize: 'var(--font-size-micro)', color: 'var(--color-text-tertiary)' }}>
                    {cfg.alignToRadius ? 'Faces along the path' : 'Keeps own rotation'}
                  </span>
                </div>
              </InspectorRow>
            </>
          )}

          {cfg.mode === 'radial' && (
            <>
              <InspectorRow label="Radius"><ValueField value={cfg.radius} precision={1} onChange={(v) => write({ radius: v })} aria-label="Radius" /></InspectorRow>
              <InspectorRow label="Start"><ValueField value={cfg.startAngle} unit="°" precision={1} onChange={(v) => write({ startAngle: v })} aria-label="Start angle" /></InspectorRow>
              <InspectorRow label="Arc"><ValueField value={cfg.arc} unit="°" precision={1} onChange={(v) => write({ arc: v })} aria-label="Arc" /></InspectorRow>
              <InspectorRow label="Face Out" align="center">
                <div className={styles.control}>
                  <Checkbox checked={cfg.alignToRadius} onChange={(e) => write({ alignToRadius: e.target.checked })} aria-label="Align to radius" />
                </div>
              </InspectorRow>
            </>
          )}

          {/* Step — a linear ramp across the clone order. Zero everywhere means
              "no ramp", which is why every field defaults to 0 rather than to
              the property's own identity. */}
          <h4 className={styles.sectionNote} style={{ margin: '8px 0 2px' }}>Step</h4>
          <InspectorRow label="Position X"><ValueField value={cfg.step.x} precision={1} onChange={(v) => write({ step: { ...cfg.step, x: v } })} aria-label="Step position X" /></InspectorRow>
          <InspectorRow label="Position Y"><ValueField value={cfg.step.y} precision={1} onChange={(v) => write({ step: { ...cfg.step, y: v } })} aria-label="Step position Y" /></InspectorRow>
          <InspectorRow label="Rotation"><ValueField value={cfg.step.rotation} unit="°" precision={1} onChange={(v) => write({ step: { ...cfg.step, rotation: v } })} aria-label="Step rotation" /></InspectorRow>
          <InspectorRow label="Scale"><ValueField value={cfg.step.scale} precision={2} onChange={(v) => write({ step: { ...cfg.step, scale: v } })} aria-label="Step scale" /></InspectorRow>
          <InspectorRow label="Opacity"><ValueField value={cfg.step.opacity} unit="%" precision={0} onChange={(v) => write({ step: { ...cfg.step, opacity: v } })} aria-label="Step opacity" /></InspectorRow>
          {/* The cascade: seconds the LAST clone's animation runs behind the
              first. One keyframed layer becomes a staggered wave. */}
          <InspectorRow label="Time"><ValueField value={cfg.step.time} unit="s" precision={2} onChange={(v) => write({ step: { ...cfg.step, time: v } })} aria-label="Step time (cascade)" /></InspectorRow>

          {/* Random — hashed from the clone index, so the scatter is the same
              whether you scrubbed to a frame or played to it. */}
          <h4 className={styles.sectionNote} style={{ margin: '8px 0 2px' }}>Random</h4>
          <InspectorRow label="Seed"><ValueField value={cfg.random.seed} precision={0} onChange={(v) => write({ random: { ...cfg.random, seed: v } })} aria-label="Random seed" /></InspectorRow>
          <InspectorRow label="Position"><ValueField value={cfg.random.position} min={0} precision={1} onChange={(v) => write({ random: { ...cfg.random, position: v } })} aria-label="Random position" /></InspectorRow>
          <InspectorRow label="Rotation"><ValueField value={cfg.random.rotation} min={0} unit="°" precision={1} onChange={(v) => write({ random: { ...cfg.random, rotation: v } })} aria-label="Random rotation" /></InspectorRow>
          <InspectorRow label="Scale"><ValueField value={cfg.random.scale} min={0} precision={2} onChange={(v) => write({ random: { ...cfg.random, scale: v } })} aria-label="Random scale" /></InspectorRow>

          {/* Falloff masks the EFFECTORS, never the layout — the clones stay
              where the mode put them. */}
          <h4 className={styles.sectionNote} style={{ margin: '8px 0 2px' }}>Falloff</h4>
          <InspectorRow label="Shape" align="center">
            <select
              className={styles.select}
              style={{ width: 110 }}
              value={cfg.falloff.shape}
              onChange={(e) => write({ falloff: { ...cfg.falloff, shape: e.target.value as FalloffShape } })}
              aria-label="Falloff shape"
            >
              {FALLOFFS.map((f) => <option key={f.value} value={f.value}>{f.label}</option>)}
            </select>
          </InspectorRow>
          {cfg.falloff.shape !== 'none' && (
            <>
              <InspectorRow label="Driven By" align="center">
                <select
                  className={styles.select}
                  style={{ width: 110 }}
                  value={cfg.falloff.source}
                  onChange={(e) => write({ falloff: { ...cfg.falloff, source: e.target.value as FalloffSource } })}
                  aria-label="Falloff source"
                >
                  <option value="order">Clone Order</option>
                  <option value="layer">Layer</option>
                </select>
              </InspectorRow>

              {cfg.falloff.source === 'layer' ? (
                <>
                  <InspectorRow label="Layer" align="center">
                    <select
                      className={styles.select}
                      style={{ width: 110 }}
                      value={cfg.falloff.layerId}
                      onChange={(e) => write({ falloff: { ...cfg.falloff, layerId: e.target.value } })}
                      aria-label="Field layer"
                    >
                      {/* An explicit empty option, so "none chosen" is a state
                          you can see and return to rather than whichever layer
                          happened to sort first. */}
                      <option value="">— none —</option>
                      {siblings.map((s) => <option key={s.id} value={s.id}>{s.name ?? s.id}</option>)}
                    </select>
                  </InspectorRow>
                  <InspectorRow label="Radius"><ValueField value={cfg.falloff.radius} min={0} precision={1} onChange={(v) => write({ falloff: { ...cfg.falloff, radius: v } })} aria-label="Field radius" /></InspectorRow>
                  {/* Positive parts the clones around the driver; negative
                      gathers them onto it. */}
                  <InspectorRow label="Push"><ValueField value={cfg.falloff.push} precision={1} onChange={(v) => write({ falloff: { ...cfg.falloff, push: v } })} aria-label="Field push" /></InspectorRow>
                </>
              ) : (
                <>
                  <InspectorRow label="Center"><ValueField value={cfg.falloff.position} min={0} max={1} precision={2} onChange={(v) => write({ falloff: { ...cfg.falloff, position: v } })} aria-label="Falloff center" /></InspectorRow>
                  <InspectorRow label="Width"><ValueField value={cfg.falloff.width} min={0} max={1} precision={2} onChange={(v) => write({ falloff: { ...cfg.falloff, width: v } })} aria-label="Falloff width" /></InspectorRow>
                </>
              )}
              <InspectorRow label="Invert" align="center">
                <div className={styles.control}>
                  <Checkbox checked={cfg.falloff.invert} onChange={(e) => write({ falloff: { ...cfg.falloff, invert: e.target.checked } })} aria-label="Invert falloff" />
                </div>
              </InspectorRow>
            </>
          )}
        </>
      )}
    </>
  );
}

export default ClonerSection;
