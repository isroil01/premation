/**
 * Painting a plugin's retained draw list, and routing the pointer back to it.
 *
 * The host half of `core/plugins/uiCanvas.ts`. The plugin describes primitives
 * in ITS layer's space; this applies the layer's transform (parenting, 3D,
 * animation and all — `layerScreenMapping` is the same resolver the puppet,
 * bone and effect-handle overlays use), paints them in screen pixels, and turns
 * a pointer event back into the coordinates the plugin drew in.
 *
 * ── Why a 2D painter and not another React overlay ───────────────────────────
 *
 * Every other overlay in this directory is a React component drawing SVG,
 * because each one has a fixed, known set of shapes. A plugin's list is
 * arbitrary and changes per event, so a component would reconcile hundreds of
 * nodes on every pointer move. The overlay canvas is already repainted whole on
 * every frame by `paintChrome`, and one more pass over a bounded list costs
 * nothing extra.
 *
 * ── The gesture, and the one undo entry ──────────────────────────────────────
 *
 * A pointer-down on a plugin HANDLE claims the gesture: until pointer-up, every
 * move goes to that plugin and no built-in tool sees it. The claim also opens a
 * history bracket (`beginPluginGesture`), so the plugin's writes during the drag
 * collapse into one undo entry — a drag that cost fifty presses of Ctrl-Z would
 * be the one thing that makes plugin handles unusable.
 *
 * A pointer-down anywhere ELSE is not claimed. A plugin that wants the whole
 * viewport contributes a TOOL (`contributes.tools`); drawing alone is not a
 * claim on the canvas, which is what lets a gizmo coexist with Select.
 */

import { activeCompSizeNow } from '@hooks/useMirrorFrame';
import {
  dispatchPluginCanvasEvent,
  findHandleAt,
  pluginDrawLists,
  beginPluginGesture,
  endPluginGesture,
  type PluginCanvasEvent,
  type PluginDrawList,
  type PluginPoint,
} from '@core/plugins/uiCanvas';
import { activePluginTool } from '@core/plugins/uiTools';
import type { WorkspaceController } from '@core/workspace/WorkspaceController';
import { layerScreenMapping, type LayerScreenMapping } from './layerScreen';

/** Modifier flags, in the shape the protocol carries them. */
export interface PluginModifiers { alt: boolean; ctrl: boolean; meta: boolean; shift: boolean }

const NO_MODIFIERS: PluginModifiers = { alt: false, ctrl: false, meta: false, shift: false };

/**
 * One draw list's space, resolved for the frame being painted.
 *
 * `comp` lists get the plain camera; `layer` lists get the layer's full
 * transform. Null when the layer is gone — which happens the instant a user
 * deletes the layer a plugin is drawing on, and must simply drop the drawing
 * rather than throw inside the paint.
 */
function mappingFor(
  list: PluginDrawList,
  controller: WorkspaceController,
  time: number,
): LayerScreenMapping | null {
  const { camera } = controller.ws;
  if (list.space === 'comp' || !list.layerId) {
    return {
      localToScreen: (x, y) => camera.worldToScreen({ x, y }),
      screenToLocal: (x, y) => camera.screenToWorld({ x, y }),
    };
  }
  return layerScreenMapping(list.layerId, time, activeCompSizeNow(), camera);
}

/** Paint every plugin's drawing onto the overlay canvas. */
export function paintPluginDrawLists(
  canvas: HTMLCanvasElement,
  controller: WorkspaceController,
  time: number,
  dpr: number,
): void {
  const lists = pluginDrawLists();
  if (lists.length === 0) return;
  const ctx = canvas.getContext('2d');
  if (!ctx) return;

  ctx.save();
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  for (const { list } of lists) {
    const map = mappingFor(list, controller, time);
    if (!map) continue;
    for (const item of list.items) paintItem(ctx, item, map);
  }
  ctx.restore();
}

function paintItem(
  ctx: CanvasRenderingContext2D,
  item: PluginDrawList['items'][number],
  map: LayerScreenMapping,
): void {
  const p = (x: number, y: number): { x: number; y: number } => map.localToScreen(x, y);
  ctx.lineWidth = 'width' in item && item.width ? item.width : 1;
  ctx.strokeStyle = item.color ?? '#4da3ff';
  ctx.setLineDash([]);

  switch (item.k) {
    case 'line': {
      const a = p(item.from.x, item.from.y);
      const b = p(item.to.x, item.to.y);
      if (item.dash) ctx.setLineDash([4, 3]);
      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(b.x, b.y);
      ctx.stroke();
      ctx.setLineDash([]);
      return;
    }
    case 'rect': {
      // Projected as four CORNERS, not as an origin plus a width: a rotated or
      // skewed layer would otherwise draw an axis-aligned box that does not sit
      // on the thing the plugin is pointing at.
      const c = [
        p(item.x, item.y),
        p(item.x + item.w, item.y),
        p(item.x + item.w, item.y + item.h),
        p(item.x, item.y + item.h),
      ];
      ctx.beginPath();
      ctx.moveTo(c[0]!.x, c[0]!.y);
      for (const q of c.slice(1)) ctx.lineTo(q.x, q.y);
      ctx.closePath();
      if (item.fill) { ctx.fillStyle = item.fill; ctx.fill(); }
      ctx.stroke();
      return;
    }
    case 'circle': {
      const centre = p(item.x, item.y);
      // The radius in SCREEN pixels, measured along the layer's own x axis, so
      // it scales with zoom the way the artwork does.
      const edge = p(item.x + item.r, item.y);
      const r = Math.hypot(edge.x - centre.x, edge.y - centre.y);
      ctx.beginPath();
      ctx.arc(centre.x, centre.y, Math.max(r, 0.5), 0, Math.PI * 2);
      if (item.fill) { ctx.fillStyle = item.fill; ctx.fill(); }
      ctx.stroke();
      return;
    }
    case 'path': {
      ctx.beginPath();
      item.points.forEach((pt, i) => {
        const q = p(pt.x, pt.y);
        if (i === 0) ctx.moveTo(q.x, q.y);
        else ctx.lineTo(q.x, q.y);
      });
      if (item.close) ctx.closePath();
      if (item.fill) { ctx.fillStyle = item.fill; ctx.fill(); }
      ctx.stroke();
      return;
    }
    case 'text': {
      const at = p(item.x, item.y);
      ctx.save();
      // Text is NOT transformed with the layer: a label on a rotated layer
      // would be drawn upside down half the time, and the point of a label is
      // that it can be read.
      ctx.font = `${item.size ?? 11}px var(--font-ui, system-ui), sans-serif`;
      ctx.textAlign = item.align ?? 'left';
      ctx.textBaseline = 'middle';
      ctx.fillStyle = item.color ?? '#4da3ff';
      ctx.fillText(item.text, at.x, at.y);
      ctx.restore();
      return;
    }
    case 'handle': {
      const at = p(item.x, item.y);
      // Handles are drawn in SCREEN pixels and do not scale with zoom — a grab
      // point that shrinks to nothing at 25% is a grab point you cannot grab.
      const r = item.radius ?? 5;
      ctx.beginPath();
      if (item.shape === 'circle') ctx.arc(at.x, at.y, r, 0, Math.PI * 2);
      else ctx.rect(at.x - r, at.y - r, r * 2, r * 2);
      ctx.fillStyle = item.fill ?? '#ffffff';
      ctx.fill();
      ctx.stroke();
      return;
    }
    default:
      // `sanitiseDrawList` drops unknown kinds, so this is unreachable for a
      // list that came through the host API — it is here for the type.
  }
}

// ── Pointer routing ──────────────────────────────────────────────────

/** The plugin currently holding the pointer, and where its gesture started. */
let claim: { pluginId: string; list: PluginDrawList; handleId: string | null } | null = null;

/** The scale from a list's own units to screen pixels, for the grab radius. */
function unitScale(map: LayerScreenMapping): number {
  const a = map.localToScreen(0, 0);
  const b = map.localToScreen(1, 0);
  return Math.hypot(b.x - a.x, b.y - a.y) || 1;
}

function toLocal(map: LayerScreenMapping, screen: PluginPoint): PluginPoint {
  return map.screenToLocal(screen.x, screen.y);
}

function send(
  pluginId: string,
  list: PluginDrawList,
  type: PluginCanvasEvent['type'],
  local: PluginPoint,
  handleId: string | null,
  modifiers: PluginModifiers,
  key?: string,
): void {
  dispatchPluginCanvasEvent(pluginId, {
    type,
    x: local.x,
    y: local.y,
    layerId: list.layerId,
    modifiers,
    ...(handleId ? { handleId } : {}),
    ...(key ? { key } : {}),
  });
}

/**
 * Offer a pointer-down to the plugin overlays. True when one claimed it.
 *
 * Two ways to claim, in order: a plugin's TOOL is active (it owns the whole
 * viewport), or the pointer landed on a plugin's handle. Anything else falls
 * through to the built-in tools untouched.
 */
export function pluginPointerDown(
  controller: WorkspaceController,
  screen: PluginPoint,
  modifiers: PluginModifiers,
  time: number,
): boolean {
  const tool = activePluginTool();
  const lists = pluginDrawLists();

  if (tool) {
    // A tool's plugin owns the gesture whether or not it has drawn anything —
    // the first thing a placement tool does is receive a click on empty canvas.
    const own = lists.find((l) => l.pluginId === tool.pluginId);
    const list: PluginDrawList = own?.list ?? { layerId: null, space: 'comp', items: [] };
    const map = mappingFor(list, controller, time);
    if (!map) return false;
    const local = toLocal(map, screen);
    const hit = own ? findHandleAt(list, local, unitScale(map)) : null;
    claim = { pluginId: tool.pluginId, list, handleId: hit?.id ?? null };
    beginPluginGesture(`${tool.pluginName}: ${tool.tool.label}`);
    send(tool.pluginId, list, 'down', local, hit?.id ?? null, modifiers);
    return true;
  }

  for (const { pluginId, list } of lists) {
    const map = mappingFor(list, controller, time);
    if (!map) continue;
    const local = toLocal(map, screen);
    const hit = findHandleAt(list, local, unitScale(map));
    if (!hit) continue;
    claim = { pluginId, list, handleId: hit.id };
    beginPluginGesture('Drag plugin handle');
    send(pluginId, list, 'down', local, hit.id, modifiers);
    return true;
  }
  return false;
}

/**
 * Offer a pointer-move. True when a gesture is in flight and consumed it.
 *
 * With no claim this still delivers HOVER to any plugin whose handle is under
 * the pointer, and returns false — hover is information, not a claim, and
 * swallowing the move would break every built-in hover in the viewport.
 */
export function pluginPointerMove(
  controller: WorkspaceController,
  screen: PluginPoint,
  modifiers: PluginModifiers,
  time: number,
): boolean {
  if (claim) {
    const map = mappingFor(claim.list, controller, time);
    if (!map) return true;
    send(claim.pluginId, claim.list, 'move', toLocal(map, screen), claim.handleId, modifiers);
    return true;
  }

  for (const { pluginId, list } of pluginDrawLists()) {
    const map = mappingFor(list, controller, time);
    if (!map) continue;
    const local = toLocal(map, screen);
    const hit = findHandleAt(list, local, unitScale(map));
    if (hit) send(pluginId, list, 'hover', local, hit.id, modifiers);
  }
  return false;
}

/** End a claimed gesture, closing its single undo entry. */
export function pluginPointerUp(
  controller: WorkspaceController,
  screen: PluginPoint,
  modifiers: PluginModifiers,
  time: number,
): boolean {
  if (!claim) return false;
  const held = claim;
  claim = null;
  const map = mappingFor(held.list, controller, time);
  if (map) send(held.pluginId, held.list, 'up', toLocal(map, screen), held.handleId, modifiers);
  // After the event, so the plugin's last write is inside the bracket.
  endPluginGesture();
  return true;
}

/**
 * A key press, while a plugin tool is active.
 *
 * Only for a tool: a plugin that has merely drawn something has no claim on the
 * keyboard, and swallowing keys it did not ask for would break every shortcut
 * the user expects to work while looking at the composition.
 */
export function pluginKeyDown(key: string, modifiers: PluginModifiers = NO_MODIFIERS): boolean {
  const tool = activePluginTool();
  if (!tool) return false;
  const own = pluginDrawLists().find((l) => l.pluginId === tool.pluginId);
  const list: PluginDrawList = own?.list ?? { layerId: null, space: 'comp', items: [] };
  send(tool.pluginId, list, 'key', { x: 0, y: 0 }, null, modifiers, key);
  return true;
}

/**
 * Abandon any in-flight gesture.
 *
 * Called on pointer-cancel and when the viewport unmounts. A claim left open
 * would suppress every undo entry in the session — the history bracket is
 * counted, and nothing else closes it.
 */
export function cancelPluginGesture(): void {
  if (!claim) return;
  claim = null;
  endPluginGesture();
}

/** Tests only — the claim is module state. */
export function resetPluginOverlayForTests(): void {
  claim = null;
}
