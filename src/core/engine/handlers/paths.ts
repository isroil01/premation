/**
 * Structural outline edits (B3, ENGINE_API.md §4.7): `editPathTopology` — a
 * vertex split / removal, Set First Vertex, Reverse Path Direction, Continue
 * Path and the Closed switch replayed on EVERY state of a mask's or a shape
 * layer's outline — and `setShapeOutline` (the Knife's runs).
 *
 * The replay is `packages/workspace` pathTopology.ts, the same functions the
 * tools build the edited outline at the playhead with; the C++ engine ports
 * them (native/engine/src/core/paths.cpp) in the same arithmetic order.
 */

import type { PathTopologyOp } from '@motion/engine-api';
import { defaultAnimation, type DataKeyframe } from '@motion/animation';
import { applyPathTopology, type BezierPoint, type PathTopologyEdit } from '@motion/workspace';
import { readNodeMask, readNodeMaskAnim, type LayerMask, type MaskPath, type MaskPoint } from '@core/effects/mask';
import { readNodeKind } from '@core/scene/sceneDerive';
import { fail } from '../errors';
import { graph, requireLayer } from '../doc';
import { newScope, scopeLayer } from '../state';
import { catalogFor, requireBinding, bezierToPoints, shapePoints, asPoints, shapeClosed, writeShapeClosed, SHAPE_PATH_TRACK } from '../props';
import type { HandlerTable } from '../handler';

/** The API op as the tools' `PathTopologyEdit`, validated. */
function topologyEdit(op: PathTopologyOp): PathTopologyEdit {
  switch (op.kind) {
    case 'insert':
      if (!(Number.isFinite(op.u) && op.u > 0 && op.u < 1)) fail('invalidArgument', 'insert: u must be strictly inside (0, 1)');
      return { op: 'insert', segment: op.segment, u: op.u };
    case 'remove':
      if (op.indices.length === 0) fail('invalidArgument', 'remove: no vertices given');
      return { op: 'deleteMany', indices: [...op.indices] };
    case 'firstVertex':
      if (op.indices.length !== 1) fail('invalidArgument', 'firstVertex: give exactly one vertex');
      return { op: 'firstVertex', index: op.indices[0]! };
    case 'reverse':
      return { op: 'reverse' };
    case 'extend': {
      if (!op.points || op.points.vertices.length < 2) fail('invalidArgument', 'extend: no points given');
      const points = bezierToPoints({ ...op.points, featherPoints: [] }).map((p) => {
        const { feather: _f, ...rest } = p;
        return rest;
      });
      return { op: 'extend', points, atStart: op.atStart };
    }
    default:
      return fail('invalidArgument', `unknown topology op '${String((op as { kind: unknown }).kind)}'`);
  }
}

const LABEL: Record<PathTopologyOp['kind'], string> = {
  insert: 'Add Vertex',
  remove: 'Delete Vertex',
  firstVertex: 'Set First Vertex',
  reverse: 'Reverse Path Direction',
  extend: 'Continue Path',
};

/** A stored vertex with both handles (a data key may omit them: a corner). */
const withHandles = (p: MaskPoint): BezierPoint =>
  ({ ...p, inX: p.inX ?? p.x, inY: p.inY ?? p.y, outX: p.outX ?? p.x, outY: p.outY ?? p.y });

export const pathHandlers: HandlerTable = {
  editPathTopology: (cmd) => {
    const layer = cmd.prop.layer;
    requireLayer(layer);
    const b = requireBinding(catalogFor(layer), cmd.prop.path);
    if (b.special !== 'maskPath' && b.special !== 'shapePath') fail('invalidArgument', `'${b.path}' is not an outline`, { layer, path: b.path });
    if (!cmd.op && cmd.closed === undefined) fail('invalidArgument', 'editPathTopology needs an op, closed, or both', { layer, path: b.path });
    const edit = cmd.op ? topologyEdit(cmd.op) : null;
    const closed = cmd.closed;
    const node = graph.getNode(layer)!;
    let applied = 0;
    const replay = (points: ReadonlyArray<MaskPoint>, isClosed: boolean): BezierPoint[] | null => {
      if (!edit) return null;
      const next = applyPathTopology(points.map(withHandles), edit, isClosed);
      if (next) applied++;
      return next;
    };
    let apply: () => void;
    if (b.special === 'maskPath') {
      const maskId = b.maskId!;
      const mapMask = (m: LayerMask): LayerMask => ({
        paths: m.paths.map((p): MaskPath => {
          if (p.id !== maskId) return p;
          const pts = replay(p.points, p.closed);
          return { ...p, ...(pts ? { points: pts as MaskPoint[] } : {}), ...(closed !== undefined ? { closed } : {}) };
        }),
      });
      const nextStatic = mapMask(readNodeMask(node) ?? { paths: [] });
      const anim = readNodeMaskAnim(node);
      const nextAnim = anim.map((k) => ({ ...k, mask: mapMask(k.mask) }));
      apply = () => {
        graph.setMask(layer, nextStatic);
        if (anim.length > 0) graph.setMaskAnim(layer, nextAnim);
      };
    } else {
      const g = node.components.find((c) => c.type === 'Geometry');
      if (!g) fail('notFound', `layer '${layer}' has no outline`, { layer, path: b.path });
      const isClosed = shapeClosed(node);
      const stat = asPoints(g.props.points);
      const nextStatic = stat ? replay(stat, isClosed) : null;
      const track = defaultAnimation.getDataTrack(layer, SHAPE_PATH_TRACK);
      let keysChanged = false;
      const keys = (track?.keyframes ?? []).map((k): DataKeyframe => {
        const pts = asPoints(k.value);
        const next = pts ? replay(pts, isClosed) : null;
        if (!next) return k;
        keysChanged = true;
        return { ...k, value: next as DataKeyframe['value'] };
      });
      apply = () => {
        if (nextStatic) graph.writeProp(layer, g.id, 'points', nextStatic);
        if (track && keysChanged) defaultAnimation.setDataTrack(layer, SHAPE_PATH_TRACK, { ...track, keyframes: keys });
        if (closed !== undefined) writeShapeClosed(layer, graph.getNode(layer)!, closed);
      };
    }
    if (edit && applied === 0) fail('invalidArgument', `the ${cmd.op!.kind} edit applies to no state of '${b.path}'`, { layer, path: b.path });
    const removeLabel = cmd.op?.kind === 'remove' && cmd.op.indices.length > 1 ? 'Delete Vertices' : undefined;
    return {
      scope: scopeLayer(newScope(), layer),
      label: cmd.op ? removeLabel ?? LABEL[cmd.op.kind] : 'Closed',
      apply: () => {
        apply();
        return {};
      },
    };
  },

  setShapeOutline: (cmd) => {
    const layer = cmd.layer;
    requireLayer(layer);
    const node = graph.getNode(layer)!;
    if (readNodeKind(node) !== 'shape') fail('invalidArgument', `layer '${layer}' is not a shape layer`, { layer });
    if (cmd.runs.length === 0) fail('invalidArgument', 'setShapeOutline needs at least one run', { layer });
    for (const r of cmd.runs) if (r.vertices.length < 4) fail('invalidArgument', 'every run needs at least 2 vertices', { layer });
    if (defaultAnimation.isDataAnimated(layer, SHAPE_PATH_TRACK)) {
      fail('animated', `layer '${layer}' has an animated outline; its keys would win over the runs`, { layer, path: 'layer/path.points' });
    }
    const subpaths = cmd.runs.map((r) => ({ points: shapePoints(r, undefined, 'layer/path.points'), open: !r.closed }));
    return {
      scope: scopeLayer(newScope(), layer),
      label: 'Set Shape Outline',
      apply: () => {
        const g = node.components.find((c) => c.type === 'Geometry');
        if (g) {
          graph.writeProp(layer, g.id, 'subpaths', subpaths);
          // `points` and `subpaths` are exclusive (raster/subpaths.ts): the flat run goes.
          if (g.props.points !== undefined) graph.writeProp(layer, g.id, 'points', undefined);
        } else {
          graph.addComponent(layer, { id: `${layer}_g`, type: 'Geometry', props: { subpaths } });
        }
        const t = graph.getNode(layer)!.components.find((c) => c.type === 'Transform');
        if (t) graph.writeProp(layer, t.id, 'shapeType', 'path');
        return {};
      },
    };
  },
};
