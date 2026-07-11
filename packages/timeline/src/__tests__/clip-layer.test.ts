import { Clip } from '../clips/Clip';
import { Layer } from '../layers/Layer';

describe('Clip', () => {
  it('derives end and source mapping', () => {
    const clip = new Clip({ start: 10, duration: 20, sourceIn: 5 });
    expect(clip.end).toBe(30);
    expect(clip.sourceFrameAt(15)).toBe(10); // sourceIn 5 + (15-10)
    expect(clip.contains(10)).toBe(true);
    expect(clip.contains(30)).toBe(false);
  });

  it('trims the head, keeping the tail fixed and syncing source', () => {
    const clip = new Clip({ start: 10, duration: 20, sourceIn: 5 });
    clip.trimStart(15);
    expect(clip.start).toBe(15);
    expect(clip.end).toBe(30);
    expect(clip.duration).toBe(15);
    expect(clip.sourceIn).toBe(10); // advanced by +5
  });

  it("won't pull sourceIn below zero when trimming head left", () => {
    const clip = new Clip({ start: 10, duration: 20, sourceIn: 3 });
    clip.trimStart(2); // wants -8 but only 3 of source-in available
    expect(clip.sourceIn).toBe(0);
    expect(clip.start).toBe(7);
  });

  it('trims the tail, clamped to source length when bounded', () => {
    const clip = new Clip({ start: 0, duration: 20, sourceIn: 0, sourceDuration: 25 });
    clip.trimEnd(40); // wants 40 but source only allows 25
    expect(clip.end).toBe(25);
  });

  it('splits into left (mutated) + right (returned)', () => {
    const clip = new Clip({ start: 0, duration: 30, sourceIn: 100 });
    const right = clip.split(10);
    expect(clip.duration).toBe(10); // left
    expect(right).not.toBeNull();
    expect(right!.start).toBe(10);
    expect(right!.duration).toBe(20);
    expect(right!.sourceIn).toBe(110); // source continues
  });

  it('rejects a split outside the interior', () => {
    const clip = new Clip({ start: 0, duration: 30 });
    expect(clip.split(0)).toBeNull();
    expect(clip.split(30)).toBeNull();
  });
});

describe('Layer', () => {
  it('reports active state from enabled + span', () => {
    const layer = new Layer({ trackId: 't', clip: { start: 5, duration: 10 } });
    expect(layer.isActiveAt(5)).toBe(true);
    expect(layer.isActiveAt(15)).toBe(false);
    layer.enabled = false;
    expect(layer.isActiveAt(6)).toBe(false);
  });

  it('splits into two layers with distinct ids', () => {
    const layer = new Layer({ trackId: 't', name: 'A', clip: { start: 0, duration: 20 } });
    const right = layer.split(8);
    expect(right).not.toBeNull();
    expect(right!.id).not.toBe(layer.id);
    expect(layer.duration).toBe(8);
    expect(right!.start).toBe(8);
    expect(right!.duration).toBe(12);
  });

  it('clones with a fresh id and fresh marker ids', () => {
    const layer = new Layer({ trackId: 't', clip: { start: 0, duration: 10 } });
    layer.markers.add(new (require('../markers/Marker').Marker)({ frame: 2, name: 'm', scope: 'layer', ownerId: layer.id }));
    const copy = layer.clone();
    expect(copy.id).not.toBe(layer.id);
    expect(copy.markers.size).toBe(1);
    expect(copy.markers.list()[0]!.id).not.toBe(layer.markers.list()[0]!.id);
  });
});
