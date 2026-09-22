/**
 * Undo commands resolve their layers BY ID when they run, not through the
 * Layer object that was live when the command was issued.
 *
 * The app rebuilds every Track/Layer when a document is restored
 * (applySerializedTimeline → Track.fromJSON, ids preserved). A command that
 * closed over the old object would undo onto a detached Layer — the history
 * entry "succeeds" and the user sees nothing move. These tests trim, rebuild,
 * then undo, and check the NEW object.
 */
import { Timeline } from '../core/Timeline';
import { Layer } from '../layers/Layer';
import { applySerializedTimeline, serializeTimeline } from '../serialization/Serializer';
import { FPS_30 } from '../time';

function timeline(): Timeline {
  return Timeline.create({ duration: 300, frameRate: FPS_30 });
}

/** Rebuild every Track/Layer object in place, ids preserved, history intact. */
function rebuild(t: Timeline): void {
  applySerializedTimeline(t, serializeTimeline(t));
}

describe('commands resolve layers by id at run time', () => {
  it('trim → rebuild → undo restores geometry on the NEW layer object', () => {
    const t = timeline();
    const track = t.addTrack();
    const before = t.addLayer(track.id, { clip: { start: 10, duration: 50 } })!;
    expect(t.trimLayer(before.id, 'end', 30)).toBe(true);
    expect(before.end).toBe(30);

    rebuild(t);
    const after = t.getLayer(before.id)!;
    expect(after).toBeDefined();
    expect(after).not.toBe(before); // genuinely a fresh object
    expect(after.end).toBe(30);

    expect(t.history.undo()).toBe(true);
    expect(after.end).toBe(60);
    expect(after.start).toBe(10);
    // The stale handle was NOT the one written to.
    expect(before.end).toBe(30);

    expect(t.history.redo()).toBe(true);
    expect(after.end).toBe(30);
  });

  it('move / slip / rename / ripple survive a rebuild', () => {
    const t = timeline();
    const track = t.addTrack();
    const a = t.addLayer(track.id, { name: 'A', clip: { start: 0, duration: 20, sourceIn: 5 } })!;
    const b = t.addLayer(track.id, { name: 'B', clip: { start: 20, duration: 10 } })!;

    t.setLayerStart(a.id, 40);
    t.slipLayer(a.id, 3);
    t.renameLayer(a.id, 'A2');
    t.rippleTrimEnd(b.id, 25);
    expect(t.history.undoLabels()).toEqual([
      'Add Track',
      'Add Layer',
      'Add Layer',
      'Move Layer',
      'Slip Layer',
      'Rename Layer',
      'Ripple Trim Layer',
    ]);

    rebuild(t);
    const a2 = t.getLayer(a.id)!;
    const b2 = t.getLayer(b.id)!;
    expect(a2).not.toBe(a);

    t.history.undo(); // ripple trim
    expect(b2.duration).toBe(10);
    t.history.undo(); // rename
    expect(a2.name).toBe('A');
    t.history.undo(); // slip
    expect(a2.clip.sourceIn).toBe(5);
    t.history.undo(); // move
    expect(a2.start).toBe(0);
  });

  it('remove → rebuild → undo resurrects the layer; split → rebuild → undo removes the right half', () => {
    const t = timeline();
    const track = t.addTrack();
    const l = t.addLayer(track.id, { name: 'L', clip: { start: 0, duration: 40 } })!;
    const m = t.addLayer(track.id, { name: 'M', clip: { start: 50, duration: 10 } })!;

    expect(t.removeLayer(l.id)).toBe(true);
    rebuild(t);
    expect(t.getLayer(l.id)).toBeUndefined();
    t.history.undo();
    const back = t.getLayer(l.id)!;
    expect(back).toBeDefined();
    expect(back.name).toBe('L');
    expect(back.duration).toBe(40);
    expect(t.getTrack(track.id)!.layers.map((x) => x.id)).toEqual([l.id, m.id]);

    const right = t.splitLayer(l.id, 15)!;
    expect(right).not.toBeNull();
    rebuild(t);
    t.history.undo();
    expect(t.getLayer(right.id)).toBeUndefined();
    expect(t.getLayer(l.id)!.duration).toBe(40);
    t.history.redo();
    expect(t.getLayer(right.id)).toBeDefined();
    expect(t.getLayer(l.id)!.duration).toBe(15);
  });

  it('moveLayer across tracks survives a rebuild', () => {
    const t = timeline();
    const v1 = t.addTrack({ name: 'V1' });
    const v2 = t.addTrack({ name: 'V2' });
    const l = t.addLayer(v1.id, { clip: { start: 0, duration: 10 } })!;
    expect(t.moveLayer(l.id, v2.id)).toBe(true);
    rebuild(t);
    expect(t.getLayer(l.id)!.trackId).toBe(v2.id);
    t.history.undo();
    expect(t.getLayer(l.id)!.trackId).toBe(v1.id);
    expect(t.getTrack(v1.id)!.layers).toHaveLength(1);
    expect(t.getTrack(v2.id)!.layers).toHaveLength(0);
  });

  it('a command whose layer id vanished undoes and redoes as a no-op, without throwing', () => {
    const t = timeline();
    const track = t.addTrack();
    const l = t.addLayer(track.id, { clip: { start: 0, duration: 40 } })!;
    const other = t.addLayer(track.id, { clip: { start: 40, duration: 10 } })!;
    t.trimLayer(l.id, 'end', 20);
    t.setLayerStart(l.id, 5);
    t.rippleTrimEnd(l.id, 15); // also shifts `other`

    // Drop the layer outside history, as a document restore that no longer
    // has it would.
    t.history.silently(() => t.removeLayer(l.id));
    expect(t.getLayer(l.id)).toBeUndefined();

    const events: string[] = [];
    t.events.on('LayerUpdated', ({ layer }) => events.push(layer.id));

    expect(() => t.history.undo()).not.toThrow(); // ripple trim: self gone, neighbour restored
    expect(other.start).toBe(40);
    expect(() => t.history.undo()).not.toThrow(); // move
    expect(() => t.history.undo()).not.toThrow(); // trim
    expect(() => t.history.redo()).not.toThrow();
    expect(() => t.history.redo()).not.toThrow();
    expect(t.getLayer(l.id)).toBeUndefined();
    expect(events).not.toContain(l.id);
    // The stale handle was never written to.
    expect(l.start).toBe(5);
  });

  it('a trim whose layer id vanished did not seed the document with a ghost', () => {
    const t = timeline();
    const track = t.addTrack();
    const l = t.addLayer(track.id, { clip: { start: 0, duration: 40 } })!;
    t.trimLayer(l.id, 'end', 20);
    t.history.silently(() => t.removeLayer(l.id));
    t.history.undo();
    expect(t.layerCount).toBe(0);
    expect(t.getTrack(track.id)!.layers).toHaveLength(0);
  });
});

describe('addLayer id uniqueness', () => {
  it('throws on a duplicate id instead of silently overwriting the index', () => {
    const t = timeline();
    const track = t.addTrack();
    const first = t.addLayer(track.id, { id: 'layer-1', clip: { start: 0, duration: 10 } })!;
    expect(() => t.addLayer(track.id, { id: 'layer-1', clip: { start: 20, duration: 10 } })).toThrow(/layer-1/);
    expect(t.layerCount).toBe(1);
    expect(t.getLayer('layer-1')).toBe(first);
    expect(t.getTrack(track.id)!.layers).toHaveLength(1);
    // Nothing was recorded for the refused add.
    expect(t.history.undoLabels()).toEqual(['Add Track', 'Add Layer']);
  });

  it('accepts the same id again once the original is gone', () => {
    const t = timeline();
    const track = t.addTrack();
    t.addLayer(track.id, { id: 'layer-1', clip: { start: 0, duration: 10 } });
    t.removeLayer('layer-1');
    expect(() => t.addLayer(track.id, { id: 'layer-1', clip: { start: 5, duration: 10 } })).not.toThrow();
    expect(t.getLayer('layer-1')!.start).toBe(5);
  });

  it('redo of an add after a rebuild re-attaches from the snapshot rather than the stale object', () => {
    const t = timeline();
    const track = t.addTrack();
    const l = t.addLayer(track.id, { name: 'fresh', clip: { start: 0, duration: 10 } })!;
    t.history.undo();
    expect(t.getLayer(l.id)).toBeUndefined();
    rebuild(t);
    t.history.redo();
    const back = t.getLayer(l.id)!;
    expect(back).toBeDefined();
    expect(back).toBeInstanceOf(Layer);
    expect(back.name).toBe('fresh');
  });
});

describe('splitLayer rightId', () => {
  it('honours a caller-supplied id for the right-hand layer', () => {
    const t = timeline();
    const track = t.addTrack();
    const l = t.addLayer(track.id, { clip: { start: 0, duration: 40 } })!;
    const right = t.splitLayer(l.id, 10, undefined, { rightId: 'right-1' })!;
    expect(right.id).toBe('right-1');
    expect(t.getLayer('right-1')).toBe(right);
    expect(right.start).toBe(10);
    expect(right.duration).toBe(30);
    t.history.undo();
    expect(t.getLayer('right-1')).toBeUndefined();
    t.history.redo();
    expect(t.getLayer('right-1')!.start).toBe(10);
  });

  it('defaults to a fresh id and still forwards the source id', () => {
    const t = timeline();
    const track = t.addTrack();
    const l = t.addLayer(track.id, { sourceId: 'node-a', clip: { start: 0, duration: 40 } })!;
    const right = t.splitLayer(l.id, 10, 'node-b')!;
    expect(right.id).not.toBe(l.id);
    expect(right.sourceId).toBe('node-b');
  });

  it('refuses a rightId that is already taken', () => {
    const t = timeline();
    const track = t.addTrack();
    const l = t.addLayer(track.id, { clip: { start: 0, duration: 40 } })!;
    t.addLayer(track.id, { id: 'taken', clip: { start: 100, duration: 10 } });
    expect(() => t.splitLayer(l.id, 10, undefined, { rightId: 'taken' })).toThrow(/taken/);
    expect(l.duration).toBe(40); // untouched
  });
});
