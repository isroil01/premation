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
import { useWorkspaceStore } from '@stores/workspaceStore';
import { useCompositionStore } from '@stores/compositionStore';
import defaultSceneGraph from '@core/scene/DefaultSceneGraph';
import { flattenScene } from '@core/scene/sceneDerive';

import { getCommandSystem } from '@core/commands/CommandSystem';
import type { IUndoableCommand, CommandContext } from '@core/commands/Command';
import type { Command as TimelineCommand } from '@motion/timeline';

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
  readonly timeline: Timeline;
  private readonly compositionTrackId: string;

  constructor() {
    // Initialise time facts from the composition settings (single source of
    // truth for fps + duration); the store defaults if nothing is persisted.
    const comp = useCompositionStore.getState();
    this.timeline = Timeline.create({
      name: 'Composition',
      frameRate: frameRate(comp.fps),
      duration: Math.max(1, Math.round(comp.durationSeconds * comp.fps)),
      historyOptions: {
        onPush: (cmd) => {
          getCommandSystem().getHistory().push(new TimelineCommandAdapter(cmd));
        }
      }
    });
    // Loop the whole composition during playback (matches the app's prior clock).
    this.timeline.setRange('loop', { start: 0, duration: this.timeline.duration });
    // One track holds a layer per scene node.
    const track = this.timeline.addTrack({ name: 'Composition', kind: 'group' });
    this.compositionTrackId = track.id;
    // Initial zoom so pixels-per-second matches the app's default (~80px/s).
    this.timeline.setZoom(80 / comp.fps);

    // Engine → store mirror (seconds). The store never re-enters the engine, so
    // no reentrancy guard is needed.
    this.timeline.events.on('CurrentTimeChanged', ({ frame, seconds }) => {
      useWorkspaceStore.getState().actions.setTime(seconds, Math.round(frame));
    });
    // Reflect engine play-state (e.g. auto-pause at the end) into the store.
    this.timeline.events.on('PlayStateChanged', ({ playing }) => {
      const ws = useWorkspaceStore.getState();
      const active = ws.activeId ? ws.workspaces[ws.activeId] : null;
      if (active && active.playing !== playing) ws.actions.setPlaying(playing);
    });

    this.syncFromScene();
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
  syncFromScene(): void {
    const track = this.timeline.getTrack(this.compositionTrackId);
    if (!track) return;
    const nodes = flattenScene(defaultSceneGraph).filter((n) => n.parent !== null); // skip comp root
    const wantIds = new Set(nodes.map((n) => n.id as string));
    // A node may back MULTIPLE clips (after a split), so group by sourceId.
    const bySource = new Map<string, Layer[]>();
    for (const layer of track.layers) {
      if (!layer.sourceId) continue;
      const arr = bySource.get(layer.sourceId) ?? [];
      arr.push(layer);
      bySource.set(layer.sourceId, arr);
    }

    this.timeline.history.silently(() => {
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
          }
        } else {
          this.timeline.addLayer(this.compositionTrackId, {
            name: node.name ?? nodeId,
            sourceId: nodeId,
            enabled: node.visible !== false,
            locked: node.locked === true,
            clip: { start: 0, duration: this.timeline.duration },
          });
        }
      }
      // Remove clips whose source node is gone.
      for (const [sourceId, layers] of bySource) {
        if (!wantIds.has(sourceId)) for (const l of layers) this.timeline.removeLayer(l.id);
      }
    });
  }
}

let singleton: TimelineController | null = null;

/** The app-wide timeline controller (created on first use). */
export function getTimelineController(): TimelineController {
  if (!singleton) {
    singleton = new TimelineController();
    if (import.meta.env?.DEV && typeof window !== 'undefined') {
      (window as unknown as { __timeline?: TimelineController }).__timeline = singleton;
    }
  }
  return singleton;
}
