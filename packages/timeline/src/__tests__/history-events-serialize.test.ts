import { Timeline } from '../core/Timeline';
import { deserializeTimeline, serializeTimeline, TIMELINE_FORMAT_VERSION, registerMigration } from '../serialization/Serializer';
import { FPS_30 } from '../time';

function seeded(): Timeline {
  const t = Timeline.create({ name: 'Comp 1', duration: 300, frameRate: FPS_30 });
  const v1 = t.addTrack({ name: 'V1', kind: 'video' });
  const v2 = t.addTrack({ name: 'V2', kind: 'shape' });
  t.addLayer(v1.id, { name: 'Clip A', clip: { start: 0, duration: 100, sourceIn: 0 }, sourceId: 'node_a' });
  t.addLayer(v2.id, { name: 'Clip B', clip: { start: 50, duration: 120 }, sourceId: 'node_b' });
  t.addMarker({ frame: 60, name: 'beat', color: '#f0f' });
  t.setRange('workArea', { start: 10, duration: 200 });
  return t;
}

describe('History undo/redo', () => {
  it('undoes and redoes track add', () => {
    const t = seeded();
    const before = t.trackCount;
    const track = t.addTrack({ name: 'Extra' });
    expect(t.trackCount).toBe(before + 1);
    expect(t.history.undo()).toBe(true);
    expect(t.trackCount).toBe(before);
    expect(t.getTrack(track.id)).toBeUndefined();
    expect(t.history.redo()).toBe(true);
    expect(t.trackCount).toBe(before + 1);
  });

  it('undoes a layer split (restores one layer)', () => {
    const t = seeded();
    const layer = t.allLayers()[0]!;
    const track = t.getTrack(layer.trackId)!;
    const countBefore = track.layerCount;
    t.splitLayer(layer.id, 40);
    expect(track.layerCount).toBe(countBefore + 1);
    expect(layer.duration).toBe(40);
    t.history.undo();
    expect(track.layerCount).toBe(countBefore);
    expect(layer.duration).toBe(100); // restored
  });

  it('undoes a trim', () => {
    const t = seeded();
    const layer = t.allLayers()[0]!;
    const start0 = layer.start;
    t.trimLayer(layer.id, 'start', 20);
    expect(layer.start).toBe(20);
    t.history.undo();
    expect(layer.start).toBe(start0);
  });

  it('undoes marker add/remove and reports depth', () => {
    const t = seeded();
    const depth0 = t.history.depth;
    const m = t.addMarker({ frame: 100, name: 'x' });
    expect(t.history.depth).toBe(depth0 + 1);
    t.history.undo();
    expect(t.getMarker(m.id)).toBeUndefined();
  });

  it('clears redo when a new command runs', () => {
    const t = seeded();
    t.addTrack({ name: 'A' });
    t.history.undo();
    expect(t.history.canRedo).toBe(true);
    t.addTrack({ name: 'B' });
    expect(t.history.canRedo).toBe(false);
  });
});

describe('Events', () => {
  it('emits structural and time events', () => {
    const t = Timeline.create({ duration: 300, frameRate: FPS_30 });
    const events: string[] = [];
    t.events.onAny((name) => events.push(name as string));
    const track = t.addTrack();
    t.addLayer(track.id, { clip: { start: 0, duration: 10 } });
    t.seek(30);
    t.addMarker({ frame: 5 });
    t.setZoom(20);
    expect(events).toEqual(
      expect.arrayContaining([
        'TrackAdded',
        'LayerAdded',
        'PlayheadMoved',
        'CurrentTimeChanged',
        'MarkerAdded',
        'TimelineZoomChanged',
      ]),
    );
  });

  it('emits TimelineSelectionChanged', () => {
    const t = seeded();
    let last: string[] | null = null;
    t.events.on('TimelineSelectionChanged', ({ selection }) => {
      last = selection.layers as string[];
    });
    const id = t.allLayers()[0]!.id;
    t.selection.set('layers', [id]);
    expect(last).toEqual([id]);
  });
});

describe('Serialization', () => {
  it('round-trips a timeline losslessly', () => {
    const t = seeded();
    t.seek(75);
    const doc = serializeTimeline(t);
    expect(doc.version).toBe(TIMELINE_FORMAT_VERSION);

    const restored = deserializeTimeline(JSON.parse(JSON.stringify(doc)));
    expect(restored.name).toBe('Comp 1');
    expect(restored.duration).toBe(300);
    expect(restored.currentFrame).toBe(75);
    expect(restored.trackCount).toBe(2);
    expect(restored.layerCount).toBe(2);
    expect(restored.markerCount).toBe(1);
    expect(restored.getRanges().workArea).toEqual({ start: 10, duration: 200 });

    const layer = restored.allLayers().find((l) => l.name === 'Clip A')!;
    expect(layer.sourceId).toBe('node_a');
    expect(layer.start).toBe(0);
    expect(layer.duration).toBe(100);
  });

  it('exposes serialize()/toJSON()/Timeline.deserialize() via the public API', () => {
    // Grafted in index.ts — import to trigger the graft.
    require('../index');
    const t = seeded();
    const doc = (t as unknown as { serialize: () => unknown }).serialize();
    const restored = (Timeline as unknown as { deserialize: (d: unknown) => Timeline }).deserialize(doc);
    expect(restored.trackCount).toBe(2);
  });

  it('applies migrations for older documents', () => {
    // A fake v0 doc missing `version`; migration bumps to v1.
    registerMigration(0, (raw) => ({ ...raw, migrated: true }));
    const base = serializeTimeline(seeded());
    const old = { ...base } as Record<string, unknown>;
    delete old.version;
    const restored = deserializeTimeline(old);
    expect(restored.trackCount).toBe(2);
  });
});
