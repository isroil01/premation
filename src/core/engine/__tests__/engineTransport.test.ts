/**
 * The page ↔ engine transport state machine (engineTransport.ts, D5): the
 * engine owns the clock; the page's play flag becomes play / pause, the
 * engine's playhead / transportChanged events move the page, and nothing the
 * ENGINE caused is echoed back.
 *
 * Regression (release blocker 2026-09-29, `electron:dev`): the editor boot ran
 * twice under StrictMode and wired TWO transports. Each guarded only its own
 * echo, so each sent the other's engine-driven flag and playhead back as
 * play / pause / seek: ~40 play+pause pairs a second, the playhead pinned at 0
 * or jumping 0.2 → 0.033 → 0.1 (preset animations looked garbled) and Pause
 * never stopped it. Real app, before the fix: 3 s after Space — plays 123,
 * pauses 122, seeks 125, playhead at 00:00:00.
 *
 * The fake engine below behaves like premation-engine's transport where it
 * matters: events arrive asynchronously, `pause` reports the last SEEK time
 * (plus a playhead there), and a play resets the clock to `from`.
 */

import type { Command, EngineClient, EventBatch } from '@motion/engine-api';
import { useProjectStore } from '@stores/projectStore';
import { getClock } from '@stores/playbackClockStore';
import { seekPlayhead } from '@core/timeline/timelineView';
import { installEngineTransport, type EngineTransportStats } from '../engineTransport';

const FLICKS = 705_600_000;
const FPS = 30;

jest.mock('@stores/documentMirror', () => {
  const comp = {
    settings: {
      frameRate: { num: 30, den: 1 },
      duration: 10 * 705_600_000,
      workArea: { start: 0, duration: 10 * 705_600_000 },
    },
  };
  const mirror = { comp: () => comp, subscribe: () => () => {} };
  return { ...jest.requireActual('@stores/documentMirror'), documentMirror: () => mirror };
});

type Listener = (b: EventBatch) => void;

/** Just enough of premation-engine's transport. */
class FakeEngine {
  readonly log: Command[] = [];
  private listeners = new Set<Listener>();
  state: 'stopped' | 'playing' = 'stopped';
  frame = 0;
  private seekFrame = 0;
  /** While set, a seek's reply waits for `releaseSeeks` (its playhead event still goes out). */
  holdSeeks = false;
  /** While set, `play` is refused (no composition yet, say) and nothing changes. */
  refusePlay = false;
  private heldSeeks: Array<() => void> = [];
  releaseSeeks(): void {
    this.holdSeeks = false;
    for (const r of this.heldSeeks.splice(0)) r();
  }
  constructor(readonly comp: string) {}

  client(): EngineClient {
    return {
      execute: (cmd: Command) => {
        this.log.push(cmd);
        if (this.refusePlay && cmd.type === 'play') return Promise.resolve({ ok: false, error: { code: 'notFound', message: 'no composition to play' } });
        this.apply(cmd);
        if (this.holdSeeks && cmd.type === 'seek') return new Promise((resolve) => this.heldSeeks.push(() => resolve({ ok: true, value: {} })));
        return Promise.resolve({ ok: true, value: {} });
      },
      subscribe: (fn: Listener) => {
        this.listeners.add(fn);
        return () => { this.listeners.delete(fn); };
      },
    } as unknown as EngineClient;
  }

  private emit(events: unknown[]): void {
    const batch = { fromRevision: 0, toRevision: 0, events } as unknown as EventBatch;
    // The process client delivers asynchronously.
    queueMicrotask(() => { for (const l of [...this.listeners]) l(batch); });
  }
  private transport(): unknown {
    return { type: 'transportChanged', state: this.state, comp: this.comp, time: this.seekFrame * FLICKS / FPS, rate: 1, loop: 'loop', range: { start: 0, duration: 10 * FLICKS } };
  }
  private playhead(frame: number): unknown {
    return { type: 'playhead', comp: this.comp, time: frame * FLICKS / FPS, frame, droppedFrames: 0 };
  }

  private apply(cmd: Command): void {
    const c = cmd as { type: string; time?: number; from?: number };
    if (c.type === 'play') {
      if (c.from !== undefined) this.frame = Math.round(c.from * FPS / FLICKS);
      // A play while playing restarts (stopped → playing), like the engine.
      if (this.state === 'playing') {
        this.state = 'stopped';
        this.emit([this.transport()]);
      }
      this.state = 'playing';
      this.emit([this.transport(), this.playhead(this.frame)]);
    } else if (c.type === 'pause') {
      if (this.state !== 'playing') return;
      this.state = 'stopped';
      // Once stopped the engine reports its last SEEK time, not where it stopped.
      this.emit([this.transport(), this.playhead(this.seekFrame)]);
    } else if (c.type === 'seek' && c.time !== undefined) {
      this.seekFrame = Math.round(c.time * FPS / FLICKS);
      this.frame = this.seekFrame;
      this.emit([this.playhead(this.frame)]);
    } else if (c.type === 'setLoop') {
      // The engine answers every setLoop with its transport state — still `stopped` when it
      // arrives just ahead of a play (session.cpp SetLoop: emit_transport, emit_playhead).
      this.emit([this.transport(), this.playhead(this.state === 'playing' ? this.frame : this.seekFrame)]);
    }
  }

  /** Advance the playing clock by `n` frames, one playhead event each. */
  tick(n: number): void {
    for (let i = 0; i < n; i++) {
      if (this.state !== 'playing') return;
      this.frame += 1;
      this.emit([this.playhead(this.frame)]);
    }
  }

  count(type: string): number {
    return this.log.filter((c) => c.type === type).length;
  }
}

const flush = async (): Promise<void> => {
  for (let i = 0; i < 20; i++) await Promise.resolve();
};

function activeTab(): { id: string; comp: string } {
  const s = useProjectStore.getState();
  const id = s.activeTabId!;
  return { id, comp: s.tabs[id]!.compositionId };
}

const setPlaying = (on: boolean): void => useProjectStore.getState().actions.setPlaying(on);
const playing = (): boolean => useProjectStore.getState().tabs[activeTab().id]?.playing === true;
const frame = (): number => getClock(activeTab().id).frame;

describe('engine transport (the engine owns the clock)', () => {
  let teardowns: Array<() => void> = [];
  const install = (eng: FakeEngine, stats?: EngineTransportStats): void => {
    teardowns.push(installEngineTransport(() => eng.client(), stats));
  };

  beforeEach(async () => {
    setPlaying(false);
    seekPlayhead(0);
    await flush();
  });
  afterEach(async () => {
    for (const t of teardowns) t();
    teardowns = [];
    setPlaying(false);
    await flush();
  });

  it('play → one play; engine playheads move the page without seeks back; pause holds the picture', async () => {
    const eng = new FakeEngine(activeTab().comp);
    install(eng);
    await flush();
    const seeksAtRest = eng.count('seek');

    setPlaying(true);
    await flush();
    expect(eng.count('play')).toBe(1);
    expect(eng.state).toBe('playing');

    eng.tick(20);
    await flush();
    expect(frame()).toBe(20);
    // The engine's own playheads are never sent back as seeks.
    expect(eng.count('seek')).toBe(seeksAtRest);
    expect(playing()).toBe(true);

    setPlaying(false);
    await flush();
    expect(eng.count('pause')).toBe(1);
    expect(eng.state).toBe('stopped');
    // Pause holds where playback stopped (the stopped-state report of the last seek time is ignored)…
    expect(frame()).toBe(20);
    // …and the engine is re-seeked there.
    expect(eng.frame).toBe(20);
    expect(playing()).toBe(false);

    // Nothing restarts it.
    eng.tick(10);
    await flush();
    expect(eng.count('play')).toBe(1);
    expect(frame()).toBe(20);
  });

  it('play again resumes from the paused frame; a user scrub while stopped is one seek', async () => {
    const eng = new FakeEngine(activeTab().comp);
    install(eng);
    await flush();
    setPlaying(true);
    await flush();
    eng.tick(12);
    await flush();
    setPlaying(false);
    await flush();
    expect(frame()).toBe(12);

    setPlaying(true);
    await flush();
    const play = eng.log.filter((c) => c.type === 'play').pop() as { from?: number };
    expect(Math.round((play.from ?? -1) * FPS / FLICKS)).toBe(12);
    eng.tick(5);
    await flush();
    expect(frame()).toBe(17);
    setPlaying(false);
    await flush();

    const before = eng.count('seek');
    seekPlayhead(3);
    await flush();
    expect(eng.count('seek')).toBe(before + 1);
    expect(eng.frame).toBe(90);
  });

  it('the engine stopping on its own (end of a once range) clears the page flag without a pause echo', async () => {
    const eng = new FakeEngine(activeTab().comp);
    install(eng);
    await flush();
    setPlaying(true);
    await flush();
    eng.tick(3);
    await flush();
    // The engine stops by itself.
    eng.state = 'stopped';
    (eng as unknown as { emit(e: unknown[]): void }).emit([
      { type: 'transportChanged', state: 'stopped', comp: activeTab().comp, time: 0, rate: 1, loop: 'once', range: { start: 0, duration: 10 * FLICKS } },
    ]);
    await flush();
    expect(playing()).toBe(false);
    expect(eng.count('pause')).toBe(0);
    expect(eng.count('play')).toBe(1);
  });

  it('a second install replaces the first: no play/pause/seek storm, and pause stops playback', async () => {
    const eng = new FakeEngine(activeTab().comp);
    const stats: EngineTransportStats = { seeksSent: 0, seeksCoalesced: 0, playheadEvents: 0, plays: 0, pauses: 0, activeComp: '' };
    // The StrictMode double boot: two installs, the first never torn down by its owner.
    install(eng);
    install(eng, stats);
    await flush();
    const seeksAtRest = eng.count('seek');

    setPlaying(true);
    await flush();
    for (let i = 0; i < 30; i++) {
      eng.tick(1);
      await flush();
    }
    // Before the fix: dozens of play/pause pairs and a seek per playhead, the clock stuck near 0.
    expect(eng.count('play')).toBe(1);
    expect(eng.count('pause')).toBe(0);
    expect(eng.count('seek')).toBe(seeksAtRest);
    expect(frame()).toBe(30);

    setPlaying(false);
    await flush();
    expect(eng.state).toBe('stopped');
    expect(eng.count('pause')).toBe(1);
    expect(playing()).toBe(false);
    eng.tick(10);
    await flush();
    expect(eng.state).toBe('stopped');
    expect(eng.count('play')).toBe(1);
    expect(stats.plays).toBe(1);
    expect(stats.pauses).toBe(1);
  });

  it('stopped: the echo of an older seek never overwrites a newer page seek (nor is sent back)', async () => {
    const eng = new FakeEngine(activeTab().comp);
    install(eng);
    await flush();
    // A tab switch seeks to the tab's old time; the mapped time lands while that seek is in flight.
    eng.holdSeeks = true;
    seekPlayhead(1);
    seekPlayhead(2);
    await flush();
    // The engine's playhead for the 1 s seek arrived: the page stays at 2 s.
    expect(frame()).toBe(60);
    eng.releaseSeeks();
    await flush();
    // The queued seek carries 2 s, not the echoed 1 s.
    expect(eng.frame).toBe(60);
    expect(frame()).toBe(60);
  });

  it('a Play click never flickers back to Play: the stale "stopped" setLoop answers is not applied', async () => {
    const eng = new FakeEngine(activeTab().comp);
    install(eng);
    await flush();
    const seen: boolean[] = [];
    const unsub = useProjectStore.subscribe((s) => { seen.push(s.tabs[s.activeTabId!]?.playing === true); });
    setPlaying(true);
    await flush();
    unsub();
    expect(eng.state).toBe('playing');
    expect(playing()).toBe(true);
    // Before the fix the flag went true → false (setLoop's `stopped`) → true (play's `playing`).
    expect(seen).not.toContain(false);
  });

  it('a refused play puts the button back', async () => {
    const eng = new FakeEngine(activeTab().comp);
    eng.refusePlay = true;
    install(eng);
    await flush();
    setPlaying(true);
    await flush();
    expect(playing()).toBe(false);
    expect(eng.count('pause')).toBe(0);
  });

  it('playing: Go to Start is not dragged back by a playhead from before the engine took the seek', async () => {
    const eng = new FakeEngine(activeTab().comp);
    install(eng);
    await flush();
    setPlaying(true);
    await flush();
    eng.tick(40);
    await flush();
    expect(frame()).toBe(40);
    eng.holdSeeks = true;
    seekPlayhead(0);
    // The engine's clock ran on until it got to the seek: one more tick from the old position.
    (eng as unknown as { emit(e: unknown[]): void }).emit([
      { type: 'playhead', comp: activeTab().comp, time: (41 * FLICKS) / FPS, frame: 41, droppedFrames: 0 },
    ]);
    await flush();
    expect(frame()).toBe(0);
    eng.releaseSeeks();
    await flush();
    eng.tick(5);
    await flush();
    expect(frame()).toBe(5);
    expect(playing()).toBe(true);
  });

  it('a torn-down transport sends nothing', async () => {
    const eng = new FakeEngine(activeTab().comp);
    const dispose = installEngineTransport(() => eng.client());
    await flush();
    dispose();
    const sent = eng.log.length;
    setPlaying(true);
    await flush();
    seekPlayhead(2);
    await flush();
    expect(eng.log.length).toBe(sent);
  });
});
