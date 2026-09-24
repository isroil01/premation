/**
 * Text layer FILL TYPE — Solid / Linear Gradient / Radial Gradient.
 *
 * Text layers keep their solid colour on the Text component (`fill`, the
 * Character panel's swatch); the Appearance section hides its Fill rows on
 * text for exactly that reason. A GRADIENT, though, is the shape layer's
 * paint model (`fx.fill`, `@core/paint/fill`), so a text gradient is stored
 * there and edited with the same rows, stop list and on-canvas gizmo a shape
 * uses — the gizmo already targets any node with a gradient fill.
 *
 * Switching back to Solid CLEARS `fx.fill` rather than writing a solid paint
 * into it: a solid `fx.fill` beats the Text component's colour in the
 * snapshot, and the Character panel's swatch would then edit a colour nothing
 * draws.
 */

import {
  convertFill,
  solidFill,
  sortedStops,
  type ColorStop,
  type FillPaint,
  type LinearFill,
  type RadialFill,
} from '@core/paint/fill';
import { documentMirror } from '@stores/documentMirror';
import { useMirrorTree } from '@hooks/useMirror';
import { mirrorFill } from '@core/mirror/paintFields';
import { hasTextLayer, mirrorTextStrokePaint } from '@layout/Text/textMirror';
import { ColorPicker } from '@components/ColorPicker';
import type { PropertyAccess } from '@core/inspector/multiSelection';
import { setFillPaintEdit, textStrokePaintCommands } from './appearance/paintEdits';
import { useEngineEdit } from './useEngineEdit';
import { useGradientEditStore } from '@layout/Workspace/gradientEditStore';
import { Icon } from '@components/Icon';
import { AnimatablePaintRow } from './appearance/AnimatablePaintRow';
import { StopList } from './appearance/StopLists';
import styles from './CharacterPanel.module.css';

/* eslint-disable design-system/no-hex-color */
const DEFAULT_TEXT_FILL = '#ffffff';
/* eslint-enable design-system/no-hex-color */

type TextFillType = 'solid' | 'linear' | 'radial';

function gradientOf(nodeId: string): Exclude<FillPaint, { type: 'solid' }> | null {
  // B4: the mirror's `layer/fillPaint`. A text layer's plain colour is its
  // Character fill, not a paint; only a stored gradient counts here.
  const f = mirrorFill(documentMirror(), nodeId);
  return f && f.type !== 'solid' ? f : null;
}

// READ accessors; the writes are the engine's gradient geometry properties
// (`layer/fillAngle`, `fillCenterX|Y`, `fillRadius` — static value inside the paint).
const ANGLE: PropertyAccess = {
  read: (id) => {
    const f = gradientOf(id);
    return f?.type === 'linear' ? f.angle : undefined;
  },
};

function radial(field: 'cx' | 'cy' | 'radius'): PropertyAccess {
  return {
    read: (id) => {
      const f = gradientOf(id);
      return f?.type === 'radial' ? f[field] : undefined;
    },
  };
}
const CX = radial('cx');
const CY = radial('cy');
const RADIUS = radial('radius');

export function TextFillRows({ nodeId, textColor }: { nodeId: string; textColor: string | undefined }): JSX.Element | null {
  const armedId = useGradientEditStore((s) => s.nodeId);
  const armedTarget = useGradientEditStore((s) => s.target);
  const arm = useGradientEditStore((s) => s.arm);
  const disarm = useGradientEditStore((s) => s.disarm);
  // B4: this layer's tree (its paint fields) wakes the rows.
  useMirrorTree(nodeId);
  if (!documentMirror().layer(nodeId)) return null;

  const gradient = gradientOf(nodeId);
  const type: TextFillType = gradient?.type ?? 'solid';
  // Armed on THIS layer's fill — the stroke rows own the stroke's toggle.
  const armed = armedId === nodeId && armedTarget === 'fill';

  const setType = (next: TextFillType): void => {
    if (next === type) return;
    // `layer/fillPaint` (G1). A new gradient starts from the text's own colour.
    void setFillPaintEdit('Text Fill Type', nodeId,
      next === 'solid' ? undefined : convertFill(gradient ?? solidFill(textColor ?? DEFAULT_TEXT_FILL), next));
  };

  return (
    <div>
      <div className={styles.controlRow}>
        <span className={styles.metricLabel} title="Fill type — a gradient spans the whole text block">Fill</span>
        <select
          aria-label="Text Fill Type"
          className={styles.metricSelect}
          value={type}
          onChange={(e) => setType(e.target.value as TextFillType)}
        >
          <option value="solid">Solid</option>
          <option value="linear">Linear Gradient</option>
          <option value="radial">Radial Gradient</option>
        </select>
      </div>
      {gradient?.type === 'linear' && (
        <AnimatablePaintRow nodeId={nodeId} prop="fillAngle" label="Angle" access={ANGLE} />
      )}
      {gradient?.type === 'radial' && (
        <>
          <AnimatablePaintRow nodeId={nodeId} prop="fillCenterX" label="Center X" access={CX} />
          <AnimatablePaintRow nodeId={nodeId} prop="fillCenterY" label="Center Y" access={CY} />
          <AnimatablePaintRow nodeId={nodeId} prop="fillRadius" label="Radius" access={RADIUS} />
        </>
      )}
      {gradient && (
        <>
          <button
            type="button"
            className={styles.metricToggle}
            data-active={armed}
            aria-pressed={armed}
            title={armed ? 'Put the gradient handles away (Escape)' : 'Drag the gradient axis and stops on the canvas'}
            onClick={() => (armed ? disarm() : arm(nodeId, 0))}
          >
            <Icon name="gradient" size="sm" />
            <span>{armed ? 'Editing on canvas' : 'Edit on canvas'}</span>
          </button>
          <StopList nodeId={nodeId} paint={gradient} />
        </>
      )}
    </div>
  );
}

/* eslint-disable design-system/no-hex-color */
const DEFAULT_TEXT_STROKE = '#000000';
/* eslint-enable design-system/no-hex-color */

type StrokeGradient = LinearFill | RadialFill;

/**
 * Text layer STROKE TYPE — Solid / Linear Gradient / Radial Gradient.
 *
 * The same paint model as the fill (`@core/paint/fill`), painted across the
 * whole text block in layer space (textGradient.ts), but stored on the Text
 * component as `strokePaint`: the text stroke's colour and width already live
 * there, and a text layer has no shape stroke (`fx.stroke`) to borrow. Solid
 * clears it — the Character panel's stroke swatch is the solid colour.
 *
 * Its geometry is keyframeable (`strokeAngle`, `strokeCenterX|Y`,
 * `strokeRadius` — the fill's four, mirrored) and editable on the canvas: the
 * gradient gizmo's Fill/Stroke chip, or "Edit on canvas" here, arms it on the
 * stroke.
 */
// The stroke gradient's geometry — the engine's `layer/strokeAngle` / … (the
// static value inside `Text.strokePaint`); this is the READ.
function strokeGeometry(prop: 'strokeAngle' | 'strokeCenterX' | 'strokeCenterY' | 'strokeRadius'): PropertyAccess {
  return {
    read: (id) => {
      const paint = mirrorTextStrokePaint(documentMirror(), id);
      if (!paint) return undefined;
      if (paint.type === 'linear') return prop === 'strokeAngle' ? paint.angle : undefined;
      return prop === 'strokeCenterX' ? paint.cx : prop === 'strokeCenterY' ? paint.cy : prop === 'strokeRadius' ? paint.radius : undefined;
    },
  };
}
const STROKE_ANGLE = strokeGeometry('strokeAngle');
const STROKE_CX = strokeGeometry('strokeCenterX');
const STROKE_CY = strokeGeometry('strokeCenterY');
const STROKE_RADIUS = strokeGeometry('strokeRadius');

export function TextStrokeRows({ nodeId, strokeColor }: { nodeId: string; strokeColor: string | undefined }): JSX.Element | null {
  const armedId = useGradientEditStore((s) => s.nodeId);
  const armedTarget = useGradientEditStore((s) => s.target);
  const arm = useGradientEditStore((s) => s.arm);
  const disarm = useGradientEditStore((s) => s.disarm);
  const engineEdit = useEngineEdit();
  // B4: this layer's tree (`text/strokePaint`) wakes the rows.
  useMirrorTree(nodeId);
  const m = documentMirror();
  if (!m.layer(nodeId) || !hasTextLayer(m, nodeId)) return null;
  const paint: StrokeGradient | undefined = mirrorTextStrokePaint(m, nodeId);
  const type: TextFillType = paint?.type ?? 'solid';
  const strokeArmed = armedId === nodeId && armedTarget === 'stroke';

  const write = (label: string, next: FillPaint | undefined): void => {
    // `text/strokePaint` (G1): the whole paint, one entry.
    // A stop colour drag is one gesture (the picker's press below).
    engineEdit.send(label, textStrokePaintCommands(nodeId, next));
  };
  const setType = (next: TextFillType): void => {
    if (next === type) return;
    write('Text Stroke Type', next === 'solid' ? undefined : convertFill(paint ?? solidFill(strokeColor ?? DEFAULT_TEXT_STROKE), next));
  };
  const patch = (label: string, fields: Partial<LinearFill> | Partial<RadialFill>): void => {
    if (paint) write(label, { ...paint, ...fields } as FillPaint);
  };
  const stops = paint ? sortedStops(paint.stops) : [];
  const setStops = (next: ColorStop[]): void => patch('Text Stroke Gradient Stops', { stops: next });

  return (
    <div>
      <div className={styles.controlRow}>
        <span className={styles.metricLabel} title="Stroke type — a gradient spans the whole text block">Stroke</span>
        <select
          aria-label="Text Stroke Type"
          className={styles.metricSelect}
          value={type}
          onChange={(e) => setType(e.target.value as TextFillType)}
        >
          <option value="solid">Solid</option>
          <option value="linear">Linear Gradient</option>
          <option value="radial">Radial Gradient</option>
        </select>
      </div>
      {/* Geometry is keyframeable — `strokeAngle` / `strokeCenterX|Y` /
          `strokeRadius`, the fill's four mirrored — through the same row the
          fill uses, so this and the timeline agree on units and keys. */}
      {paint?.type === 'linear' && (
        <AnimatablePaintRow nodeId={nodeId} prop="strokeAngle" label="Angle" access={STROKE_ANGLE} />
      )}
      {paint?.type === 'radial' && (
        <>
          <AnimatablePaintRow nodeId={nodeId} prop="strokeCenterX" label="Center X" access={STROKE_CX} />
          <AnimatablePaintRow nodeId={nodeId} prop="strokeCenterY" label="Center Y" access={STROKE_CY} />
          <AnimatablePaintRow nodeId={nodeId} prop="strokeRadius" label="Radius" access={STROKE_RADIUS} />
        </>
      )}
      {paint && (
        <button
          type="button"
          className={styles.metricToggle}
          data-active={strokeArmed}
          aria-pressed={strokeArmed}
          title={strokeArmed ? 'Put the gradient handles away (Escape)' : 'Drag the stroke gradient’s axis and stops on the canvas'}
          onClick={() => (strokeArmed ? disarm() : arm(nodeId, 0, 'stroke'))}
        >
          <Icon name="gradient" size="sm" />
          <span>{strokeArmed ? 'Editing on canvas' : 'Edit on canvas'}</span>
        </button>
      )}
      {paint && (
        <div className={styles.metricGrid}>
          {stops.map((s) => (
            <div key={s.id} className={styles.metricCell}>
              <span style={{ display: 'contents' }} {...engineEdit.press('Text Stroke Gradient Stops')}>
                <ColorPicker
                  value={s.color}
                  compact
                  aria-label="Stroke Gradient Stop Color"
                  onChange={(color) => setStops(stops.map((o) => (o.id === s.id ? { ...o, color } : o)))}
                />
              </span>
              <input
                type="number"
                aria-label="Stroke Gradient Stop Position"
                className={styles.metricInput}
                min="0"
                max="100"
                value={Math.round(s.offset * 100)}
                onChange={(e) => {
                  const offset = Math.max(0, Math.min(100, Number(e.target.value))) / 100;
                  setStops(stops.map((o) => (o.id === s.id ? { ...o, offset } : o)));
                }}
              />
              <span className={styles.metricUnit}>%</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export default TextFillRows;
