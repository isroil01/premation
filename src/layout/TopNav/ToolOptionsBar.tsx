/**
 * ToolOptionsBar — the contextual strip under the toolbar (AE's tool options).
 * Shows the ACTIVE tool's parameters: brush size/taper/pressure/color, pencil
 * width/color, polygon sides, star points/inner radius. Values live on the
 * engine's `drawToolOptions` singleton (the framework-free tools read it at
 * draw time); the local state mirror exists only to re-render the bar.
 */

import { useReducer } from 'react';
import { drawToolOptions } from '@motion/workspace';
import { useUIStore } from '@stores/uiStore';
import { usePaintStore } from '@stores/paintStore';
import { useSelectionStore } from '@stores/selectionStore';
import defaultSceneGraph from '@core/scene/DefaultSceneGraph';
import { isPaintableKind } from '@core/paint/paintCoords';
import { removeLastStroke } from '@core/paint/paintStrokes';
import { ValueField } from '@components/ValueField';
import { ColorPicker } from '@components/ColorPicker';
import { Checkbox } from '@components/Checkbox';
import { PIN_KIND_CATALOG, PUPPET_PIN_ICONS } from './puppetPinTools';
import { pinColor } from '@core/rig/puppet';
import { Icon } from '@components/Icon';
import styles from './ToolOptionsBar.module.css';

const BONE_MODES = [
  { id: 'draw', label: 'Draw', icon: 'bone', hint: 'Draw connected bones and branches.', color: '#f97316' },
  { id: 'pose', label: 'Pose', icon: 'move', hint: 'Pose bones, IK goals, poles, and controllers.', color: '#38bdf8' },
  { id: 'weights', label: 'Weights', icon: 'brush', hint: 'Bind artwork by painting bone influence.', color: '#ec4899' },
] as const;

function Row({ label, children }: { label: string; children: React.ReactNode }): JSX.Element {
  return (
    <label className={styles.opt}>
      <span className={styles.optLabel}>{label}</span>
      {children}
    </label>
  );
}

export function ToolOptionsBar(): JSX.Element | null {
  const activeTool = useUIStore((s) => s.activeTool);
  const puppetPinKind = useUIStore((s) => s.puppetPinKind);
  const setPuppetPinKind = useUIStore((s) => s.setPuppetPinKind);
  const boneRigMode = useUIStore((s) => s.boneRigMode);
  const setBoneRigMode = useUIStore((s) => s.setBoneRigMode);
  const boneWeightMode = useUIStore((s) => s.boneWeightMode);
  const setBoneWeightMode = useUIStore((s) => s.setBoneWeightMode);
  const boneBrushRadius = useUIStore((s) => s.boneBrushRadius);
  const setBoneBrushRadius = useUIStore((s) => s.setBoneBrushRadius);
  const selectedIds = useSelectionStore((s) => s.ids);
  const paint = usePaintStore();
  const [, bump] = useReducer((n: number) => n + 1, 0);
  const set = <K extends keyof typeof drawToolOptions>(key: K, value: (typeof drawToolOptions)[K]): void => {
    drawToolOptions[key] = value;
    bump();
  };
  // Paint is its own tool now, so this is no longer "the brush, if the cursor
  // happens to be over the selected layer" — it is simply whether the Paint tool
  // has somewhere to paint. Erase / opacity / hardness are meaningless without a
  // target layer, so they stay contextual.
  const paintingLayer =
    (activeTool === 'paint' || activeTool === 'eraser') &&
    selectedIds.length === 1 &&
    (() => {
      const n = defaultSceneGraph.getNode(selectedIds[0]!);
      return !!n && isPaintableKind(n);
    })();

  let content: React.ReactNode = null;
  if (activeTool === 'brush' || activeTool === 'paint' || activeTool === 'eraser') {
    content = (
      <>
        <Row label="Size">
          <ValueField value={drawToolOptions.brushSize} unit="px" min={1} max={200} onChange={(v) => set('brushSize', Number(v))} />
        </Row>
        {/* Taper and Pressure shape the freehand RIBBON's outline. A paint
            stroke is a polyline drawn at a constant width, so neither has
            anything to act on there — showing them would be two controls that
            do nothing, which is how the old shared bar read. */}
        {activeTool === 'brush' && (
          <>
            <Row label="Taper">
              <ValueField value={drawToolOptions.brushTaper} unit="%" min={0} max={100} onChange={(v) => set('brushTaper', Number(v))} />
            </Row>
            <Row label="Pressure">
              <Checkbox checked={drawToolOptions.brushPressure} onChange={() => set('brushPressure', !drawToolOptions.brushPressure)} title="Scale width by stylus pressure" />
            </Row>
          </>
        )}
        <Row label="Color">
          <ColorPicker compact value={drawToolOptions.brushColor} onChange={(hex) => set('brushColor', hex)} aria-label="Brush color" />
        </Row>
        {paintingLayer && (
          <>
            {/* Only the Paint tool gets a mode switch. Offering it under the
                ERASER would be a checkbox that turns the eraser into a brush —
                the exact hidden-mode confusion the tools were split to end. */}
            {activeTool === 'paint' && (
              <Row label="Erase">
                <Checkbox
                  checked={paint.mode === 'erase'}
                  onChange={() => paint.set({ mode: paint.mode === 'erase' ? 'paint' : 'erase' })}
                  title="Erase cuts holes in the layer instead of painting"
                />
              </Row>
            )}
            {activeTool === 'paint' && (
              <Row label="Clone">
                <Checkbox
                  checked={paint.mode === 'clone'}
                  onChange={() => paint.set({ mode: paint.mode === 'clone' ? 'paint' : 'clone' })}
                  title="Clone stamp — paints the layer's own content from an offset source. Alt-click the canvas to set the source."
                />
              </Row>
            )}
            <Row label="Opacity">
              <ValueField value={Math.round(paint.opacity * 100)} unit="%" min={0} max={100} precision={0} onChange={(v) => paint.set({ opacity: Number(v) / 100 })} />
            </Row>
            <Row label="Hardness">
              <ValueField value={Math.round(paint.hardness * 100)} unit="%" min={0} max={100} precision={0} onChange={(v) => paint.set({ hardness: Number(v) / 100 })} />
            </Row>
            {/* AE's "Erase: Last Stroke Only", as a button rather than a mode.
                `removeLastStroke` already existed with no caller — this is the
                one place a user would look for it. */}
            {activeTool === 'eraser' && (
              <button
                type="button"
                className={styles.action}
                title="Remove the most recent paint stroke on this layer"
                onClick={() => removeLastStroke(selectedIds[0]!)}
              >
                Undo last stroke
              </button>
            )}
          </>
        )}
      </>
    );
  } else if (activeTool === 'pencil' || activeTool === 'line') {
    content = (
      <>
        <Row label="Stroke">
          <ValueField value={drawToolOptions.pencilWidth} unit="px" min={1} max={100} onChange={(v) => set('pencilWidth', Number(v))} />
        </Row>
        <Row label="Color">
          <ColorPicker compact value={drawToolOptions.pencilColor} onChange={(hex) => set('pencilColor', hex)} aria-label="Stroke color" />
        </Row>
      </>
    );
  } else if (activeTool === 'polygon') {
    content = (
      <Row label="Sides">
        <ValueField value={drawToolOptions.polygonSides} min={3} max={12} precision={0} onChange={(v) => set('polygonSides', Math.round(Number(v)))} />
      </Row>
    );
  } else if (activeTool === 'star') {
    content = (
      <>
        <Row label="Points">
          <ValueField value={drawToolOptions.starPoints} min={3} max={12} precision={0} onChange={(v) => set('starPoints', Math.round(Number(v)))} />
        </Row>
        <Row label="Inner">
          <ValueField
            value={Math.round(drawToolOptions.starInnerRatio * 100)}
            unit="%"
            min={10}
            max={90}
            precision={0}
            onChange={(v) => set('starInnerRatio', Number(v) / 100)}
          />
        </Row>
      </>
    );
  } else if (activeTool === 'puppet-pin') {
    content = (
      <>
        <span className={styles.optLabel}>Pin</span>
        <div className={styles.kinds} role="group" aria-label="Puppet pin tool">
          {PIN_KIND_CATALOG.map((k) => {
            const active = puppetPinKind === k.kind;
            return (
              <button
                key={k.kind}
                type="button"
                className={active ? styles.kindActive : styles.kind}
                title={k.hint}
                aria-label={k.label}
                aria-pressed={active}
                onClick={() => setPuppetPinKind(k.kind)}
              >
                <span className={styles.kindSwatch} style={{ background: pinColor(k.kind) }} />
                <Icon name={PUPPET_PIN_ICONS[k.kind]} size="sm" />
                {k.short}
              </button>
            );
          })}
        </div>
      </>
    );
  } else if (activeTool === 'bone') {
    content = (
      <>
        <span className={styles.optLabel}>Bone</span>
        <div className={styles.kinds} role="group" aria-label="Bone workflow mode">
          {BONE_MODES.map((mode) => {
            const active = boneRigMode === mode.id;
            return (
              <button
                key={mode.id}
                type="button"
                className={active ? styles.kindActive : styles.kind}
                title={mode.hint}
                aria-pressed={active}
                onClick={() => setBoneRigMode(mode.id)}
              >
                <Icon name={mode.icon} size="sm" />
                <span>{mode.label}</span>
              </button>
            );
          })}
        </div>
        {boneRigMode === 'draw' && (
          <span className={styles.hint}>Drag to draw. Start on a joint to chain or branch. Esc cancels.</span>
        )}
        {boneRigMode === 'pose' && (
          <span className={styles.hint}>Drag bones or controllers. Auto-key controls whether a keyframe is created.</span>
        )}
        {boneRigMode === 'weights' && (
          <>
            <div className={styles.kinds} role="group" aria-label="Bone weight tool">
              {(
                [
                  { id: 'add', label: 'Add', icon: 'plus' },
                  { id: 'subtract', label: 'Subtract', icon: 'minus' },
                  { id: 'smooth', label: 'Smooth', icon: 'waves' },
                  { id: 'pick', label: 'Pick', icon: 'mouse-pointer' },
                ] as const
              ).map((tool) => (
                <button
                  key={tool.id}
                  type="button"
                  className={boneWeightMode === tool.id ? styles.kindActive : styles.kind}
                  aria-pressed={boneWeightMode === tool.id}
                  onClick={() => setBoneWeightMode(tool.id)}
                  style={{ display: 'flex', alignItems: 'center', gap: 4 }}
                >
                  <Icon name={tool.icon} size="sm" />
                  <span>{tool.label}</span>
                </button>
              ))}
            </div>
            {boneWeightMode !== 'pick' && (
              <Row label="Brush">
                <ValueField
                  value={boneBrushRadius}
                  unit="px"
                  min={4}
                  max={400}
                  onChange={(v) => setBoneBrushRadius(Number(v))}
                />
              </Row>
            )}
          </>
        )}
      </>
    );
  } else if (activeTool === 'mask-rect' || activeTool === 'mask-ellipse' || activeTool === 'mask-pen') {
    const ok = selectedIds.length === 1;
    content = (
      <>
        <span className={styles.optLabel}>Mask</span>
        <span className={styles.hint}>
          {activeTool === 'mask-rect'
            ? 'Drag a rectangle mask on the selected layer.'
            : activeTool === 'mask-ellipse'
              ? 'Drag an ellipse mask on the selected layer.'
              : 'Click to place mask points. Close the path to finish.'}
        </span>
        {!ok && (
          <span className={styles.hint} style={{ color: 'var(--color-warning, #ffb703)' }}>
            Select exactly one layer — mask tools need a target.
          </span>
        )}
        {ok && (
          <span className={styles.hint}>
            Edit modes, feather and opacity in Effects → Masks. Direct Select reshapes points.
          </span>
        )}
      </>
    );
  }

  if (!content) return null;
  return (
    <div className={styles.bar} role="toolbar" aria-label="Tool options">
      {content}
    </div>
  );
}

export default ToolOptionsBar;
