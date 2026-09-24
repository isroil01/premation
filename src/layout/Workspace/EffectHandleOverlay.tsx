/**
 * On-canvas control points for effects — Bezier Warp's twelve, Corner Pin's
 * four, and whatever declares handles next.
 *
 * ## What is NOT here
 *
 * No hit-testing maths, no drag arithmetic, no autokey rule: those are
 * `core/effects/effectHandles.ts` and the engine-API builder
 * `trackValueCommands` (an animated param keys at the playhead, a static one
 * takes the value — per param, absolute), so they are pure and tested. This file is pointer plumbing and SVG, which is the
 * part that cannot be unit-tested and therefore should be the smallest part.
 *
 * ## Projection — the existing one, not a new one
 *
 * `PuppetOverlay` and `BoneOverlay` each carry their own byte-identical
 * `localToScreen`/`screenToLocal` pair built on `worldMatrix(geom)`. This does
 * NOT add a third: it goes through `layerSpaceAt`, the same resolver the
 * expression functions `toComp`/`fromComp` use, which composes the parent chain
 * through `worldMatrixOf` and handles 3D layers as well.
 *
 * ## Screen space, so the grab is zoom-independent
 *
 * Handles are drawn and hit-tested in SCREEN pixels at a constant radius, the
 * way `SelectTool.pickHandle` and the 3D gizmo are. Sizing them in layer units
 * would make them unhittable zoomed out and enormous zoomed in.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import defaultSceneGraph from '@core/scene/DefaultSceneGraph';
import { useSelectionStore } from '@stores/selectionStore';
import { useEffectHandleStore } from '@stores/effectHandleStore';
import { useActiveWorkspace } from '@stores/projectStore';
import { useActiveCompSize, useMirrorRevisionFrame } from '@hooks/useMirrorFrame';
import { getWorkspaceController } from '@core/workspace/WorkspaceController';
import { defaultAnimation } from '@motion/animation';
import { keyAxisTimeForDisplay } from '@core/engine/displayTime';
import { getNodeEffects, effectPropPath } from '@core/effects/effects';
import { readGeometry } from '@core/workspace/geometry';
import { layerScreenMapping } from './layerScreen';
import {
  collectEffectHandles,
  hitTestEffectHandle,
  handleDragValues,
  effectToLayer,
  layerToEffect,
  hasEffectHandles,
  HANDLE_PICK_RADIUS,
  type EffectHandle,
  type HandlePoint,
} from '@core/effects/effectHandles';
import { GestureSession } from '@core/engine/uiEdits';
import { trackValueCommands } from './viewportEdits';

/** Drawn radius. Smaller than the PICK radius on purpose — see the note below. */
const VERTEX_R = 5;
const TANGENT_R = 3.5;

export function EffectHandleOverlay(): JSX.Element | null {
  // Frame-coalesced: a drag bumps the revision per pointer event, and this
  // overlay only needs to track it visually. Also the memo key below — the raw
  // rev changed per event, so the memos never hit during a drag.
  const sceneTick = useMirrorRevisionFrame();
  const ids = useSelectionStore((s) => s.ids);
  const activeNode = useEffectHandleStore((s) => s.nodeId);
  const activeEffect = useEffectHandleStore((s) => s.effectId);
  const time = useActiveWorkspace()?.time ?? 0;
  const comp = useActiveCompSize();
  const svgRef = useRef<SVGSVGElement | null>(null);
  const dragRef = useRef<{ handle: EffectHandle; nodeId: string; effectId: string; gesture: GestureSession } | null>(null);
  const [hovered, setHovered] = useState<string | null>(null);

  const nodeId = activeNode && ids.includes(activeNode) ? activeNode : null;
  const node = nodeId ? defaultSceneGraph.getNode(nodeId) : null;
  const effect = node && activeEffect
    ? getNodeEffects(nodeId!).find((e) => e.id === activeEffect) ?? null
    : null;
  const geom = node ? readGeometry(node) : null;

  // Display only: the keyframe-axis time the handles are SAMPLED at (B4's mirror
  // replaces it); the drag's writes go through the engine in comp time.
  const layerT = nodeId ? keyAxisTimeForDisplay(nodeId, time) : 0;

  /**
   * Handles at their LIVE positions — animated values folded in, so a handle on
   * an animated warp sits where the frame shows it rather than where the static
   * prop says. Drawing the static position would invite a drag that jumps.
   */
  const handles = useMemo<EffectHandle[]>(() => {
    if (!effect || !geom || !nodeId) return [];
    if (!hasEffectHandles(effect.type)) return [];
    const params: Record<string, unknown> = { ...(effect.params ?? {}) };
    for (const key of Object.keys(params)) {
      const v = defaultAnimation.sample(nodeId, effectPropPath(effect.id, key), layerT);
      if (typeof v === 'number') params[key] = v;
    }
    return collectEffectHandles(effect.type, params, geom.width, geom.height);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- scene rev drives this
  }, [effect, geom?.width, geom?.height, nodeId, layerT, sceneTick]);

  const camera = getWorkspaceController().ws.camera;

  /**
   * effect-param space ↔ screen px, over the SHARED layer↔screen mapping.
   *
   * This used to compose `layerSpaceAt` + camera inline, which was a second
   * copy of what the rig overlays now use. All this adds on top is the
   * effect-space half-box offset, which is genuinely its own concern — the rig
   * overlays work in layer-local coordinates directly.
   */
  const mapping = useMemo(
    () => (nodeId ? layerScreenMapping(nodeId, time, comp, camera) : null),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- camera is a live singleton
    [nodeId, time, comp.width, comp.height, sceneTick],
  );

  const toScreen = useMemo(() => {
    if (!mapping || !geom) return null;
    return (p: HandlePoint): HandlePoint => {
      const local = effectToLayer(p, geom.width, geom.height);
      return mapping.localToScreen(local.x, local.y);
    };
  }, [mapping, geom]);

  /** The exact inverse of `toScreen`. */
  const fromScreen = useMemo(() => {
    if (!mapping || !geom) return null;
    return (p: HandlePoint): HandlePoint => {
      const l = mapping.screenToLocal(p.x, p.y);
      return layerToEffect({ x: l.x, y: l.y }, geom.width, geom.height);
    };
  }, [mapping, geom]);

  // Pointer plumbing. A CAPTURE-phase listener on the stage would fight the
  // layer gizmo; instead the SVG sits above it and claims the event only when a
  // handle is actually under the pointer, so a click on empty canvas still
  // selects layers exactly as before.
  useEffect(() => {
    const svg = svgRef.current;
    if (!svg || !toScreen || !fromScreen || !effect || !nodeId) return;

    const local = (e: PointerEvent): HandlePoint => {
      const r = svg.getBoundingClientRect();
      return { x: e.clientX - r.left, y: e.clientY - r.top };
    };

    const onDown = (e: PointerEvent): void => {
      const hit = hitTestEffectHandle(local(e), handles, toScreen);
      if (!hit) return;
      e.stopPropagation();
      e.preventDefault();
      // One drag = one undo entry: an engine gesture for the whole press.
      dragRef.current = { handle: hit, nodeId, effectId: effect.id, gesture: new GestureSession(`Move ${hit.spec.label}`) };
      svg.setPointerCapture(e.pointerId);
    };
    const onMove = (e: PointerEvent): void => {
      const drag = dragRef.current;
      if (!drag) {
        const hit = hitTestEffectHandle(local(e), handles, toScreen);
        setHovered(hit?.spec.id ?? null);
        return;
      }
      const target = fromScreen(local(e));
      const values = handleDragValues(drag.handle, target);
      // The numeric field's rule (writeEffectParams): an animated param keys at
      // the playhead, a static one takes the value — per param, absolute.
      const tracks: Record<string, number> = {};
      for (const [key, v] of Object.entries(values)) tracks[effectPropPath(drag.effectId, key)] = v;
      // null: the engine does not address the write (a node that is not a
      // composition's layer, or a param its catalog does not list) — there is
      // nothing the API can record, so the handle does not move.
      const cmds = trackValueCommands([{ nodeId: drag.nodeId, values: tracks }], { seconds: time });
      if (cmds) drag.gesture.send(cmds);
    };
    const onUp = (e: PointerEvent): void => {
      const drag = dragRef.current;
      if (!drag) return;
      dragRef.current = null;
      void drag.gesture.end();
      if (svg.hasPointerCapture(e.pointerId)) svg.releasePointerCapture(e.pointerId);
    };
    // Escape mid-drag reverts it (the engine undoes every move of the gesture).
    const onKey = (e: KeyboardEvent): void => {
      const drag = dragRef.current;
      if (e.key !== 'Escape' || !drag) return;
      e.preventDefault();
      e.stopPropagation();
      dragRef.current = null;
      void drag.gesture.cancel();
    };
    window.addEventListener('keydown', onKey, true);

    svg.addEventListener('pointerdown', onDown);
    svg.addEventListener('pointermove', onMove);
    svg.addEventListener('pointerup', onUp);
    svg.addEventListener('pointercancel', onUp);
    return () => {
      svg.removeEventListener('pointerdown', onDown);
      svg.removeEventListener('pointermove', onMove);
      svg.removeEventListener('pointerup', onUp);
      svg.removeEventListener('pointercancel', onUp);
      window.removeEventListener('keydown', onKey, true);
    };
  }, [handles, toScreen, fromScreen, effect, nodeId, time]);

  // Unmount mid-drag commits (nothing the user saw is lost).
  useEffect(() => () => {
    const drag = dragRef.current;
    dragRef.current = null;
    if (drag) void drag.gesture.end();
  }, []);

  if (!node || !effect || !toScreen || handles.length === 0) return null;

  const screen = handles.map((h) => ({ h, s: toScreen(h.pos) }));

  return (
    <svg
      ref={svgRef}
      aria-label={`${effect.type} handles`}
      // `none` at the svg level: this overlay spans the whole stage, and an
      // `auto` svg swallowed every viewport gesture (pan, zoom, layer drags)
      // while handles were shown. Only the per-handle hit circles below are
      // interactive; everything else lets input fall through to the canvas.
      style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', pointerEvents: 'none' }}
    >
      {/* The rest outline, so a dragged handle reads as displaced FROM
          somewhere rather than as an arbitrary dot. */}
      <polygon
        points={handles.filter((h) => h.spec.kind === 'vertex')
          .map((h) => { const s = toScreen(h.rest); return `${s.x},${s.y}`; }).join(' ')}
        fill="none" stroke="var(--color-overlay-stroke-soft)" strokeDasharray="4 4" strokeWidth={1}
      />
      {screen.map(({ h, s }) => {
        const r = h.spec.kind === 'vertex' ? VERTEX_R : TANGENT_R;
        const on = hovered === h.spec.id;
        return (
          <g key={h.spec.id} aria-label={`${h.spec.label} handle`}>
            {/* Invisible fat hit target at the pick radius — the one
                interactive part of the overlay. Events bubble to the svg's
                own listeners, whose hit test uses the same radius. */}
            <circle
              cx={s.x} cy={s.y} r={HANDLE_PICK_RADIUS}
              fill="transparent" style={{ pointerEvents: 'all', cursor: 'move' }}
            />
            {/* A dark ring UNDER the fill, so the handle stays legible on
                white artwork as well as black — a single-colour dot vanishes
                against half the content people warp. */}
            <circle cx={s.x} cy={s.y} r={r + 1.5} fill="var(--color-overlay-handle-halo)" />
            <circle
              cx={s.x} cy={s.y} r={r}
              fill={on ? 'var(--color-overlay-light)' : 'var(--color-overlay-text)'}
              stroke="var(--color-overlay-stroke-dark)" strokeWidth={1}
            />
          </g>
        );
      })}
    </svg>
  );
}

export default EffectHandleOverlay;
