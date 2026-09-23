/**
 * The Fill half of the Fill & Stroke section: paint type, colour, gradient
 * geometry, the on-canvas gradient gizmo, the stop list and the extra fills.
 *
 * Split out of `AppearanceSection.tsx` (2026-09-04); the markup and every
 * write path are what the section drew inline. The gradient-geometry rows
 * (angle, centre, radius) are the one thing that changed: each is now a
 * per-node accessor, so with three gradient layers selected "Angle" reads
 * `—` where they disagree and a drag turns all three.
 */

import { useState } from 'react';
import { Icon } from '@components/Icon';
import { ColorPicker } from '@components/ColorPicker';
import defaultSceneGraph from '@core/scene/DefaultSceneGraph';
import { defaultAnimation } from '@motion/animation';
import {
  getNodeFill,
  setNodeFill,
  getNodeFills,
  setNodeFills,
  convertFill,
  sortedStops,
  solidFill,
  type FillType,
  type FillPaint,
} from '@core/paint/fill';
import type { PropertyAccess } from '@core/inspector/multiSelection';
import { normalizePaintOpOptions, type PaintOpOptions } from '@core/paint/stroke';
import { useGradientEditStore } from '@layout/Workspace/gradientEditStore';
import { ColorKfRow } from '../ColorKfRow';
import { AnimatablePaintRow } from './AnimatablePaintRow';
import { PaintOpRows } from './PaintOpRows';

/**
 * A fill with its Composite/Blend Mode replaced — defaults normalised AWAY, so a
 * fill set back to Below/Normal is the exact object (and raster cache key) it
 * was before. The fields ride the paint object structurally; `FillPaint` itself
 * does not declare them.
 */
function withPaintOp<T extends FillPaint>(paint: T, opts: PaintOpOptions): T {
  const { composite: _c, blendMode: _b, ...rest } = paint as T & PaintOpOptions;
  return { ...rest, ...normalizePaintOpOptions(opts) } as T;
}
import { StopList } from './StopLists';
import styles from '../TransformSection.module.css';
import effStyles from '../../Effects/EffectsPanel.module.css';

/**
 * Per-node accessors for the gradient geometry — module constants so their
 * identity is stable across renders (the row memoises its aggregate on them).
 * A layer whose fill is not of the right type has no such value.
 */
const FILL_ANGLE: PropertyAccess = {
  read: (id) => {
    const f = getNodeFill(id);
    return f?.type === 'linear' ? f.angle : undefined;
  },
  writeStatic: (id, angle) => {
    const f = getNodeFill(id);
    if (f?.type !== 'linear') return false;
    // B3-legacy: engine gap — layer fill paints (fx.fill / fx.fills: solid / gradient objects) have no API property or group (`contents/<fill>`).
    setNodeFill(id, { ...f, angle });
    return true;
  },
};

function radialAccess(field: 'cx' | 'cy' | 'radius'): PropertyAccess {
  return {
    read: (id) => {
      const f = getNodeFill(id);
      return f?.type === 'radial' ? f[field] : undefined;
    },
    writeStatic: (id, v) => {
      const f = getNodeFill(id);
      if (f?.type !== 'radial') return false;
      // B3-legacy: engine gap — layer fill paints (fx.fill / fx.fills: solid / gradient objects) have no API property or group (`contents/<fill>`).
      setNodeFill(id, { ...f, [field]: v });
      return true;
    },
  };
}

const FILL_CX = radialAccess('cx');
const FILL_CY = radialAccess('cy');
const FILL_RADIUS = radialAccess('radius');

export function FillRows({ nodeId }: { nodeId: string }): JSX.Element | null {
  const [, setSavedFill] = useState<FillPaint | null>(null);

  /**
   * On-canvas gradient editing, armed from here as well as from the canvas.
   *
   * This panel is exactly where you are standing when you decide that typing an
   * angle and four stop percentages is the wrong way to place a gradient, so it
   * is the second door into the gizmo — the first being a double-click on the
   * swatch chip the overlay draws at the layer's centre.
   */
  const gradientArmedId = useGradientEditStore((s) => s.nodeId);
  const armGradient = useGradientEditStore((s) => s.arm);
  const disarmGradient = useGradientEditStore((s) => s.disarm);
  const gradientArmed = gradientArmedId === nodeId;

  if (!defaultSceneGraph.getNode(nodeId)) return null;

  const fill = getNodeFill(nodeId);
  const fills = getNodeFills(nodeId);

  const handleFillTypeChange = (type: FillType | 'none') => {
    if (type === 'none') {
      if (fill) setSavedFill(fill);
      // B3-legacy: engine gap — layer fill paints (fx.fill / fx.fills: solid / gradient objects) have no API property or group (`contents/<fill>`).
      setNodeFill(nodeId, undefined);
    } else {
      // Composite / blend survive a type switch — they belong to the paint
      // operation, not to whichever kind of paint it currently is.
      const next = convertFill(fill, type);
      // B3-legacy: engine gap — layer fill paints (fx.fill / fx.fills: solid / gradient objects) have no API property or group (`contents/<fill>`).
      setNodeFill(nodeId, fill ? withPaintOp(next, fill as PaintOpOptions) : next);
      setSavedFill(null);
    }
  };

  const handleFillColorChange = (color: string) => {
    if (fill && fill.type === 'solid') {
      // B3-legacy: engine gap — layer fill paints (fx.fill / fx.fills: solid / gradient objects) have no API property or group (`contents/<fill>`).
      setNodeFill(nodeId, { ...fill, color });
    } else if (fill) {
      const newStops = [...fill.stops];
      if (newStops[0]) {
        newStops[0] = { ...newStops[0], color };
      }
      // B3-legacy: engine gap — layer fill paints (fx.fill / fx.fills: solid / gradient objects) have no API property or group (`contents/<fill>`).
      setNodeFill(nodeId, { ...fill, stops: newStops });
    } else {
      setNodeFill(nodeId, { type: 'solid', color });
    }
  };

  const isFillAnimated = defaultAnimation.isAnimated(nodeId, 'fill') || defaultAnimation.isAnimated(nodeId, 'fill_r') || defaultAnimation.isAnimated(nodeId, 'fill_g') || defaultAnimation.isAnimated(nodeId, 'fill_b');

  return (
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

            {fill && (
              <PaintOpRows
                label="Fill 1"
                value={fill as PaintOpOptions}
                // B3-legacy: engine gap — layer fill paints (fx.fill / fx.fills: solid / gradient objects) have no API property or group (`contents/<fill>`).
                onChange={(next) => setNodeFill(nodeId, withPaintOp(fill, next))}
              />
            )}

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
              <AnimatablePaintRow nodeId={nodeId} prop="fillAngle" label="Angle" access={FILL_ANGLE} />
            )}

            {fill && fill.type === 'radial' && (
              <>
                <AnimatablePaintRow nodeId={nodeId} prop="fillCenterX" label="Center X" access={FILL_CX} />
                <AnimatablePaintRow nodeId={nodeId} prop="fillCenterY" label="Center Y" access={FILL_CY} />
                <AnimatablePaintRow nodeId={nodeId} prop="fillRadius" label="Radius" access={FILL_RADIUS} />
              </>
            )}

            {fill && (fill.type === 'linear' || fill.type === 'radial') && (
              <div style={{ marginTop: 4, display: 'flex', flexDirection: 'column', gap: 6 }}>
                <button
                  type="button"
                  className={effStyles.addChip}
                  style={{ gap: 5, ...(gradientArmed ? { color: 'var(--color-primary, #4c8dff)' } : {}) }}
                  aria-pressed={gradientArmed}
                  title={gradientArmed
                    ? 'Editing this gradient on the canvas — click to put the handles away (or press Escape)'
                    : 'Drag the gradient axis and its stops directly on the canvas'}
                  onClick={() => (gradientArmed ? disarmGradient() : armGradient(nodeId, 0))}
                >
                  <Icon name="gradient" size="sm" />
                  <span>{gradientArmed ? 'Editing on canvas' : 'Edit on canvas'}</span>
                </button>
                <span className={styles.popoverLabel} style={{ fontSize: 'var(--font-size-micro)', color: 'var(--color-text-tertiary)' }}>Stops:</span>
                <StopList nodeId={nodeId} paint={fill} />
              </div>
            )}

        {/* Extra fills (multi-fill stack, drawn over the primary). Animated
            fill tracks bind to the primary only, so extras stay simple rows. */}
        {fills.slice(1).map((f, i) => (
          <div key={`xfill_${i}`} style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          <div className={styles.popoverRow}>
            <span className={styles.popoverLabel}>Fill {i + 2}</span>
            <select
              className={styles.select}
              style={{ width: 74 }}
              value={f.type}
              onChange={(e) => {
                const next = [...fills];
                // B3-legacy: engine gap — layer fill paints (fx.fill / fx.fills: solid / gradient objects) have no API property or group (`contents/<fill>`).
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
                // B3-legacy: engine gap — layer fill paints (fx.fill / fx.fills: solid / gradient objects) have no API property or group (`contents/<fill>`).
                setNodeFills(nodeId, next);
              }}
              aria-label={`Fill ${i + 2} color`}
            />
            <button
              type="button"
              className={effStyles.remove}
              aria-label={`Remove fill ${i + 2}`}
              // B3-legacy: engine gap — layer fill paints (fx.fill / fx.fills: solid / gradient objects) have no API property or group (`contents/<fill>`).
              onClick={() => setNodeFills(nodeId, fills.filter((_, fi) => fi !== i + 1))}
            >
              <Icon name="close" size="sm" />
            </button>
          </div>
          <PaintOpRows
            label={`Fill ${i + 2}`}
            value={f as PaintOpOptions}
            onChange={(opts) => {
              const next = [...fills];
              next[i + 1] = withPaintOp(f, opts);
              // B3-legacy: engine gap — layer fill paints (fx.fill / fx.fills: solid / gradient objects) have no API property or group (`contents/<fill>`).
              setNodeFills(nodeId, next);
            }}
          />
          </div>
        ))}
        {fill && (
          <button
            type="button"
            className={effStyles.addChip}
            style={{ gap: 5 }}
            // B3-legacy: engine gap — layer fill paints (fx.fill / fx.fills: solid / gradient objects) have no API property or group (`contents/<fill>`).
            onClick={() => setNodeFills(nodeId, [...fills, solidFill('#ffffff')])}
          >
            <Icon name="plus" size="sm" />
            <span>Add fill</span>
          </button>
        )}
    </>
  );
}

export default FillRows;
