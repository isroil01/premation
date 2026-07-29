import { useState } from 'react';
import { compToKeyframeTime } from '@core/timeline/TimelineController';
/**
 * EffectStack — the applied-effects list for a layer (AE Effect Controls): each
 * effect has an enable toggle, reorder, remove, and one row per PARAMETER.
 * Numeric params are keyframeable (stopwatch → keyframes under
 * `effect.<id>.<param>`, sampled per frame by buildSnapshot).
 *
 * The panel used to render exactly one field per effect, because an effect
 * carried exactly one scalar — which is why Glow's colour and Drop Shadow's
 * angle didn't exist.
 *
 * Shared by the kitchen-sink Effects panel and the dedicated Effect Controls
 * panel so the stack lives in exactly one component (no duplicated logic).
 */

import { Icon } from '@components/Icon';
import { cn } from '@utils/cn';
import { ValueField } from '@components/ValueField';
import { Checkbox } from '@components/Checkbox';
import { PropertyRow } from '@components/PropertyRow';
import { ColorPicker } from '@components/ColorPicker';
import { CurveEditor } from './CurveEditor';

import { useSceneRevision } from '@stores/sceneStore';
import defaultSceneGraph from '@core/scene/DefaultSceneGraph';
import { useActiveWorkspace } from '@stores/projectStore';
import { defaultAnimation } from '@motion/animation';
import { Color } from '@motion/renderer';
import { runAnimEdit } from '@core/animation/animationCommands';
import {
  EFFECT_DEFS,
  getNodeEffects,
  updateEffectParam,
  removeEffect,
  toggleEffect,
  moveEffect,
  dragEffectTo,
  effectPropPath,
  effectParam,
  type Effect,
  type EffectDef,
  type EffectParamDef,
  type CurvePoints,
} from '@core/effects/effects';
import { resolvePropertyMeta } from '@core/inspector/propertyMeta';
import { buildPropertyMenu } from '@core/inspector/propertyMenu';
import { openContextMenu } from '@stores/contextMenuStore';
import panel from './EffectsPanel.module.css';
import row from '@layout/Inspector/TextAnimatorControls.module.css';

/** One parameter of one effect: a stopwatch (numbers only) plus its control. */
function EffectParamRow({
  nodeId,
  effect,
  def,
  param,
}: {
  nodeId: string;
  effect: Effect;
  def: EffectDef;
  param: EffectParamDef;
}): JSX.Element {
  const time = useActiveWorkspace()?.time ?? 0;
  useSceneRevision((s) => s.rev);

  const value = effectParam(effect, param.key);
  const label = `${def.label} ${param.label}`;

  if (param.type === 'color') {
    // Keyframeable through decomposed channel tracks (`effect.<id>.<key>_r`
    // …), exactly the fill/stroke pattern — resolveEffectParams recomposes
    // them per frame. Before this, color params were the one param type the
    // stopwatch couldn't touch: no animated glow color, no shadow color ramp.
    const chPrefix = effectPropPath(effect.id, param.key);
    const animated = defaultAnimation.isAnimated(nodeId, `${chPrefix}_r`);
    // The canonical keyframe axis — what buildSnapshot samples for this node.
    const layerT = compToKeyframeTime(nodeId, time);
    const displayed = (() => {
      if (!animated) return String(value);
      const r = defaultAnimation.sample(nodeId, `${chPrefix}_r`, layerT) ?? 255;
      const g = defaultAnimation.sample(nodeId, `${chPrefix}_g`, layerT) ?? 255;
      const b = defaultAnimation.sample(nodeId, `${chPrefix}_b`, layerT) ?? 255;
      const alpha = defaultAnimation.sample(nodeId, `${chPrefix}_a`, layerT) ?? 1;
      return Color.toHex({ r, g, b, a: alpha });
    })();
    const writeChannels = (hex: string, editLabel: string): void => {
      const c = Color.fromHex(hex);
      runAnimEdit(editLabel, () => {
        defaultAnimation.setKeyframe(nodeId, `${chPrefix}_r`, layerT, c.r);
        defaultAnimation.setKeyframe(nodeId, `${chPrefix}_g`, layerT, c.g);
        defaultAnimation.setKeyframe(nodeId, `${chPrefix}_b`, layerT, c.b);
        defaultAnimation.setKeyframe(nodeId, `${chPrefix}_a`, layerT, c.a ?? 1);
      }, `fxcolor:${nodeId}:${chPrefix}`);
    };
    const toggleColorAnim = (): void => {
      if (animated) {
        runAnimEdit(`Remove ${label} animation`, () => {
          for (const ch of ['_r', '_g', '_b', '_a']) {
            defaultAnimation.removeTrack(nodeId, `${chPrefix}${ch}`);
          }
        });
      } else {
        writeChannels(String(value), `Animate ${label}`);
      }
    };
    return (
      <PropertyRow label={param.label} animated={animated} onStopwatch={toggleColorAnim} compact>
        <ColorPicker
          value={displayed}
          onChange={(hex) => {
            if (animated) writeChannels(hex, `Set ${label}`);
            else updateEffectParam(nodeId, effect.id, param.key, hex);
          }}
          aria-label={label}
          compact
        />
      </PropertyRow>
    );
  }

  if (param.type === 'checkbox') {
    return (
      <div className={row.paramRow}>
        <div style={{ width: 14 }} />
        <span className={row.paramLabel}>{param.label}</span>
        <Checkbox
          checked={value === true}
          onChange={(e) => updateEffectParam(nodeId, effect.id, param.key, e.currentTarget.checked)}
          aria-label={label}
          style={{ width: 14, height: 14 }}
        />
      </div>
    );
  }

  if (param.type === 'layer') {
    // Layer reference (e.g. Displace's Map Layer): a dropdown of the comp's
    // OTHER layers — same sibling scope as the track-matte source picker.
    // '' = None → the effect falls back to its self-referential behavior.
    const self = defaultSceneGraph.getNode(nodeId);
    const siblings = self && self.parent
      ? defaultSceneGraph.getChildren(self.parent).filter((n) => n.id !== nodeId)
      : [];
    const current = typeof value === 'string' ? value : '';
    const stale = current !== '' && !siblings.some((s) => s.id === current);
    return (
      <div className={row.paramRow}>
        <div style={{ width: 14 }} />
        <span className={row.paramLabel}>{param.label}</span>
        <select
          value={current}
          onChange={(e) => updateEffectParam(nodeId, effect.id, param.key, e.currentTarget.value)}
          aria-label={label}
          style={{
            flex: 1,
            minWidth: 0,
            height: 20,
            fontSize: 11,
            background: 'var(--color-surface-0)',
            color: 'var(--color-text-primary)',
            border: '1px solid var(--color-border-subtle)',
            borderRadius: 3,
          }}
        >
          <option value="">None (self)</option>
          {stale && <option value={current}>Missing layer ({current})</option>}
          {siblings.map((s) => (
            <option key={s.id} value={s.id}>{s.name || s.id}</option>
          ))}
        </select>
      </div>
    );
  }

  if (param.type === 'curve') {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 4, padding: '4px 0' }}>
        <span className={row.paramLabel}>{param.label}</span>
        <CurveEditor
          value={Array.isArray(value) ? (value as CurvePoints) : [[0, 0], [255, 255]]}
          onChange={(points) => updateEffectParam(nodeId, effect.id, param.key, points)}
        />
      </div>
    );
  }

  // Numeric: keyframeable under `effect.<id>.<param>`.
  const stored = typeof value === 'number' ? value : 0;
  const path = effectPropPath(effect.id, param.key);
  const animated = defaultAnimation.isAnimated(nodeId, path);
  // ONE axis for reads and writes: the canonical keyframe time.
  const layerT = compToKeyframeTime(nodeId, time);
  const display = animated ? defaultAnimation.sample(nodeId, path, layerT) ?? stored : stored;

  const onChange = (v: number): void => {
    if (animated) {
      runAnimEdit(
        `Set ${label}`,
        () => defaultAnimation.setKeyframe(nodeId, path, layerT, v),
        `fx:${nodeId}:${path}:${layerT}`,
      );
    } else {
      updateEffectParam(nodeId, effect.id, param.key, v);
    }
  };
  const toggle = (): void => {
    if (animated) runAnimEdit(`Remove ${label} animation`, () => defaultAnimation.removeTrack(nodeId, path));
    else runAnimEdit(`Animate ${label}`, () => defaultAnimation.setKeyframe(nodeId, path, layerT, stored));
  };

  // Range, step, precision and unit all resolve through the property registry,
  // which reads them off this effect's own definition — so the timeline row and
  // this row describe the same parameter identically.
  const meta = resolvePropertyMeta(path, nodeId);
  return (
    <PropertyRow
      label={param.label}
      animated={animated}
      onStopwatch={toggle}
      onReset={
        typeof meta.defaultValue === 'number' && meta.resettable
          ? () => updateEffectParam(nodeId, effect.id, param.key, meta.defaultValue as number)
          : undefined
      }
      onContextMenu={(e) => {
        e.preventDefault();
        openContextMenu(
          e.clientX,
          e.clientY,
          buildPropertyMenu({
            nodeId,
            prop: path,
            layerT,
            value: display,
            setValue: (v) => updateEffectParam(nodeId, effect.id, param.key, v),
          }),
        );
      }}
      compact
    >
      <ValueField
        value={display}
        min={meta.min}
        max={meta.max}
        unit={meta.unit}
        step={meta.step}
        precision={meta.precision}
        onChange={onChange}
        aria-label={label}
      />
    </PropertyRow>
  );
}

export function EffectStack({ nodeId }: { nodeId: string }): JSX.Element {
  useSceneRevision((s) => s.rev);
  const effects = getNodeEffects(nodeId);
  const defByType = new Map(EFFECT_DEFS.map((d) => [d.type, d]));

  const [userToggledIds, setUserToggledIds] = useState<Map<string, boolean>>(new Map());
  /** Effect being dragged, and the gap index the drop indicator sits in. */
  const [dragId, setDragId] = useState<string | null>(null);
  const [dropIndex, setDropIndex] = useState<number | null>(null);

  const toggleEffectCard = (id: string, currentCollapsed: boolean) => {
    setUserToggledIds((prev) => {
      const next = new Map(prev);
      next.set(id, !currentCollapsed);
      return next;
    });
  };

  if (effects.length === 0) {
    return (
      <div className={panel.hint}>
        No active effects on this layer. Choose an effect below to add one.
      </div>
    );
  }

  return (
    <div className={panel.stackList}>
      {effects.map((e, i) => {
        const def = defByType.get(e.type);
        if (!def) return null;
        const off = e.enabled === false;
        const defaultCollapsed = i > 0;
        const isCollapsed = userToggledIds.has(e.id) ? userToggledIds.get(e.id)! : defaultCollapsed;

        // Drop BEFORE this card when the pointer is in its top half, after it
        // when in the bottom half — the gap the indicator is drawn in is the
        // index the effect lands at, so what you see is what you get.
        const onDragOver = (ev: React.DragEvent): void => {
          if (!dragId) return;
          ev.preventDefault();
          const r = ev.currentTarget.getBoundingClientRect();
          setDropIndex(ev.clientY < r.top + r.height / 2 ? i : i + 1);
        };

        return (
          <div
            key={e.id}
            className={cn(
              panel.effectCardItem,
              dragId === e.id && panel.effectCardDragging,
              dropIndex === i && panel.effectDropBefore,
              dropIndex === effects.length && i === effects.length - 1 && panel.effectDropAfter,
            )}
            onDragOver={onDragOver}
            onDrop={(ev) => {
              ev.preventDefault();
              if (dragId && dropIndex !== null) dragEffectTo(nodeId, dragId, dropIndex);
              setDragId(null);
              setDropIndex(null);
            }}
          >
            {/* Accordion Header: Disclosure Chevron + Checkbox + Effect Label + Actions */}
            <div
              className={panel.effectCardHead}
              // The HEADER is the drag handle, not the whole card — dragging
              // from the body would fight every scrubby slider inside it.
              draggable
              onDragStart={(ev) => {
                setDragId(e.id);
                ev.dataTransfer.effectAllowed = 'move';
                // Firefox refuses to start a drag without payload.
                ev.dataTransfer.setData('text/plain', e.id);
              }}
              onDragEnd={() => { setDragId(null); setDropIndex(null); }}
            >
              <span className={panel.dragGrip} aria-hidden title="Drag to reorder">
                <Icon name="grip-vertical" size={12} />
              </span>
              <button
                type="button"
                className={panel.disclosureBtn}
                onClick={() => toggleEffectCard(e.id, isCollapsed)}
                title={isCollapsed ? 'Expand effect parameters' : 'Collapse effect parameters'}
              >
                <Icon name={isCollapsed ? 'chevron-right' : 'chevron-down'} size={12} />
              </button>

              <Checkbox
                checked={!off}
                onChange={() => toggleEffect(nodeId, e.id)}
                title={off ? 'Enable effect' : 'Disable effect'}
                style={{ width: 15, height: 15, flexShrink: 0 }}
              />

              <span
                className={off ? panel.itemLabelOff : panel.itemLabel}
                onClick={() => toggleEffectCard(e.id, isCollapsed)}
                style={{
                  flex: 1,
                  cursor: 'pointer',
                  fontSize: 12,
                  fontWeight: 600,
                  color: off ? 'var(--color-text-muted)' : 'var(--color-text-primary)',
                  letterSpacing: '0.01em',
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                }}
              >
                {def.label}
              </span>

              <div className={panel.itemActions}>
                <button
                  type="button"
                  className={panel.remove}
                  aria-label={`Move ${def.label} up`}
                  disabled={i === 0}
                  onClick={() => moveEffect(nodeId, e.id, -1)}
                >
                  <Icon name="arrow-up" size={12} />
                </button>
                <button
                  type="button"
                  className={panel.remove}
                  aria-label={`Move ${def.label} down`}
                  disabled={i === effects.length - 1}
                  onClick={() => moveEffect(nodeId, e.id, 1)}
                >
                  <Icon name="arrow-down" size={12} />
                </button>
                <button
                  type="button"
                  className={panel.remove}
                  aria-label={`Remove ${def.label}`}
                  onClick={() => removeEffect(nodeId, e.id)}
                >
                  <Icon name="close" size={12} />
                </button>
              </div>
            </div>

            {/* Accordion Body: Effect Parameters */}
            {!isCollapsed && !off && (
              <div className={panel.effectParamsBody}>
                {def.params.map((p) => (
                  <EffectParamRow key={p.key} nodeId={nodeId} effect={e} def={def} param={p} />
                ))}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

export default EffectStack;
