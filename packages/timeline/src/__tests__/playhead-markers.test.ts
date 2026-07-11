import { Playhead } from '../playhead/Playhead';
import { MarkerList } from '../markers/MarkerList';
import { Marker } from '../markers/Marker';

describe('Playhead', () => {
  it('clamps to [0, duration]', () => {
    const ph = new Playhead(100);
    ph.set(-10);
    expect(ph.current).toBe(0);
    ph.set(200);
    expect(ph.current).toBe(100);
  });

  it('steps frames and jumps', () => {
    const ph = new Playhead(100);
    ph.seek(10);
    ph.nextFrame();
    expect(ph.current).toBe(11);
    ph.previousFrame();
    expect(ph.current).toBe(10);
    ph.jump(5);
    expect(ph.current).toBe(15);
    ph.goToEnd();
    expect(ph.current).toBe(100);
    ph.goToStart();
    expect(ph.current).toBe(0);
  });

  it('fires onChange with (current, previous)', () => {
    const ph = new Playhead(100);
    const seen: Array<[number, number]> = [];
    ph.onChange = (c, p) => seen.push([c, p]);
    ph.seek(20);
    ph.seek(20); // no-op, no event
    ph.seek(30);
    expect(seen).toEqual([
      [20, 0],
      [30, 20],
    ]);
  });

  it('re-clamps when duration shrinks below the playhead', () => {
    const ph = new Playhead(100);
    ph.seek(80);
    ph.setDuration(50);
    expect(ph.current).toBe(50);
  });
});

describe('MarkerList', () => {
  const mk = (frame: number, name = '') => new Marker({ frame, name });

  it('keeps markers sorted and finds next/previous', () => {
    const list = new MarkerList();
    list.add(mk(50, 'b'));
    list.add(mk(10, 'a'));
    list.add(mk(90, 'c'));
    expect(list.list().map((m) => m.frame)).toEqual([10, 50, 90]);
    expect(list.next(10)?.frame).toBe(50);
    expect(list.previous(50)?.frame).toBe(10);
    expect(list.next(90)).toBeNull();
    expect(list.previous(10)).toBeNull();
  });

  it('queries at a frame and in a range', () => {
    const list = new MarkerList();
    list.add(new Marker({ frame: 20, duration: 10 })); // spans 20..30
    list.add(mk(60));
    expect(list.at(25)?.frame).toBe(20); // inside the span
    expect(list.at(45)).toBeUndefined();
    expect(list.inRange(0, 25).length).toBe(1);
    expect(list.inRange(0, 100).length).toBe(2);
  });

  it('removes by id', () => {
    const list = new MarkerList();
    const m = list.add(mk(10));
    expect(list.remove(m.id)).toBe(true);
    expect(list.size).toBe(0);
  });
});
