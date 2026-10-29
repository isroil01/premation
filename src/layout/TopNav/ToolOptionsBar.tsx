/**
 * ToolOptionsBar — the contextual strip under the toolbar (AE's tool options).
 * Shows the ACTIVE tool's parameters: brush size/taper/pressure/color, pencil
 * width/color, polygon sides, star points/inner radius. Values live on the
 * engine's `drawToolOptions` singleton (the framework-free tools read it at
 * draw time); the local state mirror exists only to re-render the bar.
 */

import { useCallback, useReducer, useState } from 'react';
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
import { Popover } from '@components/Popover';
import { useViewportDisplayStore } from '@stores/viewportDisplayStore';
import { useRotoBrushStore } from '@stores/rotoBrushStore';
import { activeSubjectId } from '@stores/subjectStore';
import { propagateObjectMatte, propagateRotoForward, rotoFreezeEdit, rotoMattes } from '@core/workspace/rotoBrushTool';
import { edit } from '@core/engine/uiEdits';
import { useMirrorTree } from '@hooks/useMirror';
import { mirrorMaskHeaders } from '@core/mirror/effects';
import { playheadSeconds } from '@core/timeline/timelineView';
import { settingsDurationSeconds, settingsFps, settingsSetWorkArea } from '@core/mirror/compFacts';
import { activeCompSettingsNow } from '@hooks/useMirrorFrame';
import { explainObjectMatteError } from '@core/tracking/samModelInstall';
import { objectMatteCard } from '@core/workspace/objectMatteEffect';
import { offerObjectMatteDownload } from '@layout/Settings/objectMatteJob';
import { t } from '@core/i18n';
import styles from './ToolOptionsBar.module.css';

/** The two things a roto stroke can mean, and how to say so. A function: `t()` runs at render time. */
const rotoStrokeKinds = () => [
  { kind: 'fg', label: t('topNav.toolOptions.rotoForeground', 'Foreground'), hint: t('topNav.toolOptions.rotoForegroundHint', 'Paint over the subject to keep it.') },
  { kind: 'bg', label: t('topNav.toolOptions.rotoBackground', 'Background'), hint: t('topNav.toolOptions.rotoBackgroundHint', 'Paint what to cut out. Alt while painting does this too.') },
] as const;

const boneModes = () => [
  { id: 'draw', label: t('topNav.toolOptions.boneDraw', 'Draw'), icon: 'bone', hint: t('topNav.toolOptions.boneDrawHint', 'Draw connected bones and branches.') },
  { id: 'pose', label: t('topNav.toolOptions.bonePose', 'Pose'), icon: 'move', hint: t('topNav.toolOptions.bonePoseHint', 'Pose bones, IK goals, poles, and controllers.') },
  { id: 'weights', label: t('topNav.toolOptions.boneWeights', 'Weights'), icon: 'brush', hint: t('topNav.toolOptions.boneWeightsHint', 'Bind artwork by painting bone influence.') },
] as const;

function Row({ label, children }: { label: string; children: React.ReactNode }): JSX.Element {
  return (
    <label className={styles.opt}>
      <span className={styles.optLabel}>{label}</span>
      {children}
    </label>
  );
}

export interface ToolOptionsBarProps {
  /**
   * Draw as a run inside the tool row (no strip of its own: no height, fill or
   * rule) — see TopNav. Without it, the standalone strip under a toolbar.
   */
  inline?: boolean;
}

/**
 * The strip scrolls sideways with its scrollbar hidden (a scrollbar would add
 * height to a 30 px row), so a vertical wheel has to scroll it — otherwise
 * options past the edge are reachable only by Tab.
 */
function onBarWheel(e: WheelEvent): void {
  const el = e.currentTarget as HTMLElement;
  if (el.scrollWidth <= el.clientWidth || Math.abs(e.deltaX) > Math.abs(e.deltaY)) return;
  if ((e.target as HTMLElement).closest('input')) return;
  el.scrollLeft += e.deltaY;
  e.preventDefault();
}

export function ToolOptionsBar({ inline = false }: ToolOptionsBarProps = {}): JSX.Element | null {
  const barClass = inline ? styles.barInline : styles.bar;
  const wheelScrollRef = useCallback((el: HTMLDivElement | null) => {
    el?.addEventListener('wheel', onBarWheel, { passive: false });
  }, []);
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
        <Row label={t('topNav.toolOptions.size', 'Size')}>
          <ValueField value={drawToolOptions.brushSize} unit="px" min={1} max={activeTool === 'brush' ? 200 : 2500} onChange={(v) => set('brushSize', Number(v))} />
        </Row>
        {/* Taper and Pressure shape the freehand RIBBON's outline. A paint
            stroke is a polyline drawn at a constant width, so neither has
            anything to act on there — showing them would be two controls that
            do nothing, which is how the old shared bar read. */}
        {activeTool === 'brush' && (
          <>
            <Row label={t('topNav.toolOptions.taper', 'Taper')}>
              <ValueField value={drawToolOptions.brushTaper} unit="%" min={0} max={100} onChange={(v) => set('brushTaper', Number(v))} />
            </Row>
            <Row label={t('topNav.toolOptions.pressure', 'Pressure')}>
              <Checkbox checked={drawToolOptions.brushPressure} onChange={() => set('brushPressure', !drawToolOptions.brushPressure)} title={t('topNav.toolOptions.pressureTitle', 'Scale width by stylus pressure')} />
            </Row>
          </>
        )}
        <Row label={t('topNav.toolOptions.color', 'Color')}>
          <ColorPicker compact value={drawToolOptions.brushColor} onChange={(hex) => set('brushColor', hex)} aria-label={t('topNav.toolOptions.brushColor', 'Brush color')} />
        </Row>
        {paintingLayer && (
          <>
            {/* Only the Paint tool gets a Brush/Clone switch. Erasing is the
                Eraser tool's whole identity (Ctrl+B cycles all three), so there
                is no Erase checkbox here that could turn a brush into one. */}
            {activeTool === 'paint' && (
              <Row label={t('topNav.toolOptions.clone', 'Clone')}>
                <Checkbox
                  checked={paint.mode === 'clone'}
                  onChange={() => paint.set({ mode: paint.mode === 'clone' ? 'paint' : 'clone' })}
                  title={t('topNav.toolOptions.cloneTitle', "Clone stamp — paints the layer's own content from an offset source. Alt-click the canvas to set the source.")}
                />
              </Row>
            )}
            <Row label={t('topNav.toolOptions.opacity', 'Opacity')}>
              <ValueField value={Math.round(paint.opacity * 100)} unit="%" min={0} max={100} precision={0} onChange={(v) => paint.set({ opacity: Number(v) / 100 })} />
            </Row>
            <Row label={t('topNav.toolOptions.flow', 'Flow')}>
              <ValueField value={Math.round(paint.flow * 100)} unit="%" min={0} max={100} precision={0} onChange={(v) => paint.set({ flow: Number(v) / 100 })} />
            </Row>
            <Row label={t('topNav.toolOptions.hardness', 'Hardness')}>
              <ValueField value={Math.round(paint.hardness * 100)} unit="%" min={0} max={100} precision={0} onChange={(v) => paint.set({ hardness: Number(v) / 100 })} />
            </Row>
            {/* The full AE panels: Mode, Channels, Duration, Clone Options,
                the stroke list (Paint, Ctrl+8) and tips + dynamics (Brushes, Ctrl+9). */}
            <button type="button" className={styles.action} title={t('topNav.toolOptions.paintPanelTitle', 'Paint panel ({chord})', { chord: 'Ctrl+8' })} onClick={() => useLayoutStore.getState().openPanel('paint')}>
              {t('topNav.toolOptions.paintPanel', 'Paint…')}
            </button>
            <button type="button" className={styles.action} title={t('topNav.toolOptions.brushesPanelTitle', 'Brushes panel ({chord})', { chord: 'Ctrl+9' })} onClick={() => useLayoutStore.getState().openPanel('brushes')}>
              {t('topNav.toolOptions.brushesPanel', 'Brushes…')}
            </button>
            {/* AE's "Erase: Last Stroke Only", as a button rather than a mode —
                this is the one place a user would look for it. */}
            {activeTool === 'eraser' && (
              <button
                type="button"
                className={styles.action}
                title={t('topNav.toolOptions.undoStrokeTitle', 'Remove the most recent paint stroke on this layer')}
                // Its own undo step (`removePaintStrokes`), like the stroke it removes.
                onClick={() => { void removeLastPaintStroke(selectedIds[0]!); }}
              >
                {t('topNav.toolOptions.undoStroke', 'Undo last stroke')}
              </button>
            )}
          </>
        )}
      </>
    );
  } else if (activeTool === 'pencil' || activeTool === 'line') {
    content = (
      <>
        <Row label={t('topNav.toolOptions.stroke', 'Stroke')}>
          <ValueField value={drawToolOptions.pencilWidth} unit="px" min={1} max={100} onChange={(v) => set('pencilWidth', Number(v))} />
        </Row>
        <Row label={t('topNav.toolOptions.color', 'Color')}>
          <ColorPicker compact value={drawToolOptions.pencilColor} onChange={(hex) => set('pencilColor', hex)} aria-label={t('topNav.toolOptions.strokeColor', 'Stroke color')} />
        </Row>
      </>
    );
  } else if (activeTool === 'polygon') {
    content = (
      <Row label={t('topNav.toolOptions.sides', 'Sides')}>
        <ValueField value={drawToolOptions.polygonSides} min={3} max={12} precision={0} onChange={(v) => set('polygonSides', Math.round(Number(v)))} />
      </Row>
    );
  } else if (activeTool === 'star') {
    content = (
      <>
        <Row label={t('topNav.toolOptions.points', 'Points')}>
          <ValueField value={drawToolOptions.starPoints} min={3} max={12} precision={0} onChange={(v) => set('starPoints', Math.round(Number(v)))} />
        </Row>
        <Row label={t('topNav.toolOptions.inner', 'Inner')}>
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
        <span className={styles.optLabel}>{t('topNav.toolOptions.pin', 'Pin')}</span>
        <div className={styles.kinds} role="group" aria-label={t('topNav.toolOptions.pinGroup', 'Puppet pin tool')}>
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
        <span className={styles.optLabel}>{t('topNav.toolOptions.bone', 'Bone')}</span>
        <div className={styles.kinds} role="group" aria-label={t('topNav.toolOptions.boneModeGroup', 'Bone workflow mode')}>
          {boneModes().map((mode) => {
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
          <span className={styles.hint}>{t('topNav.toolOptions.boneDrawTip', 'Drag to draw. Start on a joint to chain or branch. Esc cancels.')}</span>
        )}
        {boneRigMode === 'pose' && (
          <span className={styles.hint}>{t('topNav.toolOptions.bonePoseTip', 'Drag bones or controllers. Auto-key controls whether a keyframe is created.')}</span>
        )}
        {boneRigMode === 'weights' && (
          <>
            <div className={styles.kinds} role="group" aria-label={t('topNav.toolOptions.boneWeightGroup', 'Bone weight tool')}>
              {(
                [
                  { id: 'add', label: t('topNav.toolOptions.weightAdd', 'Add'), icon: 'plus' },
                  { id: 'subtract', label: t('topNav.toolOptions.weightSubtract', 'Subtract'), icon: 'minus' },
                  { id: 'smooth', label: t('topNav.toolOptions.weightSmooth', 'Smooth'), icon: 'waves' },
                  { id: 'pick', label: t('topNav.toolOptions.weightPick', 'Pick'), icon: 'mouse-pointer' },
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
              <Row label={t('topNav.toolOptions.brush', 'Brush')}>
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
        <span className={styles.optLabel}>{t('topNav.toolOptions.mask', 'Mask')}</span>
        <span className={styles.hint}>
          {activeTool === 'mask-rect'
            ? t('topNav.toolOptions.maskRectHint', 'Drag a rectangle mask on the selected layer.')
            : activeTool === 'mask-ellipse'
              ? t('topNav.toolOptions.maskEllipseHint', 'Drag an ellipse mask on the selected layer.')
              : t('topNav.toolOptions.maskPenHint', 'Click to place mask points. Close the path to finish.')}
        </span>
        {!ok && (
          <span className={`${styles.hint} ${styles.hintWarning}`}>
            {t('topNav.toolOptions.maskNeedsTarget', 'Select exactly one layer — mask tools need a target.')}
          </span>
        )}
        {ok && (
          <span className={styles.hint}>
            {t('topNav.toolOptions.maskEditTip', 'Edit modes, feather and opacity in Effects → Masks. Direct Select reshapes points.')}
          </span>
        )}
      </>
    );
  } else if (activeTool === 'roto' || activeTool === 'object-matte' || activeTool === 'selection-brush' || activeTool === 'refine-edge') {
    // ── VIEWPORT-ROTO-OPTIONS (unique anchor) ──────────────────────────
    // The Object Matte group: one options row; the brushes show their size.
    content = (
      <RotoOptions
        objectMatteTool={activeTool === 'object-matte'}
        brush={activeTool === 'selection-brush' ? 'exact' : activeTool === 'refine-edge' ? 'refine' : undefined}
      />
    );
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
  // With nothing to show the row STAYS, empty: it used to unmount, so picking a
  // tool with options (the shape tools) and going back to Selection moved the
  // viewport 30 px each time, and the viewport's auto-fit re-zoomed the comp by
  // ~6 % (0.477 ↔ 0.505 at 1920×1080 in a 998 px stage). A shape drawn at one
  // zoom then showed at the other — larger or smaller than the drag that made
  // it. AE's tool options never move the Composition panel either.
  if (!content && !snapToPixel) return <div className={barClass} aria-hidden="true" data-tool-options-empty="" />;
  return (
    <div className={barClass} role="toolbar" aria-label={t('topNav.toolOptions.aria', 'Tool options')} ref={wheelScrollRef}>
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
            title={t('topNav.toolOptions.snapToPixelTitle', 'Positions and sizes round to whole pixels while dragging or nudging ({chord})', { chord: 'Ctrl+Alt+Shift+P' })}
          >
            <Icon name="magnet" size="sm" />
            {t('topNav.toolOptions.snapToPixel', 'Snap to Pixel')}
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
function RotoOptions({ objectMatteTool = false, brush }: { objectMatteTool?: boolean; brush?: 'exact' | 'refine' }): JSX.Element {
  const kind = useRotoBrushStore((s) => s.kind);
  const setKind = useRotoBrushStore((s) => s.setKind);
  const size = useRotoBrushStore((s) => s.size);
  const featherPx = useRotoBrushStore((s) => s.featherPx);
  const strokes = useRotoBrushStore((s) => s.strokes);
  const busy = useRotoBrushStore((s) => s.busy);
  const progress = useRotoBrushStore((s) => s.progress);
  const nodeId = useRotoBrushStore((s) => s.nodeId);
  const box = useRotoBrushStore((s) => s.box);
  const marquee = useRotoBrushStore((s) => s.marquee);

  // Re-read on every document change: frozen is the matte mask's own name.
  const rotoTree = useMirrorTree(nodeId);
  const mattes = nodeId && rotoTree ? rotoMattes(nodeId) : { live: [], frozen: [], subject: [], subjectFrozen: [] };
  const frozen = mattes.frozen.length > 0 || mattes.subjectFrozen.length > 0;
  const matteCard = nodeId && rotoTree ? objectMatteCard(nodeId) : null;
  const canFreeze = !!nodeId && !busy && (frozen || mattes.live.length > 0 || mattes.subject.length > 0);
  // A subject on the layer (its "Object Matte" outline) is where propagation starts, strokes or not.
  const hasSubject = !!nodeId && !!rotoTree && mirrorMaskHeaders(rotoTree).some((m) => m.name === 'Object Matte');
  const canPropagate = !!nodeId && (hasSubject || strokes.some((s) => s.kind === 'fg') || box !== null) && !busy && !frozen;
  // The Object Matte tool always follows with the model; the brush has the choice.
  const engine = useRotoBrushStore((s) => (objectMatteTool || brush ? 'objectMatte' : s.engine));
  const refine = useRotoBrushStore((s) => s.refine);
  const [refineOpen, setRefineOpen] = useState(false);

  /** Object Matte (AE parity 3.1): the subject followed with the model, from the playhead, either way. */
  const propagateMatte = (direction: 'forward' | 'backward' | 'both'): void => {
    if (!nodeId) return;
    const store = useRotoBrushStore.getState();
    const settings = activeCompSettingsNow();
    const origin = playheadSeconds();
    const wa = settingsSetWorkArea(settings);
    const start = direction === 'forward' ? origin : wa ? wa.start : 0;
    const end = direction === 'backward' ? origin + 1 / settingsFps(settings) : wa ? wa.end : settingsDurationSeconds(settings);
    if (!(end > start)) {
      store.setStatus(t('topNav.roto.nothingInDirection', 'Nothing in that direction to propagate into.'));
      subject: activeSubjectId(nodeId),
      return;
    }
    store.setBusy(true, 0);
    store.setStatus(t('topNav.roto.objectMatteBusy', 'Object Matte…'));
    propagateObjectMatte(nodeId, store.strokes, {
      origin, start, end, fps: settingsFps(settings), direction, featherPx: store.featherPx, refine: store.refine, box: store.box,
    }, (f) => {
      useRotoBrushStore.getState().setBusy(true, f);
      return useRotoBrushStore.getState().busy;
    })
      .then((r) => useRotoBrushStore.getState().setStatus(r.status === 'cancelled' ? t('topNav.roto.cancelled', 'Cancelled.') : t('topNav.roto.objectMatteDone', 'Object Matte: {n} frames.', { n: r.frames })))
      .catch((err: unknown) => {
        const message = err instanceof Error ? err.message : t('topNav.roto.objectMatteFailed', 'Object Matte failed.');
        offerObjectMatteDownload(message);
        useRotoBrushStore.getState().setStatus(explainObjectMatteError(message));
      })
      .finally(() => useRotoBrushStore.getState().setBusy(false));
  };

  const propagate = (): void => {
    if (!nodeId) return;
    const store = useRotoBrushStore.getState();
    // B4: the playhead (transport seam) and the active composition's work area / length / rate from the mirror.
    const settings = activeCompSettingsNow();
    const from = playheadSeconds();
    const wa = settingsSetWorkArea(settings);
    const to = wa ? wa.end : settingsDurationSeconds(settings);
    if (!(to > from)) {
      store.setStatus(t('topNav.roto.nothingAhead', 'Nothing ahead of the playhead to propagate into.'));
      return;
    }
    store.setBusy(true, 0);
    store.setStatus(t('topNav.roto.propagatingForward', 'Propagating forward…'));
    // B4-kept: an engine job run from the UI (segments decoded frames) — not registered as an engine job yet (G).
    propagateRotoForward(nodeId, store.strokes, from, to, settingsFps(settings), store.featherPx, (f) => {
      useRotoBrushStore.getState().setBusy(true, f);
    })
      .then(() => {
        useRotoBrushStore.getState().setStatus(null);
      })
      .catch((err: unknown) => {
        useRotoBrushStore.getState().setStatus(err instanceof Error ? err.message : t('topNav.roto.propagationFailed', 'Propagation failed.'));
      })
      .finally(() => useRotoBrushStore.getState().setBusy(false));
  };

  return (
    <>
      <span className={styles.optLabel}>{objectMatteTool
        ? t('topNav.roto.objectMatteLabel', 'Object Matte')
        : brush === 'exact'
          ? t('topNav.roto.selectionBrushLabel', 'Selection Brush')
          : brush === 'refine'
            ? t('topNav.roto.refineEdgeLabel', 'Refine Edge')
            : t('topNav.roto.quickSelectionLabel', 'Quick Selection')}</span>
      {brush ? (<>
        <Row label={t('topNav.toolOptions.size', 'Size')}>
          <ValueField value={size} unit="px" min={2} max={200} precision={0} onChange={(v) => useRotoBrushStore.getState().setSize(Number(v))} />
        </Row>
        <span className={styles.hint} title={brush === 'exact'
          ? t('topNav.roto.selectionBrushPaintHint', 'Paints the selection exactly where you brush; Alt-paint erases. No edge snapping.')
          : t('topNav.roto.refineEdgeBandHint', 'Paint along hair or fur: the edge under the brush becomes soft, strand by strand.')}>
          {brush === 'exact'
            ? t('topNav.roto.selectionBrushPaintHint', 'Paints the selection exactly where you brush; Alt-paint erases. No edge snapping.')
            : t('topNav.roto.refineEdgeBandHint', 'Paint along hair or fur: the edge under the brush becomes soft, strand by strand.')}
        </span>
      </>) : null}
      {brush ? null : objectMatteTool ? (<>
        {/* AE's marquee modes for the drag: Rectangle or Lasso. */}
        <div className={styles.kinds} role="group" aria-label={t('topNav.roto.marqueeGroup', 'Marquee')}>
          <button
            type="button"
            className={marquee === 'rect' ? styles.kindActive : styles.kind}
            aria-pressed={marquee === 'rect'}
            title={t('topNav.roto.marqueeRectTitle', 'Drag a rectangle around the subject')}
            onClick={() => useRotoBrushStore.getState().setMarquee('rect')}
          >
            {t('topNav.roto.marqueeRect', 'Rectangle')}
          </button>
          <button
            type="button"
            className={marquee === 'lasso' ? styles.kindActive : styles.kind}
            aria-pressed={marquee === 'lasso'}
            title={t('topNav.roto.marqueeLassoTitle', 'Drag a loop around the subject: what is inside it is selected')}
            onClick={() => useRotoBrushStore.getState().setMarquee('lasso')}
          >
            {t('topNav.roto.marqueeLasso', 'Lasso')}
          </button>
        </div>
        <span className={styles.hint} title={t('topNav.roto.objectMatteHint', 'Hover, click · Shift adds · Alt subtracts · drag a box')}>
          {t('topNav.roto.objectMatteHint', 'Hover, click · Shift adds · Alt subtracts · drag a box')}
        </span>
      </>) : (<>
      <div className={styles.kinds} role="group" aria-label={t('topNav.roto.strokeGroup', 'Roto brush stroke')}>
        {rotoStrokeKinds().map(({ kind: k, label, hint }) => (
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
      <Row label={t('topNav.toolOptions.size', 'Size')}>
        <ValueField value={size} unit="px" min={2} max={200} precision={0} onChange={(v) => useRotoBrushStore.getState().setSize(Number(v))} />
      </Row>
      </>)}
      <Row label={t('topNav.toolOptions.feather', 'Feather')}>
        <ValueField value={featherPx} unit="px" min={0} max={64} precision={0} onChange={(v) => useRotoBrushStore.getState().setFeather(Number(v))} />
      </Row>
      {!objectMatteTool && !brush && <div className={styles.kinds} role="group" aria-label={t('topNav.roto.engineGroup', 'Matte engine')}>
        <button
          type="button"
          className={engine === 'objectMatte' ? styles.kindActive : styles.kind}
          aria-pressed={engine === 'objectMatte'}
          title={t('topNav.roto.objectMatteTitle', 'Object Matte: the segmentation model follows the subject frame by frame (soft matte, refined edges)')}
          onClick={() => useRotoBrushStore.getState().setEngine('objectMatte')}
        >
          {t('topNav.roto.objectMatte', 'Object Matte')}
        </button>
        <button
          type="button"
          className={engine === 'classic' ? styles.kindActive : styles.kind}
          aria-pressed={engine === 'classic'}
          title={t('topNav.roto.classicTitle', 'Roto Brush (classic): colour and motion carry the outline forward')}
          onClick={() => useRotoBrushStore.getState().setEngine('classic')}
        >
          {t('topNav.roto.classic', 'Classic')}
        </button>
      </div>}
      {engine === 'objectMatte' ? (
        <>
          <div className={styles.kinds} role="group" aria-label={t('topNav.roto.propagateGroup', 'Propagate')}>
            <button type="button" className={styles.kind} disabled={!canPropagate} aria-label={t('topNav.roto.propagateBackward', 'Propagate backward')} title={t('topNav.roto.propagateBackwardTitle', 'Propagate backward from the playhead')} onClick={() => propagateMatte('backward')}>
              <Icon name="skip-back" size="sm" />
            </button>
            <button type="button" className={styles.kind} disabled={!canPropagate} aria-label={t('topNav.roto.propagateBoth', 'Propagate both ways')} title={t('topNav.roto.propagateBothTitle', 'Propagate both ways over the work area')} onClick={() => propagateMatte('both')}>
              {busy ? `${Math.round(progress * 100)}%` : '◀▶'}
            </button>
            <button type="button" className={styles.kind} disabled={!canPropagate} aria-label={t('topNav.roto.propagateForward', 'Propagate forward')} title={t('topNav.roto.propagateForwardTitle', 'Propagate forward from the playhead')} onClick={() => propagateMatte('forward')}>
              <Icon name="skip-forward" size="sm" />
            </button>
          </div>
          {/* With the layer's Object Matte effect, its card holds these (the next
              propagation reads them there): point at it rather than edit a copy. */}
          {matteCard ? (
            <span className={styles.hint} title={t('topNav.roto.refineInEffectTitle', 'Edge radius, decontaminate, chatter and motion blur are on the layer\'s Object Matte effect')}>
              {t('topNav.roto.refineInEffect', 'Refine: Effect Controls')}
            </span>
          ) : (
          <Popover
            placement="bottom-start"
            open={refineOpen}
            onOpenChange={setRefineOpen}
            trigger={
              <button
                type="button"
                className={refineOpen ? styles.kindActive : styles.kind}
                aria-haspopup="dialog"
                aria-expanded={refineOpen}
                title={t('topNav.roto.refineTitle', 'Edge radius, choke, decontaminate, chatter and motion blur')}
              >
                <Icon name="tune" size="sm" />
                {t('topNav.roto.refine', 'Refine')}
                <Icon name="chevron-down" size="sm" />
              </button>
            }
          >
            <div className={styles.refinePanel} role="dialog" aria-label={t('topNav.roto.refineMatte', 'Refine matte')}>
              <Row label={t('topNav.toolOptions.edge', 'Edge')}>
                <ValueField aria-label={t('topNav.toolOptions.edgeRadiusAria', 'Refine edge radius')} value={refine.edgeRadius} unit="px" min={0} max={64} precision={0} onChange={(v) => useRotoBrushStore.getState().setRefine({ edgeRadius: Number(v) })} />
              </Row>
              <Row label={t('topNav.toolOptions.choke', 'Choke')}>
                <ValueField aria-label={t('topNav.toolOptions.choke', 'Choke')} value={refine.choke} unit="%" min={-100} max={100} precision={0} onChange={(v) => useRotoBrushStore.getState().setRefine({ choke: Number(v) })} />
              </Row>
              <Row label={t('topNav.toolOptions.decontaminate', 'Decontaminate')}>
                <ValueField aria-label={t('topNav.toolOptions.decontaminate', 'Decontaminate')} value={refine.decontaminate} unit="%" min={0} max={100} precision={0} onChange={(v) => useRotoBrushStore.getState().setRefine({ decontaminate: Number(v) })} />
              </Row>
              <Row label={t('topNav.toolOptions.chatter', 'Chatter')}>
                <ValueField aria-label={t('topNav.toolOptions.reduceChatter', 'Reduce chatter')} value={refine.reduceChatter} unit="%" min={0} max={100} precision={0} onChange={(v) => useRotoBrushStore.getState().setRefine({ reduceChatter: Number(v) })} />
              </Row>
              <button
                type="button"
                className={refine.motionBlur ? styles.kindActive : styles.kind}
                aria-pressed={refine.motionBlur}
                title={t('topNav.roto.motionBlurTitle', 'Blur the matte along the motion, as the camera blurred the subject')}
                onClick={() => useRotoBrushStore.getState().setRefine({ motionBlur: !refine.motionBlur })}
              >
                {t('topNav.roto.motionBlur', 'Motion Blur')}
              </button>
            </div>
          </Popover>
          )}
        </>
      ) : (
        <button
          type="button"
          className={styles.kind}
          disabled={!canPropagate}
          title={t('topNav.roto.trackForwardTitle', 'Track the matte forward from the playhead to the end of the work area')}
          onClick={propagate}
        >
          <Icon name="skip-forward" size="sm" />
          {busy ? t('topNav.roto.propagatingPct', 'Propagating {pct}%', { pct: Math.round(progress * 100) }) : t('topNav.roto.propagateForwardAction', 'Propagate Forward')}
        </button>
      )}
      <button
        type="button"
        className={frozen ? styles.kindActive : styles.kind}
        disabled={!canFreeze}
        aria-pressed={frozen}
        title={frozen
          ? t('topNav.roto.frozenTitle', 'The matte is frozen: strokes and Propagate cannot change it. Click to unfreeze.')
          : t('topNav.roto.freezeTitle', 'Freeze the matte so a new stroke or Propagate cannot replace it')}
        onClick={() => {
          if (!nodeId) return;
          const e = rotoFreezeEdit(nodeId, !frozen);
          if (e.commands.length) void edit(e.label, e.commands);
        }}
      >
        <Icon name={frozen ? 'lock' : 'unlock'} size="sm" />
        {frozen ? t('topNav.roto.frozen', 'Frozen') : t('topNav.roto.freeze', 'Freeze')}
      </button>
    </>
  );
}

export default ToolOptionsBar;
