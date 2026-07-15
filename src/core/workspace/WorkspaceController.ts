/**
 * WorkspaceController — the single app-side owner of the `@motion/workspace`
 * engine. Constructs the engine over the app's ports, coalesces its redraw
 * requests into a rAF, exposes the camera view for the renderer, and offers the
 * high-level actions the viewport UI (tool dock, zoom controls) calls.
 *
 * One instance per app (module singleton) so every surface — canvas, overlay,
 * zoom bar, tool bar — drives the same engine.
 */

import { Workspace, Rect, commands, type CommandPort } from '@motion/workspace';
import type { Tool as UITool } from '@stores/uiStore';
import type { RenderView } from '@core/rendering/RenderBackend';
import { useSelectionStore } from '@stores/selectionStore';
import { useCompositionStore } from '@stores/compositionStore';
import { createSceneGraphPort, createSelectionPort, createCommandPort } from './ports';

/** Map the app's tool-bar tools onto engine tool ids. */
const TOOL_MAP: Record<UITool, string> = {
  select: 'select', // Select also rotates (rotate handle) and scales (resize handles)
  move: 'move',
  rotate: 'rotate',       // AE W — dedicated rotate interaction (engine falls back to select if unavailable)
  'pan-behind': 'pan-behind', // AE Y — reposition anchor point without moving layer
  hand: 'hand',
  zoom: 'zoom',
  pen: 'pen',
  pencil: 'pencil',
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
};

export class WorkspaceController {
  readonly ws: Workspace;

  private readonly commandPort: CommandPort;
  private renderCb: (() => void) | null = null;
  private rafId: number | null = null;

  constructor() {
    this.commandPort = createCommandPort();
    this.ws = new Workspace({
      scene: createSceneGraphPort(),
      selection: createSelectionPort(),
      commands: this.commandPort,
      renderer: { markDirty: () => this.scheduleRender() },
      viewport: { width: 1280, height: 720, dpr: 1 },
      camera: { minZoom: 0.05, maxZoom: 32 },
    });
    this.ws.initialize();
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

  /** Frame the whole composition in the viewport. */
  fitComposition(padding = 48): void {
    const { width, height } = useCompositionStore.getState();
    this.ws.zoomToFit(Rect.rect(0, 0, width, height), padding);
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
