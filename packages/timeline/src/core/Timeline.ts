/**
 * Timeline — the data engine that manages all temporal data in the editor. It
 * owns tracks, layers, clips, markers, the playhead, selection, time ranges, and
 * navigation state; it stores, organizes, queries, and mutates time-based data.
 *
 * It does NOT render, animate objects, or touch React/DOM. It emits typed events
 * and routes every structural change through a local undo/redo History. Playback
 * is timer-free: an external clock calls `tick(dtMs)` (or `nextFrame`), so the
 * engine stays framework-independent.
 *
 * Canonical time unit: frames. Use the `time/` conversions for ms/seconds/timecode.
 */

import { TypedEmitter } from '../events/Emitter';
import type { TimelineEventMap } from '../events/TimelineEvents';
import { History } from '../history/History';
import { Playhead } from '../playhead/Playhead';
import { TimelineSelection } from '../selection/TimelineSelection';
import { Track, type TrackInit, type TrackFlags } from '../tracks/Track';
import { Layer, type LayerInit } from '../layers/Layer';
import { Clip } from '../clips/Clip';
import { Marker, type MarkerInit } from '../markers/Marker';
import { MarkerList } from '../markers/MarkerList';
import { type FrameRate, frameRate as makeFrameRate, FPS_30 } from '../time/FrameRate';
import { framesToSeconds, msToFrames, secondsToFrames, timecodeToFrames, convertFrames } from '../time/Time';
import { emptyRanges, type RangeKind, type TimelineRanges } from './ranges';
import { clampPixelsPerFrame, defaultView, type TimelineViewState } from './navigation';
import type { TimelineState } from './TimelineState';
import type { TimeRange } from '../utils/TimeRange';
import { uid } from '../utils/id';

export interface TrackGroup {
  id: string;
  name: string;
  collapsed: boolean;
  trackIds: string[];
}

export interface TimelineInit {
  id?: string;
  name?: string;
  frameRate?: FrameRate;
  /** Duration in frames. */
  duration?: number;
  historyOptions?: import('../history/History').HistoryOptions;
}

export class Timeline {
  readonly id: string;
  name: string;
  readonly events = new TypedEmitter<TimelineEventMap>();
  readonly history: History;
  readonly selection = new TimelineSelection();
  readonly playhead: Playhead;
  readonly markers = new MarkerList();

  private frameRate: FrameRate;
  private durationFrames: number;
  private readonly tracks: Track[] = [];
  private readonly trackIndex = new Map<string, Track>();
  private readonly layerIndex = new Map<string, Layer>();
  private readonly groups = new Map<string, TrackGroup>();
  private ranges: TimelineRanges = emptyRanges();
  private view: TimelineViewState = defaultView();
  private playing = false;

  constructor(init: TimelineInit = {}) {
    this.id = init.id ?? uid('timeline');
    this.name = init.name ?? 'Timeline';
    this.frameRate = init.frameRate ?? FPS_30;
    this.durationFrames = Math.max(0, init.duration ?? 0);
    this.history = new History(init.historyOptions);
    this.playhead = new Playhead(this.durationFrames);

    this.playhead.onChange = (current, previous): void => {
      this.events.emit('PlayheadMoved', { frame: current, previous });
      this.events.emit('CurrentTimeChanged', { frame: current, seconds: framesToSeconds(current, this.frameRate) });
    };
    this.selection.onChange = (snapshot): void => {
      this.events.emit('TimelineSelectionChanged', { selection: snapshot });
    };
  }

  /** Factory mirroring the documented `timeline.create` API. */
  static create(init: TimelineInit = {}): Timeline {
    const t = new Timeline(init);
    t.events.emit('TimelineCreated', { id: t.id });
    return t;
  }

  /** Release listeners and clear all data. */
  destroy(): void {
    this.pause();
    this.events.emit('TimelineDestroyed', { id: this.id });
    this.tracks.length = 0;
    this.trackIndex.clear();
    this.layerIndex.clear();
    this.groups.clear();
    this.markers.clear();
    this.history.clear();
    this.events.removeAll();
  }

  // ── Time / duration / frame rate ─────────────────────────────────
  getFrameRate(): FrameRate {
    return this.frameRate;
  }

  get fps(): number {
    return this.frameRate.fps;
  }

  get duration(): number {
    return this.durationFrames;
  }

  get currentFrame(): number {
    return this.playhead.current;
  }

  /** Set the total duration in frames (undoable). */
  setDuration(frames: number): void {
    const next = Math.max(0, Math.round(frames));
    const prev = this.durationFrames;
    if (next === prev) return;
    this.history.run({
      label: 'Set Duration',
      do: () => {
        this.durationFrames = next;
        this.playhead.setDuration(next);
        this.events.emit('DurationChanged', { duration: next, previous: prev });
      },
      undo: () => {
        this.durationFrames = prev;
        this.playhead.setDuration(prev);
        this.events.emit('DurationChanged', { duration: prev, previous: next });
      },
    });
  }

  /**
   * Change the frame rate. With `preserveTiming`, all frame positions are
   * rescaled so wall-clock times are unchanged; otherwise frame numbers stay and
   * the timing reinterprets. Undoable.
   */
  setFrameRate(fps: number | FrameRate, opts: { preserveTiming?: boolean } = {}): void {
    const next = typeof fps === 'number' ? makeFrameRate(fps) : fps;
    const prev = this.frameRate;
    if (next.fps === prev.fps && next.dropFrame === prev.dropFrame) return;
    const rescale = opts.preserveTiming === true;
    this.history.run({
      label: 'Set Frame Rate',
      do: () => this.applyFrameRate(next, prev, rescale),
      undo: () => this.applyFrameRate(prev, next, rescale),
    });
  }

  private applyFrameRate(to: FrameRate, from: FrameRate, rescale: boolean): void {
    this.frameRate = to;
    if (rescale) {
      const conv = (f: number): number => convertFrames(f, from, to);
      for (const track of this.tracks) {
        for (const layer of track.layers) {
          layer.clip.start = conv(layer.clip.start);
          layer.clip.duration = conv(layer.clip.duration);
          layer.clip.sourceIn = conv(layer.clip.sourceIn);
          if (layer.clip.sourceDuration !== null) layer.clip.sourceDuration = conv(layer.clip.sourceDuration);
          for (const m of layer.markers.list()) m.frame = conv(m.frame);
          layer.markers.reindex();
        }
        for (const m of track.markers.list()) m.frame = conv(m.frame);
        track.markers.reindex();
      }
      for (const m of this.markers.list()) m.frame = conv(m.frame);
      this.markers.reindex();
      this.durationFrames = Math.round(conv(this.durationFrames));
      this.playhead.setDuration(this.durationFrames);
      this.playhead.set(conv(this.playhead.current));
      this.ranges = {
        loop: this.ranges.loop ? { start: conv(this.ranges.loop.start), duration: conv(this.ranges.loop.duration) } : null,
        preview: this.ranges.preview
          ? { start: conv(this.ranges.preview.start), duration: conv(this.ranges.preview.duration) }
          : null,
        workArea: this.ranges.workArea
          ? { start: conv(this.ranges.workArea.start), duration: conv(this.ranges.workArea.duration) }
          : null,
      };
    }
    this.events.emit('FrameRateChanged', { frameRate: to, previous: from });
  }

  // ── Playhead / navigation in time ────────────────────────────────
  seek(frame: number): void {
    this.playhead.seek(frame);
  }
  seekSeconds(seconds: number): void {
    this.playhead.seek(secondsToFrames(seconds, this.frameRate));
  }
  seekTimecode(tc: string): void {
    this.playhead.seek(timecodeToFrames(tc, this.frameRate));
  }
  nextFrame(): void {
    this.playhead.nextFrame();
  }
  previousFrame(): void {
    this.playhead.previousFrame();
  }
  goToStart(): void {
    this.playhead.goToStart();
  }
  goToEnd(): void {
    this.playhead.goToEnd();
  }

  // ── Playback (timer-free; driven by an external clock) ───────────
  get isPlaying(): boolean {
    return this.playing;
  }

  play(): void {
    if (this.playing) return;
    this.playing = true;
    this.events.emit('PlayStateChanged', { playing: true });
  }

  pause(): void {
    if (!this.playing) return;
    this.playing = false;
    this.events.emit('PlayStateChanged', { playing: false });
  }

  /** Pause and return to the start of the work area (or 0). */
  stop(): void {
    this.pause();
    this.playhead.seek(this.ranges.workArea?.start ?? 0);
  }

  /**
   * Advance the playhead by `dtMs` of wall-clock while playing. Loops within the
   * loop range if set, otherwise pauses at the end. Returns true while playing.
   */
  tick(dtMs: number): boolean {
    if (!this.playing) return false;
    const advance = msToFrames(dtMs, this.frameRate);
    const loop = this.ranges.loop;
    let next = this.playhead.current + advance;
    if (loop && loop.duration > 0) {
      const start = loop.start;
      const end = loop.start + loop.duration;
      if (next >= end) next = start + ((next - start) % loop.duration);
      this.playhead.set(next);
    } else if (next >= this.durationFrames) {
      this.playhead.set(this.durationFrames);
      this.pause();
      return false;
    } else {
      this.playhead.set(next);
    }
    return true;
  }

  // ── Tracks ───────────────────────────────────────────────────────
  getTrack(id: string): Track | undefined {
    return this.trackIndex.get(id);
  }
  getTracks(): readonly Track[] {
    return this.tracks;
  }
  get trackCount(): number {
    return this.tracks.length;
  }

  addTrack(init: TrackInit = {}, index = this.tracks.length): Track {
    const track = new Track(init);
    const at = Math.max(0, Math.min(index, this.tracks.length));
    this.history.run({
      label: 'Add Track',
      do: () => this.insertTrack(track, at),
      undo: () => this.detachTrack(track.id),
    });
    return track;
  }

  removeTrack(id: string): boolean {
    const track = this.trackIndex.get(id);
    if (!track) return false;
    const index = this.tracks.indexOf(track);
    this.history.run({
      label: 'Remove Track',
      do: () => this.detachTrack(id),
      undo: () => this.insertTrack(track, index),
    });
    return true;
  }

  moveTrack(id: string, toIndex: number): boolean {
    const from = this.tracks.findIndex((t) => t.id === id);
    if (from < 0) return false;
    const to = Math.max(0, Math.min(toIndex, this.tracks.length - 1));
    if (from === to) return false;
    this.history.run({
      label: 'Move Track',
      do: () => this.reorderTrack(from, to),
      undo: () => this.reorderTrack(to, from),
    });
    return true;
  }

  duplicateTrack(id: string): Track | null {
    const track = this.trackIndex.get(id);
    if (!track) return null;
    const copy = new Track({
      name: `${track.name} copy`,
      kind: track.kind,
      flags: { ...track.flags },
      height: track.height,
      groupId: track.groupId,
      metadata: { ...track.metadata },
    });
    // Clone layers with fresh ids so the index stays collision-free.
    for (const layer of track.layers) {
      const cl = layer.clone();
      cl.trackId = copy.id;
      copy.layers.push(cl);
    }
    const index = this.tracks.indexOf(track) + 1;
    this.history.run({
      label: 'Duplicate Track',
      do: () => this.insertTrack(copy, index),
      undo: () => this.detachTrack(copy.id),
    });
    return copy;
  }

  setTrackFlags(id: string, flags: Partial<TrackFlags>): boolean {
    const track = this.trackIndex.get(id);
    if (!track) return false;
    const prev = { ...track.flags };
    const next = { ...prev, ...flags };
    this.history.run({
      label: 'Set Track Flags',
      do: () => {
        track.flags = { ...next };
        this.events.emit('TrackFlagsChanged', { track });
      },
      undo: () => {
        track.flags = { ...prev };
        this.events.emit('TrackFlagsChanged', { track });
      },
    });
    return true;
  }

  renameTrack(id: string, name: string): boolean {
    const track = this.trackIndex.get(id);
    if (!track) return false;
    const prev = track.name;
    this.history.run({
      label: 'Rename Track',
      do: () => {
        track.name = name;
        this.events.emit('TrackUpdated', { track, changed: 'name' });
      },
      undo: () => {
        track.name = prev;
        this.events.emit('TrackUpdated', { track, changed: 'name' });
      },
    });
    return true;
  }

  /** Group a set of tracks under a new group id. */
  groupTracks(trackIds: string[], name = 'Group'): TrackGroup | null {
    const valid = trackIds.filter((id) => this.trackIndex.has(id));
    if (valid.length === 0) return null;
    const group: TrackGroup = { id: uid('group'), name, collapsed: false, trackIds: valid };
    const prevGroupIds = new Map(valid.map((id) => [id, this.trackIndex.get(id)!.groupId]));
    this.history.run({
      label: 'Group Tracks',
      do: () => {
        this.groups.set(group.id, group);
        for (const id of valid) this.trackIndex.get(id)!.groupId = group.id;
      },
      undo: () => {
        this.groups.delete(group.id);
        for (const [id, gid] of prevGroupIds) {
          const t = this.trackIndex.get(id);
          if (t) t.groupId = gid;
        }
      },
    });
    return group;
  }

  ungroup(groupId: string): boolean {
    const group = this.groups.get(groupId);
    if (!group) return false;
    this.history.run({
      label: 'Ungroup Tracks',
      do: () => {
        for (const id of group.trackIds) {
          const t = this.trackIndex.get(id);
          if (t && t.groupId === groupId) t.groupId = null;
        }
        this.groups.delete(groupId);
      },
      undo: () => {
        this.groups.set(groupId, group);
        for (const id of group.trackIds) {
          const t = this.trackIndex.get(id);
          if (t) t.groupId = groupId;
        }
      },
    });
    return true;
  }

  getGroups(): readonly TrackGroup[] {
    return [...this.groups.values()];
  }

  // ── Layers ───────────────────────────────────────────────────────
  getLayer(id: string): Layer | undefined {
    return this.layerIndex.get(id);
  }

  /** Every layer across all tracks (document order). */
  allLayers(): Layer[] {
    const out: Layer[] = [];
    for (const track of this.tracks) out.push(...track.layers);
    return out;
  }

  get layerCount(): number {
    return this.layerIndex.size;
  }

  addLayer(trackId: string, init: Omit<LayerInit, 'trackId'> = {}, index?: number): Layer | null {
    const track = this.trackIndex.get(trackId);
    if (!track) return null;
    const layer = new Layer({ ...init, trackId });
    const at = index ?? track.layers.length;
    this.history.run({
      label: 'Add Layer',
      do: () => this.attachLayer(layer, track, at),
      undo: () => this.detachLayer(layer.id),
    });
    return layer;
  }

  removeLayer(id: string): boolean {
    const layer = this.layerIndex.get(id);
    if (!layer) return false;
    const track = this.trackIndex.get(layer.trackId)!;
    const index = track.indexOfLayer(id);
    this.history.run({
      label: 'Remove Layer',
      do: () => this.detachLayer(id),
      undo: () => this.attachLayer(layer, track, index),
    });
    return true;
  }

  /**
   * Ripple-delete: remove a layer and shift every later clip on the same track
   * left by its duration, closing the gap (NLE ripple). Undo restores the
   * removed layer and every shifted neighbour.
   */
  rippleRemoveLayer(id: string): boolean {
    const layer = this.layerIndex.get(id);
    if (!layer) return false;
    const track = this.trackIndex.get(layer.trackId);
    if (!track) return false;
    const index = track.indexOfLayer(id);
    const delta = layer.clip.duration;
    const cut = layer.clip.start;
    const later = track.layers
      .filter((l) => l.id !== id && l.clip.start >= cut)
      .map((l) => ({ id: l.id, prev: l.clip.toJSON() }));

    this.history.run({
      label: 'Ripple Delete Layer',
      do: () => {
        this.detachLayer(id);
        for (const { id: lid } of later) {
          const n = this.layerIndex.get(lid);
          if (n) {
            n.clip.shift(-delta);
            this.events.emit('LayerUpdated', { layer: n, changed: 'clip' });
          }
        }
      },
      undo: () => {
        this.attachLayer(layer, track, index);
        for (const { id: lid, prev } of later) {
          const n = this.layerIndex.get(lid);
          if (n) {
            n.clip = Clip.fromJSON(prev);
            this.events.emit('LayerUpdated', { layer: n, changed: 'clip' });
          }
        }
      },
    });
    return true;
  }

  /**
   * Ripple-trim the tail: shorten the layer's end and pull later clips left by
   * the same amount. Returns false when locked or the trim is a no-op.
   */
  rippleTrimEnd(id: string, newEnd: number, minDuration = 1): boolean {
    const layer = this.layerIndex.get(id);
    if (!layer || layer.locked) return false;
    const track = this.trackIndex.get(layer.trackId);
    if (!track) return false;
    const prevSelf = layer.clip.toJSON();
    const trial = layer.clip.clone();
    trial.trimEnd(newEnd, minDuration);
    const delta = prevSelf.duration - trial.duration;
    if (delta <= 0) return false;
    const later = track.layers
      .filter((l) => l.id !== id && l.clip.start >= prevSelf.start + prevSelf.duration)
      .map((l) => ({ id: l.id, prev: l.clip.toJSON() }));

    const nextSelf = trial.toJSON();
    this.history.run({
      label: 'Ripple Trim Layer',
      do: () => {
        layer.clip = Clip.fromJSON(nextSelf);
        this.events.emit('LayerUpdated', { layer, changed: 'clip' });
        for (const { id: lid } of later) {
          const n = this.layerIndex.get(lid);
          if (n) {
            n.clip.shift(-delta);
            this.events.emit('LayerUpdated', { layer: n, changed: 'clip' });
          }
        }
      },
      undo: () => {
        layer.clip = Clip.fromJSON(prevSelf);
        this.events.emit('LayerUpdated', { layer, changed: 'clip' });
        for (const { id: lid, prev } of later) {
          const n = this.layerIndex.get(lid);
          if (n) {
            n.clip = Clip.fromJSON(prev);
            this.events.emit('LayerUpdated', { layer: n, changed: 'clip' });
          }
        }
      },
    });
    return true;
  }

  /**
   * Ripple-trim the head: discard/extend source from the in-point while keeping
   * the bar's timeline start fixed, then shift later clips by the duration
   * change (NLE ripple edit on the left edge).
   */
  rippleTrimStart(id: string, newStart: number, minDuration = 1): boolean {
    const layer = this.layerIndex.get(id);
    if (!layer || layer.locked) return false;
    const track = this.trackIndex.get(layer.trackId);
    if (!track) return false;
    const prevSelf = layer.clip.toJSON();
    const trial = layer.clip.clone();
    // Ordinary trimStart moves the bar's start; ripple keeps start fixed and
    // only changes duration/sourceIn, then ripples neighbours by Δduration.
    trial.trimStart(newStart, minDuration);
    const delta = prevSelf.duration - trial.duration; // >0 shorten, <0 extend
    if (delta === 0) return false;
    const nextSelf = {
      ...trial.toJSON(),
      start: prevSelf.start,
      duration: trial.duration,
      sourceIn: trial.sourceIn,
    };
    const oldEnd = prevSelf.start + prevSelf.duration;
    const later = track.layers
      .filter((l) => l.id !== id && l.clip.start >= oldEnd)
      .map((l) => ({ id: l.id, prev: l.clip.toJSON() }));

    this.history.run({
      label: 'Ripple Trim Start',
      do: () => {
        layer.clip = Clip.fromJSON(nextSelf);
        this.events.emit('LayerUpdated', { layer, changed: 'clip' });
        for (const { id: lid } of later) {
          const n = this.layerIndex.get(lid);
          if (n) {
            n.clip.shift(-delta);
            this.events.emit('LayerUpdated', { layer: n, changed: 'clip' });
          }
        }
      },
      undo: () => {
        layer.clip = Clip.fromJSON(prevSelf);
        this.events.emit('LayerUpdated', { layer, changed: 'clip' });
        for (const { id: lid, prev } of later) {
          const n = this.layerIndex.get(lid);
          if (n) {
            n.clip = Clip.fromJSON(prev);
            this.events.emit('LayerUpdated', { layer: n, changed: 'clip' });
          }
        }
      },
    });
    return true;
  }

  /**
   * Ripple-insert empty time on a track: push every clip that starts at/after
   * `atFrame` to the right by `durationFrames` (NLE insert edit / open gap).
   */
  rippleInsertGap(trackId: string, atFrame: number, durationFrames: number): boolean {
    if (!(durationFrames > 0)) return false;
    const track = this.trackIndex.get(trackId);
    if (!track) return false;
    const later = track.layers
      .filter((l) => l.clip.start >= atFrame)
      .map((l) => ({ id: l.id, prev: l.clip.toJSON() }));
    if (later.length === 0) return false;

    this.history.run({
      label: 'Ripple Insert Gap',
      do: () => {
        for (const { id: lid } of later) {
          const n = this.layerIndex.get(lid);
          if (n) {
            n.clip.shift(durationFrames);
            this.events.emit('LayerUpdated', { layer: n, changed: 'clip' });
          }
        }
      },
      undo: () => {
        for (const { id: lid, prev } of later) {
          const n = this.layerIndex.get(lid);
          if (n) {
            n.clip = Clip.fromJSON(prev);
            this.events.emit('LayerUpdated', { layer: n, changed: 'clip' });
          }
        }
      },
    });
    return true;
  }

  /** Move a layer to another track (or reorder within a track). */
  moveLayer(id: string, toTrackId: string, index?: number): boolean {
    const layer = this.layerIndex.get(id);
    const toTrack = this.trackIndex.get(toTrackId);
    if (!layer || !toTrack) return false;
    const fromTrack = this.trackIndex.get(layer.trackId)!;
    const fromIndex = fromTrack.indexOfLayer(id);
    const toIndex = index ?? toTrack.layers.length;
    this.history.run({
      label: 'Move Layer',
      do: () => {
        fromTrack.removeLayer(id);
        toTrack.insertLayer(layer, toIndex);
        this.events.emit('LayerMoved', { layer, fromTrackId: fromTrack.id, toTrackId: toTrack.id, index: toIndex });
      },
      undo: () => {
        toTrack.removeLayer(id);
        fromTrack.insertLayer(layer, fromIndex);
        this.events.emit('LayerMoved', { layer, fromTrackId: toTrack.id, toTrackId: fromTrack.id, index: fromIndex });
      },
    });
    return true;
  }

  reorderLayer(id: string, toIndex: number): boolean {
    const layer = this.layerIndex.get(id);
    if (!layer) return false;
    const track = this.trackIndex.get(layer.trackId)!;
    const from = track.indexOfLayer(id);
    if (from === toIndex) return false;
    this.history.run({
      label: 'Reorder Layer',
      do: () => {
        track.reorderLayer(id, toIndex);
        this.events.emit('LayerUpdated', { layer, changed: 'order' });
      },
      undo: () => {
        track.reorderLayer(id, from);
        this.events.emit('LayerUpdated', { layer, changed: 'order' });
      },
    });
    return true;
  }

  duplicateLayer(id: string): Layer | null {
    const layer = this.layerIndex.get(id);
    if (!layer) return null;
    const track = this.trackIndex.get(layer.trackId)!;
    const copy = layer.clone();
    copy.name = `${layer.name} copy`;
    const index = track.indexOfLayer(id) + 1;
    this.history.run({
      label: 'Duplicate Layer',
      do: () => this.attachLayer(copy, track, index),
      undo: () => this.detachLayer(copy.id),
    });
    return copy;
  }

  /** Split a layer at a timeline frame into two layers. Returns the new right layer. */
  splitLayer(id: string, frame: number): Layer | null {
    const layer = this.layerIndex.get(id);
    if (!layer || layer.locked) return null;
    const track = this.trackIndex.get(layer.trackId)!;
    const prevClip = layer.clip.toJSON();
    // Compute the split once (this mutates layer.clip → left part).
    const rightData = layer.clip.split(frame);
    if (!rightData) {
      layer.clip = Clip.fromJSON(prevClip); // restore; nothing changed
      return null;
    }
    const leftClip = layer.clip.toJSON();
    const right = new Layer({
      name: layer.name,
      trackId: track.id,
      clip: new Clip(rightData),
      enabled: layer.enabled,
      locked: layer.locked,
      sourceId: layer.sourceId,
      metadata: { ...layer.metadata },
    });
    layer.clip = Clip.fromJSON(prevClip); // revert so `do()` applies cleanly
    const index = track.indexOfLayer(id) + 1;
    this.history.run({
      label: 'Split Layer',
      do: () => {
        layer.clip = Clip.fromJSON(leftClip);
        this.attachLayer(right, track, index);
        this.events.emit('LayerSplit', { original: layer, right, frame });
      },
      undo: () => {
        this.detachLayer(right.id);
        layer.clip = Clip.fromJSON(prevClip);
        this.events.emit('LayerUpdated', { layer, changed: 'clip' });
      },
    });
    return right;
  }

  /** Move a layer's clip to an absolute timeline start (undoable). */
  setLayerStart(id: string, frame: number): boolean {
    const layer = this.layerIndex.get(id);
    if (!layer || layer.locked) return false;
    const prev = layer.clip.start;
    const next = Math.max(0, Math.round(frame));
    if (next === prev) return false;
    this.history.run({
      label: 'Move Layer',
      do: () => {
        layer.clip.start = next;
        this.events.emit('LayerUpdated', { layer, changed: 'clip' });
      },
      undo: () => {
        layer.clip.start = prev;
        this.events.emit('LayerUpdated', { layer, changed: 'clip' });
      },
    });
    return true;
  }

  /** Trim a layer's head (`edge:'start'`) or tail (`edge:'end'`) to a frame. */
  trimLayer(id: string, edge: 'start' | 'end', frame: number, minDuration = 1): boolean {
    const layer = this.layerIndex.get(id);
    if (!layer || layer.locked) return false;
    const prevClip = layer.clip.toJSON();
    this.history.run({
      label: 'Trim Layer',
      do: () => {
        if (edge === 'start') layer.clip.trimStart(frame, minDuration);
        else layer.clip.trimEnd(frame, minDuration);
        this.events.emit('LayerTrimmed', { layer });
      },
      undo: () => {
        layer.clip = Clip.fromJSON(prevClip);
        this.events.emit('LayerTrimmed', { layer });
      },
    });
    return true;
  }

  /**
   * Slip a layer: shift `sourceIn` by `deltaFrames` without moving the bar.
   * Undoable. Returns false when locked or the slip is a no-op after clamp.
   */
  slipLayer(id: string, deltaFrames: number): boolean {
    const layer = this.layerIndex.get(id);
    if (!layer || layer.locked) return false;
    const prevClip = layer.clip.toJSON();
    const trial = layer.clip.clone();
    trial.slip(deltaFrames);
    if (trial.sourceIn === prevClip.sourceIn) return false;
    const nextClip = trial.toJSON();
    this.history.run({
      label: 'Slip Layer',
      do: () => {
        layer.clip = Clip.fromJSON(nextClip);
        this.events.emit('LayerUpdated', { layer, changed: 'clip' });
      },
      undo: () => {
        layer.clip = Clip.fromJSON(prevClip);
        this.events.emit('LayerUpdated', { layer, changed: 'clip' });
      },
    });
    return true;
  }

  /**
   * Slide a layer: move its bar by `deltaFrames` while trimming abutting
   * neighbors on the same track so the edit stays gapless (NLE slide).
   * After a split, this is how you roll the cut without opening a hole.
   * Undoable. Returns false when locked, no-op, or no room to slide.
   */
  slideLayer(id: string, deltaFrames: number, minDuration = 1): boolean {
    const layer = this.layerIndex.get(id);
    if (!layer || layer.locked || deltaFrames === 0) return false;
    const track = this.trackIndex.get(layer.trackId);
    if (!track) return false;

    const ordered = [...track.layers].sort((a, b) => a.clip.start - b.clip.start);
    const idx = ordered.findIndex((l) => l.id === id);
    if (idx < 0) return false;
    const prev = ordered[idx - 1];
    const next = ordered[idx + 1];
    const clip = layer.clip;

    // Abut within one frame — split clips and tight edits count; open gaps do not.
    const abuts = (aEnd: number, bStart: number): boolean => Math.abs(aEnd - bStart) <= 1;
    const abutsPrev = !!prev && abuts(prev.clip.end, clip.start);
    const abutsNext = !!next && abuts(clip.end, next.clip.start);

    let d = deltaFrames;
    if (d > 0) {
      if (abutsNext && next) d = Math.min(d, next.clip.duration - minDuration);
      else if (next) d = Math.min(d, Math.max(0, next.clip.start - clip.end));
    } else {
      d = Math.max(d, -clip.start);
      if (abutsPrev && prev) d = Math.max(d, -(prev.clip.duration - minDuration));
      else if (prev) d = Math.max(d, -Math.max(0, clip.start - prev.clip.end));
    }
    d = Math.trunc(d);
    if (d === 0) return false;

    const selfPrev = clip.toJSON();
    const neighborPrev = new Map<string, ReturnType<Clip['toJSON']>>();
    if (abutsPrev && prev) neighborPrev.set(prev.id, prev.clip.toJSON());
    if (abutsNext && next) neighborPrev.set(next.id, next.clip.toJSON());

    this.history.run({
      label: 'Slide Layer',
      do: () => {
        if (abutsPrev && prev) prev.clip.trimEnd(prev.clip.end + d, minDuration);
        if (abutsNext && next) next.clip.trimStart(next.clip.start + d, minDuration);
        clip.shift(d);
        this.events.emit('LayerUpdated', { layer, changed: 'clip' });
        if (prev && neighborPrev.has(prev.id)) {
          this.events.emit('LayerUpdated', { layer: prev, changed: 'clip' });
        }
        if (next && neighborPrev.has(next.id)) {
          this.events.emit('LayerUpdated', { layer: next, changed: 'clip' });
        }
      },
      undo: () => {
        layer.clip = Clip.fromJSON(selfPrev);
        for (const [nid, data] of neighborPrev) {
          const n = this.layerIndex.get(nid);
          if (n) n.clip = Clip.fromJSON(data);
        }
        this.events.emit('LayerUpdated', { layer, changed: 'clip' });
        for (const nid of neighborPrev.keys()) {
          const n = this.layerIndex.get(nid);
          if (n) this.events.emit('LayerUpdated', { layer: n, changed: 'clip' });
        }
      },
    });
    return true;
  }

  renameLayer(id: string, name: string): boolean {
    const layer = this.layerIndex.get(id);
    if (!layer) return false;
    const prev = layer.name;
    this.history.run({
      label: 'Rename Layer',
      do: () => {
        layer.name = name;
        this.events.emit('LayerUpdated', { layer, changed: 'name' });
      },
      undo: () => {
        layer.name = prev;
        this.events.emit('LayerUpdated', { layer, changed: 'name' });
      },
    });
    return true;
  }

  // ── Markers ──────────────────────────────────────────────────────
  addMarker(init: MarkerInit): Marker {
    const marker = new Marker(init);
    const list = this.markerListFor(marker);
    this.history.run({
      label: 'Add Marker',
      do: () => {
        list.add(marker);
        this.events.emit('MarkerAdded', { marker });
      },
      undo: () => {
        list.remove(marker.id);
        this.events.emit('MarkerRemoved', { markerId: marker.id });
      },
    });
    return marker;
  }

  removeMarker(id: string): boolean {
    const found = this.findMarker(id);
    if (!found) return false;
    const { marker, list } = found;
    this.history.run({
      label: 'Remove Marker',
      do: () => {
        list.remove(id);
        this.events.emit('MarkerRemoved', { markerId: id });
      },
      undo: () => {
        list.add(marker);
        this.events.emit('MarkerAdded', { marker });
      },
    });
    return true;
  }

  getMarker(id: string): Marker | undefined {
    return this.findMarker(id)?.marker;
  }

  private markerListFor(marker: Marker): MarkerList {
    if (marker.scope === 'track' && marker.ownerId) return this.trackIndex.get(marker.ownerId)?.markers ?? this.markers;
    if (marker.scope === 'layer' && marker.ownerId) return this.layerIndex.get(marker.ownerId)?.markers ?? this.markers;
    return this.markers;
  }

  private findMarker(id: string): { marker: Marker; list: MarkerList } | null {
    const top = this.markers.get(id);
    if (top) return { marker: top, list: this.markers };
    for (const track of this.tracks) {
      const tm = track.markers.get(id);
      if (tm) return { marker: tm, list: track.markers };
      for (const layer of track.layers) {
        const lm = layer.markers.get(id);
        if (lm) return { marker: lm, list: layer.markers };
      }
    }
    return null;
  }

  get markerCount(): number {
    let n = this.markers.size;
    for (const track of this.tracks) {
      n += track.markers.size;
      for (const layer of track.layers) n += layer.markers.size;
    }
    return n;
  }

  // ── Time ranges (loop / preview / work area) ─────────────────────
  getRanges(): TimelineRanges {
    return { ...this.ranges };
  }

  setRange(kind: RangeKind, range: TimeRange | null): void {
    this.ranges = { ...this.ranges, [kind]: range ? { ...range } : null };
    this.events.emit('RangeChanged', { kind, range });
  }

  // ── Navigation (view state) ──────────────────────────────────────
  getView(): TimelineViewState {
    return { ...this.view };
  }

  setViewportWidth(px: number): void {
    this.view.viewportWidth = Math.max(0, px);
  }

  setZoom(pixelsPerFrame: number, anchorFrame?: number): void {
    const prev = this.view.pixelsPerFrame;
    const next = clampPixelsPerFrame(pixelsPerFrame);
    if (next === prev) return;
    if (anchorFrame !== undefined) {
      // Keep the anchor frame at the same on-screen pixel.
      const pixel = (anchorFrame - this.view.scrollX) * prev;
      this.view.scrollX = anchorFrame - pixel / next;
    }
    this.view.pixelsPerFrame = next;
    if (this.view.scrollX < 0) this.view.scrollX = 0;
    this.events.emit('TimelineZoomChanged', { zoom: next, previous: prev });
  }

  zoomIn(factor = 1.25): void {
    this.setZoom(this.view.pixelsPerFrame * factor, this.currentFrame);
  }
  zoomOut(factor = 1.25): void {
    this.setZoom(this.view.pixelsPerFrame / factor, this.currentFrame);
  }

  /** Fit the whole duration into `viewportWidth` (or the last reported width). */
  fit(viewportWidth = this.view.viewportWidth, padding = 0): void {
    const w = Math.max(1, viewportWidth - padding);
    const dur = Math.max(1, this.durationFrames);
    this.view.viewportWidth = viewportWidth;
    this.view.scrollX = 0;
    this.setZoom(w / dur);
  }

  scrollTo(scrollX: number, scrollY = this.view.scrollY): void {
    this.view.scrollX = Math.max(0, scrollX);
    this.view.scrollY = Math.max(0, scrollY);
    this.events.emit('TimelineScrollChanged', { scrollX: this.view.scrollX, scrollY: this.view.scrollY });
  }

  scrollToFrame(frame: number): void {
    this.scrollTo(frame);
  }

  /** Center the playhead in the viewport (needs a viewport width). */
  centerPlayhead(): void {
    const framesVisible = this.view.viewportWidth / this.view.pixelsPerFrame;
    this.scrollTo(this.currentFrame - framesVisible / 2);
  }

  // ── Queries ──────────────────────────────────────────────────────
  /** All enabled layers whose span contains `frame`, honoring hidden/mute/solo. */
  activeLayersAt(frame: number): Layer[] {
    const soloActive = this.tracks.some((t) => t.flags.solo);
    const out: Layer[] = [];
    for (const track of this.tracks) {
      if (track.flags.hidden || track.flags.muted) continue;
      if (soloActive && !track.flags.solo) continue;
      for (const layer of track.layers) {
        if (layer.isActiveAt(frame)) out.push(layer);
      }
    }
    return out;
  }

  /** All layers whose span contains `frame`, ignoring flags. */
  layersAt(frame: number): Layer[] {
    const out: Layer[] = [];
    for (const track of this.tracks) {
      for (const layer of track.layers) if (layer.contains(frame)) out.push(layer);
    }
    return out;
  }

  /** Layers intersecting a frame range. */
  layersInRange(from: number, to: number): Layer[] {
    const out: Layer[] = [];
    for (const track of this.tracks) {
      for (const layer of track.layers) {
        if (layer.start < to && layer.end > from) out.push(layer);
      }
    }
    return out;
  }

  /** The last frame reached by any layer (for auto-duration / fit). */
  contentEnd(): number {
    let end = 0;
    for (const track of this.tracks) end = Math.max(end, track.contentEnd());
    return end;
  }

  // ── State snapshot ───────────────────────────────────────────────
  getState(): TimelineState {
    return {
      id: this.id,
      name: this.name,
      frameRate: this.frameRate,
      duration: this.durationFrames,
      currentFrame: this.currentFrame,
      currentSeconds: framesToSeconds(this.currentFrame, this.frameRate),
      playing: this.playing,
      trackCount: this.tracks.length,
      layerCount: this.layerIndex.size,
      markerCount: this.markerCount,
      selection: this.selection.snapshot(),
      ranges: this.getRanges(),
      view: this.getView(),
      canUndo: this.history.canUndo,
      canRedo: this.history.canRedo,
    };
  }

  // ── Low-level structural helpers (index-consistent) ──────────────
  private insertTrack(track: Track, index: number): void {
    this.tracks.splice(index, 0, track);
    this.trackIndex.set(track.id, track);
    for (const layer of track.layers) this.layerIndex.set(layer.id, layer);
    this.events.emit('TrackAdded', { track, index });
  }

  private detachTrack(id: string): void {
    const index = this.tracks.findIndex((t) => t.id === id);
    if (index < 0) return;
    const track = this.tracks[index]!;
    this.tracks.splice(index, 1);
    this.trackIndex.delete(id);
    for (const layer of track.layers) this.layerIndex.delete(layer.id);
    this.selection.forget(id);
    this.events.emit('TrackRemoved', { trackId: id, index });
  }

  private reorderTrack(from: number, to: number): void {
    const [track] = this.tracks.splice(from, 1);
    this.tracks.splice(to, 0, track!);
    this.events.emit('TrackMoved', { trackId: track!.id, from, to });
  }

  private attachLayer(layer: Layer, track: Track, index: number): void {
    track.insertLayer(layer, index);
    this.layerIndex.set(layer.id, layer);
    this.events.emit('LayerAdded', { layer, trackId: track.id, index });
  }

  private detachLayer(id: string): void {
    const layer = this.layerIndex.get(id);
    if (!layer) return;
    const track = this.trackIndex.get(layer.trackId);
    track?.removeLayer(id);
    this.layerIndex.delete(id);
    this.selection.forget(id);
    this.events.emit('LayerRemoved', { layerId: id, trackId: layer.trackId });
  }

  // Internal accessors for the serializer (keep fields private otherwise).
  /** @internal */
  _internal(): {
    tracks: Track[];
    groups: Map<string, TrackGroup>;
    ranges: TimelineRanges;
    view: TimelineViewState;
    setRanges: (r: TimelineRanges) => void;
    setView: (v: TimelineViewState) => void;
    reindex: () => void;
  } {
    return {
      tracks: this.tracks,
      groups: this.groups,
      ranges: this.ranges,
      view: this.view,
      setRanges: (r) => {
        this.ranges = r;
      },
      setView: (v) => {
        this.view = v;
      },
      reindex: () => {
        this.trackIndex.clear();
        this.layerIndex.clear();
        for (const t of this.tracks) {
          this.trackIndex.set(t.id, t);
          for (const l of t.layers) this.layerIndex.set(l.id, l);
        }
      },
    };
  }
}
