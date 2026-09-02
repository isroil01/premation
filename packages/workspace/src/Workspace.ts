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
import type { Corners } from './math/OrientedBox';

import { TypedEmitter } from './events/Emitter';
import type { WorkspaceEventMap } from './events/WorkspaceEvents';

import { Viewport, type ViewportOptions } from './viewport/Viewport';
import { Camera, type CameraOptions, type CameraState } from './camera/Camera';
import { CameraAnimator, type Easing } from './camera/CameraAnimator';
import { CoordinateSystem } from './coordinates/CoordinateSystem';
import { Grid, type GridState } from './grid/Grid';
import { Guides, type Guide, type GuideAxis } from './guides/Guides';
import { SnapEngine, type SnapSettings, type SnapTarget, type SnapLine, type SnapResult } from './snap/SnapEngine';
import { measureBetween, smartGuides as computeSmartGuides, type Gap } from './snap/smartGuides';
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
  SmartGuideOverlayData,
  SmartGuideSpan,
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

/**
 * Click slack, in SCREEN pixels, for a layer whose projection has collapsed to a
 * line — a flat 3D layer seen edge-on from Left / Right / Top / Bottom.
 *
 * Small on purpose: it is the grab radius around a hairline, not a general
 * fuzziness budget. Nothing with projected area uses it.
 */
const EDGE_HIT_TOLERANCE_PX = 4;

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
  /**
   * Alt-hover measuring: while true, the overlay measures the distance from the
   * selection to whatever is hovered, with no drag in flight. Set by the host
   * (which owns the keyboard), because the engine is only fed the keys the host
   * decides to forward and Alt is not one of them.
   */
  private measureHover = false;
  private prevCamera: CameraState;
  private initialized = false;
  private restoreTemporaryAfterDrag = false;

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
    // Read through a closure, not a captured number: the tolerance has to track
    // the LIVE zoom, or an edge-on layer stops being clickable the moment you
    // zoom out from wherever the workspace happened to be constructed.
    this.hitTester = new HitTester(this.scene, undefined, () =>
      this.camera.screenDistanceToWorld(EDGE_HIT_TOLERANCE_PX),
    );
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
    this.input.cancel();
    for (const d of this.disposers) d();
    this.disposers.length = 0;
    this.events.removeAll();
  }

  // ── Focus ────────────────────────────────────────────────────────
  setFocused(focused: boolean): void {
    if (this.focused === focused) return;
    this.focused = focused;
    if (!focused) this.input.cancel();
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

  /**
   * Turn Alt-hover measuring on or off (the host owns the Alt key).
   *
   * Idempotent, and only repaints when the flag actually flips — Alt auto-repeats
   * while held, and repainting the whole overlay per repeat is a needless frame.
   */
  setMeasureHover(active: boolean): void {
    if (this.measureHover === active) return;
    this.measureHover = active;
    this.pushOverlay();
    this.renderer.markDirty();
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

  /** Release Space's temporary tool without changing tools mid-drag. */
  releaseTemporaryTool(): void {
    if (this.input.isDragging) {
      this.restoreTemporaryAfterDrag = true;
      return;
    }
    this.restoreTemporaryAfterDrag = false;
    this.tools.popTemporary();
    this.reconcile();
  }

  /** Drop transient input/tool state when the host window loses focus. */
  cancelTransientInput(): void {
    this.input.cancel();
    this.restoreTemporaryAfterDrag = false;
    this.tools.popTemporary();
    this.reconcile();
  }

  // ── InputSink: hover + tool routing + reconcile ──────────────────
  onPointerDown(e: PointerInput): void {
    this.tools.onPointerDown(e);
    this.reconcile();
  }
  onPointerMove(e: PointerInput): void {
    // No hover resolution mid-drag: the drag target is already fixed, and the
    // hit test's `ensureFresh` rebuilds the whole spatial index — which the
    // drag's own scene writes re-dirty every event, so hovering while dragging
    // paid an O(nodes) rebuild per pointermove for a highlight nobody can see.
    // Hover recomputes on the first move after release.
    if (!this.input.isDragging) this.updateHover(e.position);
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
    if (this.restoreTemporaryAfterDrag) {
      this.restoreTemporaryAfterDrag = false;
      this.tools.popTemporary();
    }
    this.reconcile();
  }
  onWheel(e: WheelInput): void {
    this.tools.onWheel(e);
    this.reconcile();
  }
  /** True when the active tool consumed the key — see `onToolKey`. */
  onKeyDown(e: KeyInput): boolean {
    // Global shortcuts first (space → temporary hand), then the active tool.
    if (e.code === 'Space' && !this.input.isDragging) {
      this.tools.pushTemporary('hand');
    } else if (!e.modifiers.mod && !e.modifiers.ctrl && !e.modifiers.meta && e.key.length === 1) {
      this.tools.activateByShortcut(e.key);
    }
    const handled = this.tools.onKeyDown(e);
    this.reconcile();
    return handled;
  }

  /**
   * Feed a key to the ACTIVE TOOL ONLY, and report whether it consumed it.
   *
   * `onKeyDown` above is the whole keyboard channel: it also claims Space for
   * the temporary hand tool and treats any unmodified single character as a
   * tool shortcut. An embedder that already owns its own shortcut system — the
   * editor does, via `shortcutOverrides` — cannot use that channel without
   * every letter it types in the viewport silently switching tools. So it had
   * no way to reach a tool's keyboard at all, and the pen's Enter (finish) and
   * Escape (cancel) were unreachable: an in-progress outline could only be
   * committed by double-clicking and could not be abandoned at all.
   *
   * This is that channel with the global shortcuts left out.
   */
  onToolKey(e: KeyInput): boolean {
    const handled = this.tools.onKeyDown(e);
    this.reconcile();
    return handled;
  }
  onKeyUp(e: KeyInput): void {
    if (e.code === 'Space') this.releaseTemporaryTool();
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
    // Invalidate the spatial index whenever the graph changes structurally.
    // Deferred, not rebuilt: this listener fires on every scene bump AND every
    // playhead tick (onChanged also subscribes to time), and an eager rebuild
    // enumerated the whole scene each time — the index is only consumed on
    // pointer interaction, where HitTester.ensureFresh rebuilds once.
    this.disposers.push(
      this.scene.onChanged(() => {
        this.hitTester.markDirty();
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
    // Arrow properties rather than shorthand methods + `const self = this`.
    // Each one closes over the instance lexically, so the context keeps working
    // when a tool destructures it — which a shorthand method would not.
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
      selectionIds: () => this.selectionPort.get(),
      screenToWorld: (screen: Vec2) => this.coordinates.screenToWorld(screen),
      screenToViewport: (screen: Vec2) => this.viewport.screenToViewport(screen),
      requestRender: () => {
        this.pushOverlay();
        this.renderer.markDirty();
      },
      setTool: (id: string) => { this.tools.setActive(id); },
      execute: (command: WorkspaceCommand) => { this.commands.execute(command); },
      setSnapLines: (lines) => { this.snapLines = [...lines]; },
      buildSnapTargets: (region: Rect, excludeIds?: ReadonlySet<string>) =>
        this.buildSnapTargets(region, excludeIds),
      snapRect: (rect: Rect, excludeIds?: ReadonlySet<string>): SnapResult<Rect> =>
        this.snapRect(rect, excludeIds),
    };
  }

  /**
   * Snap a world rect against the live grid / guide / object targets.
   *
   * Public because it is the only way to ask "what would snapping do here?"
   * without driving a full pointer gesture — the tool context just forwards to
   * it, so tools and callers can never disagree about the answer.
   */
  snapRect(rect: Rect, excludeIds?: ReadonlySet<string>): SnapResult<Rect> {
    const region = R.inflate(rect, this.camera.screenDistanceToWorld(this.snap.getSettings().thresholdPx) + 4);
    // During a drag, snap targets are rebuilt at most once per REGION, not once
    // per pointermove. The per-move rebuild was O(scene): the drag's own scene
    // write dirties the spatial index every event, so `hitTestRegion` inside
    // `buildSnapTargets` re-enumerated every node per move — and the answers
    // never change mid-drag (the moving layers are excluded; everything else
    // holds still). The cache covers a screen-plus of travel and rebuilds when
    // the drag leaves it or the zoom changes (the threshold is zoom-relative).
    if (this.input.isDragging) {
      const zoom = this.camera.zoom;
      const c = this.dragSnapCache;
      if (c && c.zoom === zoom && R.containsRect(c.region, region)) {
        return this.snap.snapRect(rect, c.targets, c.thresholdWorld, c.bounds);
      }
      const wide = R.inflate(region, this.camera.screenDistanceToWorld(1500));
      const built = this.buildSnapTargets(wide, excludeIds);
      this.dragSnapCache = {
        region: wide,
        zoom,
        targets: built.targets,
        thresholdWorld: built.thresholdWorld,
        bounds: built.bounds,
      };
      return this.snap.snapRect(rect, built.targets, built.thresholdWorld, built.bounds);
    }
    this.dragSnapCache = null;
    const { targets, thresholdWorld, bounds } = this.buildSnapTargets(region, excludeIds);
    return this.snap.snapRect(rect, targets, thresholdWorld, bounds);
  }

  /**
   * Per-gesture snap-target cache — see `snapRect`.
   *
   * `bounds` are the neighbours' whole rects, kept alongside the 1-D targets
   * derived from them: equal-SPACING needs the boxes themselves (a gap is
   * between two edges of two different rects), and re-querying the hit tester
   * for them per pointermove is the O(scene) cost this cache exists to avoid.
   */
  private dragSnapCache: {
    region: Rect;
    zoom: number;
    targets: SnapTarget[];
    thresholdWorld: number;
    bounds: Rect[];
  } | null = null;

  /** Assemble grid + guide + object snap targets for a world region. */
  private buildSnapTargets(
    region: Rect,
    excludeIds?: ReadonlySet<string>,
  ): { targets: SnapTarget[]; thresholdWorld: number; bounds: Rect[] } {
    const settings = this.snap.getSettings();
    const targets: SnapTarget[] = [];
    let objectBounds: Rect[] = [];
    if (settings.enabled) {
      // NOT gated on `grid.visible`. After Effects keeps Show Grid and Snap to
      // Grid as independent commands and snaps to a hidden grid; `toGrid` IS
      // the Snap to Grid switch. Gating on visibility instead makes the two
      // impossible to separate, which is a different product.
      if (settings.toGrid) {
        targets.push(...SnapEngine.gridTargets(region, this.grid.snapSpacing(this.camera.zoom)));
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
        objectBounds = bounds;
      }
    }
    const thresholdWorld = this.camera.screenDistanceToWorld(settings.thresholdPx);
    return { targets, thresholdWorld, bounds: objectBounds };
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
    // The drawn outline: one oriented box per layer. Corners are projected
    // INDIVIDUALLY — mapping the AABB and rotating it afterwards would be the
    // same lie in a different place.
    const selectionBoxes = this.selectionController
      .selectionBoxes()
      .map((b) => ({ id: b.id, corners: this.cornersToScreen(b.corners) }));

    const activeTool = this.tools.activeTool;
    const ctx = this.makeToolContext();
    const hoveredHandle = activeTool?.hoveredHandleId?.() ?? null;
    const decorate = (h: { id: string; position: Vec2; kind: OverlayHandle['kind'] }): OverlayHandle => ({
      id: h.id,
      position: this.worldToScreen(h.position),
      kind: h.kind,
      ...(h.id === hoveredHandle ? { hovered: true } : {}),
    });
    const handles: OverlayHandle[] = activeTool?.getHandles
      ? activeTool.getHandles(ctx).map(decorate)
      : this.selectionController.handles().map(decorate);

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
    const hoveredCorners = hoveredNode
      ? this.cornersToScreen(hoveredNode.worldCorners ?? (R.corners(hoveredNode.worldBounds) as Corners))
      : null;

    const pendingPathWorld = activeTool?.pendingPoints as import('./math/BezierPoint').BezierPoint[] | undefined;
    const pendingPath = pendingPathWorld
      ? pendingPathWorld.map((p) => {
          const sp  = this.worldToScreen({ x: p.x,    y: p.y    });
          const sIn = this.worldToScreen({ x: p.inX,  y: p.inY  });
          const sOut= this.worldToScreen({ x: p.outX, y: p.outY });
          return { x: sp.x, y: sp.y, inX: sIn.x, inY: sIn.y, outX: sOut.x, outY: sOut.y };
        })
      : undefined;

    // The active drag's numeric readout (Δ / size / angle) — the 2D twin of
    // the 3D gizmo's measurement badge. Screen-anchored beside the pointer.
    const hud = activeTool?.getHud?.(ctx) ?? null;
    const dragHud = hud ? { anchor: this.worldToScreen(hud.anchorWorld), lines: hud.lines } : null;

    return {
      selectionBounds,
      selectionBoxes,
      handles,
      marquee,
      snapLines,
      guides,
      hoveredBounds,
      hoveredCorners,
      pendingPath,
      dragHud,
      smartGuides: this.buildSmartGuides(),
    };
  }

  /**
   * The measurement chrome for the gesture in flight — distances to the nearest
   * neighbour on each side, any equal-spacing run the drag is sitting in, and
   * neighbours of matching size.
   *
   * Computed HERE rather than in the tools because it is a property of where
   * the selection currently is, not of how it got there: a resize, a move, a
   * nudge from another surface and an Alt-hover all want the same answer, and
   * the tools would each have to grow their own copy of it.
   *
   * Returns null unless something is actually happening — no gesture and no
   * Alt-hover means no chrome, which is the whole reason the canvas stays calm.
   */
  private buildSmartGuides(): SmartGuideOverlayData | null {
    const settings = this.snap.getSettings();
    if (!settings.smartGuides) return null;
    const dragging = this.input.isDragging;
    // Between gestures the neighbour list is worthless — layers may have been
    // added, deleted or moved since — so it is dropped rather than staled.
    if (!dragging) this.smartNeighbours = null;
    const measuring = !dragging && this.measureHover;
    if (!dragging && !measuring) return null;
    // A marquee is a drag, but nothing is being POSITIONED by it — measuring
    // the stationary selection while the user rubber-bands around it is chrome
    // about something that is not happening.
    if (dragging && this.selectionController.marquee.active) return null;
    const bounds = this.selectionController.selectionBounds();
    if (!bounds) return null;

    let gaps: Gap[] = [];
    let sizeMatchRects: Rect[] = [];
    const equalSpans = new Set<Gap>();

    if (measuring) {
      // Alt-hover: measure to ONE named box — whatever the pointer is over —
      // and say nothing about anything else. Hovering a selected layer would
      // measure it against itself, so that case draws nothing.
      const id = this.hovered;
      if (!id) return null;
      const selected = new Set<string>(this.selectionPort.get());
      if (selected.has(id)) return null;
      const node = this.scene.getNode(id);
      if (!node) return null;
      gaps = measureBetween(bounds, node.worldBounds);
      if (gaps.length === 0) return null;
    } else {
      const selected = new Set<string>(this.selectionPort.get());
      /*
       * The neighbours are cached for the length of the gesture.
       *
       * Nothing but the selection moves during a drag, so re-querying the hit
       * tester per frame buys nothing and costs an index rebuild every time —
       * the drag's own scene writes dirty it on every pointermove. Same reason
       * `dragSnapCache` exists; this one is keyed on the camera and the
       * selection instead of a region, because the query covers the whole
       * visible world and only those two can change what it would return.
       */
      const cam = this.camera.getState();
      const key = `${cam.zoom}|${cam.center.x}|${cam.center.y}|${[...selected].sort().join(',')}`;
      let others: Rect[];
      if (this.smartNeighbours && this.smartNeighbours.key === key) {
        others = this.smartNeighbours.bounds;
      } else {
        others = [];
        const region = this.camera.visibleWorldRect();
        for (const n of this.hitTester.hitTestRegion(region, 'intersect', { includeLocked: true })) {
          if (selected.has(n.id)) continue;
          others.push(n.worldBounds);
        }
        this.smartNeighbours = { key, bounds: others };
      }
      if (others.length === 0) return null;
      const radius = this.camera.screenDistanceToWorld(settings.thresholdPx);
      const info = computeSmartGuides(bounds, others, radius);
      gaps = [...info.gaps];
      for (const c of info.spacing) {
        for (const span of c.spans) {
          gaps.push(span);
          equalSpans.add(span);
        }
      }
      sizeMatchRects = info.sizes.map((m) => m.other);
    }

    const spans: SmartGuideSpan[] = gaps.map((g) => this.gapToSpan(g, equalSpans.has(g)));
    if (spans.length === 0) return null;
    return { spans, sizeMatches: sizeMatchRects.map((r) => this.worldRectToScreen(r)), measuring };
  }

  /** Per-gesture neighbour cache for `buildSmartGuides`. */
  private smartNeighbours: { key: string; bounds: Rect[] } | null = null;

  /** One measured gap → screen geometry + a composition-pixel label. */
  private gapToSpan(g: Gap, equal: boolean): SmartGuideSpan {
    const label = `${Math.round(g.distance)}`;
    if (g.axis === 'x') {
      return {
        axis: 'x',
        from: this.worldToScreen({ x: g.from, y: 0 }).x,
        to: this.worldToScreen({ x: g.to, y: 0 }).x,
        cross: this.worldToScreen({ x: 0, y: g.cross }).y,
        label,
        equal,
      };
    }
    return {
      axis: 'y',
      from: this.worldToScreen({ x: 0, y: g.from }).y,
      to: this.worldToScreen({ x: 0, y: g.to }).y,
      cross: this.worldToScreen({ x: g.cross, y: 0 }).x,
      label,
      equal,
    };
  }

  /** Project an oriented box's four corners into screen space, one by one. */
  private cornersToScreen(c: Corners): Corners {
    return [
      this.worldToScreen(c[0]),
      this.worldToScreen(c[1]),
      this.worldToScreen(c[2]),
      this.worldToScreen(c[3]),
    ];
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
