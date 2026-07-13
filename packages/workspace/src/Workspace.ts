/**
 * Workspace — the interaction engine. It owns and coordinates every subsystem
 * (viewport, camera, coordinates, grid, guides, snapping, hit-testing,
 * selection, cursor, input, tools) and is the single object the host application
 * talks to. It never renders and never mutates the Scene Graph directly: it
 * reads through the `SceneGraphPort`, drives the `SelectionPort`, submits
 * `WorkspaceCommand`s to the `CommandPort`, and tells the `RendererPort` what to
 * repaint.
 *
 *   host events ──▶ InputSystem ──▶ ToolManager ──▶ tools ──▶ commands/camera
 *                                        │
 *   Workspace ◀── subsystems (camera, selection, guides…) ──▶ events + overlay
 *
 * Framework-independent: no DOM, no React, no rendering. A thin binding wires
 * the ports to `@motion/scene` and a canvas; tests use in-memory fakes.
 */

import type { Vec2 } from './math/Vec2';
import type { Rect } from './math/Rect';
import * as R from './math/Rect';

import { TypedEmitter } from './events/Emitter';
import type { WorkspaceEventMap } from './events/WorkspaceEvents';

import { Viewport, type ViewportOptions } from './viewport/Viewport';
import { Camera, type CameraOptions, type CameraState } from './camera/Camera';
import { CameraAnimator, type Easing } from './camera/CameraAnimator';
import { CoordinateSystem } from './coordinates/CoordinateSystem';
import { Grid, type GridState } from './grid/Grid';
import { Guides, type Guide, type GuideAxis } from './guides/Guides';
import { SnapEngine, type SnapSettings, type SnapTarget, type SnapLine, type SnapResult } from './snap/SnapEngine';
import { HitTester, type HitOptions } from './hit/HitTester';
import { SelectionController } from './selection/SelectionController';
import { CursorManager } from './cursor/CursorManager';
import { InputSystem, type InputSink, type DragContext } from './input/InputSystem';
import type { PointerInput, WheelInput, KeyInput } from './input/events';
import { ToolManager } from './tools/ToolManager';
import { createBuiltinTools } from './tools/builtin';
import type { Tool, ToolContext } from './tools/Tool';
import type { WorkspaceState } from './state/WorkspaceState';

import type {
  NodeId,
  SceneGraphPort,
  SelectionPort,
  RendererPort,
  CommandPort,
  WorkspaceCommand,
  WorkspaceNode,
  WorkspaceOverlay,
  OverlayHandle,
  OverlayGuide,
} from './ports';

export interface WorkspaceOptions {
  scene: SceneGraphPort;
  selection: SelectionPort;
  renderer?: RendererPort;
  commands?: CommandPort;
  viewport?: ViewportOptions;
  camera?: CameraOptions;
  grid?: Partial<GridState>;
  snap?: Partial<SnapSettings>;
  /** Register the built-in tool set (default true). */
  registerBuiltinTools?: boolean;
  /** Tool active after initialize (default 'select'). */
  defaultTool?: string;
}

const NOOP_RENDERER: RendererPort = { markDirty: () => {} };
const NOOP_COMMANDS: CommandPort = { execute: () => {} };

export class Workspace implements InputSink {
  readonly events = new TypedEmitter<WorkspaceEventMap>();

  readonly viewport: Viewport;
  readonly camera: Camera;
  readonly animator: CameraAnimator;
  readonly coordinates: CoordinateSystem;
  readonly grid: Grid;
  readonly guides: Guides;
  readonly snap: SnapEngine;
  readonly hitTester: HitTester;
  readonly selectionController: SelectionController;
  readonly cursor: CursorManager;
  readonly input: InputSystem;
  readonly tools: ToolManager;

  private readonly scene: SceneGraphPort;
  private readonly selectionPort: SelectionPort;
  private readonly renderer: RendererPort;
  private readonly commands: CommandPort;
  private readonly disposers: Array<() => void> = [];

  private focused = false;
  private hovered: NodeId | null = null;
  private snapLines: SnapLine[] = [];
  private prevCamera: CameraState;
  private initialized = false;

  constructor(opts: WorkspaceOptions) {
    this.scene = opts.scene;
    this.selectionPort = opts.selection;
    this.renderer = opts.renderer ?? NOOP_RENDERER;
    this.commands = opts.commands ?? NOOP_COMMANDS;

    this.viewport = new Viewport(opts.viewport);
    this.camera = new Camera(opts.camera);
    this.camera.setViewportSize(this.viewport.size.width, this.viewport.size.height);
    this.animator = new CameraAnimator(this.camera);
    this.coordinates = new CoordinateSystem(this.camera, this.viewport);
    this.grid = new Grid(opts.grid);
    this.guides = new Guides();
    this.snap = new SnapEngine();
    if (opts.snap) this.snap.setSettings(opts.snap);
    this.hitTester = new HitTester(this.scene);
    this.selectionController = new SelectionController(this.scene, this.selectionPort, this.hitTester);
    this.cursor = new CursorManager();
    this.input = new InputSystem();

    const ctx = this.makeToolContext();
    this.tools = new ToolManager(ctx, this.events);
    if (opts.registerBuiltinTools !== false) this.tools.registerMany(createBuiltinTools());

    this.prevCamera = this.camera.getState();
    this.wireSubsystems();
    this.input.connect(this);

    const defaultTool = opts.defaultTool ?? 'select';
    if (this.tools.get(defaultTool)) this.tools.setActive(defaultTool);
  }

  // ── Lifecycle ────────────────────────────────────────────────────
  /** Finish setup: build the hit index and paint the first overlay. */
  initialize(): void {
    if (this.initialized) return;
    this.initialized = true;
    this.hitTester.rebuild();
    this.pushOverlay();
    this.renderer.markDirty();
  }

  dispose(): void {
    for (const d of this.disposers) d();
    this.disposers.length = 0;
    this.events.removeAll();
    this.input.reset();
  }

  // ── Focus ────────────────────────────────────────────────────────
  setFocused(focused: boolean): void {
    if (this.focused === focused) return;
    this.focused = focused;
    if (!focused) this.input.reset();
    this.events.emit('WorkspaceFocused', { focused });
  }

  get isFocused(): boolean {
    return this.focused;
  }

  // ── Viewport ─────────────────────────────────────────────────────
  resize(width: number, height: number, dpr?: number): void {
    let changed = this.viewport.resize(width, height);
    if (dpr !== undefined) changed = this.viewport.setDpr(dpr) || changed;
    this.camera.setViewportSize(this.viewport.size.width, this.viewport.size.height);
    if (changed) {
      this.events.emit('ViewportChanged', { viewport: this.viewport.getState() });
      this.reconcile();
    }
  }

  /** Set the canvas's offset within screen/client space (from getBoundingClientRect). */
  setViewportOffset(x: number, y: number): void {
    if (this.viewport.setOffset(x, y)) {
      this.events.emit('ViewportChanged', { viewport: this.viewport.getState() });
    }
  }

  // ── Camera / navigation ──────────────────────────────────────────
  pan(dxScreen: number, dyScreen: number): void {
    this.camera.panByScreen(dxScreen, dyScreen);
    this.reconcile();
  }

  panWorld(dx: number, dy: number): void {
    this.camera.panByWorld(dx, dy);
    this.reconcile();
  }

  zoom(factor: number, anchorScreen?: Vec2): void {
    const anchor = anchorScreen ? this.viewport.screenToViewport(anchorScreen) : undefined;
    this.camera.zoomBy(factor, anchor);
    this.reconcile();
  }

  setZoom(zoom: number, anchorScreen?: Vec2): void {
    const anchor = anchorScreen ? this.viewport.screenToViewport(anchorScreen) : undefined;
    this.camera.zoomTo(zoom, anchor);
    this.reconcile();
  }

  /** Frame a world rect (default: everything). Animated when `durationMs > 0`. */
  zoomToFit(worldRect?: Rect, padding = 48, durationMs = 0): void {
    const rect = worldRect ?? this.contentBounds();
    if (!rect) return;
    if (durationMs > 0) {
      const target = this.cameraStateFramingRect(rect, padding);
      this.animator.animateTo(target, durationMs, undefined, () => this.reconcile());
    } else {
      this.camera.zoomToRect(rect, padding);
    }
    this.reconcile();
  }

  /** Frame the current selection (falls back to fit-all when empty). */
  zoomToSelection(padding = 64, durationMs = 0): void {
    const bounds = this.selectionController.selectionBounds();
    this.zoomToFit(bounds ?? undefined, padding, durationMs);
  }

  centerOn(worldPoint: Vec2, durationMs = 0): void {
    if (durationMs > 0) {
      this.animator.animateTo({ center: worldPoint, zoom: this.camera.zoom }, durationMs, undefined, () =>
        this.reconcile(),
      );
    } else {
      this.camera.centerOn(worldPoint);
    }
    this.reconcile();
  }

  /** Animate to an explicit camera state. */
  animateCamera(target: CameraState, durationMs = 300, easing?: Easing): void {
    this.animator.animateTo(target, durationMs, easing, () => this.reconcile());
    this.reconcile();
  }

  reset(): void {
    this.animator.cancel();
    this.camera.reset();
    this.reconcile();
  }

  /**
   * Advance time-based animation. The host calls this from its frame loop with
   * the elapsed ms; returns true while the camera is still animating.
   */
  tick(dtMs: number): boolean {
    const animating = this.animator.update(dtMs);
    if (animating) this.reconcile();
    return animating;
  }

  // ── Coordinate conversion (public API) ───────────────────────────
  screenToWorld(screen: Vec2): Vec2 {
    return this.coordinates.screenToWorld(screen);
  }

  worldToScreen(world: Vec2): Vec2 {
    return this.coordinates.worldToScreen(world);
  }

  // ── Hit testing (public API) ─────────────────────────────────────
  hitTest(worldPoint: Vec2, opts?: HitOptions): WorkspaceNode | null {
    return this.hitTester.hitTest(worldPoint, opts);
  }

  hitTestScreen(screen: Vec2, opts?: HitOptions): WorkspaceNode | null {
    return this.hitTester.hitTest(this.screenToWorld(screen), opts);
  }

  // ── Selection (public API) ───────────────────────────────────────
  select(ids: NodeId | Iterable<NodeId>): void {
    if (typeof ids === 'string') this.selectionPort.set([ids]);
    else this.selectionPort.set(ids);
  }

  selectAll(): void {
    this.selectionController.selectAll();
  }

  clearSelection(): void {
    this.selectionPort.clear();
  }

  getSelection(): readonly NodeId[] {
    return this.selectionPort.get();
  }

  // ── Tools (public API) ───────────────────────────────────────────
  setTool(id: string): boolean {
    return this.tools.setActive(id);
  }

  getTool(): string | null {
    return this.tools.activeToolId;
  }

  registerTool(tool: Tool): void {
    this.tools.register(tool);
  }

  // ── Grid / guides / snapping (public API) ────────────────────────
  setGrid(patch: Partial<GridState>): void {
    this.grid.setState(patch);
    this.events.emit('GridChanged', { grid: this.grid.getState() });
    this.renderer.markDirty();
  }

  addGuide(axis: GuideAxis, worldPosition: number): Guide {
    return this.guides.add(axis, worldPosition);
  }

  removeGuide(id: string): boolean {
    return this.guides.remove(id);
  }

  setSnap(patch: Partial<SnapSettings>): void {
    this.snap.setSettings(patch);
  }

  // ── Overlay / state (public API) ─────────────────────────────────
  /** The current interaction overlay, in screen pixels, for the renderer. */
  overlay(): WorkspaceOverlay {
    return this.buildOverlay();
  }

  getState(): WorkspaceState {
    return {
      focused: this.focused,
      activeTool: this.tools.activeToolId,
      cursor: this.cursor.current,
      camera: this.camera.getState(),
      zoom: this.camera.zoom,
      viewport: this.viewport.getState(),
      grid: this.grid.getState(),
      guides: this.guides.list(),
      snap: this.snap.getSettings(),
      selection: this.selectionPort.get(),
      hovered: this.hovered,
    };
  }

  // ── Input feed (called by the host adapter) ──────────────────────
  feedPointerDown(e: PointerInput): void {
    this.input.feedPointerDown(e);
  }
  feedPointerMove(e: PointerInput): void {
    this.input.feedPointerMove(e);
  }
  feedPointerUp(e: PointerInput): void {
    this.input.feedPointerUp(e);
  }
  feedPointerCancel(e: PointerInput): void {
    this.input.feedPointerCancel(e);
  }
  feedWheel(e: WheelInput): void {
    this.input.feedWheel(e);
  }
  feedKeyDown(e: KeyInput): void {
    this.input.feedKeyDown(e);
  }
  feedKeyUp(e: KeyInput): void {
    this.input.feedKeyUp(e);
  }

  // ── InputSink: hover + tool routing + reconcile ──────────────────
  onPointerDown(e: PointerInput): void {
    this.tools.onPointerDown(e);
    this.reconcile();
  }
  onPointerMove(e: PointerInput): void {
    this.updateHover(e.position);
    this.tools.onPointerMove(e);
    this.reconcile();
  }
  onPointerUp(e: PointerInput): void {
    this.tools.onPointerUp(e);
    this.reconcile();
  }
  onClick(e: PointerInput): void {
    this.tools.onClick(e);
    this.reconcile();
  }
  onDoubleClick(e: PointerInput): void {
    this.tools.onDoubleClick(e);
    this.reconcile();
  }
  onDragStart(c: DragContext): void {
    this.tools.onDragStart(c);
    this.reconcile();
  }
  onDrag(c: DragContext): void {
    this.tools.onDrag(c);
    this.reconcile();
  }
  onDragEnd(c: DragContext): void {
    this.tools.onDragEnd(c);
    this.reconcile();
  }
  onWheel(e: WheelInput): void {
    this.tools.onWheel(e);
    this.reconcile();
  }
  onKeyDown(e: KeyInput): void {
    // Global shortcuts first (space → temporary hand), then the active tool.
    if (e.code === 'Space' && !this.input.isDragging) {
      this.tools.pushTemporary('hand');
    } else if (!e.modifiers.mod && !e.modifiers.ctrl && !e.modifiers.meta && e.key.length === 1) {
      this.tools.activateByShortcut(e.key);
    }
    this.tools.onKeyDown(e);
    this.reconcile();
  }
  onKeyUp(e: KeyInput): void {
    if (e.code === 'Space') this.tools.popTemporary();
    this.tools.onKeyUp(e);
    this.reconcile();
  }

  // ── Internal wiring ──────────────────────────────────────────────
  private wireSubsystems(): void {
    // Selection truth lives in the port; mirror its changes as events.
    this.disposers.push(
      this.selectionPort.onChanged((selected) => {
        this.events.emit('SelectionChanged', { selected, previous: [] });
        this.pushOverlay();
        this.renderer.markDirty();
      }),
    );
    // Rebuild the spatial index whenever the graph changes structurally.
    this.disposers.push(
      this.scene.onChanged(() => {
        this.hitTester.rebuild();
        this.pushOverlay();
        this.renderer.markDirty();
      }),
    );
    // Surface guide + cursor changes.
    this.disposers.push(this.guides.events.on('added', ({ guide }) => this.events.emit('GuideAdded', { guide })).dispose);
    this.disposers.push(
      this.guides.events.on('removed', ({ guideId }) => this.events.emit('GuideRemoved', { guideId })).dispose,
    );
    this.disposers.push(this.guides.events.on('moved', ({ guide }) => this.events.emit('GuideMoved', { guide })).dispose);
    this.disposers.push(
      this.cursor.events.on('changed', ({ cursor }) => this.events.emit('CursorChanged', { cursor })).dispose,
    );
  }

  private makeToolContext(): ToolContext {
    const self = this;
    return {
      camera: this.camera,
      viewport: this.viewport,
      coordinates: this.coordinates,
      selection: this.selectionController,
      hitTester: this.hitTester,
      cursor: this.cursor,
      snap: this.snap,
      grid: this.grid,
      guides: this.guides,
      scene: this.scene,
      commands: this.commands,
      events: this.events,
      selectionIds() {
        return self.selectionPort.get();
      },
      screenToWorld(screen: Vec2) {
        return self.coordinates.screenToWorld(screen);
      },
      screenToViewport(screen: Vec2) {
        return self.viewport.screenToViewport(screen);
      },
      requestRender() {
        self.pushOverlay();
        self.renderer.markDirty();
      },
      setTool(id: string) {
        self.tools.setActive(id);
      },
      execute(command: WorkspaceCommand) {
        self.commands.execute(command);
      },
      setSnapLines(lines) {
        self.snapLines = [...lines];
      },
      buildSnapTargets(region: Rect, excludeIds?: ReadonlySet<string>) {
        return self.buildSnapTargets(region, excludeIds);
      },
      snapRect(rect: Rect, excludeIds?: ReadonlySet<string>): SnapResult<Rect> {
        const { targets, thresholdWorld } = self.buildSnapTargets(
          R.inflate(rect, self.camera.screenDistanceToWorld(self.snap.getSettings().thresholdPx) + 4),
          excludeIds,
        );
        return self.snap.snapRect(rect, targets, thresholdWorld);
      },
    };
  }

  /** Assemble grid + guide + object snap targets for a world region. */
  private buildSnapTargets(
    region: Rect,
    excludeIds?: ReadonlySet<string>,
  ): { targets: SnapTarget[]; thresholdWorld: number } {
    const settings = this.snap.getSettings();
    const targets: SnapTarget[] = [];
    if (settings.enabled) {
      if (settings.toGrid && this.grid.getState().visible) {
        const spacing = this.grid.adaptiveSpacing(this.camera.zoom);
        targets.push(...SnapEngine.gridTargets(region, spacing));
      }
      if (settings.toGuides) {
        for (const x of this.guides.verticalPositions()) targets.push({ axis: 'x', position: x, source: 'guide' });
        for (const y of this.guides.horizontalPositions()) targets.push({ axis: 'y', position: y, source: 'guide' });
      }
      if (settings.toObjects) {
        const nodes = this.hitTester.hitTestRegion(region, 'intersect', { includeLocked: true });
        const bounds: Rect[] = [];
        for (const n of nodes) {
          if (excludeIds && excludeIds.has(n.id)) continue;
          bounds.push(n.worldBounds);
        }
        targets.push(...SnapEngine.objectTargets(bounds));
      }
    }
    const thresholdWorld = this.camera.screenDistanceToWorld(settings.thresholdPx);
    return { targets, thresholdWorld };
  }

  private updateHover(screen: Vec2): void {
    if (!this.viewport.containsViewportPoint(this.viewport.screenToViewport(screen))) return;
    const node = this.hitTester.hitTest(this.screenToWorld(screen));
    const id = node?.id ?? null;
    if (id !== this.hovered) {
      const previous = this.hovered;
      this.hovered = id;
      this.events.emit('HoverChanged', { hovered: id, previous });
      this.pushOverlay();
      this.renderer.markDirty();
    }
  }

  /** Emit camera/pan/zoom deltas and refresh the overlay after any change. */
  private reconcile(): void {
    const cam = this.camera.getState();
    const prev = this.prevCamera;
    const zoomChanged = cam.zoom !== prev.zoom;
    const panChanged = cam.center.x !== prev.center.x || cam.center.y !== prev.center.y;
    if (zoomChanged) this.events.emit('ZoomChanged', { zoom: cam.zoom, previous: prev.zoom });
    if (panChanged) this.events.emit('PanChanged', { center: cam.center, previous: prev.center });
    if (zoomChanged || panChanged) this.events.emit('CameraChanged', { camera: cam });
    this.prevCamera = cam;
    if (this.selectionController.marquee.active) {
      this.events.emit('MarqueeChanged', { rect: this.selectionController.marqueeRect });
    }
    this.pushOverlay();
    this.renderer.markDirty();
  }

  private pushOverlay(): void {
    this.renderer.setOverlay?.(this.buildOverlay());
  }

  private buildOverlay(): WorkspaceOverlay {
    const selBounds = this.selectionController.selectionBounds();
    const selectionBounds = selBounds ? this.worldRectToScreen(selBounds) : null;

    const activeTool = this.tools.activeTool;
    const ctx = this.makeToolContext();
    const handles: OverlayHandle[] = activeTool?.getHandles
      ? activeTool.getHandles(ctx).map((h) => ({ id: h.id, position: this.worldToScreen(h.position), kind: h.kind }))
      : this.selectionController
          .handles(this.camera.screenDistanceToWorld(24))
          .map((h) => ({ id: h.id, position: this.worldToScreen(h.position), kind: h.kind }));

    const marqueeWorld = this.selectionController.marqueeRect;
    const marquee = marqueeWorld ? this.worldRectToScreen(marqueeWorld) : null;

    const snapLines: SnapLine[] = this.snapLines.map((l) => this.snapLineToScreen(l));

    const guides: OverlayGuide[] = this.guides.list().map((g) => ({
      axis: g.axis,
      position:
        g.axis === 'x' ? this.worldToScreen({ x: g.position, y: 0 }).x : this.worldToScreen({ x: 0, y: g.position }).y,
      locked: g.locked,
    }));

    const hoveredNode = this.hovered ? this.scene.getNode(this.hovered) : undefined;
    const hoveredBounds = hoveredNode ? this.worldRectToScreen(hoveredNode.worldBounds) : null;

    const pendingPathWorld = activeTool?.pendingPoints as import('./math/BezierPoint').BezierPoint[] | undefined;
    const pendingPath = pendingPathWorld
      ? pendingPathWorld.map((p) => {
          const sp  = this.worldToScreen({ x: p.x,    y: p.y    });
          const sIn = this.worldToScreen({ x: p.inX,  y: p.inY  });
          const sOut= this.worldToScreen({ x: p.outX, y: p.outY });
          return { x: sp.x, y: sp.y, inX: sIn.x, inY: sIn.y, outX: sOut.x, outY: sOut.y };
        })
      : undefined;

    return { selectionBounds, handles, marquee, snapLines, guides, hoveredBounds, pendingPath };
  }

  private worldRectToScreen(worldRect: Rect): Rect {
    const a = this.worldToScreen({ x: worldRect.x, y: worldRect.y });
    const b = this.worldToScreen({ x: worldRect.x + worldRect.width, y: worldRect.y + worldRect.height });
    return R.fromPoints(a, b);
  }

  private snapLineToScreen(l: SnapLine): SnapLine {
    if (l.axis === 'x') {
      const position = this.worldToScreen({ x: l.position, y: 0 }).x;
      const from = this.worldToScreen({ x: 0, y: l.from }).y;
      const to = this.worldToScreen({ x: 0, y: l.to }).y;
      return { axis: 'x', position, from, to, source: l.source };
    }
    const position = this.worldToScreen({ x: 0, y: l.position }).y;
    const from = this.worldToScreen({ x: l.from, y: 0 }).x;
    const to = this.worldToScreen({ x: l.to, y: 0 }).x;
    return { axis: 'y', position, from, to, source: l.source };
  }

  /** Union of all node world bounds (for zoom-to-fit). */
  private contentBounds(): Rect | null {
    const rects: Rect[] = [];
    for (const n of this.scene.getNodes()) rects.push(n.worldBounds);
    return R.bounds(rects);
  }

  private cameraStateFramingRect(rect: Rect, padding: number): CameraState {
    const availW = Math.max(1, this.viewport.size.width - padding * 2);
    const availH = Math.max(1, this.viewport.size.height - padding * 2);
    const zoom = Math.min(availW / Math.max(1e-6, rect.width), availH / Math.max(1e-6, rect.height));
    return { center: { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 }, zoom };
  }
}
