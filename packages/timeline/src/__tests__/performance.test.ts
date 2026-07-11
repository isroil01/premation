import { Timeline } from '../core/Timeline';
import { FPS_30 } from '../time';

/**
 * Scale checks: the engine must stay responsive with thousands of tracks and
 * layers. These assert big-O behavior indirectly via wall-clock ceilings that
 * are generous enough not to be flaky, plus O(1)/O(log n) index correctness.
 */
describe('Timeline performance', () => {
  it('builds thousands of layers and seeks/queries fast', () => {
    const t = Timeline.create({ duration: 100000, frameRate: FPS_30 });
    // History off for bulk construction (like a project load).
    t.history.setEnabled(false);

    const TRACKS = 200;
    const LAYERS_PER_TRACK = 25; // 5,000 layers total
    for (let ti = 0; ti < TRACKS; ti++) {
      const track = t.addTrack({ name: `T${ti}` });
      for (let li = 0; li < LAYERS_PER_TRACK; li++) {
        const start = li * 40;
        t.addLayer(track.id, { clip: { start, duration: 30 } });
      }
    }
    expect(t.trackCount).toBe(TRACKS);
    expect(t.layerCount).toBe(TRACKS * LAYERS_PER_TRACK);

    // O(1) index lookups.
    const someLayer = t.allLayers()[1234]!;
    expect(t.getLayer(someLayer.id)).toBe(someLayer);

    // Query active layers at a frame — should be quick even across 5k layers.
    const start = Date.now();
    let hits = 0;
    for (let f = 0; f < 400; f += 7) hits += t.activeLayersAt(f).length;
    const elapsed = Date.now() - start;
    expect(hits).toBeGreaterThan(0);
    expect(elapsed).toBeLessThan(500);
  });

  it('adds many markers and finds next/previous in O(log n)', () => {
    const t = Timeline.create({ duration: 100000, frameRate: FPS_30 });
    for (let i = 0; i < 5000; i++) t.addMarker({ frame: i * 10, name: `m${i}` });
    expect(t.markers.size).toBe(5000);
    expect(t.markers.next(105)?.frame).toBe(110);
    expect(t.markers.previous(105)?.frame).toBe(100);
  });
});
