/**
 * Workspace / WorkspaceViewport — the central editor viewport.
 *
 * Structure (AE-style):
 *   ┌──────────────────────────────────────────────────────────┐
 *   │                                                          │
 *   │   Stage (dot-grid / checkerboard void)                   │
 *   │     ┌──────────────────────────┐                        │
 *   │     │  Composition canvas      │  ← framed with shadow  │
 *   │     │  (canvas + overlay)      │                        │
 *   │     └──────────────────────────┘                        │
 *   │                                                          │
 *   │  [TL overlay]                                            │
 *   │  [BL: AI prompt]                                         │
 *   └──────────────────────────────────────────────────────────┘
 *
 * The composition's NAME is the Scene tab's label (`layout/Tabs/EditorTabs.tsx`)
 * and its status badges are in the transport bar (`ViewportTools`). The
 * viewport's DISPLAY state — view layout, channel, resolution, preview, viewer
 * LUT, overlays, snapshot compare, display mode, camera bookmarks, pop out —
 * is `ViewportDisplayControls`, rendered at the right end of that same tabs
 * row. There is no strip of this component's own above the stage: one row
 * above, one transport row below.
 *
 * Over the stage itself: the AI prompt, the focus breadcrumb, the HUD, the
 * comparison layer and the roto strokes. Nothing else floats.
 *
 * Interaction and rendering are handled by the framework-independent
 * `@motion/workspace` engine via {@link useWorkspace}.
 */

import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type DragEvent, type ReactNode, type KeyboardEvent } from 'react';
import { cn } from '@utils/cn';
import { useProjectStore } from '@stores/projectStore';
import { getTime as getPlayheadTime } from '@stores/playbackClockStore';
import { useSceneRevisionFrame } from '@hooks/useSceneRevisionFrame';
import { useCompositionStore } from '@stores/compositionStore';
import { useWorkspaceViewStore } from '@stores/workspaceViewStore';
import { getWorkspaceController } from '@core/workspace/WorkspaceController';
import { compScreenRect } from './compScreenRect';
import { hasCanvasDrag, readCanvasDrag } from '@core/dnd/canvasDrag';
import {
  insertShape,
  insertText,
  insertMedia,
  setNodeWorldPosition,
} from '@core/scene/sceneInsert';
import defaultSceneGraph from '@core/scene/DefaultSceneGraph';
import { readNodeKind, flattenComposition } from '@core/scene/sceneDerive';
import { createCompositionFromFootage } from '@core/composition/compositionOps';
import { EmptyCompositionView } from './EmptyCompositionView';
import { insertCursorItem } from '@core/library/cursorLibrary';
import { insertUiComponent } from '@core/library/uiKitLibrary';
import { insertMographItem } from '@core/library/mographLibrary';
import { applyTransitionItem } from '@core/library/transitionLibrary';
import { insertSfxItem } from '@core/library/sfxLibrary';
import { insertLottieItem } from '@core/library/lottieLibrary';
import { useAssetStore } from '@stores/assetStore';
import { useComponentStore } from '@stores/componentStore';
import { useSelectionStore } from '@stores/selectionStore';
import { useUIStore } from '@stores/uiStore';
import { addEffectAndReveal } from '@layout/Effects/revealEffectControls';
import { insertAnimPreset } from '@core/template/animPresets';
import { UI_COMPONENT_PRESETS } from '@core/scene/uiComponents';

import { SecondaryViewPane } from './SecondaryViewPane';
import { useGuidesStore } from '@stores/guidesStore';
import { useViewportDisplayStore } from '@stores/viewportDisplayStore';
import { FocusBreadcrumb } from '@layout/focus/FocusBreadcrumb';
import { CompositionNavigator } from './CompositionNavigator';
import { MiniFlowchart } from './MiniFlowchart';
import { TextEditOverlay } from './TextEditOverlay';
import { PuppetOverlay } from './PuppetOverlay';
import { EffectHandleOverlay } from './EffectHandleOverlay';
import { BoneOverlay } from './BoneOverlay';
import { TrackPointOverlay } from './TrackPointOverlay';
import { Gizmo3dOverlay } from './Gizmo3dOverlay';
import { AxisWidgetOverlay } from './AxisWidgetOverlay';
import { FocusPlaneOverlay } from './FocusPlaneOverlay';
import { SmartGuideOverlay } from './SmartGuideOverlay';
import { GradientHandleOverlay } from './GradientHandleOverlay';
import { useGizmo3d } from './useGizmo3d';
import { useDeviceHandles } from './useDeviceHandles';
import { useFocusContext } from '@layout/focus/useFocusContext';
import { useWorkspace } from './useWorkspace';
import { pluginKeyDown } from './pluginDrawOverlay';
import { TransportBar } from './TransportBar';
import { ViewportHud } from './ViewportHud';
import { EngineSurface } from '@components/EngineSurface/EngineSurface';
import { CompareOverlay } from './CompareOverlay';
import { RotoBrushOverlay } from './RotoBrushOverlay';
import { InlineAiPrompt } from './InlineAiPrompt';
import { installViewportCommands } from './viewportCommands';
import { installLayerSettingsCommands } from '@layout/Composition/layerSettingsCommands';
import { useGuideSync } from './useGuideSync';
import { resolveReplaceTarget } from '@core/scene/replaceSourceDrop';
import { replaceSourceWithAsset } from '@layout/Timeline/timelineEdits';
import { edit } from '@core/engine/uiEdits';
import { compTime } from '@core/engine/propRefs';
import styles from './Workspace.module.css';

export interface WorkspaceViewportProps {
  topLeft?: ReactNode;
  bottomLeft?: ReactNode;
  bottomRight?: ReactNode;
  className?: string;
}

/*
 * The 4-up grid's divider and its `'50%'` rects moved into
 * `Workspace.module.css` (`.quadTopRight` / `.quadBottomLeft` /
 * `.quadBottomRight`, and `.stage2up` / `.stage4up` for the interactive
 * stage). They were layout expressed as JS strings, so the `cssTokens` guard
 * could not see the `var(--color-border)` inside them and each needed a
 * hardcoded fallback that no theme could reach.
 */

/**
 * Keys the viewport handles directly.
 *
 * `Enter`/`NumpadEnter` earn their place by being the pen's "finish this
 * outline" — the viewport itself does nothing with them, but every key not in
 * this set returns before the active tool is ever offered it.
 */
const VIEWPORT_KEYS = new Set([
  'Space', 'Delete', 'Backspace', 'Escape', 'Enter', 'NumpadEnter',
  'ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown',
  // Ctrl/Cmd+T opens Free Transform Points while path vertices are selected —
  // offered to the tool, which claims it only then (see `toolClaimedKeys`).
  'KeyT',
]);

/**
 * Alpha checkerboard under a transparent composition, clipped to the comp rect.
 *
 * Positioned imperatively rather than through React state: it has to track the
 * camera, and re-rendering the whole viewport on every wheel tick to move one
 * background would be a poor trade. Writing three style properties on a ref is
 * what a pan should cost.
 *
 * Driven off `CameraChanged`/`ViewportChanged` — the same state that feeds the
 * renderer's `backdropMvp` — so the DOM rect and the GPU-drawn comp rect cannot
 * drift apart. See compScreenRect for the rounding rule that keeps the seam
 * stable at fractional zoom.
 */
function TransparencyGrid(): JSX.Element {
  const ref = useRef<HTMLDivElement | null>(null);
  const compWidth = useCompositionStore((s) => s.width);
  const compHeight = useCompositionStore((s) => s.height);

  useEffect(() => {
    const ws = getWorkspaceController().ws;
    const place = (): void => {
      const el = ref.current;
      if (!el) return;
      const r = compScreenRect((p) => ws.worldToScreen(p), compWidth, compHeight);
      el.style.transform = `translate(${r.left}px, ${r.top}px)`;
      el.style.width = `${r.width}px`;
      el.style.height = `${r.height}px`;
    };
    place();
    // Both events matter: the camera moves on pan/zoom, the viewport changes on
    // panel resize and on the auto-fit that follows a comp-size change.
    const cam = ws.events.on('CameraChanged', place);
    const vp = ws.events.on('ViewportChanged', place);
    return () => { cam.dispose(); vp.dispose(); };
  }, [compWidth, compHeight]);

  return <div ref={ref} className={styles.transparencyGrid} data-transparency-grid="" />;
}

/**
 * The 3D gizmo and the camera / light handles, as their own leaf.
 *
 * Both hooks follow the playhead (an animated camera moves the gizmo's
 * projection, a keyframed light moves its dot), so whatever calls them
 * re-renders on every tick of playback. They used to be called from
 * `WorkspaceViewport` itself, which dragged the whole viewport shell — and
 * every overlay under it — through a React render per frame. Here only this
 * subtree does.
 *
 * Their capture-phase `pointerdown` listeners are on the stage, so moving them
 * into a child changes nothing about who sees a press first: capture on an
 * ancestor always runs before the overlay canvas' own listeners, and the two
 * keep their relative order because they are still called in the same order
 * from the same component.
 */
function Gizmo3dLayer({ stageRef }: { stageRef: React.RefObject<HTMLDivElement | null> }): JSX.Element | null {
  // No view options — the main viewport IS the default view (camera3dMode +
  // the workspace controller's transform). The secondary panes pass their own.
  const gizmo3dProps = useGizmo3d(stageRef);
  // Camera / light handles. Called AFTER the layer gizmo so its capture-phase
  // listener runs second: where a device handle overlaps a transform handle the
  // layer gizmo claims the press first, which is the more specific intent.
  const { deviceHandles, hoveredHandle } = useDeviceHandles(stageRef);
  // Mounts for the whole 3D SCENE, not for the selection: the ground plane and
  // comp frame are how you orient yourself in a side view, so gating them on
  // "a 3D layer is selected" hid them in exactly the case they exist for. The
  // gizmo inside still needs a target.
  if (!(gizmo3dProps.scene3d || (gizmo3dProps.is3D && gizmo3dProps.singleId))) return null;
  return (
    <Gizmo3dOverlay
      {...gizmo3dProps}
      deviceHandles={deviceHandles}
      hoveredDeviceHandle={hoveredHandle}
      nodeId={gizmo3dProps.singleId ?? null}
      showGizmo={gizmo3dProps.is3D && !!gizmo3dProps.singleId}
    />
  );
}

export function WorkspaceViewport({
  topLeft,
  bottomLeft,
  bottomRight,
  className,
}: WorkspaceViewportProps): JSX.Element {
  // NO playhead subscription here. This component is the whole viewport shell
  // and it used to re-render on every tick of playback to hand `time` to
  // useWorkspace — which now reads the clock itself. Anything below that has
  // to follow the playhead subscribes on its own (see Gizmo3dLayer).
  //
  // Frame-coalesced, NOT the raw rev: this component is the whole viewport
  // shell — every SVG overlay under it reconciles when it does — and the raw
  // subscription re-rendered it once per pointermove during a drag.
  const sceneRev = useSceneRevisionFrame();
  // The blank-comp moment — AE's two ways in, said out loud.
  //
  // Scoped to the ACTIVE composition, not the whole scene graph: this used to
  // traverse every comp, so content in ANY composition hid the cards for an
  // empty one, and an empty comp kept them hidden while a sibling had layers
  // — exactly backwards once a project holds more than one comp. No active
  // comp at all (its tab deleted, none opened) is ALSO the empty state, which
  // is AE's behaviour when every viewer is closed. Fresh unsaved projects park
  // layers under the virtual comp_root with no active tab, so that case falls
  // back to the whole-graph scan rather than showing cards over live content.
  const activeCompId = useProjectStore((s) => (s.activeTabId ? s.tabs[s.activeTabId]?.compositionId : undefined));
  // The cards are the "no compositions yet" state, so a comp the USER made —
  // via the dialog, from footage, or the dashboard — dismisses them even while
  // it is still empty: an empty comp shows its frame, exactly as AE's does.
  // Only the auto-minted pristine comp keeps them up. Without this gate,
  // clicking "New Composition" and creating one left the cards covering the
  // brand-new comp — the create looked like it did nothing.
  const allCompsPristine = useProjectStore((s) => Object.values(s.comps).every((c) => c.pristine === true));
  const sceneIsEmpty = useMemo(() => {
    if (activeCompId && defaultSceneGraph.getNode(activeCompId)) {
      return !flattenComposition(defaultSceneGraph, activeCompId)
        .some((n) => readNodeKind(n) !== 'group');
    }
    let hasContent = false;
    defaultSceneGraph.traverse((n) => { if (readNodeKind(n) !== 'group') hasContent = true; });
    return !hasContent;
    // eslint-disable-next-line react-hooks/exhaustive-deps -- scene rev drives this
  }, [sceneRev, activeCompId]);
  // Tools that CREATE content dismiss the empty-comp surface: reaching for
  // the pen or a shape is the third way to start, and the surface must not
  // stand between the tool and the canvas. Navigation/selection tools keep it
  // up — there is nothing to select or pan over yet.
  const activeTool = useUIStore((s) => s.activeTool);
  const creationToolActive = !['select', 'direct-select', 'rotate', 'pan-behind', 'hand', 'zoom', 'move'].includes(activeTool);
  const transparent = useCompositionStore((s) => s.transparent);
  const workspaceMode = useWorkspaceViewStore((s) => s.mode);
  // Multi-view (AE-style): '2' shrinks the interactive stage to the left half
  // (one view-only pane on the right); '4' shrinks it to the top-left quadrant
  // (three view-only panes fill the other cells of a 2×2 grid).
  const viewLayout = useGuidesStore((s) => s.viewLayout);
  const quadViewModes = useGuidesStore((s) => s.quadViewModes);
  const setQuadViewMode = useGuidesStore((s) => s.setQuadViewMode);

  // Wireframe / bounding-box hide the shaded picture; the overlay draws the
  // line work (see `paintDisplayMode` in useWorkspace).
  const displayMode = useViewportDisplayStore((s) => s.displayMode);

  /**
   * The horizontal stretch the preview is shown at.
   *
   * FOOTAGE pixel aspect is already gone by the time a layer exists:
   * `sourceInfo.displaySize` multiplies the stored width by `interpret.par`,
   * so an anamorphic plate is a square-pixel layer of the right shape from
   * import onward. What is left for a viewport correction is the
   * COMPOSITION's own pixel aspect — and the composition model has no such
   * field yet (the Composition Settings row that would add it is not this
   * directory's to write). So this reads it defensively and resolves to 1
   * until that lands, at which point the toggle starts working with no change
   * here. On a square-pixel comp it is a no-op, which is also true in AE.
   */
  const compPixelAspect = useCompositionStore(
    (s) => (s as { pixelAspect?: number }).pixelAspect ?? 1,
  );
  const parCorrection = useViewportDisplayStore((s) => s.pixelAspectCorrection);
  const viewportPar = parCorrection && compPixelAspect > 0 ? compPixelAspect : 1;

  // The viewport's own commands — JKL, in/out, snapshot compare, camera
  // bookmarks, guides, display modes, HUD, snap-to-pixel, PAR, viewer LUT,
  // the roto tool and the inline AI prompt. Registered from HERE (the same
  // pattern `previewCacheCommands` uses from `ViewControls`) rather than from
  // `Providers.tsx`, which this directory does not own. Idempotent, so a
  // remount or a second viewport instance re-registers nothing.
  useEffect(() => {
    installViewportCommands();
    // Layer ▸ Layer Settings… (Ctrl/Cmd+Shift+Y) — same self-install pattern.
    installLayerSettingsCommands();
  }, []);

  // Ruler guides ⇄ document (value, unit, pin edge, colour) + comp-resize re-pinning.
  useGuideSync();

  // Keep the engine camera's lock in sync with the persisted workspace mode.
  // The composition framing itself rides on the engine's normal first-fit, so
  // this only has to (re)apply the lock — including after a reload in 'fixed'.
  useEffect(() => {
    getWorkspaceController().ws.camera.setLocked(workspaceMode === 'fixed');
    getWorkspaceController().requestRender();
  }, [workspaceMode]);

  const stageRef   = useRef<HTMLDivElement | null>(null);
  const canvasRef  = useRef<HTMLCanvasElement | null>(null);
  // RAM-preview blit layer — see `.cacheCanvas`. Sits between the content and
  // the interaction overlay so cached pixels replace the render, not the chrome.
  const cacheRef   = useRef<HTMLCanvasElement | null>(null);
  // Onion-skin ghosts — see `.onionCanvas`. Above content and cache, below the
  // interaction overlay.
  const onionRef   = useRef<HTMLCanvasElement | null>(null);
  const overlayRef = useRef<HTMLCanvasElement | null>(null);
  const { focus, focusKey } = useFocusContext();


  const { ready, renderError } = useWorkspace({
    contentCanvasRef: canvasRef,
    cacheCanvasRef: cacheRef,
    onionCanvasRef: onionRef,
    overlayCanvasRef: overlayRef,
    stageRef,
    sceneRev,
    focus,
    focusKey,
  });

  // The active tool's key claims, mirrored onto the focusable viewport so the
  // capture-phase ShortcutManager lets them through: with path vertices
  // selected, Delete deletes VERTICES and the arrows nudge them, where the
  // global bindings would delete / nudge the layer. Refreshed on every engine
  // redraw, which every change of tool state already requests.
  const rootRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const controller = getWorkspaceController();
    let last = '';
    const sync = (): void => {
      const claims = controller.ws.toolClaimedKeys().join(' ');
      if (claims === last || !rootRef.current) return;
      last = claims;
      if (claims) rootRef.current.setAttribute('data-shortcut-claim', claims);
      else rootRef.current.removeAttribute('data-shortcut-claim');
    };
    sync();
    return controller.onRender(sync);
  }, []);

  const onKeyDown = useCallback((e: KeyboardEvent<HTMLDivElement>): void => {
    const target = e.target as HTMLElement | null;
    if (
      target?.tagName === 'INPUT' ||
      target?.tagName === 'TEXTAREA' ||
      target?.isContentEditable
    ) {
      return;
    }
    if (!VIEWPORT_KEYS.has(e.code)) return;
    /*
      A plugin's TOOL gets first refusal, ahead of the engine's own.

      Only a tool: a plugin that has merely drawn a gizmo has no claim on the
      keyboard, and swallowing keys it never asked for would break every
      shortcut the user expects to work while looking at the composition. The
      plugin is asynchronous, so the key is consumed rather than answered — the
      same contract its pointer events have.
    */
    if (pluginKeyDown(e.key, {
      alt: e.altKey, ctrl: e.ctrlKey, meta: e.metaKey, shift: e.shiftKey,
    })) {
      e.preventDefault();
      e.stopPropagation();
      return;
    }
    const controller = getWorkspaceController();
    /*
      The ACTIVE TOOL gets first refusal.

      Tools have always had an `onKeyDown`, and nothing in the app ever called
      it — so the pen's Enter (finish the outline) and Escape (abandon it) were
      dead code. An outline could only be committed by double-clicking, and
      could not be cancelled at all: Escape fell through to `clearSelection`
      below, which deselects and leaves the half-drawn path on screen.

      `onToolKey` is deliberately not the workspace's whole keyboard channel —
      that one also treats any unmodified character as a tool shortcut, which
      would fight the app's own shortcut system.

      A tool only claims a key it actually acted on (the pen returns false with
      no draft in progress), so Escape still clears the selection in every case
      it used to.
    */
    if (controller.ws.onToolKey({
      key: e.key,
      code: e.code,
      modifiers: {
        shift: e.shiftKey, ctrl: e.ctrlKey, alt: e.altKey, meta: e.metaKey,
        mod: e.metaKey || e.ctrlKey,
      },
      repeat: e.repeat,
      time: e.timeStamp,
    })) {
      e.preventDefault();
      e.stopPropagation();
      return;
    }
    switch (e.code) {
      case 'Space':
        // Handled globally (tap = play, hold + drag = pan) — see useSpaceTransport.
        break;
      case 'Delete':
      case 'Backspace':
        e.preventDefault();
        controller.deleteSelection();
        break;
      case 'Escape':
        controller.ws.clearSelection();
        break;
      case 'ArrowLeft':
      case 'ArrowRight':
      case 'ArrowUp':
      case 'ArrowDown': {
        e.preventDefault();
        const step = e.shiftKey ? 10 : 1;
        const dx = e.code === 'ArrowLeft' ? -step : e.code === 'ArrowRight' ? step : 0;
        const dy = e.code === 'ArrowUp'   ? -step : e.code === 'ArrowDown'  ? step : 0;
        controller.nudgeSelection(dx, dy);
        break;
      }
    }
  }, []);

  const onKeyUp = useCallback((_e: KeyboardEvent<HTMLDivElement>): void => {
    // Space is handled globally; nothing else needs key-up here.
  }, []);

  // ── Drag-and-drop from the library panels onto the canvas (AE-style) ──
  const [dragOver, setDragOver] = useState(false);

  const onDragOverCanvas = useCallback((e: DragEvent<HTMLDivElement>): void => {
    // OS file drags are OURS now: dropping footage on the canvas is the first
    // gesture everyone tries ("here is my video, edit it"), and it used to
    // dead-end silently. Internal app drags keep their existing routing.
    const isFileDrag = !!e.dataTransfer && Array.from(e.dataTransfer.types).includes('Files');
    if (!hasCanvasDrag(e) && !isFileDrag) return; // let unrelated drags (tab reorder) pass
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
    setDragOver(true);
  }, []);

  const onDragLeaveCanvas = useCallback((e: DragEvent<HTMLDivElement>): void => {
    // Only clear when the pointer actually leaves the viewport, not when it
    // crosses between child elements (which also fire dragleave).
    if (e.currentTarget === e.target) setDragOver(false);
  }, []);

  const onDropCanvas = useCallback(async (e: DragEvent<HTMLDivElement>): Promise<void> => {
    setDragOver(false);
    // ── OS files: the "upload a video and edit it" gesture ──────────────
    // AE's two ways in, as one drop: onto an EMPTY comp, a video conforms the
    // comp to itself (size, duration, probed fps — `createCompositionFromFootage`,
    // AE's new-comp-from-footage); onto a comp with content, it lands as a
    // layer like any Assets-panel add. Either way the file is imported first,
    // so it shows in Assets and survives re-use.
    const files = e.dataTransfer?.files;
    if (files && files.length > 0) {
      e.preventDefault();
      // An After Effects project is a DOCUMENT, not footage — dropping one
      // opens it rather than adding a layer, which is also what AE itself
      // does with a dropped .aep. Checked before the media filter so a project
      // never falls through to "drop video, image or audio files".
      const aep = Array.from(files).find((f) => /\.(aep|aepx)$/i.test(f.name));
      if (aep) {
        const [{ importAepFile }, { reportAepImport, reportAepImportFailure }] = await Promise.all([
          import('@core/aep/aepImport'),
          import('@core/aep/aepImportReport'),
        ]);
        const result = await importAepFile(aep);
        if (result.ok) reportAepImport(aep.name, result);
        else reportAepImportFailure(aep.name, result.message);
        return;
      }
      const media = Array.from(files).filter((f) =>
        /^(video|image|audio)\//.test(f.type) || /\.(mp4|mov|webm|m4v|png|jpe?g|gif|svg|webp|exr|mp3|wav|m4a|aac|ogg|mxf|avi|wmv|flv|mts|m2ts|mpg|mpeg|vob|ts|mkv)$/i.test(f.name));
      if (media.length === 0) {
        useUIStore.getState().notify({ level: 'info', message: 'Drop video, image or audio files.', durationMs: 2600 });
        return;
      }
      // B3-legacy: engine gap — `importFiles` takes filesystem PATHS through the engine ports; an
      // OS drop hands the renderer browser `File` objects (no path bridge in preload), so the
      // import goes through the asset store's own ingest.
      const imported = await useAssetStore.getState().addAssetsBatch(media.map((file) => ({ file })));
      // "Empty" = no content layers anywhere in the scene. Counting the comp
      // root's children breaks on fresh unsaved projects (layers hang off the
      // virtual comp_root), so ask the nodes themselves.
      let hasContent = false;
      defaultSceneGraph.traverse((n) => { if (readNodeKind(n) !== 'group') hasContent = true; });
      const first = imported[0];
      if (!hasContent && imported.length === 1 && first && first.type === 'video') {
        // B3-legacy: engine gap — `createComposition{fromItems}` does not conform the comp to the
        // footage the way `createCompositionFromFootage` does (probed fps, tab + selection, fit).
        await createCompositionFromFootage(first);
        return;
      }
      // B3-legacy: engine gap — `createLayer` builds the factory's minimal footage node; the
      // insert router (`insertMedia`: contain-fit, PAR, SVG parse, audio layers, sequences) has no API form.
      for (const asset of imported) await insertMedia(asset);
      return;
    }
    const payload = readCanvasDrag(e);
    if (!payload) return; // not one of ours
    e.preventDefault();
    const stage = stageRef.current;
    if (!stage) return;
    const rect = stage.getBoundingClientRect();
    const local = { x: e.clientX - rect.left, y: e.clientY - rect.top };
    const controller = getWorkspaceController();
    const world = controller.ws.screenToWorld(local);

    // The insert helpers select the new node; land it under the cursor.
    const placeSelection = (): void => {
      const id = useSelectionStore.getState().ids[0];
      // B3-legacy: engine gap — the placement belongs to the legacy insert just before it (the
      // insert helpers have no API form, see below); an engine write here would split the drop
      // into two undo entries.
      if (id) setNodeWorldPosition(id, world.x, world.y);
    };

    switch (payload.kind) {
      case 'shape':
        // B3-legacy: engine gap — `createLayer` has no parametric-outline init (shape outlines,
        // tangents, open lines are built client-side by `insertShape`).
        insertShape(payload.primitive, payload.label);
        placeSelection();
        break;
      case 'text':
        // B3-legacy: engine gap — `createLayer` text init carries no style props (font size,
        // weight, fill, preset extras) nor the continuous-raster default `insertText` sets.
        insertText(payload.label, payload.fontSize, payload.weight, payload.extra ?? {});
        placeSelection();
        break;
      case 'asset': {
        // AE Alt-drag: REPLACE the source of the layer under the pointer (or
        // the selected one), keeping its transform, keyframes and effects.
        if (e.altKey) {
          const hit = controller.ws.hitTestScreen(local);
          void replaceSourceWithAsset(resolveReplaceTarget(hit?.id), payload.assetId);
          break;
        }
        const asset = useAssetStore.getState().assets.find((a) => a.id === payload.assetId);
        if (asset) {
          // B3-legacy: engine gap — the footage insert router (see the file drop above).
          await insertMedia(asset);
          placeSelection();
        }
        break;
      }
      case 'component': {
        const gid = useComponentStore.getState().insert(payload.componentId);
        // B3-legacy: engine gap — placement of a legacy component insert (one entry with it).
        if (gid) setNodeWorldPosition(gid, world.x, world.y);
        break;
      }
      case 'component-preset': {
        const preset = UI_COMPONENT_PRESETS.find((p) => p.id === payload.presetId);
        if (preset) {
          const gid = preset.insert();
          // B3-legacy: engine gap — placement of a legacy component insert (one entry with it).
          if (gid) setNodeWorldPosition(gid, world.x, world.y);
        }
        break;
      }
      case 'effect': {
        // Effects apply to a layer — target the one under the cursor (AE-style).
        const node = controller.ws.hitTestScreen(local);
        if (node) addEffectAndReveal(node.id, payload.effectType);
        else useUIStore.getState().notify({ level: 'warning', message: 'Drop an effect onto a layer.', durationMs: 2400 });
        break;
      }
      case 'motionPreset': {
        const node = controller.ws.hitTestScreen(local);
        if (node) {
          // The Motion Presets panel's write: the preset's keys (and any 3D
          // switch it flips) as one entry, addressed by name.
          void edit('Apply animation preset', {
            type: 'applyPreset', layers: [node.id], preset: payload.name, time: compTime(getPlayheadTime()),
          });
        } else {
          useUIStore.getState().notify({ level: 'warning', message: 'Drop a motion preset onto a layer.', durationMs: 2400 });
        }
        break;
      }
      // B3-legacy: engine gap (every library case below) — library items are client-side node
      // builders (layers + keys + effects + expressions); the API would need them as a
      // `pasteLayers` DocumentFragment or `applyPreset` entries in the engine's library.
      case 'animPreset':
        // A self-contained animated element — insert at the drop point.
        // B3-legacy: engine gap — library item (see above).
        insertAnimPreset(payload.presetId, world.x, world.y);
        break;
      case 'cursor':
        // B3-legacy: engine gap — library item (see above).
        insertCursorItem(payload.cursorId, world.x, world.y);
        break;
      case 'uikit':
        // B3-legacy: engine gap — library item (see above).
        insertUiComponent(payload.componentId, world.x, world.y);
        break;
      case 'mograph':
        // B3-legacy: engine gap — library item (see above).
        insertMographItem(payload.mographId, world.x, world.y);
        break;
      case 'transition':
        // Position-independent: applies to the selection at the playhead,
        // or drops a choreographed solid.
        // B3-legacy: engine gap — library item (see above).
        applyTransitionItem(payload.transId);
        break;
      case 'sfx':
        // B3-legacy: engine gap — library item (an audio layer from the SFX library, see above).
        void insertSfxItem(payload.sfxId);
        break;
      case 'lottie':
        // B3-legacy: engine gap — library item (see above).
        insertLottieItem(payload.lottieId, world.x, world.y);
        break;
    }
  }, []);


  return (
    <div className={cn(styles.wrapper, className)}>
      {/*
        No header strip. The display controls (layout, channel, resolution,
        preview, LUT, overlays, snapshot compare, display mode, bookmarks, pop
        out) sit in the transport row UNDER this component —
        `TransportBar.tsx` renders `ViewportDisplayControls` between the scene
        tools and the zoom field — so the body is one tabs row · the stage ·
        one transport row.
      */}

      {/* Canvas viewport */}
      <div
        ref={rootRef}
        className={styles.root}
        data-workspace-viewport=""
        data-drag-over={dragOver || undefined}
        tabIndex={0}
        onKeyDown={onKeyDown}
        onKeyUp={onKeyUp}
        onDragOver={onDragOverCanvas}
        onDragLeave={onDragLeaveCanvas}
        onDrop={onDropCanvas}
        style={dragOver ? { outline: '2px solid var(--color-primary)', outlineOffset: '-2px' } : undefined}
      >
        <div
          ref={stageRef}
          // Multi-view: the interactive stage yields space to the view-only
          // panes — the right half in 2-up, the top-left quadrant in 4-up. In
          // both cases useWorkspace's ResizeObserver on stageRef re-fits the
          // comp to the smaller rect automatically (no extra wiring here).
          className={cn(
            styles.stage,
            viewLayout === '2' && styles.stage2up,
            viewLayout === '4' && styles.stage4up,
          )}
          // Pixel-aspect correction, as a custom property the four canvases
          // read. See `.canvas` in the module for why it is a CSS transform
          // and not a projection change.
          style={{ '--viewport-par': viewportPar } as CSSProperties}
        >
          {/* BEFORE the canvas, so the compositor blends the canvas over it —
              that is what makes partial alpha composite correctly for free. */}
          {transparent && <TransparencyGrid />}
          <canvas
            ref={canvasRef}
            className={cn(styles.canvas, displayMode !== 'shaded' && styles.canvasHidden)}
          />
          <canvas ref={cacheRef} className={styles.cacheCanvas} data-workspace-cache="" />
          <canvas ref={onionRef} className={styles.onionCanvas} data-workspace-onion="" />
          <canvas ref={overlayRef} className={styles.overlay} data-workspace-overlay="" />
          {/* Blank-comp start surface — After Effects' empty Composition
              panel, as a REPLACEMENT: opaque over the stage, so no comp frame
              or grid implies a composition that doesn't meaningfully exist.
              The canvases stay mounted beneath it (GPU init is not free).
              Shown as soon as the scene is the auto-minted empty project —
              not gated on GPU ready — so a desktop window whose backend is
              still probing does not look like a blank dark frame.
              It stays up during a file drag — its footage card and the root's
              drop handler are the drop targets — and steps aside the moment
              the user picks a creation tool, preserving the draw-the-first-
              shape-directly workflow the local edition promises. */}
          {sceneIsEmpty && allCompsPristine && !creationToolActive && (
            <EmptyCompositionView />
          )}
          {/* Scene loading indicator — until the backend paints its first frame. */}
          {!ready && !renderError && (
            <div className={styles.loading} data-workspace-loading="">
              <div className={styles.loadingSpinner} />
            </div>
          )}
          {/* GPU init failed on every tier — say so instead of a blank stage. */}
          {renderError && (
            <div className={styles.loading} data-workspace-render-error="">
              <div className={styles.renderError} role="alert">
                <strong>Preview unavailable</strong>
                <span>{renderError}</span>
                <span>Close other GPU-heavy tabs or windows, then reopen this project.</span>
              </div>
            </div>
          )}
          {/* On-canvas text editor — screen coords match the canvas' own space. */}
          <TextEditOverlay />
          <PuppetOverlay />
          <EffectHandleOverlay />
          <BoneOverlay />
          <TrackPointOverlay />
          {/* Mounts for the whole 3D SCENE, not for the selection: the ground
              plane and comp frame are how you orient yourself in a side view,
              so gating them on "a 3D layer is selected" hid them in exactly
              the case they exist for. The gizmo inside still needs a target. */}
          <Gizmo3dLayer stageRef={stageRef} />
          {/* The camera's focus plane and its focus-pull handle. Mounted AFTER
              the 3D gizmo so it paints above the wireframes it belongs to; it
              is pointer-transparent apart from that one handle, and renders
              nothing at all unless a DOF camera is on show. */}
          <FocusPlaneOverlay />
          {/* The gradient axis, its end grips and the colour stops. Renders
              nothing unless the one selected layer has a gradient fill, and
              only a small swatch chip until the editor is armed. */}
          <GradientHandleOverlay />
          {/* Figma-style measurement chrome: distances to the nearest layers,
              equal-spacing hatch bars, equal-size highlights. Draws only while
              a gesture is in flight or Alt is measuring, so an idle viewport is
              untouched by it. */}
          <SmartGuideOverlay />
          {/* Persistent view-orientation axis widget (whenever the comp is 3D). */}
          <AxisWidgetOverlay />
          {/* Roto Brush strokes. Claims the pointer only while the roto tool
              is active and a footage layer is selected; inert otherwise. */}
          <RotoBrushOverlay />
          {/* Snapshot comparison (F5 / Shift+F5). Above the picture, below the
              interactive handles — a wipe must not cover the gizmo you drag. */}
          <CompareOverlay />
          {/* fps / frame ms / cache / resolution / backend, top-left. */}
          <ViewportHud />
          {/* The C++ engine's picture, beside (not instead of) this viewport —
              renders nothing unless the process backend is on
              (PREMATION_ENGINE=process; NATIVE_CORE_PLAN C3). */}
          <EngineSurface />
          {/* Ctrl+Enter: an AI prompt anchored to the selection's screen rect. */}
          <InlineAiPrompt />
        </div>

        {/* View-only right pane (AE's 2 Views) — its own canvas + backend. */}
        {viewLayout === '2' && <SecondaryViewPane />}

        {/* Cells 1–3 of the 2×2 "4 Views" grid. The top-left quadrant is the
            interactive stage above (shrunk via right/bottom:50%); these three
            panes fill the remaining quadrants, each its own GL context. The
            panes are FULLY INTERACTIVE — shared selection, undoable edits,
            per-pane framing (see SecondaryViewPane.tsx, which documents the
            upgrade; an earlier version of this comment called them view-only).
            `key` guarantees each pane's backend is disposed and rebuilt on
            layout change rather than reused across positions. Thin dividers =
            borders on the right-column / bottom-row cells (no doubling),
            matching --color-border. */}
        {viewLayout === '4' && (
          <>
            <SecondaryViewPane
              key="quad-1"
              mode={quadViewModes[1]}
              onModeChange={(m) => setQuadViewMode(1, m)}
              className={styles.quadTopRight}
            />
            <SecondaryViewPane
              key="quad-2"
              mode={quadViewModes[2]}
              onModeChange={(m) => setQuadViewMode(2, m)}
              className={styles.quadBottomLeft}
            />
            <SecondaryViewPane
              key="quad-3"
              mode={quadViewModes[3]}
              onModeChange={(m) => setQuadViewMode(3, m)}
              className={styles.quadBottomRight}
            />
          </>
        )}

        {/*
          Corner overlays.

          There is no top-right slot any more. Its buttons moved to the pieces
          of chrome that own them — the header bar and the tool cluster below —
          and what was left was an empty positioned div sitting over the corner
          of the stage, catching nothing and showing nothing.
        */}
        <div className={styles.overlayTL}>{topLeft}</div>
        {/*
          `ViewportTools` used to float here, over the bottom-left of the stage.
          It renders in the transport bar now, beside the play cluster — a pill
          over the canvas covers the canvas, and covers a different part of it
          at every zoom level. The slot stays for `bottomLeft`, which is the AI
          prompt.
        */}
        <div className={styles.overlayBL}>{bottomLeft}</div>
        <div className={styles.overlayBR}>{bottomRight}</div>

        <FocusBreadcrumb />
        <CompositionNavigator />
        <MiniFlowchart />
      </div>

      {/*
        The transport, under the stage.

        It lived in the timeline panel's top row, which put the play button in
        the panel you are NOT watching while it plays. AE keeps it with the
        preview for that reason, and moving it here gave the timeline's top row
        back to the composition tabs and the render queue.
      */}
      <TransportBar />
    </div>
  );
}

// ViewportZoomControls was removed — zoom is `ZoomField`, at the right end of
// the transport bar.
