/**
 * The scheduler, driven by a fake plugin.
 *
 * The four claims worth testing are the four the render path depends on, and
 * none of them is about the geometry:
 *
 *   · preview NEVER blanks — the previous frame is served while the next is
 *     being made;
 *   · a scrub is latest-wins — the frames nobody will look at are never run;
 *   · export AWAITS the exact frame, and says which layer did not make it;
 *   · a seek is deterministic — the same frame gives the same instances however
 *     the playhead got there, whatever happens to be checkpointed.
 *
 * The fake runner counts its calls, which is how "never run" is asserted:
 * checking only the OUTPUT would pass for a scheduler that runs sixty frames
 * and throws fifty-nine away, which is the bug this design exists to avoid.
 */

import { GEN_STRIDE, GEN_STRIDE_UV } from './generatorContract';
import {
  latestGeneratorBounds,
  requestGeneratorFrame,
  resetGeneratorsForTests,
  setGeneratorExactMode,
  setGeneratorRunner,
  settleGenerators,
  takeGeneratorErrors,
  type GeneratorDemand,
} from './generatorScheduler';

const LAYER = { width: 400, height: 300 };

/**
 * A deterministic "simulation": state is a running sum of the frame numbers it
 * has been stepped through, and the single instance's x IS that sum.
 *
 * Contrived on purpose. It makes the frame's CONTENT a function of the whole
 * path taken to reach it, so a scheduler that resumed from the wrong state
 * produces a visibly different number rather than an identical one — which a
 * simulation of a nicer shape would often hide.
 */
interface Sim { sum: number }

function makeRunner(opts: { stateful?: boolean; delayMs?: number; fail?: (frame: number) => string | null } = {}) {
  const calls: number[] = [];
  let resolveNext: Array<() => void> = [];
  const runner = {
    calls,
    /** Release every generate currently parked on `delayMs: -1`. */
    flush(): void {
      const waiting = resolveNext;
      resolveNext = [];
      for (const fn of waiting) fn();
    },
    async generate(_p: string, _k: string, request: unknown): Promise<unknown> {
      const req = request as { frame: number; state?: Sim };
      calls.push(req.frame);
      if (opts.delayMs === -1) await new Promise<void>((r) => resolveNext.push(r));
      else if (opts.delayMs) await new Promise((r) => setTimeout(r, opts.delayMs));
      const bad = opts.fail?.(req.frame);
      if (bad) throw new Error(bad);
      const sum = (req.state?.sum ?? 0) + req.frame;
      return {
        instances: new Float32Array([sum, 0, 0, 10, 0, 1, 1, 1, 1]),
        count: 1,
        primitive: 'point',
        ...(opts.stateful === false ? {} : { state: { sum } as Sim }),
      };
    },
  };
  return runner;
}

const demand = (frame: number, over: Partial<GeneratorDemand> = {}): GeneratorDemand => ({
  layerId: 'L1',
  pluginId: 'studio.acme',
  kindId: 'sparks',
  ...over,
  request: {
    layerTime: frame / 30,
    compTime: frame / 30,
    frame,
    fps: 30,
    compSize: { width: 1920, height: 1080 },
    layerSize: LAYER,
    params: {},
    seed: 7,
    ...(over.request ?? {}),
  },
});

/** Let every queued microtask and timer settle. */
const settle = async (): Promise<void> => {
  for (let i = 0; i < 40; i++) await Promise.resolve();
  await new Promise((r) => setTimeout(r, 0));
  for (let i = 0; i < 40; i++) await Promise.resolve();
};

/** The x of the single instance, which is the simulation's running sum. */
const xOf = (f: { instances: Float32Array } | null): number | null => (f ? f.instances[0]! : null);

beforeEach(() => {
  resetGeneratorsForTests();
});

describe('serving a frame', () => {
  it('returns null the first time and the frame once it lands', async () => {
    setGeneratorRunner(makeRunner());
    expect(requestGeneratorFrame(demand(0))).toBeNull();
    await settle();
    expect(xOf(requestGeneratorFrame(demand(0)))).toBe(0);
  });

  it('re-asks when a PARAMETER changed, with the playhead standing still', async () => {
    /*
      The case a cache keyed on the frame number alone gets wrong, and the one a
      user hits constantly: they drag a property and watch the viewport. The
      playhead has not moved, so every repaint asks for the same frame — and
      answering it from the cache shows the geometry from before the edit, which
      reads as the plugin having stopped working.

      Stateless, so the count is about the cache and not about a seek replaying
      the frames before this one.
    */
    const runner = makeRunner({ stateful: false });
    setGeneratorRunner(runner);
    const at = (size: number) => demand(5, { request: { params: { size } } as never });

    requestGeneratorFrame(at(10));
    await settle();
    const first = runner.calls.length;
    expect(first).toBeGreaterThan(0);

    // A repaint with nothing changed must cost nothing.
    requestGeneratorFrame(at(10));
    await settle();
    expect(runner.calls.length).toBe(first);

    // The same frame, one property different: that is a different picture.
    requestGeneratorFrame(at(40));
    await settle();
    expect(runner.calls.length).toBe(first + 1);
  });

  it('HOLDS the previous frame rather than blanking while the next is made', async () => {
    const runner = makeRunner({ delayMs: -1 });
    setGeneratorRunner(runner);
    requestGeneratorFrame(demand(0));
    await settle();
    runner.flush();
    await settle();
    expect(xOf(requestGeneratorFrame(demand(0)))).toBe(0);

    // Frame 1 is not ready; the viewport gets frame 0 again, never nothing.
    const held = requestGeneratorFrame(demand(1));
    expect(xOf(held)).toBe(0);
    runner.flush();
    await settle();
    expect(xOf(requestGeneratorFrame(demand(1)))).toBe(1);
  });

  it('reports the newest frame’s bounds for selection', async () => {
    setGeneratorRunner(makeRunner());
    requestGeneratorFrame(demand(4));
    await settle();
    // The fake is stateful, so frame 4 is the sum 0+1+2+3+4 = 10 — the probe
    // frame the scheduler runs first is discarded, not kept (see the
    // statefulness note in the pump). One instance at x = 10, size 10.
    expect(latestGeneratorBounds('L1')).toEqual({ x: 5, y: -5, width: 10, height: 10 });
    expect(latestGeneratorBounds('nobody')).toBeNull();
  });
});

describe('latest-wins', () => {
  it('never runs the frames a scrub passed over', async () => {
    const runner = makeRunner({ delayMs: -1, stateful: false });
    setGeneratorRunner(runner);
    // Frame 10 starts; 11..14 arrive while it is in flight and supersede each
    // other; only the newest survives.
    requestGeneratorFrame(demand(10));
    await settle();
    for (const f of [11, 12, 13, 14]) requestGeneratorFrame(demand(f));
    runner.flush();
    await settle();
    runner.flush();
    await settle();

    expect(runner.calls).toContain(10);
    expect(runner.calls).toContain(14);
    expect(runner.calls).not.toContain(11);
    expect(runner.calls).not.toContain(12);
    expect(runner.calls).not.toContain(13);
  });

  it('a jump is not playback, so nothing is prefetched', async () => {
    const runner = makeRunner({ stateful: false });
    setGeneratorRunner(runner);
    requestGeneratorFrame(demand(0, { lookAhead: 4 }));
    await settle();
    requestGeneratorFrame(demand(60, { lookAhead: 4 }));
    await settle();
    expect(runner.calls.filter((f) => f > 60)).toEqual([]);
  });
});

describe('look-ahead', () => {
  it('runs ahead once the requests look like playback', async () => {
    const runner = makeRunner({ stateful: false });
    setGeneratorRunner(runner);
    requestGeneratorFrame(demand(0, { lookAhead: 3 }));
    await settle();
    // Frame 1 follows frame 0: that is playback, and the runway opens.
    requestGeneratorFrame(demand(1, { lookAhead: 3 }));
    await settle();
    expect(runner.calls).toEqual(expect.arrayContaining([2, 3, 4]));
    // Which means the next frame is already there, synchronously.
    expect(xOf(requestGeneratorFrame(demand(2, { lookAhead: 3 })))).toBe(2);
  });
});

describe('export', () => {
  afterEach(() => setGeneratorExactMode(false));

  it('waits for the exact frame, and reports nothing outstanding once it has it', async () => {
    const runner = makeRunner({ delayMs: 1 });
    setGeneratorRunner(runner);
    setGeneratorExactMode(true);
    requestGeneratorFrame(demand(0, { exact: true }));
    expect(await settleGenerators(2_000)).toEqual([]);
    expect(xOf(requestGeneratorFrame(demand(0, { exact: true })))).toBe(0);
  });

  it('names the layer whose frame never arrived', async () => {
    const runner = makeRunner({ delayMs: -1 });
    setGeneratorRunner(runner);
    setGeneratorExactMode(true);
    requestGeneratorFrame(demand(3, { exact: true }));
    await settle();
    expect(await settleGenerators(20)).toEqual(['L1']);
  });

  it('does not prefetch during an export', async () => {
    const runner = makeRunner({ stateful: false });
    setGeneratorRunner(runner);
    setGeneratorExactMode(true);
    requestGeneratorFrame(demand(0, { lookAhead: 8, exact: true }));
    await settleGenerators(2_000);
    requestGeneratorFrame(demand(1, { lookAhead: 8, exact: true }));
    await settleGenerators(2_000);
    await settle();
    expect(runner.calls.filter((f) => f > 1)).toEqual([]);
  });
});

describe('a generator that fails', () => {
  it('records one error naming the plugin and stops re-running it', async () => {
    const runner = makeRunner({ fail: () => 'the emitter exploded' });
    setGeneratorRunner(runner);
    for (const f of [0, 1, 2, 3, 4, 5, 6]) {
      requestGeneratorFrame(demand(f));
      await settle();
    }
    const errors = takeGeneratorErrors();
    expect(errors).toHaveLength(1);
    expect(errors![0]).toMatchObject({ layerId: 'L1', pluginId: 'studio.acme', kindId: 'sparks' });
    expect(errors![0]!.message).toMatch(/emitter exploded/);
    // Three strikes, then it stops asking — a broken generator must not be run
    // sixty times a second forever.
    expect(runner.calls.length).toBeLessThanOrEqual(3);
    expect(takeGeneratorErrors()).toBeNull();
  });

  it('refuses a frame whose buffer cannot back its count, as a plugin error', async () => {
    setGeneratorRunner({
      generate: async () => ({ instances: new Float32Array(GEN_STRIDE), count: 9, primitive: 'point' }),
    });
    requestGeneratorFrame(demand(0));
    await settle();
    expect(takeGeneratorErrors()![0]!.message).toMatch(/reported 9 instances/);
  });
});

describe('a textured frame carries its owner', () => {
  /*
    `textureAssetKey` is a path INSIDE the plugin's package, and a path with no
    owner cannot be resolved to a file. The validator never learns which layer
    it is validating for, so the scheduler is the one place that can say whose
    package it is — and if it does not, the snapshot adapter has nothing to
    build a texture key from and the sprite silently draws untextured, which is
    exactly the failure this whole path exists to end.
  */
  const textured = (over: Record<string, unknown> = {}) => ({
    generate: async () => ({
      instances: new Float32Array(GEN_STRIDE_UV),
      count: 1,
      stride: GEN_STRIDE_UV,
      primitive: 'sprite',
      textureAssetKey: 'sprites/atlas.png',
      ...over,
    }),
  });

  it('stamps the plugin id onto a frame that names a package file', async () => {
    setGeneratorRunner(textured());
    requestGeneratorFrame(demand(0));
    await settle();
    const frame = requestGeneratorFrame(demand(0));
    expect(frame!.textureAssetKey).toBe('sprites/atlas.png');
    expect(frame!.pluginId).toBe('studio.acme');
  });

  it('leaves it off a frame that names none', async () => {
    setGeneratorRunner(makeRunner());
    requestGeneratorFrame(demand(0));
    await settle();
    // Not a detail: a project of plain point generators must not start carrying
    // a field it has no use for.
    expect(requestGeneratorFrame(demand(0))!.pluginId).toBeUndefined();
  });
});
