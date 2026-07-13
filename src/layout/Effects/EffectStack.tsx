/**
 * EffectStack — the applied-effects list for a layer (AE Effect Controls): each
 * effect has an enable toggle, reorder, remove, and a **keyframeable** amount
 * (stopwatch → keyframes under `effect.<id>`, sampled per frame by buildSnapshot).
 *
 * Shared by the kitchen-sink Effects panel and the dedicated Effect Controls
 * panel so the stack lives in exactly one component (no duplicated logic).
 */

import { Icon } from '@components/Icon';
import { ValueField } from '@components/ValueField';
import { EmptyState } from '@components/EmptyState';
import { cn } from '@utils/cn';
import { useSceneRevision } from '@stores/sceneStore';
import { useActiveWorkspace } from '@stores/projectStore';
import { defaultAnimation } from '@motion/animation';
import { runAnimEdit } from '@core/animation/animationCommands';
import {
  EFFECT_DEFS,
  getNodeEffects,
  updateEffect,
  removeEffect,
  toggleEffect,
  moveEffect,
  effectPropPath,
  type EffectDef,
} from '@core/effects/effects';
import panel from './EffectsPanel.module.css';
import row from '@layout/Inspector/TextAnimatorControls.module.css';

function EffectAmount({
  nodeId,
  effectId,
  amount,
  def,
}: {
  nodeId: string;
  effectId: string;
  amount: number;
  def: EffectDef;
  disabled?: boolean;
}): JSX.Element {
  const time = useActiveWorkspace()?.time ?? 0;
  useSceneRevision((s) => s.rev);
  const path = effectPropPath(effectId);
  const animated = defaultAnimation.isAnimated(nodeId, path);
  const display = animated ? defaultAnimation.sample(nodeId, path, time) ?? amount : amount;

  const onChange = (v: number): void => {
    if (animated) {
      runAnimEdit(`Set ${def.label}`, () => defaultAnimation.setKeyframe(nodeId, path, time, v), `fx:${nodeId}:${path}:${time}`);
    } else {
      updateEffect(nodeId, effectId, v);
    }
  };
  const toggle = (): void => {
    if (animated) runAnimEdit(`Remove ${def.label} animation`, () => defaultAnimation.removeTrack(nodeId, path));
    else runAnimEdit(`Animate ${def.label}`, () => defaultAnimation.setKeyframe(nodeId, path, time, amount));
  };

  return (
    <div className={row.paramRow}>
      <button
        type="button"
        className={cn(row.stopwatch, animated && row.stopwatchOn)}
        onClick={toggle}
        aria-pressed={animated}
        aria-label={animated ? `Remove ${def.label} animation` : `Animate ${def.label}`}
        title={animated ? 'Remove animation' : 'Animate (add keyframes)'}
      >
        <Icon name="keyframe" size={11} />
      </button>
      <ValueField
        value={display}
        min={def.min}
        max={def.max}
        unit={def.unit}
        precision={0}
        onChange={onChange}
        aria-label={`${def.label} amount`}
      />
    </div>
  );
}

export function EffectStack({ nodeId }: { nodeId: string }): JSX.Element {
  useSceneRevision((s) => s.rev);
  const effects = getNodeEffects(nodeId);
  const defByType = new Map(EFFECT_DEFS.map((d) => [d.type, d]));

  if (effects.length === 0) {
    return <EmptyState icon="sparkles" message="No effects — add one to grade, blur, or shadow this layer." />;
  }

  return (
    <div className={panel.list}>
      {effects.map((e, i) => {
        const def = defByType.get(e.type);
        if (!def) return null;
        const off = e.enabled === false;
        return (
          <div key={e.id} className={panel.item}>
            <div className={panel.itemHead}>
              <button
                type="button"
                className={panel.eyeBtn}
                aria-label={off ? `Enable ${def.label}` : `Disable ${def.label}`}
                aria-pressed={!off}
                onClick={() => toggleEffect(nodeId, e.id)}
              >
                <Icon name={off ? 'eye-off' : 'eye'} size={12} />
              </button>
              <span className={off ? panel.itemLabelOff : panel.itemLabel}>{def.label}</span>
              <div className={panel.itemActions}>
                <button type="button" className={panel.remove} aria-label={`Move ${def.label} up`}
                  disabled={i === 0} onClick={() => moveEffect(nodeId, e.id, -1)}>
                  <Icon name="arrow-up" size={12} />
                </button>
                <button type="button" className={panel.remove} aria-label={`Move ${def.label} down`}
                  disabled={i === effects.length - 1} onClick={() => moveEffect(nodeId, e.id, 1)}>
                  <Icon name="arrow-down" size={12} />
                </button>
                <button type="button" className={panel.remove} aria-label={`Remove ${def.label}`}
                  onClick={() => removeEffect(nodeId, e.id)}>
                  <Icon name="close" size={12} />
                </button>
              </div>
            </div>
            {!off && <EffectAmount nodeId={nodeId} effectId={e.id} amount={e.amount} def={def} />}
          </div>
        );
      })}
    </div>
  );
}

export default EffectStack;
