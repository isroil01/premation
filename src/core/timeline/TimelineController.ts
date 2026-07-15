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

import { Timeline, frameRate, framesToSeconds, secondsToFrames, type Layer } from '@motion/timeline';
import { useWorkspaceStore } from '@stores/projectStore';
import { useCompositionStore } from '@stores/compositionStore';
import { useSelectionStore } from '@stores/selectionStore';
import { useAssetStore } from '@stores/assetStore';
import defaultSceneGraph from '@core/scene/DefaultSceneGraph';
import { readNodeKind } from '@core/scene/sceneDerive';
import type { SceneNode } from '@core/types';
import { defaultAnimation } from '@motion/animation';


import { getCommandSystem } from '@core/commands/CommandSystem';
import type { IUndoableCommand, CommandContext } from '@core/commands/Command';
import type { Command as TimelineCommand } from '@motion/timeline';

/**
 * The real footage length of a media node in FRAMES, or null when unbounded
 * (shapes/text/images/groups — anything generative). Video reads its asset's
 * probed metadata; audio reads the duration stamped on its Audio component.
 * Media whose duration isn't known yet stays unbounded (graceful).
 */
export function mediaSourceFrames(node: SceneNode, fps: number): number | null {
  const kind = readNodeKind(node);
  if (kind === 'video') {
    const t = node.components.find((c) => c.type === 'Transform');
    const assetId = t?.props.assetId;
    if (typeof assetId !== 'string') return null;
    const asset = useAssetStore.getState().assets.find((a) => a.id === assetId);
    const sec = asset?.metadata?.duration;
    return typeof sec === 'number' && sec > 0 ? Math.max(1, Math.round(sec * fps)) : null;
  }
  if (kind === 'audio') {
    const a = node.components.find((c) => c.type === 'Audio');
    const sec = a?.props.__duration;
    return typeof sec === 'number' && sec > 0 ? Math.max(1, Math.round(sec * fps)) : null;
  }
  return null;
}

export interface TimelineMarkerView {
  id: string;
  /** Seconds (for the seconds-based timeline UI). */
  time: number;
  label: string;
  color: string | null;
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

export class TimelineController {
  private registries = new Map<string, Timeline>();
  private compositionTrackIds = new Map<string, string>();

  get timeline(): Timeline {
    const ws = useWorkspaceStore.getState();
    const activeTabId = ws.activeTabId;
    const tab = activeTabId ? ws.tabs[activeTabId] : null;
    const compId = tab?.compositionId || 'comp_default';
    if (!this.registries.has(compId)) {
      this.initTimeline(compId);
    }
    return this.registries.get(compId)!;
  }

  private get compositionTrackId(): string {
    const ws = useWorkspaceStore.getState();
    const activeTabId = ws.activeTabId;
    const tab = activeTabId ? ws.tabs[activeTabId] : null;
    const compId = tab?.compositionId || 'comp_default';
    return this.compositionTrackIds.get(compId)!;
  }

  constructor() {
    // Initial timeline will be created lazily when accessed
  }

  private initTimeline(compId: string) {
    const compSettings = useCompositionStore.getState();
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
    const track = timeline.addTrack({ name: 'Composition', kind: 'group' });
    this.compositionTrackIds.set(compId, track.id);
    timeline.setZoom(80 / compSettings.fps);

    timeline.events.on('CurrentTimeChanged', ({ frame, seconds }) => {
      // Only mirror to the store if this is the active comp's timeline!
      const ws = useWorkspaceStore.getState();
      const activeTabId = ws.activeTabId;
      const tab = activeTabId ? ws.tabs[activeTabId] : null;
      if (tab?.compositionId === compId) {
        ws.actions.setTime(seconds, Math.round(frame));
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
  /** All engine layers backing a scene node (its clips), left→right. */
  getLayersForNode(nodeId: string): Layer[] {
    const track = this.timeline.getTrack(this.compositionTrackId);
    if (!track) return [];
    return track.layers.filter((l) => l.sourceId === nodeId).sort((a, b) => a.start - b.start);
  }

  /** Move a clip to an absolute timeline start (seconds). Undoable (one entry
   *  per drag gesture — the UI commits only on release). */
  setClipStart(layerId: string, startSeconds: number): void {
    this.timeline.setLayerStart(layerId, secondsToFrames(startSeconds, this.timeline.getFrameRate()));
  }

  /** Trim a clip edge to an absolute time (seconds). Undoable. */
  trimClipTo(layerId: string, edge: 'start' | 'end', seconds: number): void {
    this.timeline.trimLayer(layerId, edge, Math.round(secondsToFrames(seconds, this.timeline.getFrameRate())));
  }

  // ── Time Mapping (Absolute ↔ Layer-Relative) ────────────────────

  /** Convert an absolute timeline time (seconds) to layer-relative time. */
  toLayerTime(nodeId: string, absoluteSeconds: number): number {
    const clips = this.getLayersForNode(nodeId);
    const firstClip = clips[0];
    if (clips.length === 0 || !firstClip) return absoluteSeconds;
    // We treat the first clip's start as the origin of layer time.
    return absoluteSeconds - (firstClip.start / this.timeline.getFrameRate().fps);
  }

  /** Convert a layer-relative time (seconds) to absolute timeline time. */
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

  /** Split a clip at a timeline time (seconds); returns the new right layer id. */
  splitClip(layerId: string, seconds: number): string | null {
    const frame = Math.round(secondsToFrames(seconds, this.timeline.getFrameRate()));
    const right = this.timeline.splitLayer(layerId, frame);
    return right?.id ?? null;
  }

  /** Split every clip of the given nodes at the playhead (After Effects Ctrl+Shift+D). */
  splitSelectedAtPlayhead(nodeIds: readonly string[]): void {
    const frame = Math.round(this.timeline.currentFrame);
    for (const nodeId of nodeIds) {
      for (const layer of this.getLayersForNode(nodeId)) {
        if (frame > layer.start && frame < layer.end) this.timeline.splitLayer(layer.id, frame);
      }
    }
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
    this.timeline.removeLayer(layerId);
  }

  // ── Markers (exposed to the seconds-based UI) ────────────────────
  addMarkerAtPlayhead(label = 'Marker', color: string | null = '#3b82f6'): void {
    this.timeline.addMarker({ frame: Math.round(this.timeline.currentFrame), name: label, color, scope: 'timeline' });
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

  /** Clear the work area; playback loops the whole composition again. */
  clearWorkArea(): void {
    this.timeline.setRange('workArea', null);
    this.timeline.setRange('loop', { start: 0, duration: this.timeline.duration });
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
  private syncLoopToWorkArea(): void {
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
          times.add(kf.t);
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
    }));
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

    // Only sync immediate children of the target composition group/root!
    const nodes = defaultSceneGraph.getChildren(targetCompId);
    const wantIds = new Set(nodes.map((n) => n.id as string));
    // A node may back MULTIPLE clips (after a split), so group by sourceId.
    const bySource = new Map<string, Layer[]>();
    for (const layer of track.layers) {
      if (!layer.sourceId) continue;
      const arr = bySource.get(layer.sourceId) ?? [];
      arr.push(layer);
      bySource.set(layer.sourceId, arr);
    }

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

export function getRemappedTime(nodeId: string, time: number): number {
  const controller = getTimelineController();
  const fps = controller.timeline.getFrameRate().fps;
  const currentFrame = Math.round(time * fps);
  const clips = controller.getLayersForNode(nodeId);
  if (clips.length > 0) {
    const active = clips.find((l) => l.isActiveAt(currentFrame));
    if (active) {
      return active.clip.sourceFrameAt(currentFrame) / fps;
    }
  }
  return time;
}
