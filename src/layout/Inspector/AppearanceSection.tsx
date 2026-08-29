import { useMemo, useState } from 'react';

import { ValueField } from '@components/ValueField';
import { useSceneRevision } from '@stores/sceneStore';
import { useAnimationRevision } from '@hooks/useAnimationRevision';
import defaultSceneGraph from '@core/scene/DefaultSceneGraph';
import { useNodeComponentProp } from '@hooks/useNodeComponentProp';
import { getNodeFill, setNodeFill, getNodeFills, setNodeFills, convertFill, makeStop, sortedStops, solidFill, type FillType, type FillPaint, type ColorStop,
  sortedOpacityStops,
  defaultOpacityStops,
  makeOpacityStop,
  type OpacityStop,
} from '@core/paint/fill';
import { IDENTITY_TAPER as TAPER_DEFAULTS, IDENTITY_WAVE as WAVE_DEFAULTS, isIdentityTaper, isIdentityWave } from '@core/scene/strokeProfile';
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
import { batchHistory } from '@stores/historyStore';
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
  prop:
    | 'fillAngle' | 'fillCenterX' | 'fillCenterY' | 'fillRadius' | 'strokeWidth' | 'strokeDashOffset'
    | 'cornerRadius' | 'cornerRadiusTL' | 'cornerRadiusTR' | 'cornerRadiusBR' | 'cornerRadiusBL'
    | 'strokeTaperStartWidth' | 'strokeTaperEndWidth'
    | 'strokeTaperStartLength' | 'strokeTaperEndLength'
    | 'strokeTaperStartEase' | 'strokeTaperEndEase'
    | 'strokeWaveAmount' | 'strokeWaveWavelength' | 'strokeWavePhase';
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
  const trackedProps = prop === 'cornerRadius'
    ? ['cornerRadius', 'cornerRadiusTL', 'cornerRadiusTR', 'cornerRadiusBR', 'cornerRadiusBL'] as const
    : [prop];
  const animated = trackedProps.some((trackProp) => defaultAnimation.isAnimated(nodeId, trackProp));
  // The canonical keyframe axis — what the renderer samples for this node.
  const layerT = compToKeyframeTime(nodeId, time, prop);
  const engineVal = animated
    ? trackedProps
      .map((trackProp) => defaultAnimation.sample(nodeId, trackProp, layerT))
      .find((sample): sample is number => typeof sample === 'number') ?? value
    : value;

  const handleChange = (display: number) => {
    const engine = display / scale;
    if (animated || autoKeyframe) {
      runAnimEdit(
        `Set ${prop}`,
        () => {
          for (const trackProp of trackedProps) {
            defaultAnimation.setKeyframe(nodeId, trackProp, layerT, engine);
          }
        },
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
              runAnimEdit(`Remove ${prop} animation`, () => {
                for (const trackProp of trackedProps) defaultAnimation.removeTrack(nodeId, trackProp);
              });
            } else {
              runAnimEdit(`Animate ${prop}`, () => {
                for (const trackProp of trackedProps) {
                  defaultAnimation.setKeyframe(nodeId, trackProp, layerT, value);
                }
              });
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
        <Icon name="plus" size="sm" /> Add opacity ramp
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
            <Icon name="close" size="sm" />
          </button>
        </div>
      ))}
      <button
        type="button"
        className={effStyles.addChip}
        onClick={() => write([...ramp, makeOpacityStop(0.5, 0.5)])}
      >
        <Icon name="plus" size="sm" /> Add opacity stop
      </button>
    </>
  );
}

/**
 * Editor for a gradient's stop list — linear + radial, FILL and STROKE.
 *
 * The stroke used to get two lone ColorPickers wired to `stops[0]` and
 * `stops[n-1]`: a gradient stroke could RENDER any number of stops (the model
 * and the rasterizer have always supported it) but only its two ends could be
 * edited and none could be added. Reusing this editor rather than growing a
 * second one is the point — two stop editors would drift, and this one already
 * carries the keyframing, the sort and the minimum-two rule.
 *
 * `target` selects where a write goes. Stop KEYFRAMING stays fill-only, and
 * that is honest gating rather than an oversight: the animated stop list is read
 * from the `fill.stops` data track, and there is no `stroke.stops` equivalent in
 * the renderer. Offering the stopwatch here would be a control writing keyframes
 * nothing samples — F34, which this same branch fixed twice.
 */
function StopList({
  nodeId,
  paint,
  target = 'fill',
}: { nodeId: string; paint: FillPaint; target?: 'fill' | 'stroke' }): JSX.Element | null {
  const time = useActiveWorkspace()?.time ?? 0;
  if (paint.type === 'solid') return null;
  const layerT = compToKeyframeTime(nodeId, time);
  const canAnimate = target === 'fill';

  // Gradient-stop keyframes (data track): when live, the rows show the
  // SAMPLED stop list at the playhead and every edit writes a keyframe there —
  // the renderer reads the track, so writing the static paint would be an
  // edit that changes nothing on screen.
  const stopsAnimated = canAnimate && defaultAnimation.isDataAnimated(nodeId, 'fill.stops');
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
    } else if (target === 'stroke') {
      updateNodeStroke(nodeId, { paint: { ...paint, stops: next } });
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
      {canAnimate && (
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
        <Icon name="keyframe" size="sm" /> {stopsAnimated ? 'Stops keyframed' : 'Animate stops'}
      </button>
      )}
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
            <Icon name="close" size="sm" />
          </button>
        </div>
      ))}
      <button
        type="button"
        className={effStyles.addChip}
        onClick={() => write([...stops, makeStop(0.5, '#888888')])}
      >
        <Icon name="plus" size="sm" /> Add stop
      </button>

      {canAnimate && <OpacityStopList nodeId={nodeId} paint={paint} />}
    </div>
  );
}

export function AppearanceSection({ nodeId }: { nodeId: string }): JSX.Element | null {
  useSceneRevision((s) => s.rev);
  useAnimationRevision();
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
  const [cornerTLRaw, setCornerTL] = useNodeComponentProp(defaultSceneGraph, nodeId, styleComp?.id, 'cornerRadiusTL');
  const [cornerTRRaw, setCornerTR] = useNodeComponentProp(defaultSceneGraph, nodeId, styleComp?.id, 'cornerRadiusTR');
  const [cornerBRRaw, setCornerBR] = useNodeComponentProp(defaultSceneGraph, nodeId, styleComp?.id, 'cornerRadiusBR');
  const [cornerBLRaw, setCornerBL] = useNodeComponentProp(defaultSceneGraph, nodeId, styleComp?.id, 'cornerRadiusBL');
  const [cornersLinkedRaw, setCornersLinked] = useNodeComponentProp(defaultSceneGraph, nodeId, styleComp?.id, 'cornersLinked');
  const cornerTL = typeof cornerTLRaw === 'number' ? cornerTLRaw : cornerRadius;
  const cornerTR = typeof cornerTRRaw === 'number' ? cornerTRRaw : cornerRadius;
  const cornerBR = typeof cornerBRRaw === 'number' ? cornerBRRaw : cornerRadius;
  const cornerBL = typeof cornerBLRaw === 'number' ? cornerBLRaw : cornerRadius;
  const cornersLinked = (() => {
    if (cornersLinkedRaw === false) return false;
    if (cornersLinkedRaw === true) return true;
    // Legacy docs with only `cornerRadius` (or equal individuals) stay linked.
    return cornerTL === cornerTR && cornerTR === cornerBR && cornerBR === cornerBL;
  })();

  /**
   * One drag of the linked corner field writes six props (the uniform radius,
   * all four corners, the link flag) — and history keys an action by the prop
   * it wrote, so without `batchHistory` that is six undo steps for one edit.
   */
  const writeAllCorners = (v: number, link: boolean) => {
    const r = Math.max(0, v);
    batchHistory(`corners:${nodeId}`, () => {
      setCornerRadius(r);
      setCornerTL(r);
      setCornerTR(r);
      setCornerBR(r);
      setCornerBL(r);
      if (link) setCornersLinked(true);
    });
  };

  const writeCorner = (
    which: 'TL' | 'TR' | 'BR' | 'BL',
    setOne: (v: unknown) => void,
    v: number,
  ) => {
    const r = Math.max(0, v);
    if (cornersLinked) {
      writeAllCorners(r, true);
      return;
    }
    batchHistory(`corners:${nodeId}`, () => {
      setOne(r);
      // Keep `cornerRadius` as the max so extrusion / legacy readers stay sensible.
      const next = {
        TL: which === 'TL' ? r : cornerTL,
        TR: which === 'TR' ? r : cornerTR,
        BR: which === 'BR' ? r : cornerBR,
        BL: which === 'BL' ? r : cornerBL,
      };
      setCornerRadius(Math.max(next.TL, next.TR, next.BR, next.BL));
    });
  };

  const toggleCornersLinked = () => {
    if (cornersLinked) {
      // Unlink: seed each corner from the current values so fields don't jump.
      batchHistory(`corners:${nodeId}`, () => {
        setCornerTL(cornerTL);
        setCornerTR(cornerTR);
        setCornerBR(cornerBR);
        setCornerBL(cornerBL);
        setCornersLinked(false);
      });
    } else {
      writeAllCorners(cornerRadius, true);
    }
  };

  const fill = getNodeFill(nodeId);
  const fills = getNodeFills(nodeId);
  const stroke = getNodeStroke(nodeId);
  // Progressive disclosure, the same rule the Dash Offset row follows: the
  // detail controls only appear once the thing they detail is switched on, so
  // no row is ever shown that provably cannot change a pixel.
  /**
   * Patch the taper, SEEDING a ramp when the edit would otherwise be identity.
   *
   * Found by driving the real UI: a width alone cannot leave identity, because
   * identity needs BOTH a non-full width and a ramp length. So setting "Taper
   * Start = 60%" with the default zero length normalised straight back to
   * undefined and the field snapped to 100 — a control that could not be moved,
   * which is worse than one that is missing.
   *
   * The model stays honest (identity IS identity, and is dropped so it cannot
   * bloat the raster cache key); this is the UI affordance that makes the first
   * edit do something. AE reaches the same place by shipping a non-zero default
   * length once the group is added.
   */
  const DEFAULT_RAMP = 0.5;
  const patchTaper = (patch: Partial<typeof TAPER_DEFAULTS>) => {
    const next = { ...TAPER_DEFAULTS, ...stroke?.taper, ...patch };
    if (next.startWidth < 1 && next.startLength <= 0 && patch.startLength === undefined) next.startLength = DEFAULT_RAMP;
    if (next.endWidth < 1 && next.endLength <= 0 && patch.endLength === undefined) next.endLength = DEFAULT_RAMP;
    updateNodeStroke(nodeId, { taper: next });
  };
  /** Same trap on the wave: an amplitude with no wavelength is identity. */
  const DEFAULT_WAVELENGTH = 60;
  const patchWave = (patch: Partial<typeof WAVE_DEFAULTS>) => {
    const next = { ...WAVE_DEFAULTS, ...stroke?.wave, ...patch };
    if (next.amount !== 0 && next.wavelength <= 0 && patch.wavelength === undefined) next.wavelength = DEFAULT_WAVELENGTH;
    updateNodeStroke(nodeId, { wave: next });
  };
  const hasTaper = !isIdentityTaper(stroke?.taper);
  const hasWave = !isIdentityWave(stroke?.wave);
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
  const isCornerAnimated = defaultAnimation.isAnimated(nodeId, 'cornerRadius')
    || defaultAnimation.isAnimated(nodeId, 'cornerRadiusTL')
    || defaultAnimation.isAnimated(nodeId, 'cornerRadiusTR')
    || defaultAnimation.isAnimated(nodeId, 'cornerRadiusBR')
    || defaultAnimation.isAnimated(nodeId, 'cornerRadiusBL');

  const isGroupNode = defaultSceneGraph.getChildren(node.id).length > 0 || node.components.some((c) => c.type === 'group');

  return (
    <div className={styles.section}>

      {/* Group Assembly Actions (Group / Ungroup Sub-Parts) */}
      <div style={{ display: 'flex', gap: 6, marginBottom: 12, padding: '0 4px' }}>
        {selectedIds.length > 1 && (
          <button
            type="button"
            className={effStyles.addChip}
            style={{ flex: 1, justifyContent: 'center', background: 'rgba(245, 176, 65, 0.12)', color: '#f5b041', borderColor: 'rgba(245, 176, 65, 0.35)', gap: 5 }}
            onClick={() => groupSelectedNodes()}
          >
            <Icon name="folder" size="sm" style={{ color: '#f5b041' }} />
            <span>Group Parts (⌘G)</span>
          </button>
        )}
        {isGroupNode && (
          <button
            type="button"
            className={effStyles.addChip}
            style={{ flex: 1, justifyContent: 'center', borderColor: 'var(--color-border-glass)', gap: 5 }}
            onClick={() => ungroupSelectedNode(nodeId)}
          >
            <Icon name="layout" size="sm" />
            <span>Detach Parts (Ungroup)</span>
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
        {/* Text layers own Character Color in TextSection. Editing paint fill
            here wrote the same prop and looked like a duplicate background
            picker — hide Fill chrome on text; Stroke remains. */}
        {!textComp && (
          <>
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
                <span className={styles.popoverLabel} style={{ fontSize: 'var(--font-size-micro)', color: 'var(--color-text-tertiary)' }}>Stops:</span>
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
              <Icon name="close" size="sm" />
            </button>
          </div>
        ))}
        {fill && (
          <button
            type="button"
            className={effStyles.addChip}
            style={{ gap: 5 }}
            onClick={() => setNodeFills(nodeId, [...fills, solidFill('#ffffff')])}
          >
            <Icon name="plus" size="sm" />
            <span>Add fill</span>
          </button>
        )}
          </>
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
                <AnimatablePaintRow
                  nodeId={nodeId}
                  prop="strokeWidth"
                  label="Width"
                  value={stroke?.width ?? 0}
                  onStatic={handleStrokeWidthChange}
                />

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

                {/* ── Taper and Wave (AE's Stroke group) ──
                    One group, because AE ships them as one and they share the
                    same arc-length walk. Every row is keyframeable and every
                    track is folded in `buildSnapshot` — a stopwatch the renderer
                    ignores is F34/F35, and the class guard now fails the build
                    for it.

                    The dashed-stroke warning that used to sit here is gone
                    because the limitation is gone: dash and taper compose now,
                    each dash reading its width from where it sits on the whole
                    path. A warning about a restriction that no longer exists is
                    worse than none. */}

                <AnimatablePaintRow
                  nodeId={nodeId} prop="strokeTaperStartWidth" label="Taper Start"
                  value={stroke?.taper?.startWidth ?? 1}
                  onStatic={(v) => patchTaper({ startWidth: v })}
                />
                <AnimatablePaintRow
                  nodeId={nodeId} prop="strokeTaperEndWidth" label="Taper End"
                  value={stroke?.taper?.endWidth ?? 1}
                  onStatic={(v) => patchTaper({ endWidth: v })}
                />
                {hasTaper && (
                  <>
                    <AnimatablePaintRow
                      nodeId={nodeId} prop="strokeTaperStartLength" label="Start Length"
                      value={stroke?.taper?.startLength ?? 0}
                      onStatic={(v) => patchTaper({ startLength: v })}
                    />
                    <AnimatablePaintRow
                      nodeId={nodeId} prop="strokeTaperEndLength" label="End Length"
                      value={stroke?.taper?.endLength ?? 0}
                      onStatic={(v) => patchTaper({ endLength: v })}
                    />
                    <AnimatablePaintRow
                      nodeId={nodeId} prop="strokeTaperStartEase" label="Start Ease"
                      value={stroke?.taper?.startEase ?? 0}
                      onStatic={(v) => patchTaper({ startEase: v })}
                    />
                    <AnimatablePaintRow
                      nodeId={nodeId} prop="strokeTaperEndEase" label="End Ease"
                      value={stroke?.taper?.endEase ?? 0}
                      onStatic={(v) => patchTaper({ endEase: v })}
                    />
                  </>
                )}

                <AnimatablePaintRow
                  nodeId={nodeId} prop="strokeWaveAmount" label="Wave Amount"
                  value={stroke?.wave?.amount ?? 0}
                  onStatic={(v) => patchWave({ amount: v })}
                />
                {/* Wavelength and phase only mean something against an
                    amplitude — the same rule the Dash Offset row above follows. */}
                {hasWave && (
                  <>
                    <AnimatablePaintRow
                      nodeId={nodeId} prop="strokeWaveWavelength" label="Wavelength"
                      value={stroke?.wave?.wavelength ?? 0}
                      onStatic={(v) => patchWave({ wavelength: v })}
                    />
                    <AnimatablePaintRow
                      nodeId={nodeId} prop="strokeWavePhase" label="Wave Phase"
                      value={stroke?.wave?.phase ?? 0}
                      onStatic={(v) => patchWave({ phase: v })}
                    />
                  </>
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
                {/* The full stop list, not two lone end-pickers. A gradient
                    stroke has always RENDERED any number of stops; until now
                    only its two ends were editable and none could be added. */}
                {stroke?.paint && stroke.paint.type !== 'solid' && (
                  <StopList nodeId={nodeId} paint={stroke.paint} target="stroke" />
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
              <Icon name="close" size="sm" />
            </button>
          </div>
        ))}
        {(stroke?.enabled ?? false) && (
          <button
            type="button"
            className={effStyles.addChip}
            style={{ gap: 5 }}
            onClick={() => setNodeStrokes(nodeId, [...(strokes.length ? strokes : [defaultStroke()]), normalizeStroke({ ...defaultStroke('#ffffff'), width: 2 })])}
          >
            <Icon name="plus" size="sm" /> Add stroke
          </button>
        )}

        {styleComp && (
          <>
            <div className={styles.subhead} style={{ marginTop: 10 }}>
              <span>Corners</span>
              <button
                type="button"
                onClick={toggleCornersLinked}
                className={`${styles.lockBtn} ${cornersLinked ? styles.lockBtnActive : ''}`}
                title={cornersLinked ? 'Unlink corners (edit individually)' : 'Link corners (same radius)'}
                style={{ marginLeft: 6 }}
                aria-pressed={cornersLinked}
              >
                <Icon name={cornersLinked ? 'lock' : 'unlock'} size="sm" style={{ color: cornersLinked ? '#f59e0b' : '#94a3b8' }} />
              </button>
              {isCornerAnimated && <span className={styles.animatedDot} />}
            </div>
            {cornersLinked ? (
              <AnimatablePaintRow
                nodeId={nodeId}
                prop="cornerRadius"
                label="All"
                value={cornerRadius}
                onStatic={(v) => writeAllCorners(v, true)}
              />
            ) : (
              <>
                <div className={styles.popoverRow}>
                  <span className={styles.popoverLabel}>All</span>
                  <ValueField
                    value={Math.max(cornerTL, cornerTR, cornerBR, cornerBL)}
                    unit="px"
                    min={0}
                    onChange={(v) => writeAllCorners(v, false)}
                    aria-label="Corner radius"
                  />
                </div>
                <div className={styles.cornerGrid} role="group" aria-label="Individual corner radii">
                  <AnimatablePaintRow nodeId={nodeId} prop="cornerRadiusTL" label="TL" value={cornerTL} onStatic={(v) => writeCorner('TL', setCornerTL, v)} />
                  <AnimatablePaintRow nodeId={nodeId} prop="cornerRadiusTR" label="TR" value={cornerTR} onStatic={(v) => writeCorner('TR', setCornerTR, v)} />
                  <AnimatablePaintRow nodeId={nodeId} prop="cornerRadiusBL" label="BL" value={cornerBL} onStatic={(v) => writeCorner('BL', setCornerBL, v)} />
                  <AnimatablePaintRow nodeId={nodeId} prop="cornerRadiusBR" label="BR" value={cornerBR} onStatic={(v) => writeCorner('BR', setCornerBR, v)} />
                </div>
              </>
            )}
          </>
        )}
      </div>
    </div>
  );
}

export default AppearanceSection;
