/**
 * WorkspaceController — the single app-side owner of the `@motion/workspace`
 * engine. Constructs the engine over the app's ports, coalesces its redraw
 * requests into a rAF, exposes the camera view for the renderer, and offers the
 * high-level actions the viewport UI (tool dock, zoom controls) calls.
 *
 * One instance per app (module singleton) so every surface — canvas, overlay,
 * zoom bar, tool bar — drives the same engine.
 */

import { Workspace, Rect, commands, type CommandPort, type SceneGraphPort } from '@motion/workspace';
import type { Tool as UITool } from '@stores/uiStore';
import type { RenderView } from '@core/rendering/RenderBackend';
import { useSelectionStore } from '@stores/selectionStore';
import { useCompositionStore } from '@stores/compositionStore';
import { createSceneGraphPort, createSelectionPort, createCommandPort } from './ports';

/** Map the app's tool-bar tools onto engine tool ids. */
const TOOL_MAP: Record<UITool, string> = {
  select: 'select', // Select also rotates (rotate handle) and scales (resize handles)
  move: 'move',
  rotate: 'rotate',           // AE W — spin the selection about its anchor
  'pan-behind': 'pan-behind', // AE Y — reposition anchor point without moving layer
  hand: 'hand',
  zoom: 'zoom',
  pen: 'pen',
  pencil: 'pencil',
  brush: 'brush',
  curvature: 'curvature',
  line: 'line',
  text: 'text',
  shape: 'rectangle',
  ellipse: 'ellipse',
  polygon: 'polygon',
  star: 'star',
  'direct-select': 'direct-select',
  'mask-rect': 'mask-rect',
  'mask-ellipse': 'mask-ellipse',
  'mask-pen': 'mask-pen',
  // Like puppet-pin and bone, the HOST owns this gesture: `useWorkspace`'s paint
  // branch captures the pointer and returns before the engine sees it. The
  // mapping only decides what happens when paint has no valid target, and there
  // it is nothing — that branch returns rather than falling through to a marquee.
  paint: 'select',
  eraser: 'select',
  'puppet-pin': 'select',
  bone: 'select',
};

export class WorkspaceController {
  readonly ws: Workspace;

  private readonly commandPort: CommandPort;
  private readonly scenePort: SceneGraphPort;
  /**
   * Render-tick subscribers. This was a SINGLE slot (`renderCb = cb`), but
   * three call sites register: the viewport draw in useWorkspace, and the
   * puppet + bone canvas overlays. Last writer won, so the overlays' "redraw on
   * camera movement" effect was silently dead — VERIFIED: panning the camera
   * with the puppet tool active left the pin handles frozen in place until some
   * unrelated state change (a scene bump) happened to re-render the component,
   * at which point they snapped to the correct position.
   *
   * A Set + disposer means every subscriber gets the tick and unmounting one
   * overlay cannot silently disable another's.
   */
  private renderCbs = new Set<() => void>();
  private rafId: number | null = null;

  /** AE-style auto-fit: when on, the comp is re-framed to fill the viewport on
   *  every viewport resize (panel collapse/expand) and comp-size change. A manual
   *  zoom or pan turns it off so the user's chosen zoom sticks; "Fit in view"
   *  turns it back on. */
  private autoFitEnabled = true;
  /** Guards a programmatic fit so its own CameraChanged doesn't read as a user
   *  gesture and disable auto-fit. */
  private fitting = false;

  constructor() {
    this.commandPort = createCommandPort();
    this.scenePort = createSceneGraphPort();
    this.ws = new Workspace({
      scene: this.scenePort,
      selection: createSelectionPort(),
      commands: this.commandPort,
      renderer: { markDirty: () => this.scheduleRender() },
      viewport: { width: 1280, height: 720, dpr: 1 },
      camera: { minZoom: 0.05, maxZoom: 32 },
    });
    this.ws.initialize();

    // Any camera change the app didn't drive via fitComposition is a user
    // zoom/pan → stop auto-fitting so their framing is preserved.
    this.ws.events.on('CameraChanged', () => {
      if (!this.fitting) this.autoFitEnabled = false;
    });
  }

  /** Whether the viewport should re-fit the comp on the next resize. */
  get autoFit(): boolean {
    return this.autoFitEnabled;
  }

  /**
   * Where a node's box sits on screen, with camera zoom and the layer's own
   * scale. Backs the on-canvas text editor so the overlay matches the glyphs
   * the renderer draws — including a scaled / offset text box, not a tiny
   * unscaled input at the layer origin.
   */
  getNodeScreenPlacement(nodeId: string): {
    x: number;
    y: number;
    zoom: number;
    rotationDeg: number;
    scaleX: number;
    scaleY: number;
  } | null {
    const node = this.scenePort.getNode(nodeId as never);
    if (!node) return null;
    // worldMatrix e/f are the node's world-space origin; its on-screen angle is
    // the matrix's rotation (camera never rotates, only pans/zooms). Scale is
    // the matrix's axis lengths — camera zoom is applied separately.
    const m = node.worldMatrix;
    const screen = this.ws.camera.worldToScreen({ x: m.e, y: m.f });
    return {
      x: screen.x,
      y: screen.y,
      zoom: this.ws.camera.zoom,
      rotationDeg: (Math.atan2(m.b, m.a) * 180) / Math.PI,
      scaleX: Math.hypot(m.a, m.b) || 1,
      scaleY: Math.hypot(m.c, m.d) || 1,
    };
  }

  // ── Render scheduling ────────────────────────────────────────────
  /**
   * Subscribe to render ticks. Returns a disposer — CALL IT on unmount, or the
   * subscriber leaks and keeps ticking against a dead component.
   */
  onRender(cb: () => void): () => void {
    this.renderCbs.add(cb);
    return () => {
      this.renderCbs.delete(cb);
    };
  }

  private scheduleRender(): void {
    if (this.rafId !== null || this.renderCbs.size === 0) return;
    this.rafId = requestAnimationFrame(() => {
      this.rafId = null;
      // Copy first: a subscriber may unsubscribe (or subscribe) during the tick.
      for (const cb of [...this.renderCbs]) cb();
    });
  }

  /** Force an immediate redraw request (e.g. after an external scene change). */
  requestRender(): void {
    this.scheduleRender();
  }

  // ── Camera view for the renderer (comp → canvas, CSS px) ─────────
  getView(): RenderView {
    const origin = this.ws.camera.worldToScreen({ x: 0, y: 0 });
    return { scale: this.ws.camera.zoom, offsetX: origin.x, offsetY: origin.y };
  }

  // ── Viewport sizing ──────────────────────────────────────────────
  resize(cssWidth: number, cssHeight: number, dpr: number, refit: boolean): void {
    this.ws.resize(cssWidth, cssHeight, dpr);
    if (refit) this.fitComposition();
  }

  applyUITool(tool: UITool): void {
    const engineTool = TOOL_MAP[tool] ?? 'select';
    this.ws.setTool(engineTool);
    if (tool === 'paint' || tool === 'brush') this.ws.cursor.setBase('brush');
    else if (tool === 'eraser') this.ws.cursor.setBase('eraser');
  }

  // ── Zoom controls ────────────────────────────────────────────────
  private viewportCenterScreen(): { x: number; y: number } {
    const { width, height } = this.ws.viewport.size;
    return { x: width / 2, y: height / 2 };
  }

  zoomIn(): void {
    this.ws.zoom(1.2, this.viewportCenterScreen());
  }

  zoomOut(): void {
    this.ws.zoom(1 / 1.2, this.viewportCenterScreen());
  }

  setZoomPercent(percent: number): void {
    this.ws.setZoom(percent / 100, this.viewportCenterScreen());
  }

  zoomPercent(): number {
    return Math.round(this.ws.camera.zoom * 100);
  }

  /** Frame the whole composition in the viewport, and (re-)enable auto-fit so it
   *  keeps tracking viewport/comp-size changes until the user zooms or pans.
   *  Zero padding = AE-style fit: the contain-fit is computed from the viewport
   *  and comp sizes, so the comp touches the viewport on the binding axis
   *  (top/bottom for wide comps) instead of floating in a 48px margin. */
  fitComposition(padding = 0): void {
    const { width, height } = useCompositionStore.getState();
    this.fitting = true;
    this.autoFitEnabled = true;
    try {
      this.ws.zoomToFit(Rect.rect(0, 0, width, height), padding);
    } finally {
      this.fitting = false;
    }
  }

  /** Frame the current selection (falls back to fit-all). */
  fitSelection(): void {
    // Duration 0 — INSTANT, like fitComposition. The animated variant needs
    // someone to drive `ws.tick(dt)` per frame and nothing in the editor
    // does, so a non-zero duration here parks the camera mid-flight forever
    // (the reason this method sat unused: it looked broken when tried).
    this.ws.zoomToSelection(64, 0);
  }

  // ── Per-view framing ─────────────────────────────────────────────
  //
  // Each 3D view (Active Camera, the six axis views, the custom views) keeps
  // its OWN pan and zoom, the way After Effects does. They used to share one
  // viewport transform, so panning in Top view also panned Active Camera view —
  // you could not frame a side view without disturbing the shot.

  /** The camera's raw pan/zoom state, for stashing against a view. */
  framing(): { center: { x: number; y: number }; zoom: number } {
    return this.ws.camera.getState();
  }

  /** Restore a stashed pan/zoom. Marked as programmatic so it does not count
   *  as a user gesture and cancel auto-fit. */
  restoreFraming(state: { center: { x: number; y: number }; zoom: number }): void {
    this.fitting = true;
    try {
      this.ws.camera.setState(state);
      // Nudge the camera through a public mutator so the workspace reconciles
      // and emits CameraChanged — setState alone touches only the camera object.
      this.ws.pan(0, 0);
    } finally {
      this.fitting = false;
    }
  }

  // ── Keyboard-driven edits ────────────────────────────────────────
  /** Delete the current selection (Delete/Backspace in the viewport). */
  deleteSelection(): void {
    const ids = useSelectionStore.getState().ids;
    if (ids.length === 0) return;
    this.commandPort.execute(commands.deleteNodes([...ids]));
  }

  /** Nudge the selection by a world-space delta (arrow keys). */
  nudgeSelection(dx: number, dy: number): void {
    const ids = useSelectionStore.getState().ids;
    if (ids.length === 0) return;
    this.commandPort.execute(commands.moveNodes([...ids], { x: dx, y: dy }));
  }
}

let singleton: WorkspaceController | null = null;

/** The app-wide workspace controller (created on first use). */
export function getWorkspaceController(): WorkspaceController {
  if (!singleton) {
    singleton = new WorkspaceController();
    // Dev aid: expose the engine on the window for debugging/inspection.
    const isDev = typeof process !== 'undefined' && process.env ? process.env.NODE_ENV === 'development' : true;
    if (isDev && typeof window !== 'undefined') {
      (window as unknown as { __wsController?: WorkspaceController }).__wsController = singleton;
    }
  }
  return singleton;
}
