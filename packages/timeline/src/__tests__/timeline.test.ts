import { Timeline } from '../core/Timeline';
import { FPS_24, FPS_30 } from '../time';

function timeline(): Timeline {
  return Timeline.create({ duration: 300, frameRate: FPS_30 });
}

describe('Timeline tracks', () => {
  it('adds, indexes, moves, and removes tracks', () => {
    const t = timeline();
    const a = t.addTrack({ name: 'A' });
    const b = t.addTrack({ name: 'B' });
    const c = t.addTrack({ name: 'C' });
    expect(t.getTracks().map((x) => x.name)).toEqual(['A', 'B', 'C']);
    expect(t.getTrack(a.id)).toBe(a);

    t.moveTrack(c.id, 0);
    expect(t.getTracks().map((x) => x.name)).toEqual(['C', 'A', 'B']);

    expect(t.removeTrack(b.id)).toBe(true);
    expect(t.getTracks().map((x) => x.name)).toEqual(['C', 'A']);
    expect(t.getTrack(b.id)).toBeUndefined();
  });

  it('toggles flags and duplicates', () => {
    const t = timeline();
    const track = t.addTrack({ name: 'V1' });
    t.addLayer(track.id, { name: 'L', clip: { start: 0, duration: 10 } });
    t.setTrackFlags(track.id, { solo: true, locked: true });
    expect(t.getTrack(track.id)!.flags.solo).toBe(true);

    const dup = t.duplicateTrack(track.id)!;
    expect(dup).not.toBeNull();
    expect(dup.layers).toHaveLength(1);
    expect(dup.layers[0]!.id).not.toBe(track.layers[0]!.id); // fresh layer id
    expect(t.trackCount).toBe(2);
  });

  it('routes a layer-scoped marker onto its layer, not the timeline', () => {
    const t = timeline();
    const track = t.addTrack({ name: 'V1' });
    const layer = t.addLayer(track.id, { name: 'L', clip: { start: 0, duration: 10 } });

    const compMarker = t.addMarker({ frame: 5, name: 'chapter', scope: 'timeline' });
    const layerMarker = t.addMarker({ frame: 3, name: 'beat', scope: 'layer', ownerId: layer.id });

    // The layer marker lives on the layer; the comp marker on the timeline.
    expect(layer.markers.get(layerMarker.id)).toBeDefined();
    expect(layer.markers.get(compMarker.id)).toBeUndefined();
    // Both are still findable/removable through the timeline (undo/serialize).
    expect(t.getMarker(layerMarker.id)).toBe(layerMarker);
    expect(t.removeMarker(layerMarker.id)).toBe(true);
    expect(layer.markers.get(layerMarker.id)).toBeUndefined();
  });

  it('groups and ungroups tracks', () => {
    const t = timeline();
    const a = t.addTrack();
    const b = t.addTrack();
    const g = t.groupTracks([a.id, b.id], 'Group 1')!;
    expect(t.getTrack(a.id)!.groupId).toBe(g.id);
    expect(t.getGroups()).toHaveLength(1);
    t.ungroup(g.id);
    expect(t.getTrack(a.id)!.groupId).toBeNull();
    expect(t.getGroups()).toHaveLength(0);
  });
});

describe('Timeline layers', () => {
  it('adds/removes layers and maintains the global index', () => {
    const t = timeline();
    const track = t.addTrack();
    const l1 = t.addLayer(track.id, { clip: { start: 0, duration: 50 } })!;
    const l2 = t.addLayer(track.id, { clip: { start: 60, duration: 40 } })!;
    expect(t.layerCount).toBe(2);
    expect(t.getLayer(l1.id)).toBe(l1);
    expect(t.removeLayer(l2.id)).toBe(true);
    expect(t.layerCount).toBe(1);
  });

  it('moves a layer between tracks', () => {
    const t = timeline();
    const a = t.addTrack();
    const b = t.addTrack();
    const layer = t.addLayer(a.id, { clip: { start: 0, duration: 10 } })!;
    expect(t.moveLayer(layer.id, b.id)).toBe(true);
    expect(a.layerCount).toBe(0);
    expect(b.layerCount).toBe(1);
    expect(layer.trackId).toBe(b.id);
  });

  it('splits a layer into two contiguous layers', () => {
    const t = timeline();
    const track = t.addTrack();
    const layer = t.addLayer(track.id, { clip: { start: 0, duration: 30, sourceIn: 0 } })!;
    const right = t.splitLayer(layer.id, 10)!;
    expect(layer.duration).toBe(10);
    expect(right.start).toBe(10);
    expect(right.duration).toBe(20);
    expect(track.layerCount).toBe(2);
  });

  it('slides a split cut by trimming abutting neighbours', () => {
    const t = timeline();
    const track = t.addTrack();
    // Three abutting clips — classic NLE slide keeps the sequence span fixed.
    const a = t.addLayer(track.id, { clip: { start: 0, duration: 10, sourceIn: 0 } })!;
    const b = t.addLayer(track.id, { clip: { start: 10, duration: 10, sourceIn: 10 } })!;
    const c = t.addLayer(track.id, { clip: { start: 20, duration: 20, sourceIn: 20 } })!;
    expect(t.slideLayer(b.id, 5)).toBe(true);
    expect(a.end).toBe(15);
    expect(b.start).toBe(15);
    expect(b.duration).toBe(10);
    expect(c.start).toBe(25);
    expect(c.duration).toBe(15);
    expect(c.clip.sourceIn).toBe(25);
    t.history.undo();
    expect(a.end).toBe(10);
    expect(b.start).toBe(10);
    expect(c.start).toBe(20);
    expect(c.duration).toBe(20);
  });

  it('ripple-deletes a clip and closes the gap', () => {
    const t = timeline();
    const track = t.addTrack();
    const a = t.addLayer(track.id, { clip: { start: 0, duration: 10 } })!;
    const b = t.addLayer(track.id, { clip: { start: 10, duration: 10 } })!;
    const c = t.addLayer(track.id, { clip: { start: 20, duration: 10 } })!;
    expect(t.rippleRemoveLayer(b.id)).toBe(true);
    expect(t.getLayer(b.id)).toBeUndefined();
    expect(a.end).toBe(10);
    expect(c.start).toBe(10);
    t.history.undo();
    expect(t.getLayer(b.id)).toBeDefined();
    expect(c.start).toBe(20);
  });

  it('ripple-trims the out point and pulls later clips', () => {
    const t = timeline();
    const track = t.addTrack();
    const a = t.addLayer(track.id, { clip: { start: 0, duration: 20 } })!;
    const b = t.addLayer(track.id, { clip: { start: 20, duration: 10 } })!;
    expect(t.rippleTrimEnd(a.id, 12)).toBe(true);
    expect(a.end).toBe(12);
    expect(b.start).toBe(12);
    t.history.undo();
    expect(a.end).toBe(20);
    expect(b.start).toBe(20);
  });

  it('ripple-trims the in point, keeps start, pulls later clips', () => {
    const t = timeline();
    const track = t.addTrack();
    const a = t.addLayer(track.id, { clip: { start: 0, duration: 20, sourceIn: 0 } })!;
    const b = t.addLayer(track.id, { clip: { start: 20, duration: 10 } })!;
    // Trim head as if the left edge moved to frame 8, then ripple keeps start=0.
    expect(t.rippleTrimStart(a.id, 8)).toBe(true);
    expect(a.start).toBe(0);
    expect(a.duration).toBe(12);
    expect(a.clip.sourceIn).toBe(8);
    expect(b.start).toBe(12);
    t.history.undo();
    expect(a.duration).toBe(20);
    expect(a.clip.sourceIn).toBe(0);
    expect(b.start).toBe(20);
  });

  it('ripple-inserts a gap and pushes later clips right', () => {
    const t = timeline();
    const track = t.addTrack();
    const a = t.addLayer(track.id, { clip: { start: 0, duration: 10 } })!;
    const b = t.addLayer(track.id, { clip: { start: 10, duration: 10 } })!;
    expect(t.rippleInsertGap(track.id, 10, 5)).toBe(true);
    expect(a.start).toBe(0);
    expect(b.start).toBe(15);
    t.history.undo();
    expect(b.start).toBe(10);
  });

  it('moves a layer clip (undoable)', () => {
    const t = timeline();
    const track = t.addTrack();
    const layer = t.addLayer(track.id, { clip: { start: 0, duration: 30 } })!;
    expect(t.setLayerStart(layer.id, 40)).toBe(true);
    expect(layer.start).toBe(40);
    expect(layer.duration).toBe(30); // duration preserved
    t.history.undo();
    expect(layer.start).toBe(0);
  });

  it('trims a layer head and tail', () => {
    const t = timeline();
    const track = t.addTrack();
    const layer = t.addLayer(track.id, { clip: { start: 0, duration: 30, sourceIn: 10 } })!;
    t.trimLayer(layer.id, 'start', 5);
    expect(layer.start).toBe(5);
    t.trimLayer(layer.id, 'end', 20);
    expect(layer.end).toBe(20);
  });

  it('queries active layers honoring solo/hidden', () => {
    const t = timeline();
    const a = t.addTrack({ name: 'A' });
    const b = t.addTrack({ name: 'B' });
    t.addLayer(a.id, { clip: { start: 0, duration: 100 } });
    t.addLayer(b.id, { clip: { start: 0, duration: 100 } });
    expect(t.activeLayersAt(50)).toHaveLength(2);
    t.setTrackFlags(b.id, { solo: true });
    expect(t.activeLayersAt(50)).toHaveLength(1); // only soloed track
    t.setTrackFlags(b.id, { solo: false, hidden: true });
    expect(t.activeLayersAt(50)).toHaveLength(1); // hidden b excluded, a shows
  });
});

describe('Timeline markers', () => {
  it('adds scoped markers and counts them', () => {
    const t = timeline();
    const track = t.addTrack();
    const layer = t.addLayer(track.id, { clip: { start: 0, duration: 10 } })!;
    t.addMarker({ frame: 30, name: 'chapter', scope: 'timeline' });
    t.addMarker({ frame: 5, name: 't', scope: 'track', ownerId: track.id });
    t.addMarker({ frame: 2, name: 'l', scope: 'layer', ownerId: layer.id });
    expect(t.markerCount).toBe(3);
    expect(t.markers.size).toBe(1); // timeline-level
    expect(track.markers.size).toBe(1);
    expect(layer.markers.size).toBe(1);
  });

  it('removes a marker at any scope', () => {
    const t = timeline();
    const track = t.addTrack();
    const m = t.addMarker({ frame: 5, scope: 'track', ownerId: track.id });
    expect(t.getMarker(m.id)).toBe(m);
    expect(t.removeMarker(m.id)).toBe(true);
    expect(t.getMarker(m.id)).toBeUndefined();
  });
});

describe('Timeline duration & frame rate', () => {
  it('sets duration and re-clamps the playhead', () => {
    const t = timeline();
    t.seek(250);
    t.setDuration(100);
    expect(t.duration).toBe(100);
    expect(t.currentFrame).toBe(100);
  });

  it('rescales frame positions when preserving timing', () => {
    const t = Timeline.create({ duration: 240, frameRate: FPS_24 });
    const track = t.addTrack();
    const layer = t.addLayer(track.id, { clip: { start: 24, duration: 24 } })!; // 1s..2s
    t.setFrameRate(FPS_30, { preserveTiming: true });
    expect(layer.start).toBeCloseTo(30); // 1s at 30fps
    expect(layer.duration).toBeCloseTo(30);
    expect(t.duration).toBe(300); // 10s
  });

  it('keeps frame numbers when not preserving timing', () => {
    const t = Timeline.create({ duration: 240, frameRate: FPS_24 });
    const track = t.addTrack();
    const layer = t.addLayer(track.id, { clip: { start: 24, duration: 24 } })!;
    t.setFrameRate(FPS_30);
    expect(layer.start).toBe(24);
  });
});

describe('Timeline ranges & navigation', () => {
  it('stores loop / preview / work-area ranges', () => {
    const t = timeline();
    t.setRange('loop', { start: 10, duration: 50 });
    expect(t.getRanges().loop).toEqual({ start: 10, duration: 50 });
    t.setRange('loop', null);
    expect(t.getRanges().loop).toBeNull();
  });

  it('zooms keeping an anchor frame stationary', () => {
    const t = timeline();
    t.setViewportWidth(1000);
    t.scrollTo(0);
    t.setZoom(10);
    const anchor = 40;
    const pixelBefore = (anchor - t.getView().scrollX) * t.getView().pixelsPerFrame;
    t.setZoom(20, anchor);
    const pixelAfter = (anchor - t.getView().scrollX) * t.getView().pixelsPerFrame;
    expect(pixelAfter).toBeCloseTo(pixelBefore);
  });

  it('fits the duration into the viewport', () => {
    const t = timeline(); // duration 300
    t.fit(600);
    expect(t.getView().pixelsPerFrame).toBeCloseTo(2); // 600 / 300
  });
});

describe('Timeline playback (external clock)', () => {
  it('advances while playing and loops within the loop range', () => {
    const t = Timeline.create({ duration: 300, frameRate: FPS_30 });
    t.setRange('loop', { start: 0, duration: 30 }); // 1s loop
    t.seek(0);
    t.play();
    t.tick(1000); // 30 frames → wraps to 0
    expect(t.currentFrame).toBeCloseTo(0, 4);
    t.tick(500); // 15 frames
    expect(t.currentFrame).toBeCloseTo(15, 4);
    expect(t.isPlaying).toBe(true);
  });

  it('pauses at the end without a loop', () => {
    const t = Timeline.create({ duration: 30, frameRate: FPS_30 });
    t.seek(0);
    t.play();
    const stillPlaying = t.tick(2000); // way past end
    expect(t.currentFrame).toBe(30);
    expect(stillPlaying).toBe(false);
    expect(t.isPlaying).toBe(false);
  });

  it('stop() pauses and returns to work-area start', () => {
    const t = timeline();
    t.setRange('workArea', { start: 12, duration: 100 });
    t.seek(200);
    t.play();
    t.stop();
    expect(t.isPlaying).toBe(false);
    expect(t.currentFrame).toBe(12);
  });
});
