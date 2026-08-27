/**
 * Cloner controls.
 *
 * Rendered authentically as an AE Effect Card inside Effect Controls.
 */

import { useState } from 'react';
import { ValueField } from '@components/ValueField';
import { Checkbox } from '@components/Checkbox';
import { PropertyRow } from '@components/PropertyRow';
import { Icon } from '@components/Icon';
import { useSceneRevision, bumpScene } from '@stores/sceneStore';
import defaultSceneGraph from '@core/scene/DefaultSceneGraph';
import { readNodeClonerRaw, CLONER_PROP } from '@core/scene/clonerExpand';
import {
  cloneCount,
  MAX_CLONES,
  DEFAULT_CLONER,
  type ClonerConfig,
  type ClonerMode,
  type FalloffShape,
  type FalloffSource,
} from '@core/scene/cloner';
import panel from '@layout/Effects/EffectsPanel.module.css';

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
  const cfg = readNodeClonerRaw(node);
  const [isCollapsed, setIsCollapsed] = useState(false);
  const [stepCollapsed, setStepCollapsed] = useState(false);
  const [randomCollapsed, setRandomCollapsed] = useState(false);
  const [falloffCollapsed, setFalloffCollapsed] = useState(false);

  if (!node) return null;

  const off = !cfg.enabled;

  const write = (patch: Partial<ClonerConfig>): void => {
    defaultSceneGraph.setFxKey(nodeId, CLONER_PROP, { ...cfg, ...patch });
    bumpScene();
  };

  const removeCloner = (): void => {
    defaultSceneGraph.setFxKey(nodeId, CLONER_PROP, undefined);
    bumpScene();
  };

  const resetCloner = (): void => {
    defaultSceneGraph.setFxKey(nodeId, CLONER_PROP, DEFAULT_CLONER);
    bumpScene();
  };

  const count = cloneCount({ ...cfg, enabled: true });
  const capped = count >= MAX_CLONES;

  const siblings = (node.parent ? defaultSceneGraph.getChildren(node.parent) : [])
    .filter((s) => s.id !== nodeId);

  return (
    <div className={panel.effectCardItem}>
      {/* AE Effect Controls header: ▾ fx Cloner .......... Reset */}
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
          title={off ? 'Enable cloner' : 'Disable cloner'}
          style={{ width: 15, height: 15, flexShrink: 0 }}
        />

        <span className={panel.fxMark} aria-hidden>fx</span>

        <span
          className={off ? panel.itemLabelOff : panel.itemLabel}
          onClick={() => setIsCollapsed(!isCollapsed)}
        >
          Cloner ({count} clone{count === 1 ? '' : 's'}{capped ? ' max' : ''})
        </span>

        <div className={panel.itemActions}>
          <button
            type="button"
            className={panel.remove}
            aria-label="Remove Cloner"
            title="Remove Cloner effect"
            onClick={removeCloner}
          >
            <Icon name="close" size="sm" />
          </button>
        </div>

        <button
          type="button"
          className={panel.resetLink}
          title="Restore cloner parameters to default"
          onClick={resetCloner}
        >
          Reset
        </button>
      </div>

      {/* Parameters Accordion Body */}
      {!isCollapsed && !off && (
        <div className={panel.effectParamsBody}>
          <PropertyRow label="Mode" compact>
            <select
              className={panel.paramSelect}
              value={cfg.mode}
              onChange={(e) => write({ mode: e.target.value as ClonerMode })}
              aria-label="Cloner mode"
            >
              {MODES.map((m) => <option key={m.value} value={m.value}>{m.label}</option>)}
            </select>
          </PropertyRow>

          {cfg.mode === 'grid' ? (
            <>
              <PropertyRow label="Columns" compact><ValueField value={cfg.countX} min={0} precision={0} onChange={(v) => write({ countX: v })} aria-label="Columns" /></PropertyRow>
              <PropertyRow label="Rows" compact><ValueField value={cfg.countY} min={0} precision={0} onChange={(v) => write({ countY: v })} aria-label="Rows" /></PropertyRow>
              <PropertyRow label="Cell X" compact><ValueField value={cfg.offsetX} precision={1} onChange={(v) => write({ offsetX: v })} aria-label="Cell width" /></PropertyRow>
              <PropertyRow label="Cell Y" compact><ValueField value={cfg.offsetY} precision={1} onChange={(v) => write({ offsetY: v })} aria-label="Cell height" /></PropertyRow>
            </>
          ) : (
            <PropertyRow label="Count" compact><ValueField value={cfg.count} min={0} precision={0} onChange={(v) => write({ count: v })} aria-label="Clone count" /></PropertyRow>
          )}

          {cfg.mode === 'linear' && (
            <>
              <PropertyRow label="Offset X" compact><ValueField value={cfg.offsetX} precision={1} onChange={(v) => write({ offsetX: v })} aria-label="Offset X" /></PropertyRow>
              <PropertyRow label="Offset Y" compact><ValueField value={cfg.offsetY} precision={1} onChange={(v) => write({ offsetY: v })} aria-label="Offset Y" /></PropertyRow>
            </>
          )}

          {cfg.mode === 'path' && (
            <>
              <PropertyRow label="Path" compact>
                <select
                  className={panel.paramSelect}
                  value={cfg.pathLayerId}
                  onChange={(e) => write({ pathLayerId: e.target.value })}
                  aria-label="Path layer"
                >
                  <option value="">— none —</option>
                  {siblings.map((sib) => <option key={sib.id} value={sib.id}>{sib.name ?? sib.id}</option>)}
                </select>
              </PropertyRow>
              <PropertyRow label="Follow" compact>
                <div style={{ display: 'flex', alignItems: 'center', gap: 6, width: '100%' }}>
                  <Checkbox checked={cfg.alignToRadius} onChange={(e) => write({ alignToRadius: e.target.checked })} aria-label="Follow path tangent" />
                  <span style={{ fontSize: 'var(--font-size-micro)', color: 'var(--color-text-tertiary)' }}>
                    {cfg.alignToRadius ? 'Faces path' : 'Keep rotation'}
                  </span>
                </div>
              </PropertyRow>
            </>
          )}

          {cfg.mode === 'radial' && (
            <>
              <PropertyRow label="Radius" compact><ValueField value={cfg.radius} precision={1} onChange={(v) => write({ radius: v })} aria-label="Radius" /></PropertyRow>
              <PropertyRow label="Start" compact><ValueField value={cfg.startAngle} unit="°" precision={1} onChange={(v) => write({ startAngle: v })} aria-label="Start angle" /></PropertyRow>
              <PropertyRow label="Arc" compact><ValueField value={cfg.arc} unit="°" precision={1} onChange={(v) => write({ arc: v })} aria-label="Arc" /></PropertyRow>
              <PropertyRow label="Face Out" compact>
                <div style={{ display: 'flex', alignItems: 'center', gap: 6, width: '100%' }}>
                  <Checkbox checked={cfg.alignToRadius} onChange={(e) => write({ alignToRadius: e.target.checked })} aria-label="Align to radius" />
                </div>
              </PropertyRow>
            </>
          )}

          {/* Step Ramp */}
          <div className={panel.paramGroup}>
            <button
              type="button"
              className={panel.paramGroupHead}
              onClick={() => setStepCollapsed(!stepCollapsed)}
            >
              <Icon name={stepCollapsed ? 'chevron-right' : 'chevron-down'} size="sm" />
              <span>Step (Transform Ramp)</span>
            </button>
            {!stepCollapsed && (
              <div className={panel.paramGroupBody}>
                <PropertyRow label="Position X" compact><ValueField value={cfg.step.x} precision={1} onChange={(v) => write({ step: { ...cfg.step, x: v } })} aria-label="Step position X" /></PropertyRow>
                <PropertyRow label="Position Y" compact><ValueField value={cfg.step.y} precision={1} onChange={(v) => write({ step: { ...cfg.step, y: v } })} aria-label="Step position Y" /></PropertyRow>
                <PropertyRow label="Rotation" compact><ValueField value={cfg.step.rotation} unit="°" precision={1} onChange={(v) => write({ step: { ...cfg.step, rotation: v } })} aria-label="Step rotation" /></PropertyRow>
                <PropertyRow label="Scale" compact><ValueField value={cfg.step.scale} precision={2} onChange={(v) => write({ step: { ...cfg.step, scale: v } })} aria-label="Step scale" /></PropertyRow>
                <PropertyRow label="Opacity" compact><ValueField value={cfg.step.opacity} unit="%" precision={0} onChange={(v) => write({ step: { ...cfg.step, opacity: v } })} aria-label="Step opacity" /></PropertyRow>
                <PropertyRow label="Time (Cascade)" compact><ValueField value={cfg.step.time} unit="s" precision={2} onChange={(v) => write({ step: { ...cfg.step, time: v } })} aria-label="Step time (cascade)" /></PropertyRow>
              </div>
            )}
          </div>

          {/* Random Scatter */}
          <div className={panel.paramGroup}>
            <button
              type="button"
              className={panel.paramGroupHead}
              onClick={() => setRandomCollapsed(!randomCollapsed)}
            >
              <Icon name={randomCollapsed ? 'chevron-right' : 'chevron-down'} size="sm" />
              <span>Random Scatter</span>
            </button>
            {!randomCollapsed && (
              <div className={panel.paramGroupBody}>
                <PropertyRow label="Seed" compact><ValueField value={cfg.random.seed} precision={0} onChange={(v) => write({ random: { ...cfg.random, seed: v } })} aria-label="Random seed" /></PropertyRow>
                <PropertyRow label="Position" compact><ValueField value={cfg.random.position} min={0} precision={1} onChange={(v) => write({ random: { ...cfg.random, position: v } })} aria-label="Random position" /></PropertyRow>
                <PropertyRow label="Rotation" compact><ValueField value={cfg.random.rotation} min={0} unit="°" precision={1} onChange={(v) => write({ random: { ...cfg.random, rotation: v } })} aria-label="Random rotation" /></PropertyRow>
                <PropertyRow label="Scale" compact><ValueField value={cfg.random.scale} min={0} precision={2} onChange={(v) => write({ random: { ...cfg.random, scale: v } })} aria-label="Random scale" /></PropertyRow>
              </div>
            )}
          </div>

          {/* Falloff */}
          <div className={panel.paramGroup}>
            <button
              type="button"
              className={panel.paramGroupHead}
              onClick={() => setFalloffCollapsed(!falloffCollapsed)}
            >
              <Icon name={falloffCollapsed ? 'chevron-right' : 'chevron-down'} size="sm" />
              <span>Falloff Mask</span>
            </button>
            {!falloffCollapsed && (
              <div className={panel.paramGroupBody}>
                <PropertyRow label="Shape" compact>
                  <select
                    className={panel.paramSelect}
                    value={cfg.falloff.shape}
                    onChange={(e) => write({ falloff: { ...cfg.falloff, shape: e.target.value as FalloffShape } })}
                    aria-label="Falloff shape"
                  >
                    {FALLOFFS.map((f) => <option key={f.value} value={f.value}>{f.label}</option>)}
                  </select>
                </PropertyRow>
                {cfg.falloff.shape !== 'none' && (
                  <>
                    <PropertyRow label="Driven By" compact>
                      <select
                        className={panel.paramSelect}
                        value={cfg.falloff.source}
                        onChange={(e) => write({ falloff: { ...cfg.falloff, source: e.target.value as FalloffSource } })}
                        aria-label="Falloff source"
                      >
                        <option value="order">Clone Order</option>
                        <option value="layer">Layer</option>
                      </select>
                    </PropertyRow>

                    {cfg.falloff.source === 'layer' ? (
                      <>
                        <PropertyRow label="Layer" compact>
                          <select
                            className={panel.paramSelect}
                            value={cfg.falloff.layerId}
                            onChange={(e) => write({ falloff: { ...cfg.falloff, layerId: e.target.value } })}
                            aria-label="Field layer"
                          >
                            <option value="">— none —</option>
                            {siblings.map((s) => <option key={s.id} value={s.id}>{s.name ?? s.id}</option>)}
                          </select>
                        </PropertyRow>
                        <PropertyRow label="Radius" compact><ValueField value={cfg.falloff.radius} min={0} precision={1} onChange={(v) => write({ falloff: { ...cfg.falloff, radius: v } })} aria-label="Field radius" /></PropertyRow>
                        <PropertyRow label="Push" compact><ValueField value={cfg.falloff.push} precision={1} onChange={(v) => write({ falloff: { ...cfg.falloff, push: v } })} aria-label="Field push" /></PropertyRow>
                      </>
                    ) : (
                      <>
                        <PropertyRow label="Center" compact><ValueField value={cfg.falloff.position} min={0} max={1} precision={2} onChange={(v) => write({ falloff: { ...cfg.falloff, position: v } })} aria-label="Falloff center" /></PropertyRow>
                        <PropertyRow label="Width" compact><ValueField value={cfg.falloff.width} min={0} max={1} precision={2} onChange={(v) => write({ falloff: { ...cfg.falloff, width: v } })} aria-label="Falloff width" /></PropertyRow>
                      </>
                    )}
                    <PropertyRow label="Invert" compact>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 6, width: '100%' }}>
                        <Checkbox checked={cfg.falloff.invert} onChange={(e) => write({ falloff: { ...cfg.falloff, invert: e.target.checked } })} aria-label="Invert falloff" />
                      </div>
                    </PropertyRow>
                  </>
                )}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

export default ClonerSection;

