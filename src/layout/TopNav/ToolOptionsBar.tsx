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
import { ValueField } from '@components/ValueField';
import { ColorPicker } from '@components/ColorPicker';
import { Checkbox } from '@components/Checkbox';
import styles from './ToolOptionsBar.module.css';

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
  const selectedIds = useSelectionStore((s) => s.ids);
  const paint = usePaintStore();
  const [, bump] = useReducer((n: number) => n + 1, 0);
  const set = <K extends keyof typeof drawToolOptions>(key: K, value: (typeof drawToolOptions)[K]): void => {
    drawToolOptions[key] = value;
    bump();
  };
  // The Brush paints onto a single selected paintable layer (else it draws a
  // freehand shape) — only then are the paint-specific params (erase/opacity/
  // hardness) meaningful, so show them contextually.
  const paintingLayer =
    activeTool === 'brush' &&
    selectedIds.length === 1 &&
    (() => {
      const n = defaultSceneGraph.getNode(selectedIds[0]!);
      return !!n && isPaintableKind(n);
    })();

  let content: React.ReactNode = null;
  if (activeTool === 'brush') {
    content = (
      <>
        <Row label="Size">
          <ValueField value={drawToolOptions.brushSize} unit="px" min={1} max={200} onChange={(v) => set('brushSize', Number(v))} />
        </Row>
        <Row label="Taper">
          <ValueField value={drawToolOptions.brushTaper} unit="%" min={0} max={100} onChange={(v) => set('brushTaper', Number(v))} />
        </Row>
        <Row label="Pressure">
          <Checkbox checked={drawToolOptions.brushPressure} onChange={() => set('brushPressure', !drawToolOptions.brushPressure)} title="Scale width by stylus pressure" />
        </Row>
        <Row label="Color">
          <ColorPicker compact value={drawToolOptions.brushColor} onChange={(hex) => set('brushColor', hex)} aria-label="Brush color" />
        </Row>
        {paintingLayer && (
          <>
            <Row label="Erase">
              <Checkbox
                checked={paint.mode === 'erase'}
                onChange={() => paint.set({ mode: paint.mode === 'erase' ? 'paint' : 'erase' })}
                title="Erase cuts holes in the layer instead of painting"
              />
            </Row>
            <Row label="Opacity">
              <ValueField value={Math.round(paint.opacity * 100)} unit="%" min={0} max={100} precision={0} onChange={(v) => paint.set({ opacity: Number(v) / 100 })} />
            </Row>
            <Row label="Hardness">
              <ValueField value={Math.round(paint.hardness * 100)} unit="%" min={0} max={100} precision={0} onChange={(v) => paint.set({ hardness: Number(v) / 100 })} />
            </Row>
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
  }

  if (!content) return null;
  return (
    <div className={styles.bar} role="toolbar" aria-label="Tool options">
      {content}
    </div>
  );
}

export default ToolOptionsBar;
