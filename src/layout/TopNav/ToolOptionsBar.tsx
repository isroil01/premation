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
import { useLayoutStore } from '@stores/layoutStore';
import { useSelectionStore } from '@stores/selectionStore';
import { documentMirror } from '@stores/documentMirror';
import { isPaintableLayer } from '@core/mirror/layerKinds';
import { removeLastPaintStroke } from '@core/engine/paintEdits';
import { ValueField } from '@components/ValueField';
import { ColorPicker } from '@components/ColorPicker';
import { Checkbox } from '@components/Checkbox';
import { PIN_KIND_CATALOG, PUPPET_PIN_ICONS } from './puppetPinTools';
import { ShapePaintOptions } from './ShapePaintOptions';
import { SHAPE_PAINT_TOOLS } from '@core/workspace/shapeToolPaint';
import { pinColor } from '@core/rig/puppet';
import { Icon } from '@components/Icon';
import { Badge } from '@components/Badge';
import { useViewportDisplayStore } from '@stores/viewportDisplayStore';
import { useRotoBrushStore } from '@stores/rotoBrushStore';
import { propagateRotoForward } from '@core/workspace/rotoBrushTool';
import { getTimelineController } from '@core/timeline/TimelineController';
import styles from './ToolOptionsBar.module.css';

/** The two things a roto stroke can mean, and how to say so. */
const ROTO_STROKE_KINDS = [
  { kind: 'fg', label: 'Foreground', hint: 'Paint over the subject to keep it.' },
  { kind: 'bg', label: 'Background', hint: 'Paint what to cut out. Alt while painting does this too.' },
] as const;

const BONE_MODES = [
  { id: 'draw', label: 'Draw', icon: 'bone', hint: 'Draw connected bones and branches.' },
  { id: 'pose', label: 'Pose', icon: 'move', hint: 'Pose bones, IK goals, poles, and controllers.' },
  { id: 'weights', label: 'Weights', icon: 'brush', hint: 'Bind artwork by painting bone influence.' },
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
  // Snap-to-pixel is a VIEWPORT mode, not a tool option, which is exactly
  // why its indicator belongs on the tool bar: it changes what every drag in
  // every tool produces.
  const snapToPixel = useViewportDisplayStore((s) => s.snapToPixel);
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
    // The layer's kind from the document mirror (B4).
    isPaintableLayer(documentMirror().layer(selectedIds[0]!));

  let content: React.ReactNode = null;
  if (activeTool === 'brush' || activeTool === 'paint' || activeTool === 'eraser') {
    content = (
      <>
        <Row label="Size">
          <ValueField value={drawToolOptions.brushSize} unit="px" min={1} max={activeTool === 'brush' ? 200 : 2500} onChange={(v) => set('brushSize', Number(v))} />
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
            {/* Only the Paint tool gets a Brush/Clone switch. Erasing is the
                Eraser tool's whole identity (Ctrl+B cycles all three), so there
                is no Erase checkbox here that could turn a brush into one. */}
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
            <Row label="Flow">
              <ValueField value={Math.round(paint.flow * 100)} unit="%" min={0} max={100} precision={0} onChange={(v) => paint.set({ flow: Number(v) / 100 })} />
            </Row>
            <Row label="Hardness">
              <ValueField value={Math.round(paint.hardness * 100)} unit="%" min={0} max={100} precision={0} onChange={(v) => paint.set({ hardness: Number(v) / 100 })} />
            </Row>
            {/* The full AE panels: Mode, Channels, Duration, Clone Options,
                the stroke list (Paint, Ctrl+8) and tips + dynamics (Brushes, Ctrl+9). */}
            <button type="button" className={styles.action} title="Paint panel (Ctrl+8)" onClick={() => useLayoutStore.getState().openPanel('paint')}>
              Paint…
            </button>
            <button type="button" className={styles.action} title="Brushes panel (Ctrl+9)" onClick={() => useLayoutStore.getState().openPanel('brushes')}>
              Brushes…
            </button>
            {/* AE's "Erase: Last Stroke Only", as a button rather than a mode —
                this is the one place a user would look for it. */}
            {activeTool === 'eraser' && (
              <button
                type="button"
                className={styles.action}
                title="Remove the most recent paint stroke on this layer"
                // Its own undo step (`removePaintStrokes`), like the stroke it removes.
                onClick={() => { void removeLastPaintStroke(selectedIds[0]!); }}
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
          <span className={`${styles.hint} ${styles.hintWarning}`}>
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
  } else if (activeTool === 'roto') {
    // ── VIEWPORT-ROTO-OPTIONS (unique anchor) ──────────────────────────
    content = <RotoOptions />;
  }

  // AE's toolbar Fill / Stroke beside the shape and pen tools — the paint the
  // NEXT drawn shape takes, after any options the tool already shows.
  if (SHAPE_PAINT_TOOLS.has(activeTool)) {
    content = (
      <>
        {content}
        <ShapePaintOptions />
      </>
    );
  }

  // The bar shows even with no per-tool content when snap-to-pixel is on: the
  // badge is a MODE indicator, and a mode that silently rounds every drag has
  // to be visible from the canvas, not only from a menu.
  if (!content && !snapToPixel) return null;
  return (
    <div className={styles.bar} role="toolbar" aria-label="Tool options">
      {content}
      {/* ── VIEWPORT-SNAP-BADGE (unique anchor) ─────────────────────────
          Pushed to the far end so it never moves as tool options change
          width — a mode light that jumps around is one you stop trusting. */}
      {snapToPixel && (
        <>
          <span className={styles.snapSpacer} />
          <Badge
            variant="info"
            size="sm"
            title="Positions and sizes round to whole pixels while dragging or nudging (Ctrl+Alt+Shift+P)"
          >
            <Icon name="magnet" size="sm" />
            Snap to Pixel
          </Badge>
        </>
      )}
    </div>
  );
}

/**
 * Roto Brush options: which side the brush paints, its width, the matte's
 * feather, and "propagate forward" — the tracker pass that carries the matte
 * from the playhead to the end of the work area.
 *
 * The strokes themselves are `Workspace/RotoBrushOverlay`; this is the row of
 * numbers that gesture needs and cannot hold.
 */
function RotoOptions(): JSX.Element {
  const kind = useRotoBrushStore((s) => s.kind);
  const setKind = useRotoBrushStore((s) => s.setKind);
  const size = useRotoBrushStore((s) => s.size);
  const featherPx = useRotoBrushStore((s) => s.featherPx);
  const strokes = useRotoBrushStore((s) => s.strokes);
  const busy = useRotoBrushStore((s) => s.busy);
  const progress = useRotoBrushStore((s) => s.progress);
  const nodeId = useRotoBrushStore((s) => s.nodeId);

  const canPropagate = !!nodeId && strokes.some((s) => s.kind === 'fg') && !busy;

  const propagate = (): void => {
    if (!nodeId) return;
    const store = useRotoBrushStore.getState();
    const controller = getTimelineController();
    const from = controller.currentSeconds;
    const wa = controller.getWorkArea();
    const to = wa ? wa.end : controller.durationSeconds;
    if (!(to > from)) {
      store.setStatus('Nothing ahead of the playhead to propagate into.');
      return;
    }
    store.setBusy(true, 0);
    store.setStatus('Propagating forward…');
    propagateRotoForward(nodeId, store.strokes, from, to, controller.fps, store.featherPx, (f) => {
      useRotoBrushStore.getState().setBusy(true, f);
    })
      .then(() => {
        useRotoBrushStore.getState().setStatus(null);
      })
      .catch((err: unknown) => {
        useRotoBrushStore.getState().setStatus(err instanceof Error ? err.message : 'Propagation failed.');
      })
      .finally(() => useRotoBrushStore.getState().setBusy(false));
  };

  return (
    <>
      <span className={styles.optLabel}>Roto</span>
      <div className={styles.kinds} role="group" aria-label="Roto brush stroke">
        {ROTO_STROKE_KINDS.map(({ kind: k, label, hint }) => (
          <button
            key={k}
            type="button"
            className={kind === k ? styles.kindActive : styles.kind}
            title={hint}
            aria-label={label}
            aria-pressed={kind === k}
            onClick={() => setKind(k)}
          >
            {label}
          </button>
        ))}
      </div>
      <Row label="Size">
        <ValueField value={size} unit="px" min={2} max={200} precision={0} onChange={(v) => useRotoBrushStore.getState().setSize(Number(v))} />
      </Row>
      <Row label="Feather">
        <ValueField value={featherPx} unit="px" min={0} max={64} precision={0} onChange={(v) => useRotoBrushStore.getState().setFeather(Number(v))} />
      </Row>
      <button
        type="button"
        className={styles.kind}
        disabled={!canPropagate}
        title="Track the matte forward from the playhead to the end of the work area"
        onClick={propagate}
      >
        <Icon name="skip-forward" size="sm" />
        {busy ? `Propagating ${Math.round(progress * 100)}%` : 'Propagate Forward'}
      </button>
    </>
  );
}

export default ToolOptionsBar;
