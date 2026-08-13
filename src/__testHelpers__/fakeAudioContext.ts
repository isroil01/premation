/**
 * A recording stand-in for `BaseAudioContext`.
 *
 * ## Why a fake and not jsdom
 *
 * jsdom has no Web Audio at all, and the real thing needs a device. But the
 * property these tests care about is not what an effect SOUNDS like — it is the
 * shape of the graph, and that is exactly what a recording fake can show.
 *
 * A delay is only an echo if the dry and wet paths are PARALLEL; a modulator is
 * only modulation if the LFO reaches an `AudioParam` rather than a node input;
 * a stereo mixer only pans if each input channel fans out to both outputs. Every
 * one of those is a topology fact, invisible to a test that checks parameter
 * values, and every one of them has a plausible-looking wrong version that
 * produces nodes with correct numbers on them.
 *
 * ## Why it lives here rather than in one test file
 *
 * It was written inside `audioEffects.test.ts`, which was right until a second
 * file needed it. Copying it would put the fake's own correctness in two places
 * — and a fake that drifts from the real Web Audio surface is worse than none,
 * because it makes tests pass against an API that does not exist. (That has
 * happened here once already: an earlier version nested params under `.params`,
 * which type-checked against the fake and threw against reality.)
 */

/** One connection, WITH its channel indices — what a splitter/merger needs. */
export interface Wire {
  to: unknown;
  fromCh?: number;
  toCh?: number;
}

/**
 * A recording `AudioParam`.
 *
 * `value` is the assignment path; `scheduled` is the automation path. Keeping
 * them apart is the point: an animated parameter must produce a CURVE, and an
 * unanimated one must stay a single assignment rather than dozens of scheduled
 * points per voice. A fake that collapsed the two could not tell those apart,
 * and the cheap path silently becoming expensive is exactly the kind of
 * regression nothing else would notice.
 */
function fakeParam(initial = 0): Record<string, unknown> {
  const scheduled: number[] = [];
  return {
    value: initial,
    scheduled,
    setValueAtTime(v: number) { scheduled.push(v); },
    linearRampToValueAtTime(v: number) { scheduled.push(v); },
    cancelScheduledValues() { /* the ramp builder calls this first */ },
  };
}

export interface FakeNode {
  kind: string;
  /** Everything this node connects to, in order. */
  out: FakeNode[];
  /** The same connections, carrying the channel indices `out` discards. */
  wires: Wire[];
  connect(n: unknown, fromCh?: number, toCh?: number): FakeNode;
  [k: string]: unknown;
}

/** The sample rate the fake reports. Real enough for pre-delay arithmetic. */
export const FAKE_SAMPLE_RATE = 48000;

export function fakeAudioContext(): { ctx: BaseAudioContext; created: FakeNode[] } {
  const created: FakeNode[] = [];
  // Properties are set DIRECTLY on the node (`f.frequency.value`), matching the
  // real Web Audio surface.
  const mk = (kind: string, props: Record<string, unknown> = {}): FakeNode => {
    const n = {
      kind,
      out: [] as FakeNode[],
      wires: [] as Wire[],
      connect(t: unknown, fromCh?: number, toCh?: number) {
        (n.out as FakeNode[]).push(t as FakeNode);
        (n.wires as Wire[]).push({ to: t, fromCh, toCh });
        return t as FakeNode;
      },
      ...props,
    } as unknown as FakeNode;
    created.push(n);
    return n;
  };
  const ctx = {
    sampleRate: FAKE_SAMPLE_RATE,
    createBiquadFilter: () => mk('biquad', {
      type: '', frequency: fakeParam(), gain: fakeParam(), Q: fakeParam(),
    }),
    createGain: () => mk('gain', { gain: fakeParam(1) }),
    createDelay: (max: number) => mk('delay', { maxDelay: max, delayTime: fakeParam() }),
    createConvolver: () => mk('convolver', { normalize: true, buffer: null }),
    // `start`/`stop` are no-ops that still EXIST: the code under test hands
    // these back for the caller to schedule, and a fake without them would
    // throw in the one test that checks the caller does.
    createOscillator: () => mk('osc', { type: '', frequency: fakeParam(), start() {}, stop() {} }),
    createChannelSplitter: (n: number) => mk('splitter', { channels: n }),
    createChannelMerger: (n: number) => mk('merger', { channels: n }),
    createBuffer: (channels: number, length: number, rate: number) => {
      const data = Array.from({ length: channels }, () => new Float32Array(length));
      return {
        numberOfChannels: channels,
        length,
        sampleRate: rate,
        duration: length / rate,
        getChannelData: (c: number) => data[c]!,
      };
    },
  } as unknown as BaseAudioContext;
  return { ctx, created };
}

/** Read an `AudioParam`-shaped property's value off a fake node. */
export const paramValue = (n: FakeNode, k: string): number => (n[k] as { value: number }).value;

/** A bare source node — the thing an effect chain is built onto. */
export const fakeSource = (): FakeNode => {
  const n = {
    kind: 'source',
    out: [] as FakeNode[],
    wires: [] as Wire[],
    connect(t: unknown, fromCh?: number, toCh?: number) {
      n.out.push(t as FakeNode);
      n.wires.push({ to: t, fromCh, toCh });
      return t as FakeNode;
    },
  } as unknown as FakeNode;
  return n;
};
