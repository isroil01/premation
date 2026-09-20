/**
 * `History.transaction` — many reversible commands recorded as one undo entry.
 *
 * The case this exists for: a timeline drag that moves every SELECTED bar
 * calls `setLayerStart` once per bar. Each of those is a command, so without a
 * transaction one gesture costs one Ctrl+Z per layer.
 */

import { Timeline } from '../core/Timeline';
import { FPS_30 } from '../time';

interface Seeded {
  t: Timeline;
  a: string;
  b: string;
  c: string;
}

function seeded(): Seeded {
  const t = Timeline.create({ name: 'Comp', duration: 600, frameRate: FPS_30 });
  const track = t.addTrack({ name: 'V1', kind: 'video' });
  const a = t.addLayer(track.id, { name: 'A', clip: { start: 0, duration: 60 } })!;
  const b = t.addLayer(track.id, { name: 'B', clip: { start: 100, duration: 60 } })!;
  const c = t.addLayer(track.id, { name: 'C', clip: { start: 200, duration: 60 } })!;
  return { t, a: a.id, b: b.id, c: c.id };
}

const startOf = (t: Timeline, id: string): number => t.getLayer(id)!.clip.start;

describe('History.transaction', () => {
  it('records a three-layer move as ONE undo entry', () => {
    const { t, a, b, c } = seeded();
    const depthBefore = t.history.depth;

    t.history.transaction('Move Layers', () => {
      t.setLayerStart(a, 10);
      t.setLayerStart(b, 110);
      t.setLayerStart(c, 210);
    });

    expect(t.history.depth).toBe(depthBefore + 1);
    expect([startOf(t, a), startOf(t, b), startOf(t, c)]).toEqual([10, 110, 210]);

    expect(t.history.undo()).toBe(true);
    expect([startOf(t, a), startOf(t, b), startOf(t, c)]).toEqual([0, 100, 200]);
    expect(t.history.depth).toBe(depthBefore);

    expect(t.history.redo()).toBe(true);
    expect([startOf(t, a), startOf(t, b), startOf(t, c)]).toEqual([10, 110, 210]);
  });

  it('applies the change immediately, not on close', () => {
    // The drag release needs the bars where it put them BEFORE the entry is
    // recorded — a transaction defers the recording, never the mutation.
    const { t, a } = seeded();
    t.history.transaction('Move Layers', () => {
      t.setLayerStart(a, 42);
      expect(startOf(t, a)).toBe(42);
    });
  });

  it('undoes the parts in reverse order', () => {
    // Two bars that swap places only land back where they started if the
    // composite replays its parts last-in-first-out.
    const { t, a, b } = seeded();
    t.history.transaction('Swap', () => {
      t.setLayerStart(a, 100); // A onto B's frame
      t.setLayerStart(b, 0); // B onto A's old frame
    });
    expect([startOf(t, a), startOf(t, b)]).toEqual([100, 0]);
    t.history.undo();
    expect([startOf(t, a), startOf(t, b)]).toEqual([0, 100]);
  });

  it('pushes nothing when the body changed nothing', () => {
    const { t, a } = seeded();
    const depth = t.history.depth;
    t.history.transaction('Move Layers', () => {
      t.setLayerStart(a, 0); // same frame — setLayerStart bails out
    });
    expect(t.history.depth).toBe(depth);
  });

  it('nests — an inner transaction folds into the outer entry', () => {
    const { t, a, b } = seeded();
    const depth = t.history.depth;
    t.history.transaction('Outer', () => {
      t.setLayerStart(a, 10);
      t.history.transaction('Inner', () => {
        t.setLayerStart(b, 110);
      });
    });
    expect(t.history.depth).toBe(depth + 1);
    t.history.undo();
    expect([startOf(t, a), startOf(t, b)]).toEqual([0, 100]);
  });

  it('routes the composite through onPush as a single command', () => {
    // The app mirrors engine commands into its own history through `onPush`;
    // a group move must arrive there as one entry too, or the global undo
    // stack disagrees with the local one.
    const pushed: string[] = [];
    const t = Timeline.create({
      name: 'Comp',
      duration: 600,
      frameRate: FPS_30,
      historyOptions: { onPush: (cmd) => pushed.push(cmd.label) },
    });
    const track = t.addTrack({ name: 'V1', kind: 'video' });
    const a = t.addLayer(track.id, { name: 'A', clip: { start: 0, duration: 60 } })!;
    const b = t.addLayer(track.id, { name: 'B', clip: { start: 100, duration: 60 } })!;
    pushed.length = 0;

    t.history.transaction('Move Layers', () => {
      t.setLayerStart(a.id, 10);
      t.setLayerStart(b.id, 110);
    });
    expect(pushed).toEqual(['Move Layers']);
  });

  it('keeps a lone command’s own label rather than wrapping it', () => {
    const pushed: string[] = [];
    const t = Timeline.create({
      name: 'Comp',
      duration: 600,
      frameRate: FPS_30,
      historyOptions: { onPush: (cmd) => pushed.push(cmd.label) },
    });
    const track = t.addTrack({ name: 'V1', kind: 'video' });
    const a = t.addLayer(track.id, { name: 'A', clip: { start: 0, duration: 60 } })!;
    pushed.length = 0;
    t.history.transaction('Move Layers', () => t.setLayerStart(a.id, 10));
    expect(pushed).toEqual(['Move Layer']);
  });

  it('still runs, unrecorded, when history is disabled', () => {
    const { t, a } = seeded();
    const depth = t.history.depth;
    t.history.silently(() => {
      t.history.transaction('Move Layers', () => t.setLayerStart(a, 10));
    });
    expect(startOf(t, a)).toBe(10);
    expect(t.history.depth).toBe(depth);
  });
});
