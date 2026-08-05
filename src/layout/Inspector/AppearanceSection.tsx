import { useMemo, useState } from 'react';

import { ValueField } from '@components/ValueField';
import { useSceneRevision } from '@stores/sceneStore';
import defaultSceneGraph from '@core/scene/DefaultSceneGraph';
import { useNodeComponentProp } from '@hooks/useNodeComponentProp';
import { getNodeFill, setNodeFill, getNodeFills, setNodeFills, convertFill, makeStop, sortedStops, solidFill, type FillType, type FillPaint, type ColorStop,
  sortedOpacityStops,
  defaultOpacityStops,
  makeOpacityStop,
  type OpacityStop,
} from '@core/paint/fill';
import { getNodeStroke, updateNodeStroke, getNodeStrokes, setNodeStrokes, defaultStroke, normalizeStroke, type StrokeAlign, type StrokeCap, type StrokeJoin } from '@core/paint/stroke';
import { Icon } from '@components/Icon';
import { ColorPicker } from '@components/ColorPicker';
import { Checkbox } from '@components/Checkbox';
import { ColorKfRow } from './ColorKfRow';
import styles from './TransformSection.module.css';
import effStyles from '../Effects/EffectsPanel.module.css';
import { defaultAnimation } from '@motion/animation';
import { runAnimEdit } from '@core/animation/animationCommands';
import { resolvePropertyMeta } from '@core/inspector/propertyMeta';
import { compToKeyframeTime } from '@core/timeline/TimelineController';
import { useActiveWorkspace } from '@stores/projectStore';
import { usePreferenceStore } from '@stores/preferenceStore';
import { groupSelectedNodes, ungroupSelectedNode } from '@core/scene/sceneInsert';
import { useSelectionStore } from '@stores/selectionStore';

/**
 * One keyframeable paint scalar — a ValueField plus a keyframe toggle.
 *
 * Started as the gradient-geometry row (angle / centre / radius) and was WIDENED
 * rather than copied when stroke dash offset needed the same control. Every
 * property it drives shares one contract: a scalar engine track that
 * `buildSnapshot` samples by name, with label / unit / range / step read from
 * the property registry — so this row and the timeline row for the same track
 * cannot disagree about what the number means. A second component would have
 * been a second place for that agreement to break (§2·0).
 *
 * `scale` converts between the display unit and the engine value (e.g. % ↔ 0..1).
 * Dash offset is 1:1 — both sides are layer-local px of arc length.
 */
function AnimatablePaintRow({
  nodeId,
  prop,
  label: labelOverride,
  value,
  onStatic,
}: {
  nodeId: string;
  prop: 'fillAngle' | 'fillCenterX' | 'fillCenterY' | 'fillRadius' | 'strokeDashOffset';
  /** Overrides the registry label — the panel shows "Angle" under a Fill
   *  heading where the timeline needs the unambiguous "Fill Angle". */
  label?: string;
  /** Current PAINT value (engine units). */
  value: number;
  onStatic: (engineValue: number) => void;
}): JSX.Element {
  // Label, unit, range, step and the stored→displayed scale all come from the
  // property registry, so this row and the timeline row for the same track
  // cannot disagree about what the number means.
  const meta = resolvePropertyMeta(prop, nodeId);
  const label = labelOverride ?? meta.label;
  const unit = meta.unit;
  const scale = meta.displayScale ?? 1;
  const min = meta.min !== undefined ? meta.min * scale : undefined;
  const max = meta.max !== undefined ? meta.max * scale : undefined;
  const time = useActiveWorkspace()?.time ?? 0;
  const autoKeyframe = usePreferenceStore((s) => s.timelineAutoKeyframe);
  const animated = defaultAnimation.isAnimated(nodeId, prop);
  // The canonical keyframe axis — what the renderer samples for this node.
  const layerT = compToKeyframeTime(nodeId, time);
  const engineVal = animated ? defaultAnimation.sample(nodeId, prop, layerT) ?? value : value;

  const handleChange = (display: number) => {
    const engine = display / scale;
    if (animated || autoKeyframe) {
      runAnimEdit(
        `Set ${prop}`,
        () => defaultAnimation.setKeyframe(nodeId, prop, layerT, engine),
        `set:${nodeId}:${prop}:${layerT}`,
      );
    } else {
      onStatic(engine);
    }
  };

  return (
    <div className={styles.popoverRow}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, flex: 1 }}>
        <Checkbox
          checked={animated}
          onChange={() => {
            if (animated) {
              runAnimEdit(`Remove ${prop} animation`, () => defaultAnimation.removeTrack(nodeId, prop));
            } else {
              runAnimEdit(`Animate ${prop}`, () => defaultAnimation.setKeyframe(nodeId, prop, layerT, value));
            }
          }}
          title="Toggle Keyframes"
          style={{ width: 13, height: 13 }}
        />
        <span className={styles.popoverLabel}>{label}</span>
      </div>
      <ValueField
        value={Math.round((engineVal ?? 0) * scale)}
        unit={unit}
        {...(min !== undefined ? { min } : {})}
        {...(max !== undefined ? { max } : {})}
        step={meta.step * scale}
        precision={meta.precision}
        onChange={(v) => handleChange(Number(v))}
        aria-label={label}
      />
    </div>
  );
}


/**
 * Editor for a gradient's OPACITY stops — a second, independent list.
 *
 * Deliberately its own control rather than an alpha field on each colour stop:
 * that is the whole point of the separate list. Fading a five-colour gradient
 * out at one end is two opacity stops here, versus editing alpha on all five
 * and re-editing them every time a colour moves.
 *
 * Absent means opaque, so the list starts collapsed behind an "Add opacity
 * ramp" affordance — an existing gradient must not change appearance just
 * because the control now exists.
 */
function OpacityStopList({ nodeId, paint }: { nodeId: string; paint: FillPaint }): JSX.Element | null {
  if (paint.type === 'solid') return null;
  const ramp = sortedOpacityStops(paint.opacityStops);

  const write = (next: OpacityStop[] | undefined): void => {
    setNodeFill(nodeId, { ...paint, opacityStops: next && next.length > 0 ? next : undefined });
  };

  if (ramp.length === 0) {
    return (
      <button
        type="button"
        className={effStyles.addChip}
        title="Fade this gradient independently of its colours"
        onClick={() => write(defaultOpacityStops())}
      >
        <Icon name="plus" size={11} /> Add opacity ramp
      </button>
    );
  }

  return (
    <>
      {ramp.map((o, i) => (
        <div key={o.id} className={effStyles.stopRow}>
          <span className={effStyles.blendLabel} style={{ minWidth: 46 }}>Alpha</span>
          <ValueField
            value={Math.round(o.opacity * 100)}
            min={0}
            max={100}
            precision={0}
            unit="%"
            onChange={(v) => write(ramp.map((x) => (x.id === o.id ? { ...x, opacity: v / 100 } : x)))}
            aria-label={`Opacity stop ${i + 1} value`}
          />
          <ValueField
            value={Math.round(o.offset * 100)}
            min={0}
            max={100}
            precision={0}
            unit="%"
            onChange={(v) => write(ramp.map((x) => (x.id === o.id ? { ...x, offset: v / 100 } : x)))}
            aria-label={`Opacity stop ${i + 1} position`}
          />
          <button
            type="button"
            className={effStyles.remove}
            aria-label={`Remove opacity stop ${i + 1}`}
            // Dropping below two stops removes the ramp entirely rather than
            // leaving one stop behind, which would read as a constant fade.
            onClick={() => write(ramp.length <= 2 ? undefined : ramp.filter((x) => x.id !== o.id))}
          >
            <Icon name="close" size={12} />
          </button>
        </div>
      ))}
      <button
        type="button"
        className={effStyles.addChip}
        onClick={() => write([...ramp, makeOpacityStop(0.5, 0.5)])}
      >
        <Icon name="plus" size={11} /> Add opacity stop
      </button>
    </>
  );
}

/** Editor for a gradient's stop list (shared by linear + radial fills). */
function StopList({ nodeId, paint }: { nodeId: string; paint: FillPaint }): JSX.Element | null {
  const time = useActiveWorkspace()?.time ?? 0;
  if (paint.type === 'solid') return null;
  const layerT = compToKeyframeTime(nodeId, time);

  // Gradient-stop keyframes (data track): when live, the rows show the
  // SAMPLED stop list at the playhead and every edit writes a keyframe there —
  // the renderer reads the track, so writing the static paint would be an
  // edit that changes nothing on screen.
  const stopsAnimated = defaultAnimation.isDataAnimated(nodeId, 'fill.stops');
  const sampled = stopsAnimated
    ? (defaultAnimation.sampleData(nodeId, 'fill.stops', layerT) as Array<{ pos: number; color: string }> | undefined)
    : undefined;
  const stops = sampled
    ? sortedStops(sampled.map((s, i) => ({ id: `anim_${i}`, offset: s.pos, color: s.color })))
    : sortedStops(paint.stops);
  const write = (next: ColorStop[]): void => {
    if (stopsAnimated) {
      runAnimEdit('Edit gradient stops keyframe', () => {
        defaultAnimation.setDataKeyframe(
          nodeId, 'fill.stops', 'gradientStops', layerT,
          sortedStops(next).map((s) => ({ pos: s.offset, color: s.color })),
        );
      }, `gradStops:${nodeId}`);
    } else {
      setNodeFill(nodeId, { ...paint, stops: next });
    }
  };
  const toggleStopwatch = (): void => {
    if (stopsAnimated) {
      runAnimEdit('Remove gradient stop keyframes', () => {
        defaultAnimation.setDataTrack(nodeId, 'fill.stops', null);
      });
    } else {
      runAnimEdit('Animate gradient stops', () => {
        defaultAnimation.setDataKeyframe(
          nodeId, 'fill.stops', 'gradientStops', layerT,
          stops.map((s) => ({ pos: s.offset, color: s.color })),
        );
      });
    }
  };

  return (
    <div className={effStyles.list}>
      <button
        type="button"
        className={effStyles.addChip}
        onClick={toggleStopwatch}
        aria-pressed={stopsAnimated}
        title={stopsAnimated
          ? 'Gradient stops are keyframed — click to remove all stop keyframes'
          : 'Keyframe the gradient stops at the playhead (positions and colors tween)'}
        style={stopsAnimated ? { color: 'var(--color-primary, #4c8dff)' } : undefined}
      >
        <Icon name="keyframe" size={11} /> {stopsAnimated ? 'Stops keyframed' : 'Animate stops'}
      </button>
      {stops.map((s, i) => (
        <div key={s.id} className={effStyles.stopRow}>
          <ColorPicker
            value={s.color}
            onChange={(color) => write(stops.map((x) => (x.id === s.id ? { ...x, color } : x)))}
            aria-label={`Stop ${i + 1} color`}
          />
          <ValueField
            value={Math.round(s.offset * 100)}
            min={0}
            max={100}
            precision={0}
            unit="%"
            onChange={(v) => write(stops.map((x) => (x.id === s.id ? { ...x, offset: v / 100 } : x)))}
            aria-label={`Stop ${i + 1} position`}
          />
          <button
            type="button"
            className={effStyles.remove}
            aria-label={`Remove stop ${i + 1}`}
            disabled={stops.length <= 2}
            onClick={() => write(stops.filter((x) => x.id !== s.id))}
          >
            <Icon name="close" size={12} />
          </button>
        </div>
      ))}
      <button
        type="button"
        className={effStyles.addChip}
        onClick={() => write([...stops, makeStop(0.5, '#888888')])}
      >
        <Icon name="plus" size={11} /> Add stop
      </button>

      <OpacityStopList nodeId={nodeId} paint={paint} />
    </div>
  );
}

export function AppearanceSection({ nodeId }: { nodeId: string }): JSX.Element | null {
  useSceneRevision((s: any) => s.rev);
  const node = defaultSceneGraph.getNode(nodeId);

  // No early return above this line: every hook below has to run on every
  // render, including the ones for a node that has just been deleted. Returning
  // before them made React render fewer hooks than the previous pass and throw
  // — deleting a selected layer with this panel open took the editor down.
  const styleComp = useMemo(() => node?.components.find((c) => c.type === 'Style'), [node]);
  const textComp = useMemo(() => node?.components.find((c) => c.type === 'Text'), [node]);
  const sComp = styleComp ?? textComp;

  const [cornerRadiusRaw, setCornerRadius] = useNodeComponentProp(defaultSceneGraph, nodeId, styleComp?.id, 'cornerRadius');
  const cornerRadius = typeof cornerRadiusRaw === 'number' ? cornerRadiusRaw : 0;

  const fill = getNodeFill(nodeId);
  const fills = getNodeFills(nodeId);
  const stroke = getNodeStroke(nodeId);
  const strokes = getNodeStrokes(nodeId);

  const [, setSavedFill] = useState<FillPaint | null>(null);

  // Hoisted above the `!node || !sComp` guard with the other hooks — it used to
  // sit below it, which is what made the hook count vary between renders.
  const selectedIds = useSelectionStore((s) => s.ids);

  const handleFillTypeChange = (type: FillType | 'none') => {
    if (type === 'none') {
      if (fill) setSavedFill(fill);
      setNodeFill(nodeId, undefined);
    } else {
      setNodeFill(nodeId, convertFill(fill, type));
      setSavedFill(null);
    }
  };

  const handleFillColorChange = (color: string) => {
    if (fill && fill.type === 'solid') {
      setNodeFill(nodeId, { ...fill, color });
    } else if (fill) {
      const newStops = [...fill.stops];
      if (newStops[0]) {
        newStops[0] = { ...newStops[0], color };
      }
      setNodeFill(nodeId, { ...fill, stops: newStops });
    } else {
      setNodeFill(nodeId, { type: 'solid', color });
    }
  };

  const handleStrokeWidthChange = (width: number) => {
    updateNodeStroke(nodeId, { width, enabled: width > 0 });
  };

  const handleStrokeColorChange = (color: string) => {
    updateNodeStroke(nodeId, { color });
  };

  const handleStrokeCapChange = (cap: StrokeCap) => {
    updateNodeStroke(nodeId, { cap });
  };

  const handleStrokeJoinChange = (join: StrokeJoin) => {
    updateNodeStroke(nodeId, { join });
  };

  const handleStrokeAlignChange = (align: StrokeAlign) => {
    updateNodeStroke(nodeId, { align });
  };

  const handleStrokeOpacityChange = (v: number) => {
    updateNodeStroke(nodeId, { opacity: v / 100 });
  };

  const handleStrokeDashChange = (raw: string) => {
    updateNodeStroke(nodeId, {
      dash: raw.split(',').map((n) => Number.parseFloat(n.trim())).filter((n) => Number.isFinite(n) && n >= 0),
    });
  };

  if (!node || !sComp) return null;

  const isFillAnimated = defaultAnimation.isAnimated(nodeId, 'fill') || defaultAnimation.isAnimated(nodeId, 'fill_r') || defaultAnimation.isAnimated(nodeId, 'fill_g') || defaultAnimation.isAnimated(nodeId, 'fill_b');
  const isStrokeAnimated = defaultAnimation.isAnimated(nodeId, 'stroke') || defaultAnimation.isAnimated(nodeId, 'stroke_r') || defaultAnimation.isAnimated(nodeId, 'stroke_g') || defaultAnimation.isAnimated(nodeId, 'stroke_b');
  const isCornerAnimated = defaultAnimation.isAnimated(nodeId, 'cornerRadius');

  const isGroupNode = defaultSceneGraph.getChildren(node.id).length > 0 || node.components.some((c) => c.type === 'group');

  return (
    <div className={styles.section}>

      {/* Group Assembly Actions (Group / Ungroup Sub-Parts) */}
      <div style={{ display: 'flex', gap: 6, marginBottom: 12, padding: '0 4px' }}>
        {selectedIds.length > 1 && (
          <button
            type="button"
            className={effStyles.addChip}
            style={{ flex: 1, justifyContent: 'center', background: 'var(--color-primary, #4c8dff)', color: '#ffffff' }}
            onClick={() => groupSelectedNodes()}
          >
            <Icon name="folder" size={12} /> Group Parts (⌘G)
          </button>
        )}
        {isGroupNode && (
          <button
            type="button"
            className={effStyles.addChip}
            style={{ flex: 1, justifyContent: 'center', borderColor: 'var(--color-border-glass)' }}
            onClick={() => ungroupSelectedNode(nodeId)}
          >
            <Icon name="layout" size={12} /> Detach Parts (Ungroup)
          </button>
        )}
      </div>

      {/* A six-button "Quick Style Presets" grid lived here — a second preset
          grid ONE ACCORDION away from the registry-backed Style Presets section
          in this same panel, with its own hard-coded looks that bypassed
          `applyStylePreset`. Removed rather than kept in sync: the presets
          section previews the real paint stack and covers all four categories
          plus 3D materials. */}
      <div className={styles.inlineRows}>
        <div className={styles.subhead}>
          Fill
          {isFillAnimated && <span className={styles.animatedDot} />}
        </div>
            <div className={styles.popoverRow}>
              <span className={styles.popoverLabel}>Type</span>
              <select
                value={fill?.type ?? 'none'}
                onChange={(e) => handleFillTypeChange(e.target.value as FillType | 'none')}
                className={styles.select}
                style={{ width: 110 }}
              >
                <option value="none">None</option>
                <option value="solid">Solid</option>
                <option value="linear">Linear</option>
                <option value="radial">Radial</option>
              </select>
            </div>

            {fill && fill.type === 'solid' && (
              <ColorKfRow
                nodeId={nodeId}
                propPrefix="fill"
                label="Color"
                value={fill.color}
                setValue={handleFillColorChange}
              />
            )}

            {fill && fill.type === 'linear' && (
              <AnimatablePaintRow
                nodeId={nodeId}
                prop="fillAngle"
                label="Angle"
                value={fill.angle}
                onStatic={(angle) => setNodeFill(nodeId, { ...fill, angle })}
              />
            )}

            {fill && fill.type === 'radial' && (
              <>
                <AnimatablePaintRow
                  nodeId={nodeId}
                  prop="fillCenterX"
                  label="Center X"
                  value={fill.cx}
                  onStatic={(cx) => setNodeFill(nodeId, { ...fill, cx })}
                />
                <AnimatablePaintRow
                  nodeId={nodeId}
                  prop="fillCenterY"
                  label="Center Y"
                  value={fill.cy}
                  onStatic={(cy) => setNodeFill(nodeId, { ...fill, cy })}
                />
                <AnimatablePaintRow
                  nodeId={nodeId}
                  prop="fillRadius"
                  label="Radius"
                  value={fill.radius}
                  onStatic={(radius) => setNodeFill(nodeId, { ...fill, radius })}
                />
              </>
            )}

            {fill && (fill.type === 'linear' || fill.type === 'radial') && (
              <div style={{ marginTop: 4, display: 'flex', flexDirection: 'column', gap: 6 }}>
                <span className={styles.popoverLabel} style={{ fontSize: 10, color: 'var(--color-text-tertiary)' }}>Stops:</span>
                <StopList nodeId={nodeId} paint={fill} />
              </div>
            )}

        {/* Extra fills (multi-fill stack, drawn over the primary). Animated
            fill tracks bind to the primary only, so extras stay simple rows. */}
        {fills.slice(1).map((f, i) => (
          <div key={`xfill_${i}`} className={styles.popoverRow}>
            <span className={styles.popoverLabel}>Fill {i + 2}</span>
            <select
              className={styles.select}
              style={{ width: 74 }}
              value={f.type}
              onChange={(e) => {
                const next = [...fills];
                next[i + 1] = convertFill(f, e.target.value as FillType);
                setNodeFills(nodeId, next);
              }}
              aria-label={`Fill ${i + 2} type`}
            >
              <option value="solid">Solid</option>
              <option value="linear">Linear</option>
              <option value="radial">Radial</option>
            </select>
            <ColorPicker
              compact
              value={f.type === 'solid' ? f.color : sortedStops(f.stops)[0]?.color ?? '#ffffff'}
              onChange={(hex) => {
                const next = [...fills];
                next[i + 1] =
                  f.type === 'solid'
                    ? solidFill(hex)
                    : { ...f, stops: f.stops.map((s, si) => (si === 0 ? { ...s, color: hex } : s)) };
                setNodeFills(nodeId, next);
              }}
              aria-label={`Fill ${i + 2} color`}
            />
            <button
              type="button"
              className={effStyles.remove}
              aria-label={`Remove fill ${i + 2}`}
              onClick={() => setNodeFills(nodeId, fills.filter((_, fi) => fi !== i + 1))}
            >
              <Icon name="close" size={12} />
            </button>
          </div>
        ))}
        {fill && (
          <button
            type="button"
            className={effStyles.addChip}
            onClick={() => setNodeFills(nodeId, [...fills, solidFill('#ffffff')])}
          >
            <Icon name="plus" size={11} /> Add fill
          </button>
        )}

        <div className={styles.subhead} style={{ marginTop: 10 }}>
          Stroke
          {isStrokeAnimated && <span className={styles.animatedDot} />}
        </div>
            <div className={styles.popoverRow}>
              <span className={styles.popoverLabel}>Enabled</span>
              <Checkbox
                checked={stroke?.enabled ?? false}
                onChange={() => updateNodeStroke(nodeId, { enabled: !(stroke?.enabled ?? false) })}
              />
            </div>

            {(stroke?.enabled ?? false) && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                <div className={styles.popoverRow}>
                  <span className={styles.popoverLabel}>Width</span>
                  <ValueField value={stroke?.width ?? 0} unit="px" onChange={handleStrokeWidthChange} />
                </div>

                <ColorKfRow
                  nodeId={nodeId}
                  propPrefix="stroke"
                  label="Color"
                  value={stroke?.color ?? '#ffffff'}
                  setValue={handleStrokeColorChange}
                />

                <div className={styles.popoverRow}>
                  <span className={styles.popoverLabel}>Opacity</span>
                  <ValueField
                    value={Math.round((stroke?.opacity ?? 1) * 100)}
                    min={0} max={100} precision={0} unit="%"
                    onChange={handleStrokeOpacityChange}
                  />
                </div>

                <div className={styles.popoverRow}>
                  <span className={styles.popoverLabel}>Align</span>
                  <select
                    value={stroke?.align ?? 'center'}
                    onChange={(e) => handleStrokeAlignChange(e.target.value as StrokeAlign)}
                    className={styles.select}
                    style={{ width: 100 }}
                  >
                    <option value="center">Center</option>
                    <option value="inside">Inside</option>
                    <option value="outside">Outside</option>
                  </select>
                </div>

                <div className={styles.popoverRow}>
                  <span className={styles.popoverLabel}>Cap</span>
                  <select
                    value={stroke?.cap ?? 'round'}
                    onChange={(e) => handleStrokeCapChange(e.target.value as StrokeCap)}
                    className={styles.select}
                    style={{ width: 100 }}
                  >
                    <option value="butt">Butt</option>
                    <option value="round">Round</option>
                    <option value="square">Square</option>
                  </select>
                </div>

                <div className={styles.popoverRow}>
                  <span className={styles.popoverLabel}>Join</span>
                  <select
                    value={stroke?.join ?? 'round'}
                    onChange={(e) => handleStrokeJoinChange(e.target.value as StrokeJoin)}
                    className={styles.select}
                    style={{ width: 100 }}
                  >
                    <option value="miter">Miter</option>
                    <option value="round">Round</option>
                    <option value="bevel">Bevel</option>
                  </select>
                </div>

                <div className={styles.popoverRow}>
                  <span className={styles.popoverLabel}>Dash</span>
                  <input
                    type="text"
                    value={(stroke?.dash ?? []).join(', ')}
                    placeholder="8, 4"
                    onChange={(e) => handleStrokeDashChange(e.currentTarget.value)}
                    className={styles.textInput}
                    style={{ width: 100, height: 24, padding: '2px 6px' }}
                  />
                </div>

                {/* Offset is only meaningful against a pattern, so it appears
                    with one. Shown unconditionally it would be a control that
                    provably does nothing — worse than a missing one, because it
                    reads as working. */}
                {(stroke?.dash ?? []).length > 0 && (
                  <AnimatablePaintRow
                    nodeId={nodeId}
                    prop="strokeDashOffset"
                    label="Dash Offset"
                    value={stroke?.dashOffset ?? 0}
                    onStatic={(v) => updateNodeStroke(nodeId, { dashOffset: v })}
                  />
                )}

                {/* Gradient stroke: an optional paint that overrides the solid
                    colour (Canvas2D builds the gradient in layer space). */}
                <div className={styles.popoverRow}>
                  <span className={styles.popoverLabel}>Paint</span>
                  <select
                    className={styles.select}
                    style={{ width: 100 }}
                    value={stroke?.paint && stroke.paint.type !== 'solid' ? stroke.paint.type : 'solid'}
                    onChange={(e) => {
                      const t = e.target.value as FillType;
                      if (t === 'solid') {
                        updateNodeStroke(nodeId, { paint: undefined });
                      } else {
                        updateNodeStroke(nodeId, { paint: convertFill(stroke?.paint, t) });
                      }
                    }}
                    aria-label="Stroke paint type"
                  >
                    <option value="solid">Solid color</option>
                    <option value="linear">Linear gradient</option>
                    <option value="radial">Radial gradient</option>
                  </select>
                </div>
                {stroke?.paint && stroke.paint.type !== 'solid' && (
                  <div className={styles.popoverRow}>
                    <span className={styles.popoverLabel}>Grad</span>
                    <ColorPicker
                      compact
                      value={sortedStops(stroke.paint.stops)[0]?.color ?? '#ffffff'}
                      onChange={(hex) => {
                        const p = stroke.paint!;
                        if (p.type === 'solid') return;
                        updateNodeStroke(nodeId, {
                          paint: { ...p, stops: p.stops.map((s, si) => (si === 0 ? { ...s, color: hex } : s)) },
                        });
                      }}
                      aria-label="Stroke gradient start color"
                    />
                    <span style={{ fontSize: 10, color: 'var(--color-text-tertiary)' }}>→</span>
                    <ColorPicker
                      compact
                      value={sortedStops(stroke.paint.stops).slice(-1)[0]?.color ?? '#000000'}
                      onChange={(hex) => {
                        const p = stroke.paint!;
                        if (p.type === 'solid') return;
                        const last = p.stops.length - 1;
                        updateNodeStroke(nodeId, {
                          paint: { ...p, stops: p.stops.map((s, si) => (si === last ? { ...s, color: hex } : s)) },
                        });
                      }}
                      aria-label="Stroke gradient end color"
                    />
                  </div>
                )}
              </div>
            )}

        {/* Extra strokes (multi-stroke stack). */}
        {strokes.slice(1).map((s, i) => (
          <div key={`xstroke_${i}`} className={styles.popoverRow}>
            <span className={styles.popoverLabel}>Stroke {i + 2}</span>
            <ValueField
              value={s.width}
              unit="px"
              min={0}
              onChange={(v) => {
                const next = [...strokes];
                next[i + 1] = normalizeStroke({ ...s, width: Number(v) });
                setNodeStrokes(nodeId, next);
              }}
              aria-label={`Stroke ${i + 2} width`}
            />
            <ColorPicker
              compact
              value={s.color}
              onChange={(hex) => {
                const next = [...strokes];
                next[i + 1] = normalizeStroke({ ...s, color: hex });
                setNodeStrokes(nodeId, next);
              }}
              aria-label={`Stroke ${i + 2} color`}
            />
            <button
              type="button"
              className={effStyles.remove}
              aria-label={`Remove stroke ${i + 2}`}
              onClick={() => setNodeStrokes(nodeId, strokes.filter((_, si) => si !== i + 1))}
            >
              <Icon name="close" size={12} />
            </button>
          </div>
        ))}
        {(stroke?.enabled ?? false) && (
          <button
            type="button"
            className={effStyles.addChip}
            onClick={() => setNodeStrokes(nodeId, [...(strokes.length ? strokes : [defaultStroke()]), normalizeStroke({ ...defaultStroke('#ffffff'), width: 2 })])}
          >
            <Icon name="plus" size={11} /> Add stroke
          </button>
        )}

        {styleComp && (
          <>
            <div className={styles.subhead} style={{ marginTop: 10 }}>
              Corners
              {isCornerAnimated && <span className={styles.animatedDot} />}
            </div>
            <div className={styles.popoverRow}>
              <span className={styles.popoverLabel}>Radius</span>
              <ValueField value={cornerRadius} unit="px" onChange={(v) => setCornerRadius(v)} />
            </div>
          </>
        )}
      </div>
    </div>
  );
}

export default AppearanceSection;
