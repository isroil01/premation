/**
 * Native plugin viewer overlays (plugin SDK 1.1, AE's PF_Cmd_EVENT draw /
 * click / drag): what the selected layers' plugin effects draw over the
 * viewer, and their draggable handles.
 *
 * The engine asks the plugin (PR_CMD_DRAW_OVERLAY) and pushes the draw list
 * with every frame (overlay kind `plugin`, layer px), like the rig. This maps
 * it through the shared layer ↔ screen mapping and draws it. A handle drag is
 * `dragEffectOverlay` steps inside ONE engine gesture — one undo entry — and
 * the plugin writes its params through the engine. No plugin code runs here.
 *
 * Pointer handling follows EffectHandleOverlay: the SVG lets input through
 * except over a handle, so the canvas keeps its own gestures.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import { secondsToFlicks, type OverlayKind } from '@motion/engine-api';
import { useSelectionStore } from '@stores/selectionStore';
import { useActiveWorkspace } from '@stores/projectStore';
import { useActiveCompSize } from '@hooks/useMirrorFrame';
import { MAIN_VIEWPORT, overlayLayer, requestOverlayLayers, subscribeOverlayGeometry } from '@stores/overlayGeometry';
import { GestureSession } from '@core/engine/uiEdits';
import {
  dragCommand,
  overlayShapes,
  pickHandle,
  DRAG_BEGIN,
  DRAG_END,
  DRAG_MOVE,
  type OverlayShape,
  type Point,
} from '@core/nativePlugins/pluginOverlay';
import { layerScreenMapping } from './layerScreen';
import { useDisplayedCamera2D } from './useOverlayView';

/** The draw list, and the layer's transform it maps through. */
const PLUGIN_KINDS: ReadonlyArray<OverlayKind> = ['plugin', 'transform', 'bounds'];
const PICK_RADIUS = 9;
const HANDLE_R = 5;

interface Drag {
  layer: string;
  effect: string;
  handle: number;
  start: Point;
  gesture: GestureSession;
  screenToLocal: (x: number, y: number) => Point;
}

export function PluginOverlay(): JSX.Element | null {
  const ids = useSelectionStore((s) => s.ids);
  const time = useActiveWorkspace()?.time ?? 0;
  const comp = useActiveCompSize();
  const camera = useDisplayedCamera2D();
  const svgRef = useRef<SVGSVGElement | null>(null);
  const dragRef = useRef<Drag | null>(null);
  const [tick, setTick] = useState(0);
  const layersKey = ids.join('\u0001');

  useEffect(() => {
    void requestOverlayLayers(MAIN_VIEWPORT, 'pluginOverlays', layersKey ? layersKey.split('\u0001') : [], PLUGIN_KINDS).then(() => setTick((t) => t + 1));
  }, [layersKey]);
  useEffect(() => {
    const off = subscribeOverlayGeometry(MAIN_VIEWPORT, () => setTick((t) => t + 1));
    return () => {
      off();
      void requestOverlayLayers(MAIN_VIEWPORT, 'pluginOverlays', [], PLUGIN_KINDS);
    };
  }, []);

  /** Per selected layer: its shapes in screen px and the inverse mapping a drag needs. */
  const layers = useMemo(() => {
    const at = secondsToFlicks(time);
    const out: Array<{ layer: string; shapes: OverlayShape[]; screenToLocal: (x: number, y: number) => Point }> = [];
    for (const layer of ids) {
      const items = overlayLayer(MAIN_VIEWPORT, layer, at)?.plugin ?? [];
      if (items.length === 0) continue;
      const mapping = layerScreenMapping(layer, time, comp, camera);
      if (!mapping) continue;
      out.push({ layer, shapes: overlayShapes(items, mapping.localToScreen), screenToLocal: mapping.screenToLocal });
    }
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps -- the push is read by tick
  }, [layersKey, time, comp.width, comp.height, camera, tick]);

  useEffect(() => {
    const svg = svgRef.current;
    if (!svg || layers.length === 0) return undefined;
    const local = (e: PointerEvent): Point => {
      const r = svg.getBoundingClientRect();
      return { x: e.clientX - r.left, y: e.clientY - r.top };
    };
    const onDown = (e: PointerEvent): void => {
      const p = local(e);
      for (const l of layers) {
        const hit = pickHandle(l.shapes, p, PICK_RADIUS);
        if (!hit) continue;
        e.stopPropagation();
        e.preventDefault();
        const gesture = new GestureSession('Drag Effect Handle');
        dragRef.current = { layer: l.layer, effect: hit.effect, handle: hit.handle, start: hit.local, gesture, screenToLocal: l.screenToLocal };
        gesture.send([dragCommand(l.layer, hit.effect, hit.handle, hit.local, hit.local, DRAG_BEGIN)]);
        try {
          svg.setPointerCapture(e.pointerId);
        } catch {
          /* capture is a nicety; the drag still works */
        }
        return;
      }
    };
    const onMove = (e: PointerEvent): void => {
      const d = dragRef.current;
      if (!d) return;
      const p = local(e);
      d.gesture.send([dragCommand(d.layer, d.effect, d.handle, d.screenToLocal(p.x, p.y), d.start, DRAG_MOVE)]);
    };
    const onUp = (e: PointerEvent): void => {
      const d = dragRef.current;
      if (!d) return;
      dragRef.current = null;
      const p = local(e);
      d.gesture.send([dragCommand(d.layer, d.effect, d.handle, d.screenToLocal(p.x, p.y), d.start, DRAG_END)]);
      void d.gesture.end();
      if (svg.hasPointerCapture(e.pointerId)) svg.releasePointerCapture(e.pointerId);
    };
    const onKey = (e: KeyboardEvent): void => {
      const d = dragRef.current;
      if (e.key !== 'Escape' || !d) return;
      e.preventDefault();
      e.stopPropagation();
      dragRef.current = null;
      void d.gesture.cancel();  // Esc reverts the whole drag
    };
    svg.addEventListener('pointerdown', onDown);
    svg.addEventListener('pointermove', onMove);
    svg.addEventListener('pointerup', onUp);
    svg.addEventListener('pointercancel', onUp);
    window.addEventListener('keydown', onKey, true);
    return () => {
      svg.removeEventListener('pointerdown', onDown);
      svg.removeEventListener('pointermove', onMove);
      svg.removeEventListener('pointerup', onUp);
      svg.removeEventListener('pointercancel', onUp);
      window.removeEventListener('keydown', onKey, true);
    };
  }, [layers]);

  // Unmount mid-drag commits (nothing the user saw is lost).
  useEffect(() => () => {
    const d = dragRef.current;
    dragRef.current = null;
    if (d) void d.gesture.end();
  }, []);

  if (layers.length === 0) return null;
  return (
    <svg
      ref={svgRef}
      aria-label="Plugin overlays"
      style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', pointerEvents: 'none' }}
    >
      {layers.map((l) => (
        <g key={l.layer}>
          {l.shapes.map((s, i) => (s.kind === 'path' ? (
            // The plugin's draw order is the identity of a path.
            <path key={i} d={s.d} fill="none" stroke={s.color ?? 'var(--color-overlay-text)'} strokeWidth={1} />
          ) : (
            <g key={`h${s.effect}:${s.handle}`} aria-label="Effect handle">
              <circle cx={s.at.x} cy={s.at.y} r={PICK_RADIUS} fill="transparent" style={{ pointerEvents: 'all', cursor: 'move' }} />
              {s.shape === 2 ? (
                <path
                  d={`M${s.at.x - 7} ${s.at.y}H${s.at.x + 7}M${s.at.x} ${s.at.y - 7}V${s.at.y + 7}`}
                  stroke={s.color ?? 'var(--color-overlay-text)'} strokeWidth={1.5}
                />
              ) : null}
              {s.shape === 1 || s.shape === 2 ? (
                <circle cx={s.at.x} cy={s.at.y} r={HANDLE_R} fill="none" stroke={s.color ?? 'var(--color-overlay-text)'} strokeWidth={1.5} />
              ) : (
                <rect
                  x={s.at.x - HANDLE_R} y={s.at.y - HANDLE_R} width={HANDLE_R * 2} height={HANDLE_R * 2}
                  fill={s.color ?? 'var(--color-overlay-text)'} stroke="var(--color-overlay-stroke-dark)" strokeWidth={1}
                />
              )}
            </g>
          )))}
        </g>
      ))}
    </svg>
  );
}

export default PluginOverlay;
