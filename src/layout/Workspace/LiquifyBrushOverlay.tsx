/**
 * The Liquify brush on the canvas (AE parity 5.5): while a Liquify effect's
 * brush is on (Properties ▸ Effects ▸ Liquify ▸ Paint), dragging over the
 * selected layer paints its distortion field with the chosen tool — one
 * stroke, one undo entry (an engine gesture of `setProperty` writes of the
 * effect's `field` / `fieldGrid`). The brush circle follows the pointer.
 * Escape mid-stroke reverts the stroke; Escape otherwise turns the brush off.
 */

import { useEffect, useRef, useState } from 'react';
import { secondsToFlicks, type OverlayKind } from '@motion/engine-api';
import { useSelectionStore } from '@stores/selectionStore';
import { useLiquifyBrushStore } from '@stores/liquifyBrushStore';
import { useActiveWorkspace } from '@stores/projectStore';
import { useActiveCompSize, useMirrorRevisionFrame } from '@hooks/useMirrorFrame';
import { useMirrorTree } from '@hooks/useMirror';
import { MAIN_VIEWPORT, overlayLayer, requestOverlayLayers } from '@stores/overlayGeometry';
import { mirrorEffects } from '@core/mirror/effects';
import { getWorkspaceController } from '@core/workspace/WorkspaceController';
import { GestureSession } from '@core/engine/uiEdits';
import { paths, ref, values } from '@core/engine/propRefs';
import { layerToEffect } from '@core/effects/effectHandles';
import { liquifyDabInto, liquifyFieldOf, liquifyGridFor } from '@core/effects/liquifyField';
import { layerScreenMapping } from './layerScreen';

const KINDS: ReadonlyArray<OverlayKind> = ['bounds', 'transform'];

export function LiquifyBrushOverlay(): JSX.Element | null {
  useMirrorRevisionFrame();
  const ids = useSelectionStore((s) => s.ids);
  const brushNode = useLiquifyBrushStore((s) => s.nodeId);
  const brushEffect = useLiquifyBrushStore((s) => s.effectId);
  const size = useLiquifyBrushStore((s) => s.size);
  const time = useActiveWorkspace()?.time ?? 0;
  const comp = useActiveCompSize();
  const svgRef = useRef<SVGSVGElement | null>(null);
  const [cursor, setCursor] = useState<{ x: number; y: number } | null>(null);
  const nodeId = brushNode && ids.includes(brushNode) ? brushNode : null;
  const tree = useMirrorTree(nodeId);
  useEffect(() => {
    void requestOverlayLayers(MAIN_VIEWPORT, 'liquifyBrush', nodeId ? [nodeId] : [], KINDS, nodeId ? ['active'] : []);
    return () => { void requestOverlayLayers(MAIN_VIEWPORT, 'liquifyBrush', [], KINDS); };
  }, [nodeId]);
  const effect = nodeId && brushEffect ? mirrorEffects(tree).find((e) => e.id === brushEffect && e.type === 'liquify') ?? null : null;
  const box = nodeId ? overlayLayer(MAIN_VIEWPORT, nodeId, secondsToFlicks(time))?.box : undefined;
  const geom = box && box.length >= 4 ? { width: box[2]!, height: box[3]! } : null;
  const mapping = nodeId ? layerScreenMapping(nodeId, time, comp, getWorkspaceController().ws.camera) : null;

  // The stroke's live state: the field being painted, the last dab point, the gesture.
  const stroke = useRef<{ field: number[]; last: { x: number; y: number }; gesture: GestureSession; seed: number } | null>(null);
  const latest = useRef({ effect, geom, mapping, nodeId });
  latest.current = { effect, geom, mapping, nodeId };

  useEffect(() => {
    const svg = svgRef.current;
    if (!svg) return;
    const local = (e: PointerEvent): { x: number; y: number } => {
      const r = svg.getBoundingClientRect();
      return { x: e.clientX - r.left, y: e.clientY - r.top };
    };
    const toLayer = (p: { x: number; y: number }): { x: number; y: number } | null => {
      const { mapping: mp, geom: g } = latest.current;
      if (!mp || !g) return null;
      const l = mp.screenToLocal(p.x, p.y);
      return layerToEffect({ x: l.x, y: l.y }, g.width, g.height);
    };
    /** Paint from the last dab to `to` in steps of a quarter brush. */
    const paintTo = (to: { x: number; y: number }): void => {
      const s = stroke.current;
      const { effect: fx, geom: g, nodeId: id } = latest.current;
      if (!s || !fx || !g || !id) return;
      const st = useLiquifyBrushStore.getState();
      const grid = liquifyGridFor(g.width, g.height);
      const radius = st.size / 2;
      const dist = Math.hypot(to.x - s.last.x, to.y - s.last.y);
      const steps = Math.max(1, Math.ceil(dist / Math.max(2, radius / 4)));
      let prev = s.last;
      for (let k = 1; k <= steps; k++) {
        const p = { x: s.last.x + ((to.x - s.last.x) * k) / steps, y: s.last.y + ((to.y - s.last.y) * k) / steps };
        liquifyDabInto(s.field, grid, g.width, g.height, {
          tool: st.tool, x: p.x, y: p.y, radius, pressure: st.pressure / 100, dx: p.x - prev.x, dy: p.y - prev.y, seed: s.seed,
        });
        prev = p;
      }
      s.last = to;
      s.gesture.send([
        { type: 'setProperty', prop: ref(id, paths.effectParam(fx.id, 'fieldGrid')), value: values.json([grid.cols, grid.rows]) },
        { type: 'setProperty', prop: ref(id, paths.effectParam(fx.id, 'field')), value: values.json(s.field) },
      ]);
    };
    const onDown = (e: PointerEvent): void => {
      if (e.button !== 0) return;
      const { effect: fx, geom: g } = latest.current;
      const at = toLayer(local(e));
      if (!fx || !g || !at) return;
      e.stopPropagation();
      e.preventDefault();
      const grid = liquifyGridFor(g.width, g.height);
      stroke.current = {
        field: liquifyFieldOf(fx.params?.field, fx.params?.fieldGrid, grid),
        last: at,
        gesture: new GestureSession('Liquify'),
        seed: Math.round(at.x * 7 + at.y * 13),
      };
      svg.setPointerCapture(e.pointerId);
      paintTo(at);
    };
    const onMove = (e: PointerEvent): void => {
      setCursor(local(e));
      const at = toLayer(local(e));
      if (stroke.current && at) paintTo(at);
    };
    const onUp = (e: PointerEvent): void => {
      const s = stroke.current;
      stroke.current = null;
      if (s) void s.gesture.end();
      if (svg.hasPointerCapture(e.pointerId)) svg.releasePointerCapture(e.pointerId);
    };
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return;
      const s = stroke.current;
      if (s) {
        stroke.current = null;
        void s.gesture.cancel();
      } else {
        useLiquifyBrushStore.getState().stop();
      }
      e.preventDefault();
    };
    svg.addEventListener('pointerdown', onDown);
    svg.addEventListener('pointermove', onMove);
    svg.addEventListener('pointerup', onUp);
    window.addEventListener('keydown', onKey);
    return () => {
      svg.removeEventListener('pointerdown', onDown);
      svg.removeEventListener('pointermove', onMove);
      svg.removeEventListener('pointerup', onUp);
      window.removeEventListener('keydown', onKey);
      const s = stroke.current;
      stroke.current = null;
      if (s) void s.gesture.end();
    };
  }, [nodeId, brushEffect]);

  if (!nodeId || !effect || !geom || !mapping) return null;
  // The brush radius on screen: a layer-px vector mapped through the layer↔screen mapping.
  const c = cursor;
  let rScreen = size / 2;
  if (c) {
    const l = mapping.screenToLocal(c.x, c.y);
    const edge = mapping.localToScreen(l.x + size / 2, l.y);
    rScreen = Math.hypot(edge.x - c.x, edge.y - c.y);
  }
  return (
    <svg
      ref={svgRef}
      data-liquify-brush=""
      style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', zIndex: 23, cursor: 'none', touchAction: 'none' }}
    >
      {c && (
        <>
          <circle cx={c.x} cy={c.y} r={rScreen} fill="none" style={{ stroke: 'var(--color-overlay-text)' }} strokeWidth={1.5} />
          <circle cx={c.x} cy={c.y} r={rScreen} fill="none" style={{ stroke: 'var(--color-overlay-stroke-dark)' }} strokeWidth={0.75} strokeDasharray="3 3" />
          <circle cx={c.x} cy={c.y} r={1.5} style={{ fill: 'var(--color-overlay-text)' }} />
        </>
      )}
    </svg>
  );
}
