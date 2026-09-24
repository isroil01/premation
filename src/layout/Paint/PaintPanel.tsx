/**
 * PaintPanel — AE's Paint panel (Ctrl+8).
 *
 * Tool (Brush / Clone Stamp / Eraser), colours, Opacity, Flow, Mode, Channels,
 * Duration, Erase mode and Clone Options, then the selected layer's strokes:
 * select one to redraw its Path, hide it (the timeline's video switch), key its
 * Path, delete it, and the layer's Paint On Transparent.
 *
 * Settings live on `paintStore` (diameter and foreground colour on the shared
 * `drawToolOptions`), so the compact Tool Options bar, this panel and the
 * Brushes panel stay one source.
 */

import { useReducer } from 'react';
import { drawToolOptions } from '@motion/workspace';
import { defaultAnimation } from '@motion/animation';
import defaultSceneGraph from '@core/scene/DefaultSceneGraph';
import { activeCompRootId } from '@core/scene/activeComp';
import { isPaintableKind } from '@core/paint/paintCoords';
import { paintPathProp } from '@core/paint/paintProps';
import {
  getNodePaint,
  removePaintStroke,
  setPaintOnTransparent,
  strokeDisplayNames,
  toggleStrokePathAnimation,
  updatePaintStroke,
  type EraseMode,
  type PaintBlend,
  type PaintChannels,
} from '@core/paint/paintStrokes';
import type { PaintDuration } from '@core/paint/paintCapture';
import { runDocumentEdit } from '@core/commands/documentEdit';
import { getRemappedTime, getTimelineController } from '@core/timeline/TimelineController';
import { usePaintStore } from '@stores/paintStore';
import { useSelectionStore } from '@stores/selectionStore';
import { useSceneRevision } from '@stores/sceneStore';
import { useUIStore } from '@stores/uiStore';
import { ValueField } from '@components/ValueField';
import { ColorPicker } from '@components/ColorPicker';
import { Checkbox } from '@components/Checkbox';
import { Segmented } from '@components/Segmented';
import { Icon } from '@components/Icon';
import { currentPaintTool, setPaintTool, type PaintToolKind } from './paintTool';
import styles from './Paint.module.css';

export const PAINT_BLENDS: ReadonlyArray<{ value: PaintBlend; label: string }> = [
  { value: 'normal', label: 'Normal' },
  { value: 'darken', label: 'Darken' },
  { value: 'multiply', label: 'Multiply' },
  { value: 'color-burn', label: 'Color Burn' },
  { value: 'add', label: 'Add' },
  { value: 'lighten', label: 'Lighten' },
  { value: 'screen', label: 'Screen' },
  { value: 'color-dodge', label: 'Color Dodge' },
  { value: 'overlay', label: 'Overlay' },
  { value: 'soft-light', label: 'Soft Light' },
  { value: 'hard-light', label: 'Hard Light' },
  { value: 'difference', label: 'Difference' },
  { value: 'exclusion', label: 'Exclusion' },
  { value: 'hue', label: 'Hue' },
  { value: 'saturation', label: 'Saturation' },
  { value: 'color', label: 'Color' },
  { value: 'luminosity', label: 'Luminosity' },
];

const CHANNELS: ReadonlyArray<{ value: PaintChannels; label: string }> = [
  { value: 'rgba', label: 'RGBA' },
  { value: 'rgb', label: 'RGB' },
  { value: 'alpha', label: 'Alpha' },
];

const DURATIONS: ReadonlyArray<{ value: PaintDuration; label: string }> = [
  { value: 'constant', label: 'Constant' },
  { value: 'writeOn', label: 'Write On' },
  { value: 'single', label: 'Single Frame' },
  { value: 'custom', label: 'Custom' },
];

const ERASE_MODES: ReadonlyArray<{ value: EraseMode; label: string }> = [
  { value: 'layerAndPaint', label: 'Layer Source & Paint' },
  { value: 'paintOnly', label: 'Paint Only' },
  { value: 'lastStroke', label: 'Last Stroke Only' },
];

const TOOLS: ReadonlyArray<{ value: PaintToolKind; label: string }> = [
  { value: 'brush', label: 'Brush' },
  { value: 'clone', label: 'Clone' },
  { value: 'eraser', label: 'Eraser' },
];

function Row({ label, children }: { label: string; children: React.ReactNode }): JSX.Element {
  return (
    <label className={styles.row}>
      <span className={styles.rowLabel}>{label}</span>
      {children}
    </label>
  );
}

function Select<V extends string>({ value, options, onChange, label }: {
  value: V;
  options: ReadonlyArray<{ value: V; label: string }>;
  onChange: (v: V) => void;
  label: string;
}): JSX.Element {
  return (
    <select className={styles.select} aria-label={label} value={value} onChange={(e) => onChange(e.target.value as V)}>
      {options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
    </select>
  );
}

const pct = (v: number): number => Math.round(v * 1000) / 10;

export function PaintPanel(): JSX.Element {
  const paint = usePaintStore();
  const activeTool = useUIStore((s) => s.activeTool);
  const selectedIds = useSelectionStore((s) => s.ids);
  useSceneRevision((s) => s.rev);
  const [, bump] = useReducer((n: number) => n + 1, 0);

  const tool = currentPaintTool();
  const layerId = selectedIds.length === 1 ? selectedIds[0]! : null;
  const layer = layerId ? defaultSceneGraph.getNode(layerId) : undefined;
  const paintable = !!layer && isPaintableKind(layer);
  const cfg = layerId ? getNodePaint(layerId) : null;
  const names = cfg ? strokeDisplayNames(cfg.strokes) : new Map<string, string>();
  const compLayers = defaultSceneGraph.getChildren(activeCompRootId()).filter((n) => isPaintableKind(n));

  const layerTime = (): number => (layerId ? getRemappedTime(layerId, getTimelineController().currentSeconds) : 0);

  return (
    <div className={styles.panelRoot} aria-label="Paint">
      <div className={styles.group}>
        <Segmented
          size="sm"
          fullWidth
          aria-label="Paint tool"
          options={TOOLS}
          value={tool ?? (activeTool === 'eraser' ? 'eraser' : 'brush')}
          onChange={(v) => setPaintTool(v)}
        />
        {!tool && <span className={styles.hint}>Pick a paint tool (Ctrl+B cycles them) to paint on the selected layer.</span>}
      </div>

      <div className={styles.group}>
        <div className={styles.inline}>
          <ColorPicker compact value={drawToolOptions.brushColor} aria-label="Foreground color" onChange={(hex) => { drawToolOptions.brushColor = hex; bump(); }} />
          <ColorPicker compact value={paint.backgroundColor} aria-label="Background color" onChange={(hex) => paint.set({ backgroundColor: hex })} />
          <button type="button" className={styles.iconButton} title="Swap colors (X)" aria-label="Swap colors" onClick={() => { paint.swapColors(); bump(); }}>
            <Icon name="refresh" size="sm" />
          </button>
          <button type="button" className={styles.button} title="Default colors (D)" onClick={() => { paint.resetColors(); bump(); }}>
            Default
          </button>
        </div>
        <Row label="Opacity">
          <ValueField value={pct(paint.opacity)} unit="%" min={0} max={100} precision={1} onChange={(v) => paint.set({ opacity: Number(v) / 100 })} />
        </Row>
        <Row label="Flow">
          <ValueField value={pct(paint.flow)} unit="%" min={0} max={100} precision={1} onChange={(v) => paint.set({ flow: Number(v) / 100 })} />
        </Row>
        <Row label="Mode">
          <Select label="Mode" value={paint.blend} options={PAINT_BLENDS} onChange={(v) => paint.set({ blend: v })} />
        </Row>
        <Row label="Channels">
          <Select label="Channels" value={paint.channels} options={CHANNELS} onChange={(v) => paint.set({ channels: v })} />
        </Row>
        <Row label="Duration">
          <div className={styles.inline}>
            <Select label="Duration" value={paint.duration} options={DURATIONS} onChange={(v) => paint.set({ duration: v })} />
            {paint.duration === 'custom' && (
              <ValueField value={paint.customFrames} unit="f" min={1} max={100000} precision={0} aria-label="Duration frames" onChange={(v) => paint.set({ customFrames: Math.max(1, Math.round(Number(v))) })} />
            )}
          </div>
        </Row>
        {tool === 'eraser' && (
          <Row label="Erase">
            <Select label="Erase" value={paint.eraseMode} options={ERASE_MODES} onChange={(v) => paint.set({ eraseMode: v })} />
          </Row>
        )}
      </div>

      {tool === 'clone' && (
        <div className={styles.group}>
          <span className={styles.groupLabel}>Clone Options</span>
          <div className={styles.inline} role="group" aria-label="Clone presets">
            {paint.clonePresets.map((_, i) => (
              <button
                key={i}
                type="button"
                className={paint.activeClonePreset === i ? styles.buttonActive : styles.button}
                aria-pressed={paint.activeClonePreset === i}
                title={`Clone preset ${i + 1} (${i + 3})`}
                onClick={() => paint.selectClonePreset(i)}
              >
                {i + 1}
              </button>
            ))}
          </div>
          <Row label="Source">
            <select
              className={styles.select}
              aria-label="Clone source layer"
              value={paint.cloneSourceLayerId ?? ''}
              onChange={(e) => paint.set({ cloneSourceLayerId: e.target.value || null, cloneSource: null, alignedOffset: null })}
            >
              <option value="">Current Layer</option>
              {compLayers.map((n) => <option key={n.id} value={n.id}>{n.name}</option>)}
            </select>
          </Row>
          <Checkbox label="Aligned" checked={paint.cloneAligned} onChange={() => paint.set({ cloneAligned: !paint.cloneAligned, alignedOffset: null })} />
          <Checkbox label="Lock Source Time" checked={paint.cloneLockTime} onChange={() => paint.set({ cloneLockTime: !paint.cloneLockTime })} />
          {paint.cloneLockTime ? (
            <Row label="Source Time">
              <ValueField value={paint.cloneSourceTime} unit="s" step={0.01} precision={2} onChange={(v) => paint.set({ cloneSourceTime: Number(v) })} />
            </Row>
          ) : (
            <Row label="Source Time Shift">
              <ValueField value={paint.cloneTimeShift} unit="s" step={0.01} precision={2} onChange={(v) => paint.set({ cloneTimeShift: Number(v) })} />
            </Row>
          )}
          <Row label="Offset">
            <div className={styles.inline}>
              <span className={styles.hint}>
                {paint.alignedOffset
                  ? `${Math.round(paint.alignedOffset.x)}, ${Math.round(paint.alignedOffset.y)}`
                  : paint.cloneSource ? 'set on first stroke' : 'Alt-click to set source'}
              </span>
              <button type="button" className={styles.button} disabled={!paint.alignedOffset && !paint.cloneSource} onClick={() => paint.set({ alignedOffset: null, cloneSource: null })}>
                Reset
              </button>
            </div>
          </Row>
          <Checkbox label="Clone Source Overlay" checked={paint.cloneOverlay} onChange={() => paint.set({ cloneOverlay: !paint.cloneOverlay })} />
          {paint.cloneOverlay && (
            <>
              <Row label="Overlay Opacity">
                <ValueField value={pct(paint.cloneOverlayOpacity)} unit="%" min={0} max={100} precision={0} onChange={(v) => paint.set({ cloneOverlayOpacity: Number(v) / 100 })} />
              </Row>
              <Checkbox label="Difference" checked={paint.cloneOverlayDifference} onChange={() => paint.set({ cloneOverlayDifference: !paint.cloneOverlayDifference })} />
            </>
          )}
        </div>
      )}

      <div className={styles.group}>
        <span className={styles.groupLabel}>Strokes{layer ? ` — ${layer.name}` : ''}</span>
        {!layerId && <span className={styles.hint}>Select one layer to see its paint.</span>}
        {layerId && !paintable && <span className={styles.hint}>This layer cannot be painted on.</span>}
        {layerId && paintable && (!cfg || cfg.strokes.length === 0) && <span className={styles.hint}>No strokes yet.</span>}
        {layerId && cfg && cfg.strokes.length > 0 && (
          <>
            <div className={styles.strokeList} role="listbox" aria-label="Paint strokes">
              {cfg.strokes.map((s) => {
                const selected = paint.selectedStroke?.nodeId === layerId && paint.selectedStroke.strokeId === s.id;
                const keyed = defaultAnimation.isDataAnimated(layerId, paintPathProp(s.id));
                return (
                  <div
                    key={s.id}
                    role="option"
                    aria-selected={selected}
                    className={selected ? styles.strokeRowSelected : styles.strokeRow}
                    onClick={() => paint.set({ selectedStroke: selected ? null : { nodeId: layerId, strokeId: s.id } })}
                  >
                    <button
                      type="button"
                      className={styles.iconButton}
                      aria-label={s.visible === false ? 'Show stroke' : 'Hide stroke'}
                      title="Video switch"
                      onClick={(e) => {
                        e.stopPropagation();
                        // B3-legacy: engine gap — paint strokes are not an API group, so a stroke's
                        // video switch (visible) has no address (`setGroupEnabled` does not take paint).
                        runDocumentEdit(s.visible === false ? 'Show Paint Stroke' : 'Hide Paint Stroke', () =>
                          updatePaintStroke(layerId, s.id, { visible: s.visible === false ? undefined : false }));
                      }}
                    >
                      <Icon name={s.visible === false ? 'eye-off' : 'eye'} size="sm" />
                    </button>
                    <span>{names.get(s.id)}</span>
                    <button
                      type="button"
                      className={styles.iconButton}
                      aria-label={keyed ? 'Stop animating path' : 'Animate path'}
                      aria-pressed={keyed}
                      title={keyed ? 'Path is keyframed — click to remove its keyframes' : 'Key the Path at the current time'}
                      onClick={(e) => {
                        e.stopPropagation();
                        // B3-legacy: engine gap — ON could be `addKeyframes` with the stroke's points, but
                        // OFF cannot: once the Path is keyed, `catalogFor` binds `paint/<id>/path` as a scalar
                        // member row (propertyTree's paintRows lists the keyed data track as a member), so
                        // `setAnimated{false}` is a silent no-op, `setProperty{time}` answers typeMismatch and
                        // `getKeyframes` returns none. Both halves stay here until the binding is fixed.
                        runDocumentEdit(keyed ? 'Disable Path Animation' : 'Enable Path Animation', () =>
                          toggleStrokePathAnimation(layerId, s.id, layerTime()));
                      }}
                    >
                      <Icon name={keyed ? 'keyframe' : 'stopwatch'} size="sm" />
                    </button>
                    <button
                      type="button"
                      className={styles.iconButton}
                      aria-label="Delete stroke"
                      onClick={(e) => {
                        e.stopPropagation();
                        if (selected) paint.set({ selectedStroke: null });
                        // B3-legacy: engine gap — `removePropertyGroups` does not take paint strokes.
                        runDocumentEdit('Delete Paint Stroke', () => removePaintStroke(layerId, s.id));
                      }}
                    >
                      <Icon name="trash" size="sm" />
                    </button>
                  </div>
                );
              })}
            </div>
            {paint.selectedStroke?.nodeId === layerId && (
              <span className={styles.hint}>Drawing now replaces the selected stroke's Path. Click it again to deselect.</span>
            )}
            <Checkbox
              label="Paint on Transparent"
              checked={cfg.onTransparent === true}
              onChange={() => {
                // B3-legacy: engine gap — Paint on Transparent is a layer paint setting with no API
                // property (`paint/onTransparent` is not in the catalog).
                runDocumentEdit('Paint on Transparent', () => setPaintOnTransparent(layerId, cfg.onTransparent !== true));
              }}
            />
          </>
        )}
      </div>
    </div>
  );
}

export default PaintPanel;
