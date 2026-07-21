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
  'puppet-pin': 'select',
  bone: 'select',
};

export class WorkspaceController {
  readonly ws: Workspace;

  private readonly commandPort: CommandPort;
  private readonly scenePort: SceneGraphPort;
  private renderCb: (() => void) | null = null;
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
   * Where a node's anchor sits on screen, and the current zoom.
   *
   * Backs the on-canvas text editor, which overlays a DOM element on the
   * canvas at the layer's position. Returns null when the node isn't known to
   * the workspace (e.g. it was just deleted).
   */
  getNodeScreenPlacement(nodeId: string): { x: number; y: number; zoom: number; rotationDeg: number } | null {
    const node = this.scenePort.getNode(nodeId as never);
    if (!node) return null;
    // worldMatrix e/f are the node's world-space origin; its on-screen angle is
    // the matrix's rotation (camera never rotates, only pans/zooms).
    const m = node.worldMatrix;
    const screen = this.ws.camera.worldToScreen({ x: m.e, y: m.f });
    return {
      x: screen.x,
      y: screen.y,
      zoom: this.ws.camera.zoom,
      rotationDeg: (Math.atan2(m.b, m.a) * 180) / Math.PI,
    };
  }

  // ── Render scheduling ────────────────────────────────────────────
  onRender(cb: () => void): void {
    this.renderCb = cb;
  }

  private scheduleRender(): void {
    if (this.rafId !== null || !this.renderCb) return;
    this.rafId = requestAnimationFrame(() => {
      this.rafId = null;
      this.renderCb?.();
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

  // ── Tool bar ─────────────────────────────────────────────────────
  applyUITool(tool: UITool): void {
    this.ws.setTool(TOOL_MAP[tool] ?? 'select');
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
    this.ws.zoomToSelection(64, 260);
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
