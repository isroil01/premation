/**
 * On-canvas control points for effects — Bezier Warp's twelve, Corner Pin's
 * four, and whatever declares handles next.
 *
 * ## What is NOT here
 *
 * No hit-testing maths, no drag arithmetic, no autokey rule: those are
 * `core/effects/effectHandles.ts` and `core/effects/writeEffectParams.ts`, so
 * they are pure and tested. This file is pointer plumbing and SVG, which is the
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
import { useSceneRevision } from '@stores/sceneStore';
import { useSelectionStore } from '@stores/selectionStore';
import { useEffectHandleStore } from '@stores/effectHandleStore';
import { useActiveWorkspace } from '@stores/projectStore';
import { useCompositionStore } from '@stores/compositionStore';
import { getWorkspaceController } from '@core/workspace/WorkspaceController';
import { defaultAnimation } from '@motion/animation';
import { compToKeyframeTime } from '@core/timeline/TimelineController';
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
  type EffectHandle,
  type HandlePoint,
} from '@core/effects/effectHandles';
import { writeEffectParams } from '@core/effects/writeEffectParams';

/** Drawn radius. Smaller than the PICK radius on purpose — see the note below. */
const VERTEX_R = 5;
const TANGENT_R = 3.5;

export function EffectHandleOverlay(): JSX.Element | null {
  useSceneRevision((s) => s.rev);
  const ids = useSelectionStore((s) => s.ids);
  const activeNode = useEffectHandleStore((s) => s.nodeId);
  const activeEffect = useEffectHandleStore((s) => s.effectId);
  const time = useActiveWorkspace()?.time ?? 0;
  const comp = useCompositionStore((s) => s.comp());
  const svgRef = useRef<SVGSVGElement | null>(null);
  const dragRef = useRef<{ handle: EffectHandle; nodeId: string; effectId: string } | null>(null);
  const [hovered, setHovered] = useState<string | null>(null);

  const nodeId = activeNode && ids.includes(activeNode) ? activeNode : null;
  const node = nodeId ? defaultSceneGraph.getNode(nodeId) : null;
  const effect = node && activeEffect
    ? getNodeEffects(nodeId!).find((e) => e.id === activeEffect) ?? null
    : null;
  const geom = node ? readGeometry(node) : null;

  const layerT = nodeId ? compToKeyframeTime(nodeId, time) : 0;

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
  }, [effect, geom?.width, geom?.height, nodeId, layerT, useSceneRevision((s) => s.rev)]);

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
    [nodeId, time, comp.width, comp.height, useSceneRevision((s) => s.rev)],
  );

  const toScreen = useMemo(() => {
    if (!mapping || !geom) return null;
    return (p: HandlePoint): HandlePoint => {
      const local = effectToLayer(p, geom.width, geom.height);
      return mapping.localToScreen(local.x, local.y);
    };
  }, [mapping, geom?.width, geom?.height]);

  /** The exact inverse of `toScreen`. */
  const fromScreen = useMemo(() => {
    if (!mapping || !geom) return null;
    return (p: HandlePoint): HandlePoint => {
      const l = mapping.screenToLocal(p.x, p.y);
      return layerToEffect({ x: l.x, y: l.y }, geom.width, geom.height);
    };
  }, [mapping, geom?.width, geom?.height]);

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
      dragRef.current = { handle: hit, nodeId, effectId: effect.id };
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
      writeEffectParams(
        drag.nodeId, drag.effectId, handleDragValues(drag.handle, target),
        {
          time,
          // Stable for the whole gesture and distinct between gestures, so one
          // drag collapses to one undo entry.
          mergeKey: `fxhandle:${drag.nodeId}:${drag.effectId}:${drag.handle.spec.id}`,
          label: `Move ${drag.handle.spec.label}`,
        },
      );
    };
    const onUp = (e: PointerEvent): void => {
      if (!dragRef.current) return;
      dragRef.current = null;
      if (svg.hasPointerCapture(e.pointerId)) svg.releasePointerCapture(e.pointerId);
    };

    svg.addEventListener('pointerdown', onDown);
    svg.addEventListener('pointermove', onMove);
    svg.addEventListener('pointerup', onUp);
    svg.addEventListener('pointercancel', onUp);
    return () => {
      svg.removeEventListener('pointerdown', onDown);
      svg.removeEventListener('pointermove', onMove);
      svg.removeEventListener('pointerup', onUp);
      svg.removeEventListener('pointercancel', onUp);
    };
  }, [handles, toScreen, fromScreen, effect, nodeId, time]);

  if (!node || !effect || !toScreen || handles.length === 0) return null;

  const screen = handles.map((h) => ({ h, s: toScreen(h.pos) }));

  return (
    <svg
      ref={svgRef}
      aria-label={`${effect.type} handles`}
      style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', pointerEvents: 'auto' }}
    >
      {/* The rest outline, so a dragged handle reads as displaced FROM
          somewhere rather than as an arbitrary dot. */}
      <polygon
        points={handles.filter((h) => h.spec.kind === 'vertex')
          .map((h) => { const s = toScreen(h.rest); return `${s.x},${s.y}`; }).join(' ')}
        fill="none" stroke="rgba(255,255,255,0.25)" strokeDasharray="4 4" strokeWidth={1}
      />
      {screen.map(({ h, s }) => {
        const r = h.spec.kind === 'vertex' ? VERTEX_R : TANGENT_R;
        const on = hovered === h.spec.id;
        return (
          <g key={h.spec.id} aria-label={`${h.spec.label} handle`}>
            {/* A dark ring UNDER the fill, so the handle stays legible on
                white artwork as well as black — a single-colour dot vanishes
                against half the content people warp. */}
            <circle cx={s.x} cy={s.y} r={r + 1.5} fill="rgba(0,0,0,0.55)" />
            <circle
              cx={s.x} cy={s.y} r={r}
              fill={on ? '#ffd166' : '#ffffff'}
              stroke="#101014" strokeWidth={1}
            />
          </g>
        );
      })}
    </svg>
  );
}

export default EffectHandleOverlay;
