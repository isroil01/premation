/**
 * Fill & Stroke controls (Prompt E2). Edits a layer's fill paint (solid /
 * linear / radial gradient with multi-stop) and its stroke (width, colour,
 * opacity, alignment, dashes, caps, joins). Writes route through the paint
 * modules → SceneGraph `fx` component → AnimationChanged (undoable, captured by
 * autosave/export), mirroring the Effects/Masks controls in this panel.
 */

import { Icon } from '@components/Icon';
import { ValueField } from '@components/ValueField';
import { ColorPicker } from '@components/ColorPicker';
import { Dropdown, type DropdownItem } from '@components/Dropdown';
import {
  getNodeFill,
  setNodeFill,
  convertFill,
  makeStop,
  sortedStops,
  type FillType,
  type FillPaint,
  type ColorStop,
} from '@core/paint/fill';
import {
  getNodeStroke,
  setNodeStroke,
  updateNodeStroke,
  defaultStroke,
  STROKE_ALIGNS,
  STROKE_CAPS,
  STROKE_JOINS,
} from '@core/paint/stroke';
import styles from './EffectsPanel.module.css';

const FILL_TYPES: ReadonlyArray<{ value: FillType; label: string }> = [
  { value: 'solid', label: 'Solid' },
  { value: 'linear', label: 'Linear' },
  { value: 'radial', label: 'Radial' },
];

function dropdownTrigger(label: string): JSX.Element {
  return (
    <button type="button" className={styles.blendTrigger}>
      {label}
      <Icon name="chevron-down" size={12} />
    </button>
  );
}

/** Editor for a gradient's stop list (shared by linear + radial). */
function StopList({ nodeId, paint }: { nodeId: string; paint: FillPaint }): JSX.Element | null {
  if (paint.type === 'solid') return null;
  const stops = sortedStops(paint.stops);
  const write = (next: ColorStop[]): void => setNodeFill(nodeId, { ...paint, stops: next });

  return (
    <div className={styles.list}>
      {stops.map((s, i) => (
        <div key={s.id} className={styles.stopRow}>
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
            className={styles.remove}
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
        className={styles.addChip}
        onClick={() => write([...stops, makeStop(0.5, '#888888')])}
      >
        <Icon name="plus" size={11} /> Add stop
      </button>
    </div>
  );
}

export function FillStrokeControls({ nodeId }: { nodeId: string }): JSX.Element {
  const fill = getNodeFill(nodeId) ?? { type: 'solid', color: '#2b7eff' };
  const stroke = getNodeStroke(nodeId);

  const fillTypeItems: DropdownItem[] = FILL_TYPES.map((t) => ({
    type: 'item',
    id: t.value,
    label: t.label,
    icon: t.value === fill.type ? 'check' : undefined,
    onSelect: () => setNodeFill(nodeId, convertFill(fill, t.value)),
  }));

  return (
    <>
      <div className={styles.sectionTitle}>Fill</div>
      <div className={styles.blendRow}>
        <span className={styles.blendLabel}>Type</span>
        <Dropdown placement="bottom-end" trigger={dropdownTrigger(
          FILL_TYPES.find((t) => t.value === fill.type)?.label ?? 'Solid',
        )} items={fillTypeItems} />
      </div>

      {fill.type === 'solid' ? (
        <div className={styles.blendRow}>
          <span className={styles.blendLabel}>Color</span>
          <ColorPicker value={fill.color} onChange={(color) => setNodeFill(nodeId, { type: 'solid', color })} aria-label="Fill color" />
        </div>
      ) : null}

      {fill.type === 'linear' ? (
        <div className={styles.maskControls}>
          <label className={styles.maskField}>
            <span>Angle</span>
            <ValueField value={fill.angle} precision={0} unit="°"
              onChange={(v) => setNodeFill(nodeId, { ...fill, angle: v })} aria-label="Gradient angle" />
          </label>
        </div>
      ) : null}

      {fill.type === 'radial' ? (
        <div className={styles.maskControls}>
          <label className={styles.maskField}>
            <span>Center X</span>
            <ValueField value={Math.round(fill.cx * 100)} min={0} max={100} precision={0} unit="%"
              onChange={(v) => setNodeFill(nodeId, { ...fill, cx: v / 100 })} aria-label="Radial center X" />
          </label>
          <label className={styles.maskField}>
            <span>Center Y</span>
            <ValueField value={Math.round(fill.cy * 100)} min={0} max={100} precision={0} unit="%"
              onChange={(v) => setNodeFill(nodeId, { ...fill, cy: v / 100 })} aria-label="Radial center Y" />
          </label>
          <label className={styles.maskField}>
            <span>Radius</span>
            <ValueField value={Math.round(fill.radius * 100)} min={1} max={200} precision={0} unit="%"
              onChange={(v) => setNodeFill(nodeId, { ...fill, radius: v / 100 })} aria-label="Radial radius" />
          </label>
        </div>
      ) : null}

      {fill.type !== 'solid' ? <StopList nodeId={nodeId} paint={fill} /> : null}

      <div className={styles.sectionTitle}>Stroke</div>
      <div className={styles.blendRow}>
        <span className={styles.blendLabel}>Stroke</span>
        <button
          type="button"
          className={stroke ? styles.invertOn : styles.blendTrigger}
          aria-pressed={!!stroke}
          onClick={() => setNodeStroke(nodeId, stroke ? undefined : defaultStroke())}
        >
          {stroke ? 'On' : 'Off'}
        </button>
      </div>

      {stroke ? (
        <>
          <div className={styles.blendRow}>
            <span className={styles.blendLabel}>Color</span>
            <ColorPicker value={stroke.color} onChange={(color) => updateNodeStroke(nodeId, { color })} aria-label="Stroke color" />
          </div>
          <div className={styles.maskControls}>
            <label className={styles.maskField}>
              <span>Width</span>
              <ValueField value={stroke.width} min={0} max={400} precision={1} unit="px"
                onChange={(v) => updateNodeStroke(nodeId, { width: v })} aria-label="Stroke width" />
            </label>
            <label className={styles.maskField}>
              <span>Opacity</span>
              <ValueField value={Math.round(stroke.opacity * 100)} min={0} max={100} precision={0} unit="%"
                onChange={(v) => updateNodeStroke(nodeId, { opacity: v / 100 })} aria-label="Stroke opacity" />
            </label>
          </div>
          <div className={styles.blendRow}>
            <span className={styles.blendLabel}>Align</span>
            <Dropdown placement="bottom-end" trigger={dropdownTrigger(
              STROKE_ALIGNS.find((a) => a.value === stroke.align)?.label ?? 'Center',
            )} items={STROKE_ALIGNS.map((a) => ({
              type: 'item', id: a.value, label: a.label,
              icon: a.value === stroke.align ? 'check' : undefined,
              onSelect: () => updateNodeStroke(nodeId, { align: a.value }),
            }))} />
          </div>
          <div className={styles.blendRow}>
            <span className={styles.blendLabel}>Cap</span>
            <Dropdown placement="bottom-end" trigger={dropdownTrigger(
              STROKE_CAPS.find((c) => c.value === stroke.cap)?.label ?? 'Butt',
            )} items={STROKE_CAPS.map((c) => ({
              type: 'item', id: c.value, label: c.label,
              icon: c.value === stroke.cap ? 'check' : undefined,
              onSelect: () => updateNodeStroke(nodeId, { cap: c.value }),
            }))} />
          </div>
          <div className={styles.blendRow}>
            <span className={styles.blendLabel}>Join</span>
            <Dropdown placement="bottom-end" trigger={dropdownTrigger(
              STROKE_JOINS.find((j) => j.value === stroke.join)?.label ?? 'Miter',
            )} items={STROKE_JOINS.map((j) => ({
              type: 'item', id: j.value, label: j.label,
              icon: j.value === stroke.join ? 'check' : undefined,
              onSelect: () => updateNodeStroke(nodeId, { join: j.value }),
            }))} />
          </div>
          <label className={styles.maskField}>
            <span>Dashes</span>
            <input
              className={styles.dashInput}
              type="text"
              value={stroke.dash.join(', ')}
              placeholder="e.g. 8, 4"
              onChange={(e) => updateNodeStroke(nodeId, {
                dash: e.currentTarget.value.split(',').map((n) => Number.parseFloat(n.trim())).filter((n) => Number.isFinite(n) && n >= 0),
              })}
              aria-label="Stroke dashes"
            />
          </label>
        </>
      ) : null}
    </>
  );
}

export default FillStrokeControls;
