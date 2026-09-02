/**
 * TimelineController — the app-side owner of the framework-independent
 * `@motion/timeline` engine. It makes the engine the single authority for the
 * time domain (playhead, duration, frame rate, playback, markers, ranges) and
 * mirrors that into the app's `workspaceStore` (seconds), which the rest of the
 * UI already reads. It also mirrors Scene Graph nodes into timeline **layers**
 * so the engine holds real structure (for markers, queries, serialization).
 *
 * Division of labor: this engine owns *time*; keyframes remain in the Animation
 * Engine. Nothing here samples or stores keyframes.
 *
 *   transport / clock ──▶ TimelineController ──▶ @motion/timeline
 *                                    │  engine events (CurrentTimeChanged, …)
 *                                    ▼
 *                            workspaceStore (seconds) ──▶ existing UI
 */

import {
  Timeline,
  frameRate,
  framesToSeconds,
  secondsToFrames,
  serializeTimeline,
  applySerializedTimeline,
  Marker,
  Clip,
  rollClips,
  rollLimits,
  type SerializedTimeline,
  type Layer,
} from '@motion/timeline';
import { useWorkspaceStore } from '@stores/projectStore';
import { useCompositionStore } from '@stores/compositionStore';
import { useSelectionStore } from '@stores/selectionStore';
import defaultSceneGraph from '@core/scene/DefaultSceneGraph';
import { cloneLayerNode, removeLayerNodeClone, mintSplitNodeId } from '@core/scene/cloneLayerNode';
import { deleteLayerNode } from '@core/scene/deleteLayerNode';
import { captureLayerSnapshot, restoreLayerSnapshot } from '@core/scene/layerSnapshot';
import { bumpScene, batchScene } from '@stores/sceneStore';
import { readResponsiveTime } from '@core/template/responsiveTimeStore';
import { stretchedToAuthored } from '@core/template/responsiveTime';
import { readNodeKind } from '@core/scene/sceneDerive';
import { readNodeLayerTime, remapTime } from '@core/scene/layerTime';
import { isPrecomp } from '@core/scene/precomp';
import { instanceSourceOf } from '@core/scene/compInstance';
import { sourceOf } from '@core/source/sourceInfo';
import { compSourceOf } from '@core/composition/compSizes';
import type { SceneNode } from '@core/types';
import { defaultAnimation } from '@motion/animation';
import { runAnimEdit } from '@core/animation/animationCommands';


import { getEventBus } from '@core/events/EventBus';
import { getCommandSystem } from '@core/commands/CommandSystem';
import type { HistoryService } from '@core/commands/HistoryService';
import { useHistoryStore, type HistoryStore } from '@stores/historyStore';
import type { IUndoableCommand, CommandContext } from '@core/commands/Command';
import type { Command as TimelineCommand } from '@motion/timeline';

/**
 * The intrinsic length of a SOURCE layer in FRAMES, or null when unbounded
 * (shapes/text/groups — anything generative). A clip bar cannot be dragged past
 * this, which is what stops you trimming to footage that does not exist.
 *
 * Asks `sourceOf` rather than branching on kind, so a **composition placed as a
 * layer is bounded by its own duration** like any other source. It used to
 * check `kind === 'video'` and return null for everything else, so a comp
 * instance was treated as unbounded: you could stretch its bar arbitrarily past
 * the end of the composition it referenced and the extra frames rendered
 * nothing. A comp has intrinsic time exactly as footage does.
 *
 * Audio still reads the duration stamped on its own component — an audio layer
 * has no `SourceInfo` because it is not a picture source.
 */
export function mediaSourceFrames(node: SceneNode, fps: number): number | null {
  const kind = readNodeKind(node);
  if (kind === 'audio') {
    const a = node.components.find((c) => c.type === 'Audio');
    const sec = a?.props.__duration;
    return typeof sec === 'number' && sec > 0 ? Math.max(1, Math.round(sec * fps)) : null;
  }
  // Stills are unbounded on purpose: a photo can hold for any length.
  if (kind === 'image' || kind === 'svg') return null;

  const source = sourceOf(node, compSourceOf);
  const sec = source?.durationSec;
  if (!source || typeof sec !== 'number' || sec <= 0) return null;
  // A looping source is as long as its loops. `loopCount: 0` (forever) is
  // unbounded by definition.
  if (source.loopCount === 0) return null;
  return Math.max(1, Math.round(sec * source.loopCount * fps));
}

export interface TimelineMarkerView {
  id: string;
  /** Seconds (for the seconds-based timeline UI). */
  time: number;
  label: string;
  color: string | null;
  /**
   * The marker's note. Carried here rather than through a second, richer
   * accessor because `marker.key(n).comment` in an expression and the marker
   * chip on the ruler must not read markers by two different paths — the
   * layer-relative → comp conversion in `getLayerMarkers` is exactly the kind
   * of step that goes wrong once it exists twice. One reader, widened.
   */
  comment: string;
  /** Span length in SECONDS (0 = point marker); the model stores frames. */
  duration: number;
}

class TimelineCommandAdapter implements IUndoableCommand {
  readonly label: string;
  private readonly cmd: TimelineCommand;

  constructor(cmd: TimelineCommand) {
    this.label = cmd.label;
    this.cmd = cmd;
  }

  execute(_ctx: CommandContext): void {
    this.cmd.do();
  }

  undo(_ctx: CommandContext): void {
    this.cmd.undo();
  }
}

/**
 * The app history, or null when there isn't one.
 *
 * `getCommandSystem()` throws in headless tests (and during boot, before the
 * Application wires it up). Split has to work in both — the engine mutation is
 * the real work; recording it for undo is a bonus the caller may not have.
 */
function getCommandSystem_safe(): HistoryService | null {
  try {
    return getCommandSystem().getHistory();
  } catch {
    return null;
  }
}

/**
 * The app's snapshot-history store, or null when there isn't one.
 *
 * Same reason as {@link getCommandSystem_safe}: it reaches into the
 * CommandSystem, which headless tests do not build.
 */
function historyStore(): Pick<HistoryStore, 'flush' | 'runRestoring'> | null {
  try {
    return useHistoryStore.getState();
  } catch {
    return null;
  }
}

export class TimelineController {
  private registries = new Map<string, Timeline>();
  private compositionTrackIds = new Map<string, string>();
  /**
   * True while loading a document or mirroring the scene. Both replay the
   * engine's structural events, which must not be mistaken for user edits and
   * re-saved (a load would immediately dirty the project it just loaded).
   */
  private reconciling = false;
  /** Per-composition loop toggle; absent means the default (looping on). */
  private loopingByComp = new Map<string, boolean>();

  /** The composition the active tab is showing. */
  private get activeCompId(): string {
    const ws = useWorkspaceStore.getState();
    const tab = ws.activeTabId ? ws.tabs[ws.activeTabId] : null;
    return tab?.compositionId || 'comp_default';
  }

  get timeline(): Timeline {
    const compId = this.activeCompId;
    if (!this.registries.has(compId)) {
      this.initTimeline(compId);
    }
    return this.registries.get(compId)!;
  }

  constructor() {
    // Initial timeline will be created lazily when accessed
  }

  private initTimeline(compId: string) {
    // Read the comp being initialized — not the active tab's. These differ
    // whenever a timeline is created for a comp the user isn't looking at
    // (project load, precompose), which would otherwise seed the wrong fps.
    const compSettings =
      useWorkspaceStore.getState().comps[compId] ?? useCompositionStore.getState().comp();
    const timeline = Timeline.create({
      name: 'Composition',
      frameRate: frameRate(compSettings.fps),
      duration: Math.max(1, Math.round(compSettings.durationSeconds * compSettings.fps)),
      historyOptions: {
        onPush: (cmd) => {
          try {
            getCommandSystem().getHistory().push(new TimelineCommandAdapter(cmd));
          } catch (err) {
            // CommandSystem is not initialized in headless tests.
          }
        }
      }
    });

    timeline.setRange('loop', { start: 0, duration: timeline.duration });
    // Silently: booting a composition's own track is structure, not an edit.
    // Recorded, it landed an "Add Track" entry on the user's undo stack the
    // first time anything touched a comp's timeline — so a Ctrl+Z aimed at
    // their last real edit could instead delete the track every clip lives on.
    const track = timeline.history.silently(() =>
      timeline.addTrack({ name: 'Composition', kind: 'group' }),
    );
    this.compositionTrackIds.set(compId, track.id);
    timeline.setZoom(80 / compSettings.fps);

    timeline.events.on('CurrentTimeChanged', ({ frame }) => {
      // Only mirror to the store if this is the active comp's timeline!
      const ws = useWorkspaceStore.getState();
      const activeTabId = ws.activeTabId;
      const tab = activeTabId ? ws.tabs[activeTabId] : null;
      if (tab?.compositionId === compId) {
        // Mirror a FRAME-EXACT time, not the raw fractional one.
        //
        // The playhead runs fractionally on purpose (smooth accumulation across
        // rAF deltas), but the viewport renders from these `seconds` while the
        // exporter renders at `i / fps`. Mirroring the fraction meant playback
        // preview sampled BETWEEN export frames: keyframe interpolation,
        // expressions and particles all landed on values no exported frame ever
        // shows. Rounding here keeps the smooth internal clock and makes what
        // you watch the frame you get — and it re-couples `seconds` with the
        // `frame` beside it, which was already rounded.
        const snapped = Math.round(frame);
        // Deduplicate on the snapped frame: the fractional clock ticks at
        // display rate (60Hz for a 30fps comp = two identical mirrors per comp
        // frame), and the store set() re-rendered the whole viewport each
        // time. Rounding already erased the difference — emitting it twice
        // only paid the render twice.
        if (tab.frame === snapped && tab.playing) return;
        ws.actions.setTime(framesToSeconds(snapped, timeline.getFrameRate()), snapped);
      }
    });

    timeline.events.on('PlayStateChanged', ({ playing }) => {
      const ws = useWorkspaceStore.getState();
      const activeTabId = ws.activeTabId;
      const tab = activeTabId ? ws.tabs[activeTabId] : null;
      if (tab?.compositionId === compId && tab.playing !== playing) {
        ws.actions.setPlaying(playing);
      }
    });

    // The time domain is persisted state, but none of it moves the scene graph,
    // so autosave would never hear about a trim, split, marker or work area.
    // Deliberately excludes playhead/zoom/scroll — those are view state and
    // would make autosave fire on every frame of playback.
    const persisted = [
      'LayerAdded', 'LayerRemoved', 'LayerMoved', 'LayerTrimmed', 'LayerSplit', 'LayerUpdated',
      'TrackAdded', 'TrackRemoved', 'TrackMoved', 'TrackUpdated', 'TrackFlagsChanged',
      'MarkerAdded', 'MarkerRemoved', 'MarkerUpdated',
      'RangeChanged', 'DurationChanged', 'FrameRateChanged',
    ] as const;
    for (const evt of persisted) {
      timeline.events.on(evt, () => {
        if (this.reconciling) return;
        getEventBus().emit('DocumentChanged', { source: 'timeline' });
      });
    }

    this.registries.set(compId, timeline);
    this.syncFromScene(compId);
  }

  // ── Time facts ───────────────────────────────────────────────────
  get fps(): number {
    return this.timeline.getFrameRate().fps;
  }
  get durationSeconds(): number {
    return framesToSeconds(this.timeline.duration, this.timeline.getFrameRate());
  }

  // ── Comp settings → time domain (driven by the Composition Settings dialog) ─
  /** Change the comp frame rate, preserving on-screen timing, and reloop. */
  setFrameRate(fps: number): void {
    this.timeline.setFrameRate(fps, { preserveTiming: true });
    this.timeline.setRange('loop', { start: 0, duration: this.timeline.duration });
  }
  /** Change the comp duration (seconds) and reloop over the new length. */
  setDurationSeconds(seconds: number): void {
    const frames = Math.max(1, Math.round(seconds * this.timeline.getFrameRate().fps));
    this.timeline.setDuration(frames);
    this.timeline.setRange('loop', { start: 0, duration: this.timeline.duration });
  }
  get currentSeconds(): number {
    return framesToSeconds(this.timeline.currentFrame, this.timeline.getFrameRate());
  }

  // ── Transport (the engine is the authority; the store mirrors) ────
  seekSeconds(seconds: number): void {
    this.timeline.seek(secondsToFrames(seconds, this.timeline.getFrameRate()));
  }
  goToStart(): void {
    this.timeline.goToStart();
  }
  goToEnd(): void {
    this.timeline.goToEnd();
  }
  nextFrame(): void {
    this.timeline.nextFrame();
  }
  previousFrame(): void {
    this.timeline.previousFrame();
  }
  play(): void {
    // Restart from the beginning if parked at the end.
    if (this.timeline.currentFrame >= this.timeline.duration) this.timeline.goToStart();
    this.timeline.play();
  }
  pause(): void {
    this.timeline.pause();
  }
  togglePlay(): void {
    if (this.timeline.isPlaying) this.pause();
    else this.play();
  }
  get isPlaying(): boolean {
    return this.timeline.isPlaying;
  }

  /**
   * Stop the transport on every composition EXCEPT the active one, and clear
   * those tabs' playing flags.
   *
   * Only one composition can be pumped at a time: `usePlaybackClock` ticks
   * `controller.tick()`, which resolves to whichever comp the active tab shows.
   * Switching tabs mid-playback therefore silently retargeted the pump and left
   * the outgoing comp's engine — and its tab flag — asserting `playing` with
   * nothing driving them. Nothing ever cleared either, because `pause()` also
   * resolves through the ACTIVE comp (so it paused the wrong engine, or none)
   * and `setPlaying` only writes the ACTIVE tab. Coming back to that tab then
   * found a store flag already true and an engine already playing, and the
   * clock simply started pumping again: the composition played without anyone
   * pressing play.
   */
  pauseInactiveComps(): void {
    const activeCompId = this.activeCompId;
    for (const [compId, timeline] of this.registries) {
      if (compId !== activeCompId && timeline.isPlaying) timeline.pause();
    }
    const ws = useWorkspaceStore.getState();
    for (const tab of Object.values(ws.tabs)) {
      if (tab.id !== ws.activeTabId && tab.playing) {
        ws.actions.setTabPlaying(tab.id, false);
      }
    }
  }

  /** Pump the engine's playhead from the app's frame clock (ms delta). */
  tick(dtMs: number): boolean {
    return this.timeline.tick(dtMs);
  }

  // ── Timeline zoom (engine view is the authority; pps = ppf × fps) ─
  getPixelsPerSecond(): number {
    return this.timeline.getView().pixelsPerFrame * this.fps;
  }
  setPixelsPerSecond(pps: number, anchorSeconds?: number): void {
    const ppf = pps / this.fps;
    const anchorFrame =
      anchorSeconds !== undefined ? secondsToFrames(anchorSeconds, this.timeline.getFrameRate()) : undefined;
    this.timeline.setZoom(ppf, anchorFrame);
  }
  /** Fit the whole composition into `viewportWidthPx`. */
  fitZoom(viewportWidthPx: number): void {
    this.timeline.setViewportWidth(viewportWidthPx);
    this.timeline.fit(viewportWidthPx, 24);
  }

  // ── Clips (a node's engine layers) ───────────────────────────────
  /**
   * The timeline that OWNS a node's clips: the registry keyed by the node's
   * parent (a comp root or an opened precomp group). Falls back to the active
   * comp for parents with no registry — plain groups, whose children have no
   * clips of their own.
   *
   * This used to be hardwired to the ACTIVE comp, which had two consequences:
   * precomposing a layer orphaned its clips (the node was no longer an
   * immediate child of the active root, so syncFromScene deleted its trims),
   * and rendering a non-active comp (render queue) ignored that comp's trims
   * entirely.
   */
  private registryForNode(nodeId: string): { timeline: Timeline; trackId: string } | null {
    const parentId = defaultSceneGraph.getNode(nodeId)?.parent;
    if (parentId && this.registries.has(parentId)) {
      const trackId = this.compositionTrackIds.get(parentId);
      const timeline = this.registries.get(parentId);
      if (trackId && timeline) return { timeline, trackId };
    }
    const compId = this.activeCompId;
    if (!this.registries.has(compId)) this.initTimeline(compId);
    const timeline = this.registries.get(compId);
    const trackId = this.compositionTrackIds.get(compId);
    return timeline && trackId ? { timeline, trackId } : null;
  }

  /** Frame rate of the timeline that owns a node's clips. */
  fpsForNode(nodeId: string): number {
    return this.registryForNode(nodeId)?.timeline.getFrameRate().fps ?? this.fps;
  }

  /** The composition that OWNS a node's clips — its parent when that parent is
   *  a registered comp, else the active comp. Same resolution fpsForNode and
   *  durationFramesForNode already use, exposed so the responsive-time map can
   *  read the right comp's config for a node nested in a precomp. */
  compIdForNode(nodeId: string): string {
    const parentId = defaultSceneGraph.getNode(nodeId)?.parent;
    if (parentId && this.registries.has(parentId)) return parentId;
    return this.activeCompId;
  }

  /** Duration (frames) of the timeline that owns a node's clips. */
  durationFramesForNode(nodeId: string): number {
    return this.registryForNode(nodeId)?.timeline.duration ?? this.timeline.duration;
  }

  /**
   * Memoized per-track sourceId → layers indexes. `getLayersForNode` is called
   * PER NODE by the renderer (remapOf), the workspace ports and the timeline
   * model — a full `layers.filter` per call made every frame O(n²) in layer
   * count. Membership only changes when clips are added/removed/split, which
   * shows up as an array/length change (and syncFromScene clears the indexes
   * explicitly); per-clip start edits don't affect membership, and the tiny
   * per-node arrays are re-sorted on read. Keyed per track because clips now
   * resolve to the OWNING comp's track, not always the active one.
   */
  private layerIndexes = new WeakMap<object, { arr: unknown; len: number; idx: Map<string, Layer[]> }>();

  /** Drop the memoized layer indexes (call after structural clip changes). */
  invalidateLayerIndex(): void {
    this.layerIndexes = new WeakMap();
  }

  /**
   * Every clip in a composition's own track, in track order.
   *
   * For `clipGeometrySignature` — the cache needs to see ALL the bars, not one
   * node's. Returns empty for a comp with no timeline yet, which is a comp
   * nothing has been added to.
   */
  layersOfComp(compId?: string): Layer[] {
    const ws = useWorkspaceStore.getState();
    const tab = ws.activeTabId ? ws.tabs[ws.activeTabId] : null;
    const targetCompId = compId || tab?.compositionId || 'scene-root';
    const timeline = this.registries.get(targetCompId);
    const trackId = this.compositionTrackIds.get(targetCompId);
    if (!timeline || !trackId) return [];
    return timeline.getTrack(trackId)?.layers ?? [];
  }

  getLayersForNode(nodeId: string): Layer[] {
    const reg = this.registryForNode(nodeId);
    if (!reg) return [];
    const track = reg.timeline.getTrack(reg.trackId);
    if (!track) return [];
    let entry = this.layerIndexes.get(track);
    if (!entry || entry.arr !== track.layers || entry.len !== track.layers.length) {
      const idx = new Map<string, Layer[]>();
      for (const l of track.layers) {
        if (!l.sourceId) continue; // sourceless clips can't be looked up by node
        const arr = idx.get(l.sourceId);
        if (arr) arr.push(l);
        else idx.set(l.sourceId, [l]);
      }
      entry = { arr: track.layers, len: track.layers.length, idx };
      this.layerIndexes.set(track, entry);
    }
    const arr = entry.idx.get(nodeId);
    return arr ? [...arr].sort((a, b) => a.start - b.start) : [];
  }

  /**
   * Move the clip geometry (trims, splits, positions, markers) that backs
   * `nodeIds` from one comp's timeline to another's. Used by precompose: the
   * nodes become children of the precomp group, so their clips must follow
   * them into the precomp's timeline — before this existed, syncFromScene
   * dropped them as orphans and every trim/split was silently lost.
   *
   * Replaces any clips the destination already holds for those nodes (its
   * initTimeline sync seeds full-length ones). Not undoable: it accompanies a
   * structural scene change, mirroring syncFromScene's contract.
   */
  transferNodeClips(nodeIds: ReadonlyArray<string>, fromCompId: string, toCompId: string): void {
    const from = this.registries.get(fromCompId);
    if (!from) return; // source timeline never existed — nothing to preserve
    const fromTrackId = this.compositionTrackIds.get(fromCompId);
    const fromTrack = fromTrackId ? from.getTrack(fromTrackId) : null;
    if (!fromTrack) return;

    if (!this.registries.has(toCompId)) this.initTimeline(toCompId);
    const to = this.registries.get(toCompId);
    const toTrackId = this.compositionTrackIds.get(toCompId);
    const toTrack = toTrackId ? to?.getTrack(toTrackId) : null;
    if (!to || !toTrackId || !toTrack) return;

    const wanted = new Set(nodeIds);
    const moving = fromTrack.layers.filter((l) => l.sourceId && wanted.has(l.sourceId));
    if (moving.length === 0) return;

    const wasReconciling = this.reconciling;
    this.reconciling = true;
    try {
      to.history.silently(() => {
        // Drop the full-length clips initTimeline's sync seeded for these
        // nodes, then recreate the real geometry.
        for (const stale of [...toTrack.layers]) {
          if (stale.sourceId && wanted.has(stale.sourceId)) to.removeLayer(stale.id);
        }
        for (const l of moving) {
          const added = to.addLayer(toTrackId, {
            name: l.name,
            sourceId: l.sourceId,
            enabled: l.enabled,
            locked: l.locked,
            clip: l.clip.toJSON(),
            metadata: { ...l.metadata },
          });
          if (added) {
            for (const m of l.markers.list()) {
              added.markers.add(new Marker({
                frame: m.frame,
                duration: m.duration,
                name: m.name,
                color: m.color,
                comment: m.comment,
                scope: m.scope,
                ownerId: added.id,
              }));
            }
          }
        }
      });
      from.history.silently(() => {
        for (const l of moving) from.removeLayer(l.id);
      });
    } finally {
      this.reconciling = wasReconciling;
      this.invalidateLayerIndex();
    }
  }

  /** Move a clip to an absolute timeline start (seconds). Undoable (one entry
   *  per drag gesture — the UI commits only on release). */
  setClipStart(layerId: string, startSeconds: number): void {
    this.timeline.setLayerStart(layerId, secondsToFrames(startSeconds, this.timeline.getFrameRate()));
  }

  /**
   * After Effects "Sequence Layers": lay the given layers' BARS end-to-end in
   * time, in the order supplied — each layer starts where the previous one ends
   * (minus `overlapSeconds` for a cross-dissolve-style overlap). The first layer
   * stays put. This offsets the clip bars, unlike the keyframe-stagger assistant
   * `sequenceLayers` (which only shifts animation in place). Returns false with
   * fewer than two timeline layers among the nodes.
   */
  sequenceLayerBars(
    nodeIds: ReadonlyArray<string>,
    overlapSeconds = 0,
    opts: { crossfade?: boolean } = {},
  ): boolean {
    const fr = this.timeline.getFrameRate();
    // nodeId is kept ALONGSIDE the layer, not discarded: the crossfade writes
    // keyframes, and keyframes are addressed by node, not by timeline layer.
    const pairs = nodeIds
      .map((id) => ({ id, layer: this.getLayersForNode(id)[0] }))
      .filter((p): p is { id: string; layer: Layer } => !!p.layer);
    if (pairs.length < 2) return false;
    const overlap = Math.round(secondsToFrames(overlapSeconds, fr));
    // The first layer anchors the sequence; each next bar butts against it.
    let cursor = Math.max(0, pairs[0]!.layer.start + pairs[0]!.layer.duration - overlap);
    for (let i = 1; i < pairs.length; i++) {
      const L = pairs[i]!.layer;
      this.timeline.setLayerStart(L.id, cursor);
      cursor = Math.max(0, cursor + L.duration - overlap);
    }
    this.invalidateLayerIndex();
    if (opts.crossfade && overlap > 0) this.writeCrossfades(pairs, fr);
    return true;
  }

  /**
   * Opacity ramps across each overlap region produced by `sequenceLayerBars`.
   *
   * Lives HERE, beside the geometry that created the overlap, rather than as a
   * separate pass a caller composes. The fade region is not derivable from the
   * layers alone — it is exactly the span the sequencing just produced — so
   * recomputing it anywhere else is two definitions of one region that agree
   * until someone changes the cursor arithmetic (§2·0).
   *
   * ## The axis
   *
   * Keyframe times go through `compToKeyframeTime`, which is the ONLY axis the
   * renderer samples. The naive alternative next door, `toLayerTime`, carries a
   * docstring forbidding exactly this use — it ignores `sourceIn`, stretch,
   * reverse and precomp remaps, so a sequenced precomp would fade at the wrong
   * time. Called AFTER the bars have moved, because that mapping depends on
   * where the bar now is.
   *
   * ## What is deliberately not faded
   *
   * The first layer never fades IN and the last never fades OUT: a sequence
   * that opened from and ended in transparency would be a different edit from
   * the one asked for, and both are trivially added by hand if wanted. Only the
   * OVERLAP is touched.
   */
  private writeCrossfades(
    pairs: ReadonlyArray<{ id: string; layer: Layer }>,
    fr: ReturnType<TimelineController['timeline']['getFrameRate']>,
  ): void {
    const fps = fr.fps;
    // ONE undo entry for the whole set of ramps. Without this each
    // `setKeyframe` is its own step and undoing a four-layer crossfade takes
    // twelve presses.
    runAnimEdit('Sequence Layers crossfade', () => {
    for (let i = 1; i < pairs.length; i++) {
      const outgoing = pairs[i - 1]!;
      const incoming = pairs[i]!;
      // Re-read: `setLayerStart` moved these bars, so the cached objects from
      // before the loop would describe the pre-sequence layout.
      const outL = this.getLayersForNode(outgoing.id)[0];
      const inL = this.getLayersForNode(incoming.id)[0];
      if (!outL || !inL) continue;
      const fadeStart = inL.start;
      const fadeEnd = outL.start + outL.duration;
      if (fadeEnd <= fadeStart) continue;

      const t0Out = compToKeyframeTime(outgoing.id, fadeStart / fps);
      const t1Out = compToKeyframeTime(outgoing.id, fadeEnd / fps);
      const t0In = compToKeyframeTime(incoming.id, fadeStart / fps);
      const t1In = compToKeyframeTime(incoming.id, fadeEnd / fps);

      // Opacity is a percentage (propertyMeta: PCT), so 100 → 0, not 1 → 0.
      defaultAnimation.setKeyframe(outgoing.id, 'opacity', t0Out, 100);
      defaultAnimation.setKeyframe(outgoing.id, 'opacity', t1Out, 0);
      defaultAnimation.setKeyframe(incoming.id, 'opacity', t0In, 0);
      defaultAnimation.setKeyframe(incoming.id, 'opacity', t1In, 100);
    }
    });
  }

  /** Trim a clip edge to an absolute time (seconds). Undoable. */
  trimClipTo(layerId: string, edge: 'start' | 'end', seconds: number): void {
    this.timeline.trimLayer(layerId, edge, Math.round(secondsToFrames(seconds, this.timeline.getFrameRate())));
  }

  /**
   * Slip: shift source under a fixed bar. `deltaSeconds` is how far the source
   * window moves (positive = later into the file). Undoable.
   */
  slipClip(layerId: string, deltaSeconds: number): void {
    const fr = this.timeline.getFrameRate();
    this.timeline.slipLayer(layerId, Math.round(secondsToFrames(deltaSeconds, fr)));
  }

  /**
   * Slide: move the bar by `deltaSeconds` and trim abutting neighbors on the
   * same track so the cut stays closed. Undoable.
   */
  slideClip(layerId: string, deltaSeconds: number): void {
    const fr = this.timeline.getFrameRate();
    this.timeline.slideLayer(layerId, Math.round(secondsToFrames(deltaSeconds, fr)));
  }

  // ── Roll (two-sided trim at a cut) ───────────────────────────────

  /**
   * The two bars that meet at a cut, addressed by SCENE NODE.
   *
   * Node ids, not layer ids, for the reason `splitLayerAtFrame` spells out at
   * length: engine layer ids are re-minted by `syncFromScene` after any scene
   * restore, so anything that captures one is stale by its own redo. Node ids
   * live in the document and survive.
   *
   * This also has to search, rather than take bar 0 of each node: splitting
   * again gives a node several bars, and only one pair of them actually meets.
   * The seam tolerance is one frame, matching `slideLayer`'s `abuts` — split
   * halves are exact, but a hand-built edit that is a frame apart is still an
   * edit the user sees as a cut.
   */
  private rollPair(leftNodeId: string, rightNodeId: string): { left: Layer; right: Layer } | null {
    if (leftNodeId === rightNodeId) return null;
    const lefts = this.getLayersForNode(leftNodeId);
    const rights = this.getLayersForNode(rightNodeId);
    let best: { left: Layer; right: Layer } | null = null;
    let bestGap = Infinity;
    for (const left of lefts) {
      for (const right of rights) {
        const gap = Math.abs(left.end - right.start);
        if (gap > 1 || gap >= bestGap) continue;
        best = { left, right };
        bestGap = gap;
      }
    }
    return best;
  }

  /**
   * How far the cut between two nodes' abutting bars may roll, in frames.
   * Exposed so the timeline can clamp its drag (and its HUD) to the truth
   * instead of committing an edit the engine will quietly shorten.
   */
  rollLimitsFor(leftNodeId: string, rightNodeId: string): { min: number; max: number } | null {
    const pair = this.rollPair(leftNodeId, rightNodeId);
    if (!pair) return null;
    if (pair.left.locked || pair.right.locked) return { min: 0, max: 0 };
    return rollLimits(pair.left.clip, pair.right.clip);
  }

  /**
   * ROLL EDIT — move the cut between two adjacent clips, in FRAMES.
   *
   * The left clip's out-point and the right clip's in-point travel together, so
   * the pair occupies exactly the same span afterwards and no gap opens. Both
   * ends are bounded by the source handles actually available (see
   * {@link rollLimits}); asking for more rolls as far as it can and reports
   * that, rather than failing or inventing footage.
   *
   * ONE history entry covers both bars. Doing this as two `trimLayer` calls —
   * which is what it looks like — costs two undo presses and leaves a gap in
   * the middle state, so a Ctrl+Z aimed at the roll shows the user a broken
   * edit before it shows them the old one. The geometry never touches the scene
   * graph, so this stays on the engine's own history exactly as trim and slide
   * do, with no snapshot suspension needed.
   *
   * Returns the delta actually applied (0 when nothing moved).
   */
  rollEdit(leftNodeId: string, rightNodeId: string, deltaFrames: number): number {
    const pair = this.rollPair(leftNodeId, rightNodeId);
    if (!pair) return 0;
    const { left, right } = pair;
    if (left.locked || right.locked) return 0;

    // Trial on clones: the applied delta has to be known BEFORE the history
    // entry is opened, so a clamped-to-zero roll pushes nothing at all.
    const leftTrial = left.clip.clone();
    const rightTrial = right.clip.clone();
    const applied = rollClips(leftTrial, rightTrial, deltaFrames);
    if (applied === 0) return 0;

    const leftPrev = left.clip.toJSON();
    const rightPrev = right.clip.toJSON();
    const leftNext = leftTrial.toJSON();
    const rightNext = rightTrial.toJSON();

    const set = (l: ReturnType<Clip['toJSON']>, r: ReturnType<Clip['toJSON']>): void => {
      left.clip = Clip.fromJSON(l);
      right.clip = Clip.fromJSON(r);
      this.timeline.events.emit('LayerUpdated', { layer: left, changed: 'clip' });
      this.timeline.events.emit('LayerUpdated', { layer: right, changed: 'clip' });
    };

    this.timeline.history.run({
      label: 'Roll Edit',
      do: () => set(leftNext, rightNext),
      undo: () => set(leftPrev, rightPrev),
    });
    return applied;
  }

  /** Roll a cut by a duration in SECONDS — the axis the timeline UI works in. */
  rollEditSeconds(leftNodeId: string, rightNodeId: string, deltaSeconds: number): number {
    const fr = this.timeline.getFrameRate();
    return this.rollEdit(leftNodeId, rightNodeId, Math.round(secondsToFrames(deltaSeconds, fr)));
  }

  // ── Time Mapping (Absolute ↔ Layer-BAR-Relative) ────────────────

  /**
   * Convert an absolute timeline time (seconds) to layer-BAR-relative time
   * (0 = the first clip bar's in-point).
   *
   * **NEVER use this for keyframes** — reading, writing, moving or displaying
   * them. Keyframes live on the axis the renderer samples, which this is not:
   * it is a naive "subtract the first clip's start" that ignores `sourceIn`,
   * the active clip, stretch/reverse/freeze and precomp time remaps. The
   * canonical keyframe conversions are {@link compToKeyframeTime} /
   * {@link keyframeToCompTime}. This helper exists ONLY for bar-anchored
   * geometry such as layer markers ({@link addLayerMarkerAtPlayhead}), which
   * travel with the clip bar by definition.
   */
  toLayerTime(nodeId: string, absoluteSeconds: number): number {
    const clips = this.getLayersForNode(nodeId);
    const firstClip = clips[0];
    if (clips.length === 0 || !firstClip) return absoluteSeconds;
    // We treat the first clip's start as the origin of layer time.
    return absoluteSeconds - (firstClip.start / this.timeline.getFrameRate().fps);
  }

  /**
   * Convert a layer-BAR-relative time (seconds) to absolute timeline time.
   * Same contract as {@link toLayerTime}: bar geometry only, never keyframes —
   * use {@link keyframeToCompTime} for those.
   */
  toAbsoluteTime(nodeId: string, layerSeconds: number): number {
    const clips = this.getLayersForNode(nodeId);
    const firstClip = clips[0];
    if (clips.length === 0 || !firstClip) return layerSeconds;
    return layerSeconds + (firstClip.start / this.timeline.getFrameRate().fps);
  }

  // ── Undo / redo (the engine's own history — clip edits, split, …) ─
  undo(): boolean {
    return this.timeline.history.undo();
  }
  redo(): boolean {
    return this.timeline.history.redo();
  }
  canUndo(): boolean {
    return this.timeline.history.canUndo;
  }
  canRedo(): boolean {
    return this.timeline.history.canRedo;
  }

  /** Mirror the timeline's horizontal scroll (px) into the engine view. */
  setScrollPixels(scrollLeftPx: number): void {
    const ppf = this.timeline.getView().pixelsPerFrame;
    if (ppf > 0) this.timeline.scrollTo(scrollLeftPx / ppf);
  }

  /**
   * Split one clip bar in two, each half backed by its OWN scene node.
   *
   * The node clone is the point. `Timeline.splitLayer` alone gives the right
   * half the left half's `sourceId`, and since everything above the engine —
   * selection, delete, the property inspector — addresses a LAYER by its node
   * id, two bars sharing one node are not two layers. Reported symptom: split a
   * rectangle, try to select and delete the second half, and nothing can be
   * done to it independently; delete took both halves away because it removes
   * the node they shared.
   *
   * One undo entry covers both halves of the operation. The app history is
   * suspended across the mutation so the engine's own `splitLayer` command is
   * not recorded separately (which would leave the user pressing Ctrl+Z twice,
   * with an incoherent scene in between: a clip bar pointing at a node that no
   * longer exists), and a single composite is pushed in its place.
   *
   * Returns the new right-hand layer id, or null when the frame does not fall
   * strictly inside the bar.
   */
  private splitLayerAtFrame(layerId: string, frame: number): string | null {
    const timeline = this.timeline;
    const layer = timeline.getLayer(layerId);
    if (!layer || layer.locked) return null;
    if (!(frame > layer.start && frame < layer.end)) return null;

    const sourceNodeId = layer.sourceId;
    // Nodeless bars (an engine-level track with no scene node behind it) keep
    // the plain engine behaviour — there is nothing to clone.
    const rightNodeId = sourceNodeId ? mintSplitNodeId(sourceNodeId) : null;
    const originalEnd = layer.end;

    let rightLayerId: string | null = null;

    /**
     * Find the bar to split (or the one to un-split) by SCENE NODE, not by the
     * layer id we started with.
     *
     * Timeline layer ids are not stable across the session: undoing any
     * snapshot entry that touches the scene makes `syncFromScene` rebuild every
     * bar from scratch with freshly minted ids. A command that captured an id
     * at the moment of the split is therefore stale by its own redo — which is
     * exactly how redo silently did nothing. Node ids live in the document and
     * survive every restore, so they are what this addresses.
     */
    const barContaining = (nodeId: string | null, at: number): Layer | undefined => {
      if (!nodeId) return timeline.getLayer(layerId);
      this.invalidateLayerIndex();
      return this.getLayersForNode(nodeId).find((l) => at > l.start && at < l.end);
    };
    const barEndingAt = (nodeId: string | null, at: number): Layer | undefined => {
      if (!nodeId) return timeline.getLayer(layerId);
      this.invalidateLayerIndex();
      const bars = this.getLayersForNode(nodeId);
      return bars.find((l) => l.end === at) ?? bars[0];
    };

    // `batchScene` holds the scene notification until BOTH halves are in place.
    // Announcing the cloned node before its bar exists would send the
    // reconciler down the "node with no clip" path, where it seeds a
    // full-length bar — leaving the clone with two overlapping clips.
    const apply = (): void => {
      batchScene(() => {
        const target = barContaining(sourceNodeId, frame);
        if (!target) return;
        if (sourceNodeId && rightNodeId) cloneLayerNode(sourceNodeId, rightNodeId);
        timeline.history.silently(() => {
          const right = timeline.splitLayer(target.id, frame, rightNodeId ?? undefined);
          rightLayerId = right?.id ?? null;
        });
        if (!rightLayerId && rightNodeId) removeLayerNodeClone(rightNodeId);
        this.invalidateLayerIndex();
        bumpScene();
      });
    };

    const revert = (): void => {
      batchScene(() => {
        const right = rightNodeId
          ? this.getLayersForNode(rightNodeId)[0]
          : rightLayerId ? timeline.getLayer(rightLayerId) : undefined;
        const left = barEndingAt(sourceNodeId, frame);
        timeline.history.silently(() => {
          if (right) timeline.removeLayer(right.id);
          // Split only shortens the left bar's END, so restoring that end is
          // the whole inverse of the geometry change.
          if (left) timeline.trimLayer(left.id, 'end', originalEnd);
        });
        rightLayerId = null;
        if (rightNodeId) removeLayerNodeClone(rightNodeId);
        this.invalidateLayerIndex();
        bumpScene();
      });
    };

    const history = getCommandSystem_safe();
    // Two history mechanisms meet here and both want this edit.
    //
    //   • The ENGINE records clip geometry as explicit commands (onPush →
    //     TimelineCommandAdapter). Geometry is invisible to a scene snapshot.
    //   • The APP auto-captures a debounced scene+animation SNAPSHOT whenever
    //     SceneGraphChanged fires. Cloning a node fires it.
    //
    // Split is the first operation that changes BOTH domains, and left alone it
    // produced two undo entries for one act: the composite below, plus a
    // snapshot 700ms later. Undoing them in sequence restored a scene from
    // before the split on top of geometry that had already been reverted, and
    // the layer disappeared entirely.
    //
    // `flush` commits whatever edit was mid-debounce so it keeps its own step,
    // and `runRestoring` both silences the auto-capture for the duration and
    // re-baselines it afterwards — so the snapshot layer sees the post-split
    // scene as the new normal and has nothing left to record.
    const store = historyStore();
    store?.flush();
    const run = (fn: () => void): void => {
      history?.suspend();
      try {
        if (store) store.runRestoring(fn);
        else fn();
      } finally {
        history?.resume();
      }
    };

    run(apply);
    if (!rightLayerId) return null;

    history?.push({
      label: 'Split Layer',
      // Undo/redo arrive through `performUndo`/`performRedo`, which already
      // wrap the call in `runRestoring` — so these must NOT nest another one.
      // The engine push still has to be suspended, hence the direct calls.
      execute: () => {
        history?.suspend();
        try { apply(); } finally { history?.resume(); }
      },
      undo: () => {
        history?.suspend();
        try { revert(); } finally { history?.resume(); }
      },
    });
    return rightLayerId;
  }

  /** Split a clip at a timeline time (seconds); returns the new right layer id. */
  splitClip(layerId: string, seconds: number): string | null {
    const frame = Math.round(secondsToFrames(seconds, this.timeline.getFrameRate()));
    return this.splitLayerAtFrame(layerId, frame);
  }

  /**
   * Split every clip of the given nodes at the playhead (After Effects
   * Ctrl+Shift+D), and leave the RIGHT halves selected — AE's behaviour, and
   * the one that makes "split, then delete the tail" a two-step operation
   * instead of an impossible one.
   */
  splitSelectedAtPlayhead(nodeIds: readonly string[]): void {
    const frame = Math.round(this.timeline.currentFrame);
    const rightNodeIds: string[] = [];
    for (const nodeId of nodeIds) {
      // Snapshot the bars first: splitting appends to the same list, and
      // iterating it live would re-split the half just created.
      for (const layer of [...this.getLayersForNode(nodeId)]) {
        const rightLayerId = this.splitLayerAtFrame(layer.id, frame);
        if (!rightLayerId) continue;
        const rightSource = this.timeline.getLayer(rightLayerId)?.sourceId;
        if (rightSource && rightSource !== nodeId) rightNodeIds.push(rightSource);
      }
    }
    if (rightNodeIds.length > 0) useSelectionStore.getState().set(rightNodeIds);
  }

  /** Trim In point of selected layers to playhead (After Effects: Alt+[). */
  trimSelectedStartToPlayhead(nodeIds: readonly string[]): void {
    const frame = Math.round(this.timeline.currentFrame);
    for (const nodeId of nodeIds) {
      for (const layer of this.getLayersForNode(nodeId)) {
        if (frame < layer.end) {
          this.timeline.trimLayer(layer.id, 'start', frame);
        }
      }
    }
  }

  /** Trim Out point of selected layers to playhead (After Effects: Alt+]). */
  trimSelectedEndToPlayhead(nodeIds: readonly string[]): void {
    const frame = Math.round(this.timeline.currentFrame);
    for (const nodeId of nodeIds) {
      for (const layer of this.getLayersForNode(nodeId)) {
        if (frame > layer.start) {
          this.timeline.trimLayer(layer.id, 'end', frame);
        }
      }
    }
  }

  /** Move selected layers' start time to playhead (After Effects: [). */
  moveSelectedStartToPlayhead(nodeIds: readonly string[]): void {
    const frame = Math.round(this.timeline.currentFrame);
    for (const nodeId of nodeIds) {
      for (const layer of this.getLayersForNode(nodeId)) {
        this.timeline.setLayerStart(layer.id, frame);
      }
    }
  }

  /** Move selected layers' end time to playhead (After Effects: ]). */
  moveSelectedEndToPlayhead(nodeIds: readonly string[]): void {
    const frame = Math.round(this.timeline.currentFrame);
    for (const nodeId of nodeIds) {
      for (const layer of this.getLayersForNode(nodeId)) {
        const duration = layer.end - layer.start;
        this.timeline.setLayerStart(layer.id, frame - duration);
      }
    }
  }

  /** Remove a clip (engine layer). */
  deleteLayer(layerId: string): void {
    this.deleteLayerForClip(layerId, { ripple: false });
  }

  /** Ripple-delete: remove the layer and close the gap on the same track. */
  rippleDeleteLayer(layerId: string): void {
    this.deleteLayerForClip(layerId, { ripple: true });
  }

  /**
   * Delete the LAYER a clip bar belongs to — its scene node, its animation and
   * every bar of it.
   *
   * These two used to call `Timeline.removeLayer` / `rippleRemoveLayer`, which
   * only ever removed the BAR. The scene node survived, so the timeline row
   * stayed behind with nothing on it, and the next `syncFromScene` — any
   * structural scene change at all — found a node with no clip and seeded it a
   * fresh full-length bar. The layer came back, and the user's report was that
   * deleting from the timeline simply does not work while deleting from the
   * Scene tree does.
   *
   * `ripple` is the only real difference between the two menu entries: later
   * clips on the same track slide left to close the gap the layer leaves. Both
   * delete the layer completely.
   *
   * One undo entry covers the scene half and the clip geometry, for the reason
   * spelled out in `splitLayerAtFrame`: geometry is invisible to the app's
   * scene snapshot, so the two halves have to be recorded together or undo
   * restores one without the other.
   */
  deleteLayerForClip(layerId: string, opts: { ripple?: boolean } = {}): boolean {
    const timeline = this.timeline;
    const layer = timeline.getLayer(layerId);
    if (!layer || layer.locked) return false;
    const nodeId = layer.sourceId;
    if (!nodeId) {
      // A bar with no scene node behind it (engine-level track). Nothing to
      // delete but the bar itself, and nothing will resurrect it.
      if (opts.ripple) timeline.rippleRemoveLayer(layerId);
      else timeline.removeLayer(layerId);
      return true;
    }

    // Captured BEFORE the mutation: `revert` needs the geometry back, and the
    // node is about to stop existing.
    const track = timeline.getTrack(layer.trackId);
    const gap = layer.duration;
    const shifted = opts.ripple && track
      ? track.layers
          .filter((l) => l.id !== layerId && l.sourceId && l.start >= layer.end)
          .map((l) => ({ nodeId: l.sourceId as string, start: l.start }))
      : [];
    const snapshot = captureLayerSnapshot(nodeId);
    // The bar's own geometry, which no scene snapshot carries.
    snapshot.clip = { start: layer.start, end: layer.end };

    const apply = (): void => {
      batchScene(() => {
        timeline.history.silently(() => {
          for (const s of shifted) {
            for (const l of this.getLayersForNode(s.nodeId)) {
              if (l.start === s.start) timeline.setLayerStart(l.id, Math.max(0, s.start - gap));
            }
          }
        });
        deleteLayerNode(nodeId);
        // Reconcile HERE rather than waiting for the `SceneGraphChanged`
        // subscriber to do it. The bar outlives the node until something
        // reconciles, and leaving that to an event round-trip is what made the
        // old delete look like it had worked and then un-worked: the row
        // vanished, the bar stayed, and the next sync re-seeded a full-length
        // clip. `revert` reconciles explicitly for the same reason.
        this.syncFromScene();
        this.invalidateLayerIndex();
        bumpScene();
      });
    };

    const revert = (): void => {
      batchScene(() => {
        restoreLayerSnapshot(snapshot);
        // `syncFromScene` seeds the restored node a full-length bar; put its
        // real geometry back on top of that.
        this.syncFromScene();
        timeline.history.silently(() => {
          // `syncFromScene` seeds exactly ONE bar for a node that had none, so
          // this is the bar it just made. Move it, then trim — trimEnd takes an
          // absolute frame, so the order matters.
          const restored = this.getLayersForNode(nodeId)[0];
          if (restored) {
            timeline.setLayerStart(restored.id, snapshot.clip.start);
            timeline.trimLayer(restored.id, 'end', snapshot.clip.end);
          }
          for (const s of shifted) {
            for (const l of this.getLayersForNode(s.nodeId)) {
              if (l.start === Math.max(0, s.start - gap)) timeline.setLayerStart(l.id, s.start);
            }
          }
        });
        this.invalidateLayerIndex();
        bumpScene();
      });
    };

    const history = getCommandSystem_safe();
    const store = historyStore();
    store?.flush();
    const run = (fn: () => void): void => {
      history?.suspend();
      try {
        if (store) store.runRestoring(fn);
        else fn();
      } finally {
        history?.resume();
      }
    };

    run(apply);
    history?.push({
      label: opts.ripple ? 'Ripple Delete Layer' : 'Delete Layer',
      execute: () => {
        history?.suspend();
        try { apply(); } finally { history?.resume(); }
      },
      undo: () => {
        history?.suspend();
        try { revert(); } finally { history?.resume(); }
      },
    });
    return true;
  }

  /** Ripple-trim the clip's out-point (seconds) and pull later clips left. */
  rippleTrimClipEnd(layerId: string, endSeconds: number): void {
    const fr = this.timeline.getFrameRate();
    this.timeline.rippleTrimEnd(layerId, Math.round(secondsToFrames(endSeconds, fr)));
  }

  /** Ripple-trim the clip's in-point (seconds); bar start stays, later clips shift. */
  rippleTrimClipStart(layerId: string, startSeconds: number): void {
    const fr = this.timeline.getFrameRate();
    this.timeline.rippleTrimStart(layerId, Math.round(secondsToFrames(startSeconds, fr)));
  }

  /** Open a gap on the clip's track at `atSeconds`, pushing later clips right. */
  rippleInsertGapAt(layerId: string, atSeconds: number, durationSeconds: number): void {
    const layer = this.timeline.getLayer(layerId);
    if (!layer) return;
    const fr = this.timeline.getFrameRate();
    this.timeline.rippleInsertGap(
      layer.trackId,
      Math.round(secondsToFrames(atSeconds, fr)),
      Math.max(1, Math.round(secondsToFrames(durationSeconds, fr))),
    );
  }

  // ── Markers (exposed to the seconds-based UI) ────────────────────
  addMarkerAtPlayhead(label = 'Marker', color: string | null = '#3b82f6'): void {
    this.timeline.addMarker({ frame: Math.round(this.timeline.currentFrame), name: label, color, scope: 'timeline' });
  }
  /**
   * Add a LAYER marker on the given node's layer at the playhead (AE: layer
   * markers travel with the layer). The frame is stored layer-relative (0 = the
   * layer's in-point), so trimming or sliding the layer carries its markers
   * along. The Marker model, `layerIndex` routing and serialization already
   * support `scope:'layer'`; this fills the missing controller entry point.
   * Returns false when the node has no timeline layer.
   */
  addLayerMarkerAtPlayhead(nodeId: string, label = 'Marker', color: string | null = '#a855f7'): boolean {
    const layer = this.getLayersForNode(nodeId)[0];
    if (!layer) return false;
    const fps = this.timeline.getFrameRate().fps;
    const layerSeconds = this.toLayerTime(nodeId, this.timeline.currentFrame / fps);
    this.timeline.addMarker({
      frame: Math.round(layerSeconds * fps),
      name: label,
      color,
      scope: 'layer',
      ownerId: layer.id,
    });
    return true;
  }
  removeMarker(id: string): void {
    this.timeline.removeMarker(id);
  }
  // ── Work area (in/out region; playback loops within it) ──────────
  /** Set the work-area in-point to the current playhead (After Effects: B). */
  setWorkAreaIn(): void {
    const f = Math.round(this.timeline.currentFrame);
    const wa = this.timeline.getRanges().workArea;
    const outFrame = wa ? wa.start + wa.duration : this.timeline.duration;
    const start = Math.min(f, outFrame - 1);
    this.timeline.setRange('workArea', { start, duration: outFrame - start });
    this.syncLoopToWorkArea();
  }
  /** Set the work-area out-point to the current playhead (After Effects: N). */
  setWorkAreaOut(): void {
    const f = Math.round(this.timeline.currentFrame);
    const wa = this.timeline.getRanges().workArea;
    const inFrame = wa ? wa.start : 0;
    const end = Math.max(f, inFrame + 1);
    this.timeline.setRange('workArea', { start: inFrame, duration: end - inFrame });
    this.syncLoopToWorkArea();
  }
  /** Set the work area to an explicit range in seconds (drag on the band). */
  setWorkArea(startSeconds: number, endSeconds: number): void {
    const rate = this.timeline.getFrameRate();
    const startF = Math.max(0, Math.round(secondsToFrames(startSeconds, rate)));
    const endF = Math.min(this.timeline.duration, Math.round(secondsToFrames(endSeconds, rate)));
    if (endF <= startF) return;
    this.timeline.setRange('workArea', { start: startF, duration: endF - startF });
    this.syncLoopToWorkArea();
  }

  /** Clear the work area; playback covers the whole composition again. */
  clearWorkArea(): void {
    this.timeline.setRange('workArea', null);
    this.syncLoopToWorkArea();
  }
  /** Work area in seconds, or null when unset. */
  getWorkArea(): { start: number; end: number } | null {
    const wa = this.timeline.getRanges().workArea;
    if (!wa) return null;
    const rate = this.timeline.getFrameRate();
    return {
      start: framesToSeconds(wa.start, rate),
      end: framesToSeconds(wa.start + wa.duration, rate),
    };
  }
  // ── Looping (a preview setting, NOT the work area) ────────────────
  /**
   * Whether playback loops. Independent of the work area: the two are separate
   * concepts in After Effects, and conflating them meant the Loop button
   * silently destroyed a work area set with B/N (and cleared it on mount).
   *
   * The loop RANGE follows the work area when one is set, which is what makes
   * B/N define a preview region.
   */
  isLooping(): boolean {
    return this.loopingByComp.get(this.activeCompId) ?? true;
  }

  setLooping(on: boolean): void {
    this.loopingByComp.set(this.activeCompId, on);
    this.syncLoopToWorkArea();
  }

  private syncLoopToWorkArea(): void {
    if (!this.isLooping()) {
      // No loop range ⇒ the engine parks the playhead at the end.
      this.timeline.setRange('loop', null);
      return;
    }
    const wa = this.timeline.getRanges().workArea;
    this.timeline.setRange('loop', wa ? { ...wa } : { start: 0, duration: this.timeline.duration });
  }

  /** Seek to the next timeline marker after the playhead (if any). */
  goToNextMarker(): void {
    const m = this.timeline.markers.next(Math.round(this.timeline.currentFrame));
    if (m) this.timeline.seek(m.frame);
  }
  /** Seek to the previous timeline marker before the playhead (if any). */
  goToPrevMarker(): void {
    const m = this.timeline.markers.previous(Math.round(this.timeline.currentFrame));
    if (m) this.timeline.seek(m.frame);
  }

  /**
   * Seek to the Nth COMP marker, 1-based, in TIME order — the operation behind
   * the number-key shortcuts.
   *
   * "Nth" is by time, not creation order, because time order is the only one a
   * user can see: markers are a row on the ruler and "jump to the third one"
   * means the third one along.
   *
   * No sort here, and that is VERIFIED rather than assumed: `MarkerList` keeps
   * itself ordered by frame (`insertSorted` on add, `reindex()` after an
   * in-place frame change) and says so in its own header — being ordered is the
   * reason `at`/`next`/`previous` are O(log n). An earlier draft of this method
   * re-sorted defensively and carried a docstring claiming the order was
   * undocumented; it is documented, the sort was dead, and a local sort would
   * have MASKED a genuinely stale list instead of surfacing it.
   *
   * COMP scope only. Layer markers live on their own layer and
   * `layerMarkers.test.ts` guards that they do not leak into this list — a
   * number key that sometimes jumped to a marker belonging to whichever layer
   * happened to be selected would be unusable for beat work.
   *
   * Returns false when there is no Nth marker, so pressing 5 with three markers
   * set does NOTHING rather than seeking to frame 0.
   */
  goToMarkerIndex(n: number): boolean {
    if (!Number.isInteger(n) || n < 1) return false;
    const m = this.timeline.markers.list()[n - 1];
    if (!m) return false;
    this.timeline.seek(m.frame);
    return true;
  }

  /** How many comp markers exist — lets a command disable itself honestly. */
  compMarkerCount(): number {
    return this.timeline.markers.list().length;
  }

  private collectKeyframeTimes(): number[] {
    const ids = useSelectionStore.getState().ids;
    let nodeIds: string[];
    if (ids.length > 0) {
      nodeIds = [...ids];
    } else {
      nodeIds = [];
      defaultSceneGraph.traverse((n) => nodeIds.push(n.id));
    }
    const times = new Set<number>();

    for (const nodeId of nodeIds) {
      const tracks = defaultAnimation.tracksFor(nodeId);
      for (const track of tracks) {
        for (const kf of track.keyframes) {
          // `kf.t` is LAYER time — the canonical keyframe axis. The playhead
          // these are compared against is COMP time, so they must be converted
          // or navigation runs on a different clock than the diamonds it is
          // meant to land on. On a layer whose bar starts at 2s, keyframes at
          // layer 0s/2s draw at comp 2s/4s but were offered as 0s/2s: J/K
          // jumped to the wrong frames and then dead-ended, because no raw
          // layer time was ever greater than the comp-time playhead.
          // Same conversion the timeline rows already use to place the
          // diamonds, so navigation and display finally agree.
          times.add(keyframeToCompTime(nodeId, kf.t, track.prop as string));
        }
      }
    }
    return Array.from(times).sort((a, b) => a - b);
  }

  /** Seek to the next keyframe after the playhead across selected layers (or all). */
  goToNextKeyframe(): void {
    const currentT = framesToSeconds(this.timeline.currentFrame, this.timeline.getFrameRate());
    const times = this.collectKeyframeTimes();
    // Use a small epsilon to avoid getting stuck on the current keyframe due to float precision
    const next = times.find(t => t > currentT + 0.0001);
    if (next !== undefined) {
      this.seekSeconds(next);
    }
  }

  /** Seek to the previous keyframe before the playhead across selected layers (or all). */
  goToPrevKeyframe(): void {
    const currentT = framesToSeconds(this.timeline.currentFrame, this.timeline.getFrameRate());
    const times = this.collectKeyframeTimes();
    const prev = times.slice().reverse().find(t => t < currentT - 0.0001);
    if (prev !== undefined) {
      this.seekSeconds(prev);
    }
  }
  getMarkers(): TimelineMarkerView[] {
    const rate = this.timeline.getFrameRate();
    return this.timeline.markers.list().map((m) => ({
      id: m.id,
      time: framesToSeconds(m.frame, rate),
      label: m.name || 'Marker',
      color: m.color,
      comment: m.comment,
      duration: framesToSeconds(m.duration, rate),
    }));
  }

  /**
   * A node's LAYER markers, converted back to comp time.
   *
   * Layer markers are stored layer-relative (0 = the layer's in-point) so they
   * travel with a trimmed or slid layer. Everything that draws them works in
   * comp seconds, so the inverse of the `toLayerTime` used when writing has to
   * be applied here — without it a marker on a layer starting at 2 s would draw
   * 2 s early. `toAbsoluteTime` existed for exactly this and had no callers,
   * because there was no read path at all: `addLayerMarkerAtPlayhead` wrote into
   * `layer.markers`, which nothing ever listed, so layer markers were invisible.
   */
  getLayerMarkers(nodeId: string): TimelineMarkerView[] {
    const rate = this.timeline.getFrameRate();
    const out: TimelineMarkerView[] = [];
    for (const layer of this.getLayersForNode(nodeId)) {
      for (const m of layer.markers.list()) {
        out.push({
          id: m.id,
          time: this.toAbsoluteTime(nodeId, framesToSeconds(m.frame, rate)),
          label: m.name || 'Marker',
          color: m.color,
          comment: m.comment,
          // NOT run through `toAbsoluteTime`: that maps an INSTANT from layer
          // to comp time, and a duration is a difference between two instants.
          // Converting it would add the layer's start offset to a length.
          duration: framesToSeconds(m.duration, rate),
        });
      }
    }
    return out;
  }

  // ── Persistence ──────────────────────────────────────────────────
  /**
   * Serialize every live composition timeline, keyed by composition id.
   *
   * This is the time domain's only route into the project file. Without it the
   * scene graph saves but every trim, split, clip position, marker and the work
   * area are discarded on reload and regenerated from scratch by syncFromScene.
   */
  capture(): Record<string, SerializedTimeline> {
    const out: Record<string, SerializedTimeline> = {};
    for (const [compId, timeline] of this.registries) {
      out[compId] = serializeTimeline(timeline);
    }
    return out;
  }

  /**
   * Drop every composition timeline.
   *
   * For File ▸ New Project, which cannot express this as a document: `restore`
   * merges the compositions a document names and leaves the rest, and an empty
   * document names none — so a new project kept the previous one's clips,
   * markers and work areas, now pointing at scene nodes that no longer exist.
   *
   * Safe to call at any time: `get timeline()` re-creates the active
   * composition's timeline on next access, seeded from the comp settings that
   * are live by then (so this must run AFTER the new comps are in place).
   */
  reset(): void {
    this.registries.clear();
    this.compositionTrackIds.clear();
    this.loopingByComp.clear();
  }

  /**
   * Rebuild the composition timelines from a captured document.
   *
   * Restores into instances created by `initTimeline` so the history hook and
   * event wiring survive, then reconciles against the scene: `syncFromScene`
   * only adds clips for nodes that have none and drops orphans, so restored
   * clip geometry is left intact. Call AFTER the scene graph is restored.
   */
  restore(docs: Record<string, SerializedTimeline> | undefined | null): void {
    if (!docs) return;
    const wasReconciling = this.reconciling;
    this.reconciling = true;
    try {
      for (const [compId, doc] of Object.entries(docs)) {
        if (!doc) continue;
        if (!this.registries.has(compId)) this.initTimeline(compId);
        const timeline = this.registries.get(compId);
        if (!timeline) continue;

        applySerializedTimeline(timeline, doc);

        // Track identity is re-established from the restored document — the id
        // minted by initTimeline belonged to a track we just replaced.
        const tracks = timeline._internal().tracks;
        const compTrack = tracks.find((t) => t.name === 'Composition') ?? tracks[0];
        if (compTrack) {
          this.compositionTrackIds.set(compId, compTrack.id);
        } else {
          const fresh = timeline.addTrack({ name: 'Composition', kind: 'group' });
          this.compositionTrackIds.set(compId, fresh.id);
        }

        this.syncFromScene(compId);
      }
    } finally {
      this.reconciling = wasReconciling;
    }
  }

  // ── Scene → layers mirror ────────────────────────────────────────
  /**
   * Reconcile timeline layers to the current scene nodes: one layer per node on
   * the composition track, spanning the whole comp. Structural mirror — not
   * undoable, so it runs with history suppressed.
   */
  syncFromScene(compId?: string): void {
    const ws = useWorkspaceStore.getState();
    const activeTabId = ws.activeTabId;
    const tab = activeTabId ? ws.tabs[activeTabId] : null;
    const targetCompId = compId || tab?.compositionId || 'scene-root';

    const timeline = this.registries.get(targetCompId);
    if (!timeline) return;
    const trackId = this.compositionTrackIds.get(targetCompId);
    if (!trackId) return;
    const track = timeline.getTrack(trackId);
    if (!track) return;

    // Every layer of the composition, walked THROUGH parented layers: in this
    // graph `parent` IS the tree, so parenting a rect to a null physically
    // nests it — and mirroring only the root's immediate children DELETED the
    // rect's timeline clip the moment it was parented (row, keyframes and
    // duration bar all vanished while the viewport kept rendering it — the
    // renderer flattens the whole subtree). After Effects' rule: a layer
    // keeps its place in the stack no matter who its parent is. GROUPS remain
    // the one collapse mechanism — their members are not independent clips,
    // so the walk does not descend into them.
    const nodes: SceneNode[] = [];
    const collect = (parentId: string): void => {
      for (const n of defaultSceneGraph.getChildren(parentId)) {
        nodes.push(n);
        if (readNodeKind(n) !== 'group') collect(n.id as string);
      }
    };
    collect(targetCompId);
    const wantIds = new Set(nodes.map((n) => n.id as string));
    // A node may back MULTIPLE clips (after a split), so group by sourceId.
    const bySource = new Map<string, Layer[]>();
    for (const layer of track.layers) {
      if (!layer.sourceId) continue;
      const arr = bySource.get(layer.sourceId) ?? [];
      arr.push(layer);
      bySource.set(layer.sourceId, arr);
    }

    // Structural mirror of the scene, not a user edit — SceneGraphChanged has
    // already told autosave about whatever caused this.
    const wasReconciling = this.reconciling;
    this.reconciling = true;
    try {
    timeline.history.silently(() => {
      // Add one clip for new nodes; refresh props on existing clips (don't touch
      // geometry — that's user-edited).
      for (const node of nodes) {
        const nodeId = node.id as string;
        const existing = bySource.get(nodeId);
        if (existing && existing.length > 0) {
          for (const layer of existing) {
            layer.name = node.name ?? nodeId;
            layer.enabled = node.visible !== false;
            layer.locked = node.locked === true;
            // Media layers learn their real footage bound as soon as it is
            // known (asset metadata probes async) — bounds future trims only.
            if (layer.clip.sourceDuration === null) {
              const late = mediaSourceFrames(node, timeline.getFrameRate().fps);
              if (late !== null) layer.clip.sourceDuration = late;
            }
          }
        } else {
          // Video/audio clips are bounded by their real footage length so a
          // clip can't be stretched past media that doesn't exist; generative
          // layers (shapes/text/images) stay unbounded (null).
          const sourceFrames = mediaSourceFrames(node, timeline.getFrameRate().fps);
          timeline.addLayer(trackId, {
            name: node.name ?? nodeId,
            sourceId: nodeId,
            enabled: node.visible !== false,
            locked: node.locked === true,
            clip: {
              start: 0,
              duration: sourceFrames !== null ? Math.min(timeline.duration, sourceFrames) : timeline.duration,
              sourceDuration: sourceFrames ?? undefined,
            },
          });
        }
      }
      // Remove clips whose source node is gone.
      for (const [sourceId, layers] of bySource) {
        if (!wantIds.has(sourceId)) for (const l of layers) timeline.removeLayer(l.id);
      }
    });
    } finally {
      this.reconciling = wasReconciling;
      // Clip membership may have changed (adds/removes above) — drop the
      // memoized sourceId→layers index.
      this.invalidateLayerIndex();
    }
  }
}

let singleton: TimelineController | null = null;

/** The app-wide timeline controller (created on first use). */
export function getTimelineController(): TimelineController {
  if (!singleton) {
    singleton = new TimelineController();
    const isDev = typeof process !== 'undefined' && process.env ? process.env.NODE_ENV === 'development' : true;
    if (isDev && typeof window !== 'undefined') {
      (window as unknown as { __timeline?: TimelineController }).__timeline = singleton;
    }
  }
  return singleton;
}

// ── Canonical keyframe time axis ──────────────────────────────────
//
// Keyframes are stored on ONE axis: the time `buildSnapshot` hands the
// animation engine for the node (its `remapOf`). Every surface that reads,
// writes, moves or draws a keyframe must convert through this pair —
// `compToKeyframeTime` on the way in, `keyframeToCompTime` on the way out.
// Anything else re-creates the "typed a value at 5s, it overwrote my 1s
// keyframe" family of bugs the moment a clip is trimmed, slid, split,
// stretched or nested in a remapped precomp.

/** Props the renderer samples on the PRECOMP-CHAIN axis (a group's own remap
 *  track is read at chain time — buildSnapshot's `sourceTime` / ancestor fold —
 *  never through the group's own clip/stretch mapping). */
const REMAP_PROPS: ReadonlySet<string> = new Set(['timeRemap', 'precompTime']);

/** Comp-instance indirection: clones sample the ORIGINAL node's tracks and
 *  clips (buildSnapshot's `srcId`); real nodes map to themselves. */
function srcIdOf(nodeId: string): string {
  return instanceSourceOf(defaultSceneGraph.getNode(nodeId)) ?? nodeId;
}

/**
 * A fingerprint of every clip bar in a composition.
 *
 * Clip geometry lives in the Timeline Engine, NOT in the scene graph or the
 * animation engine — so it is absent from `sceneContentHash`, and the viewport
 * frame cache (which keys on that hash) could not see a bar move. Frames
 * rendered before a drag stayed servable afterwards, and playback interleaved
 * them with freshly rendered ones: the layer flickered in and out at times it
 * no longer occupied, and only "worked" once every frame had been re-rendered.
 *
 * A HASH rather than a change counter, for the reason `sceneContentHash` is one:
 * undo restores identical geometry, and identical geometry must produce an
 * identical key or every undo throws away a warm cache.
 *
 * Cheap by construction — one pass over the composition's own layers, four
 * numbers each. Call it once per clip edit, not per frame.
 */
export function clipGeometrySignature(compId?: string): string {
  const controller = getTimelineController();
  const parts: string[] = [];
  for (const layer of controller.layersOfComp(compId)) {
    parts.push(
      `${layer.sourceId ?? ''}:${layer.start}:${layer.duration}:${layer.clip.sourceIn}`,
    );
  }
  // Sorted: track order is an implementation detail of how layers were added,
  // and a reorder that changes no geometry must not invalidate the cache.
  parts.sort();
  return parts.join('|');
}

/**
 * The clips that GOVERN a node's time — its own, or its enclosing GROUP's.
 *
 * ── The bug this exists for ────────────────────────────────────────────
 * `syncFromScene` deliberately does not descend into groups: a group is the
 * collapse unit, so it gets ONE clip bar and its members get none. But the
 * renderer draws the MEMBERS, not the group — groups are skipped in the layer
 * walk — and both the in/out gate and the keyframe time axis asked each drawn
 * layer for ITS OWN clips. A member has none, both treated "no clips" as "no
 * constraints", and the group's bar governed nothing at all.
 *
 * The bar was therefore decorative on every grouped element, which is every
 * item the Motion GFX library inserts. Trimming it did nothing. Dragging it to
 * start at two seconds did nothing. The layer drew from frame zero regardless,
 * and there was no error anywhere to suggest why.
 *
 * The walk is the exact inverse of `collect`'s: it stops climbing where that
 * one stops descending, so every node is governed by precisely the clip the
 * timeline drew for it.
 *
 * PRECOMPS are not climbed through. A precomp's children live in the precomp's
 * own timeline and are folded by `foldPrecompChain`; borrowing the instance's
 * clip here as well would apply that mapping twice.
 */
export function governingClipsFor(nodeId: string): Layer[] {
  const controller = getTimelineController();
  const own = controller.getLayersForNode(srcIdOf(nodeId));
  if (own.length > 0) return own;

  let node = defaultSceneGraph.getNode(nodeId);
  // Bounded rather than `while (true)`: a malformed parent cycle must not hang
  // a render. Nothing legitimate nests groups this deep.
  for (let depth = 0; depth < 32; depth++) {
    const parentId = node?.parent ?? null;
    if (!parentId) return [];
    const parent = defaultSceneGraph.getNode(parentId);
    if (!parent) return [];
    // A precomp boundary, or anything that is not a plain group, ends the walk:
    // only a group's members are clip-less by design.
    if (isPrecomp(parent) || readNodeKind(parent) !== 'group') return [];
    const clips = controller.getLayersForNode(srcIdOf(parent.id as string));
    if (clips.length > 0) return clips;
    node = parent;
  }
  return [];
}

/** The node's precomp-group ancestors, OUTERMOST first, excluding itself
 *  (mirrors `precompAncestorChain`, reading straight off the scene graph). */
function precompChainOf(nodeId: string): SceneNode[] {
  const chain: SceneNode[] = [];
  let parentId = defaultSceneGraph.getNode(nodeId)?.parent ?? null;
  while (parentId) {
    const parent = defaultSceneGraph.getNode(parentId);
    if (!parent) break;
    if (isPrecomp(parent)) chain.push(parent);
    parentId = parent.parent ?? null;
  }
  chain.reverse(); // outermost first — outer remaps feed inner ones
  return chain;
}

function isChainRemapAnimated(pc: SceneNode): boolean {
  const src = srcIdOf(pc.id);
  return defaultAnimation.isAnimated(src, 'timeRemap') || defaultAnimation.isAnimated(src, 'precompTime');
}

/** Fold every ancestor precomp's animated time remap over `compTime`,
 *  outermost → innermost — buildSnapshot's ancestor-chain composition. */
function foldPrecompChain(nodeId: string, compTime: number): number {
  let time = compTime;
  for (const pc of precompChainOf(nodeId)) {
    if (isChainRemapAnimated(pc)) {
      const src = srcIdOf(pc.id);
      time = defaultAnimation.sample(src, 'timeRemap', time)
        ?? defaultAnimation.sample(src, 'precompTime', time)
        ?? time;
    }
  }
  return time;
}

/**
 * Fold the owning composition's responsive-time stretch, if it has one.
 *
 * Costs one property lookup on the miss path, which is every non-template comp
 * and therefore essentially every sample.
 */
function applyResponsiveTime(nodeId: string, compTime: number): number {
  const controller = getTimelineController();
  const cfg = readResponsiveTime(controller.compIdForNode(nodeId));
  if (!cfg) return compTime;
  const fps = controller.fpsForNode(nodeId);
  const target = controller.durationFramesForNode(nodeId) / (fps || 1);
  if (!(target > 0)) return compTime;
  return stretchedToAuthored(compTime, cfg.authoredDurationSec, target, cfg.protectedRegions);
}

/**
 * Composition time → the axis `nodeId`'s keyframes are stored on. This is,
 * step for step, what `buildSnapshot`'s `remapOf` hands the animation engine:
 *
 *   1. fold the precomp ANCESTOR chain's animated time remaps (outermost →
 *      innermost) over comp time;
 *   2. clip retime — the clip ACTIVE at that frame maps it to its source frame
 *      (`sourceIn + (frame − start)`), frame-rounded exactly like the
 *      renderer; outside every clip the renderer falls through to the raw
 *      time, and so does this (a keyframe written there is self-consistent:
 *      the renderer samples the same raw time);
 *   3. the node's own stretch / reverse / freeze (`layerTime.remapTime`) on
 *      top. NOTE the span anchor is the node's keyframe span, which moves as
 *      keyframes are added — that is the renderer's own behavior, matched
 *      here rather than "fixed" one-sidedly.
 *
 * `prop` matters for the remap track itself: a group's `timeRemap` /
 * `precompTime` keyframes are sampled by the renderer at CHAIN time (step 1
 * only), so pass the prop being edited whenever it might be a remap track.
 */
export function compToKeyframeTime(nodeId: string, compTime: number, prop?: string): number {
  const controller = getTimelineController();
  const src = srcIdOf(nodeId);
  // 0 — RESPONSIVE TIME (M7). Stretched comp time -> authored comp time, so
  // protected regions keep their authored duration and only the unprotected
  // remainder absorbs a duration change.
  //
  // Composed into THIS function rather than added as a parallel path,
  // deliberately: this is the only axis keyframes are sampled on, and a second
  // one would let keyframes and the clip bar drift apart. Everything below
  // continues to work in authored time and needs no knowledge of the stretch.
  compTime = applyResponsiveTime(nodeId, compTime);
  // The OWNING comp's fps — a node nested in a precomp keeps its clips in the
  // precomp's timeline, which may run at a different rate than the active tab.
  const fps = controller.fpsForNode(src);
  let time = foldPrecompChain(nodeId, compTime);
  if (prop !== undefined && REMAP_PROPS.has(prop)) return time;
  const frame = Math.round(time * fps);
  // The GOVERNING clip, not merely this node's own: a group's members have no
  // clips, and reading only their own left a moved or trimmed group bar with no
  // effect on the animation inside it. See `governingClipsFor`.
  const active = governingClipsFor(nodeId).find((l) => l.isActiveAt(frame));
  if (active) time = active.clip.sourceFrameAt(frame) / fps;
  const node = defaultSceneGraph.getNode(nodeId);
  const cfg = node ? readNodeLayerTime(node) : undefined;
  if (cfg) time = remapTime(time, cfg, defaultAnimation.timeSpan(src) ?? { start: 0, end: 1 });
  return time;
}

/**
 * Stored keyframe time → the composition time where the renderer applies it —
 * the TRUE inverse of {@link compToKeyframeTime}, for display: timeline
 * diamonds, the graph editor, seeking to a keyframe.
 *
 * Deliberate choices where the forward map is not invertible:
 *   - Non-monotonic / hold ancestor remaps: scan the owning comp's frames and
 *     return the EARLIEST comp time whose forward map lands on the keyframe
 *     (nearest frame when nothing lands exactly — e.g. a hold jumped over it).
 *   - Freeze frame: every comp time samples `freezeTime`, so the map collapses
 *     to a point. Inverting as if unfrozen keeps the diamonds laid out (and
 *     round-tripping) instead of stacking them all on one instant.
 *   - A keyframe no clip reaches (trimmed-off head/tail): clamp to the nearest
 *     clip edge — the comp time where its clamped value actually takes effect.
 *   - Outside every clip with no clips at all: identity, matching the forward
 *     fall-through.
 */
export function keyframeToCompTime(nodeId: string, keyframeTime: number, prop?: string): number {
  const controller = getTimelineController();
  const src = srcIdOf(nodeId);
  const fps = controller.fpsForNode(src);
  // Animated ancestor remaps have no closed form (arbitrary keyframed curves,
  // holds, reversals) — invert by scanning the owning comp's frames against
  // the full forward map. Only entered when a chain remap is live.
  if (precompChainOf(nodeId).some(isChainRemapAnimated)) {
    const frames = controller.durationFramesForNode(src);
    let best = 0;
    let bestErr = Infinity;
    for (let f = 0; f <= frames; f++) {
      const err = Math.abs(compToKeyframeTime(nodeId, f / fps, prop) - keyframeTime);
      if (err === 0) return f / fps; // first (earliest) exact landing wins
      // Strict `<` keeps the EARLIEST of equally-near frames (hold plateaus).
      if (err < bestErr) { bestErr = err; best = f; }
    }
    return best / fps;
  }
  // The remap track itself lives on the chain axis; with no animated chain the
  // fold is the identity.
  if (prop !== undefined && REMAP_PROPS.has(prop)) return keyframeTime;
  let t = keyframeTime;
  // 3⁻¹ — stretch / reverse (freeze: see doc above).
  const node = defaultSceneGraph.getNode(nodeId);
  const cfg = node ? readNodeLayerTime(node) : undefined;
  if (cfg && !cfg.freeze) {
    const span = defaultAnimation.timeSpan(src) ?? { start: 0, end: 1 };
    const stretch = cfg.stretch > 0 ? cfg.stretch : 100;
    let s = t;
    if (cfg.reverse) s = span.start + span.end - s;
    t = span.start + (s - span.start) * (stretch / 100);
  }
  // 2⁻¹ — clip retime: earliest clip that shows this source frame, else the
  // nearest clip edge.
  //
  // The GOVERNING clips, exactly as `compToKeyframeTime` uses. These two are a
  // matched pair — one places a keyframe, the other draws it — and asking them
  // different questions is visible immediately: the motion follows a moved bar
  // while the diamonds stay behind, so the animation and the keyframes that
  // define it appear at different times. That is what "the keyframes don't move
  // with the template" was.
  const clips = governingClipsFor(nodeId);
  if (clips.length > 0) {
    const sourceFrame = Math.round(t * fps);
    let best: number | null = null;
    let bestDist = Infinity;
    for (const l of clips) { // getLayersForNode sorts by start → earliest wins
      const compFrame = l.start + (sourceFrame - l.clip.sourceIn);
      if (l.isActiveAt(compFrame)) { best = compFrame; break; }
      const clamped = Math.max(l.start, Math.min(l.end - 1, compFrame));
      const dist = Math.abs(compFrame - clamped);
      if (dist < bestDist) { bestDist = dist; best = clamped; }
    }
    if (best !== null) t = best / fps;
  }
  return t;
}

/**
 * @deprecated Old name for the canonical comp→keyframe axis, kept so existing
 * read surfaces stay on it. New code should call {@link compToKeyframeTime}
 * (and {@link keyframeToCompTime} for the display direction).
 */
export function getRemappedTime(nodeId: string, time: number): number {
  return compToKeyframeTime(nodeId, time);
}
