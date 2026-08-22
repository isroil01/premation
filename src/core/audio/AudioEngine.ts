/**
 * AudioEngine — the app's single Web Audio authority.
 *
 * Owns one AudioContext, decodes imported audio assets into buffers +
 * {@link WaveformPeaks} envelopes, and keeps live playback in sync with the
 * transport: {@link sync} is called whenever the playhead or play-state changes
 * and it starts/stops BufferSources so audio layers play in time with the
 * comp. It also exposes {@link currentLevel} — the amplitude at the playhead —
 * which drives the expression engine's `audio` accessor.
 *
 * Deliberately framework-free (no React, no store imports) so it can be driven
 * from a hook and unit-reasoned about. Decoding degrades gracefully when Web
 * Audio is unavailable (SSR / tests) — the rest of the app keeps working.
 */

import { computePeaks, mixToMono, amplitudeAt, type WaveformPeaks } from './waveform';
import { rmsPeak, type Levels } from './audioLevels';
import { buildParamRamp, applyRamp } from './audioParams';
import {
  connectAudioEffects, hasBackwards, reverseBuffer, backwardsOffset, type AudioEffect,
} from './audioEffects';

/** One audio layer's transport-relevant state, derived from the scene. */
export interface AudioLayerState {
  /**
   * Voice identity. One audio NODE can own several audible spans — splitting
   * its timeline bar makes two clips of the same asset at different times — so
   * voices are keyed by clip, not by node. Defaults to `nodeId` when the caller
   * doesn't distinguish (a node with no clip bars has exactly one voice).
   */
  id?: string;
  nodeId: string;
  assetId: string;
  src: string;
  /** Static layer gain in DECIBELS (0 = unity). When `levelAnimated` is set
   *  this is only the fallback — the real curve is sampled per frame. */
  levelDb: number;
  /** True when the node carries level keyframes, so a constant gain is not
   *  enough and the voice needs a scheduled ramp. */
  levelAnimated?: boolean;
  /** `'audio'` for a real audio layer, `'video'` for a clip's own track.
   *  Read by `currentLevel` so audio-reactive expressions can keep their
   *  pre-existing meaning — see there. */
  source?: 'audio' | 'video';
  /**
   * The layer's audio effect chain, applied BEFORE the level gain by both the
   * live engine and the offline mixdown. Absent means no nodes are created at
   * all, so a project without effects has the graph it always had.
   */
  effects?: AudioEffect[];
  /** Comp time (seconds) at which the clip starts. */
  startSec: number;
  /** In/out trim within the clip, seconds. */
  inSec: number;
  outSec: number;
  /**
   * Playback rate for varispeed (tape-style). `1` = natural.
   * Stretch 200% (half-speed picture) → `0.5`. Pitch follows rate.
   */
  playbackRate?: number;
  /**
   * Layer-time reverse: play the source window backwards (same buffer
   * reverse path as the Backwards effect). Combined with `playbackRate`
   * for stretch+reverse.
   */
  retimeReverse?: boolean;
  /** Muted layers decode (for waveform) but never sound. */
  muted: boolean;
}

interface LoadedAsset {
  buffer: AudioBuffer;
  wave: WaveformPeaks;
}

interface ActiveVoice {
  source: AudioBufferSourceNode;
  gain: GainNode;
  /**
   * Oscillators the effect chain created (an LFO, a tone generator).
   *
   * Held on the voice because they share its lifetime exactly: they are started
   * with it and must be stopped with it. A voice that tracked only its buffer
   * source would leave them running into a disconnected subgraph on every seek.
   */
  sources: AudioScheduledSourceNode[];
  /** The layer state hash this voice was started for (restart on change). */
  key: string;
  /** AudioContext time when the voice started, and the buffer offset it began
   *  at — together they predict where playback should be, so a transport seek
   *  or loop-wrap is detected as drift and the voice restarts. */
  startCtxTime: number;
  startOffset: number;
}

/** Max tolerated drift (s) between predicted and wanted playback position
 *  before a voice is restarted — absorbs rAF jitter, catches real seeks. */
const SEEK_TOLERANCE = 0.25;

const WAVEFORM_BUCKETS = 1024;

/** Read an asset's bytes. `blob:`/`http(s):` go through fetch; `data:` URLs are
 *  decoded inline (some CSPs block fetching `data:`), so embedded audio works. */
async function fetchAudioBytes(src: string): Promise<ArrayBuffer> {
  if (src.startsWith('data:')) {
    const comma = src.indexOf(',');
    const meta = src.slice(5, comma);
    const payload = src.slice(comma + 1);
    if (meta.includes('base64')) {
      const bin = atob(payload);
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      return bytes.buffer;
    }
    return new TextEncoder().encode(decodeURIComponent(payload)).buffer as ArrayBuffer;
  }
  const res = await fetch(src);
  return res.arrayBuffer();
}

class AudioEngine {
  private ctx: AudioContext | null = null;
  private readonly assets = new Map<string, LoadedAsset>();
  private readonly loading = new Map<string, Promise<LoadedAsset | null>>();
  /**
   * Assets whose decode failed — a video with no audio track, or a codec the
   * platform can't decode. Remembered because `sync` runs on every playhead
   * change and asks for every referenced asset: without this, a silent video
   * re-fetched and re-decoded its entire file dozens of times a second.
   */
  private readonly undecodable = new Set<string>();
  private readonly voices = new Map<string, ActiveVoice>();
  /** The layer set from the most recent {@link sync} — what `currentLevel`
   *  samples, so it reflects the scene rather than the decode cache. */
  private layers: readonly AudioLayerState[] = [];
  private timeSec = 0;
  private readonly listeners = new Set<() => void>();

  // Master metering chain: every voice routes through `master` → destination,
  // and `master` also feeds a splitter → per-channel analysers so the VU meter
  // reads the full stereo mix. Built lazily with the context.
  private master: GainNode | null = null;
  private analyserL: AnalyserNode | null = null;
  private analyserR: AnalyserNode | null = null;
  private meterBufL: Float32Array<ArrayBuffer> | null = null;
  private meterBufR: Float32Array<ArrayBuffer> | null = null;

  private context(): AudioContext | null {
    if (this.ctx) return this.ctx;
    const Ctor =
      typeof window !== 'undefined'
        ? (window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext)
        : undefined;
    if (!Ctor) return null;
    this.ctx = new Ctor();
    this.buildMasterChain(this.ctx);
    return this.ctx;
  }

  /** Master gain → destination, plus a stereo splitter → L/R analysers for the
   *  VU meter. Voices connect to `master` (see startVoice). */
  private buildMasterChain(ctx: AudioContext): void {
    const master = ctx.createGain();
    master.connect(ctx.destination);
    try {
      const splitter = ctx.createChannelSplitter(2);
      master.connect(splitter);
      const aL = ctx.createAnalyser();
      const aR = ctx.createAnalyser();
      aL.fftSize = 1024;
      aR.fftSize = 1024;
      splitter.connect(aL, 0);
      splitter.connect(aR, 1);
      this.analyserL = aL;
      this.analyserR = aR;
      this.meterBufL = new Float32Array(aL.fftSize);
      this.meterBufR = new Float32Array(aR.fftSize);
    } catch {
      /* metering is best-effort; playback still works without analysers */
    }
    this.master = master;
  }

  /** Live L/R levels for the VU meter, or null when no analyser exists
   *  (Web Audio unavailable / not yet started). Reads the current time-domain
   *  block from each channel analyser. */
  getLevels(): { l: Levels; r: Levels } | null {
    if (!this.analyserL || !this.analyserR || !this.meterBufL || !this.meterBufR) return null;
    this.analyserL.getFloatTimeDomainData(this.meterBufL);
    this.analyserR.getFloatTimeDomainData(this.meterBufR);
    return { l: rmsPeak(this.meterBufL), r: rmsPeak(this.meterBufR) };
  }

  /** Subscribe to load/level changes (so the waveform UI can re-render). */
  onChange(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private emit(): void {
    for (const fn of this.listeners) fn();
  }

  /** Decoded envelope for an asset, or undefined until it has loaded. */
  getWaveform(assetId: string): WaveformPeaks | undefined {
    return this.assets.get(assetId)?.wave;
  }

  /**
   * Decode outcome for an asset, for UI that needs to distinguish "still
   * working" from "there is genuinely no sound here" — a video layer has to be
   * able to say *why* it is silent.
   */
  decodeState(assetId: string): 'decoded' | 'silent' | 'pending' {
    if (this.assets.has(assetId)) return 'decoded';
    if (this.undecodable.has(assetId)) return 'silent';
    return 'pending';
  }

  /** Forget a failed decode so a replaced/re-encoded source is retried. */
  retry(assetId: string): void {
    this.undecodable.delete(assetId);
  }

  /**
   * Decode an asset into a buffer + waveform (idempotent, cached). Returns null
   * when Web Audio is unavailable or decoding fails.
   */
  async load(assetId: string, src: string): Promise<LoadedAsset | null> {
    const cached = this.assets.get(assetId);
    if (cached) return cached;
    if (this.undecodable.has(assetId)) return null;
    const inflight = this.loading.get(assetId);
    if (inflight) return inflight;

    const p = (async (): Promise<LoadedAsset | null> => {
      const ctx = this.context();
      if (!ctx) return null;
      try {
        const bytes = await fetchAudioBytes(src);
        const buffer = await ctx.decodeAudioData(bytes);
        const channels: Float32Array[] = [];
        for (let c = 0; c < buffer.numberOfChannels; c++) channels.push(buffer.getChannelData(c));
        const mono = mixToMono(channels, buffer.length);
        const wave: WaveformPeaks = {
          buckets: WAVEFORM_BUCKETS,
          peaks: computePeaks(mono, WAVEFORM_BUCKETS),
          duration: buffer.duration,
        };
        const loaded: LoadedAsset = { buffer, wave };
        this.assets.set(assetId, loaded);
        this.emit();
        return loaded;
      } catch {
        // Most common cause by far is a legitimate one: a video file with no
        // audio track. Remember it so the per-frame `sync` stops asking, and
        // emit so any inspector showing "checking…" can settle on "no audio".
        this.undecodable.add(assetId);
        this.emit();
        return null;
      } finally {
        this.loading.delete(assetId);
      }
    })();
    this.loading.set(assetId, p);
    return p;
  }

  /**
   * Peak amplitude (0..1) across the scene's audible layers at the current
   * playhead. Read from the envelope (not live analysis) so it works while
   * paused/scrubbing — which is what drives audio-reactive expressions.
   *
   * Sampled at each layer's CLIP-LOCAL time (`inSec + (t − startSec)`) and only
   * inside its audible span. Sampling every decoded asset at raw comp time —
   * as this used to — reported loudness from clips the playhead wasn't over,
   * from muted layers, and from assets whose layer had been deleted (the decode
   * cache outlives the scene), so expressions reacted to sound nobody heard.
   */
  currentLevel(): number {
    let max = 0;
    for (const l of this.layers) {
      if (l.muted) continue;
      // AUDIO LAYERS ONLY, deliberately.
      //
      // This drives the expression engine's `audio` accessor and the Audio
      // Throb behaviour. Video layers only became voices recently; counting
      // them here would silently re-key every existing audio-reactive
      // composition to a louder, different signal the moment footage was added
      // — a behaviour change to saved projects, arriving without an edit. The
      // VU meter is a different question and correctly reads the whole master
      // bus, footage included, because it is metering output rather than
      // driving animation.
      //
      // If per-layer source selection lands, this is the seam it plugs into.
      if (l.source === 'video') continue;
      const asset = this.assets.get(l.assetId);
      if (!asset) continue;
      const localT = this.timeSec - l.startSec;
      if (localT < 0) continue;
      const offset = l.inSec + localT;
      const outSec = l.outSec > 0 ? l.outSec : asset.wave.duration;
      if (offset >= outSec) continue;
      const a = amplitudeAt(asset.wave, offset);
      if (a > max) max = a;
    }
    return max;
  }

  private voiceKey(l: AudioLayerState): string {
    // `levelAnimated` is part of the identity: turning keyframes on or off
    // changes how the voice must be scheduled, not just its value.
    const rate = l.playbackRate ?? 1;
    const rev = l.retimeReverse ? 'r' : 'f';
    return `${l.assetId}|${l.levelDb}|${l.levelAnimated ? 'a' : 's'}|${l.startSec}|${l.inSec}|${l.outSec}|${l.muted}|${rate}|${rev}`;
  }

  /** Stable per-voice identity — the clip id when the caller supplies one. */
  private voiceId(l: AudioLayerState): string {
    return l.id ?? l.nodeId;
  }

  /**
   * Reconcile live playback with the transport. Called on every play/pause,
   * seek, or scene edit. Starts voices for audible layers when playing (seeking
   * into each buffer to match the playhead), and stops everything otherwise.
   */
  sync(playing: boolean, timeSec: number, layers: readonly AudioLayerState[]): void {
    this.timeSec = timeSec;
    this.layers = layers;
    const ctx = this.context();
    if (!ctx) return;

    // Ensure every referenced asset is (being) decoded. `load` short-circuits
    // on both the decoded and the known-undecodable cases, so this stays a map
    // lookup per layer per frame rather than a re-fetch.
    for (const l of layers) if (!this.assets.has(l.assetId)) void this.load(l.assetId, l.src);

    if (!playing) {
      this.stopAll();
      return;
    }
    if (ctx.state === 'suspended') void ctx.resume();

    const wanted = new Map(layers.filter((l) => !l.muted).map((l) => [this.voiceId(l), l] as const));

    // Stop voices whose layer vanished, changed materially, or drifted out of
    // sync with the playhead (a seek or loop-wrap).
    for (const [voiceId, voice] of [...this.voices]) {
      const l = wanted.get(voiceId);
      if (!l || this.voiceKey(l) !== voice.key) {
        this.stopVoice(voiceId);
        continue;
      }
      // Past the clip's out-point the voice must stop even though its layer is
      // unchanged. `source.start(…, duration)` already bounds it, but only for
      // the span it was scheduled with; a bar trimmed shorter mid-playback (or
      // a playhead that jumped past the tail) has to be caught here or the
      // clip keeps sounding after its bar ends.
      //
      // With playbackRate (stretch), buffer time advances at `rate` × wall
      // time: a 200% stretch (rate 0.5) consumes half a second of source per
      // second of timeline.
      const rate = Math.max(0.01, l.playbackRate ?? 1);
      const localT = timeSec - l.startSec;
      const outSec = l.outSec > 0 ? l.outSec : Infinity;
      const barLen = Math.max(0, (l.outSec > 0 ? l.outSec : 0) - l.inSec);
      const wanted0 = l.inSec + localT * rate;
      if (localT < 0 || (barLen > 0 && localT >= barLen) || wanted0 >= outSec) {
        this.stopVoice(voiceId);
        continue;
      }
      const predicted = voice.startOffset + (ctx.currentTime - voice.startCtxTime) * rate;
      if (Math.abs(wanted0 - predicted) > SEEK_TOLERANCE) this.stopVoice(voiceId);
    }

    // (Re)start voices. A large seek while playing lands here after the stop
    // above and restarts at the new offset.
    for (const [voiceId, l] of wanted) {
      if (this.voices.has(voiceId)) continue;
      const asset = this.assets.get(l.assetId);
      if (!asset) continue; // not decoded yet; a later sync will start it
      const rate = Math.max(0.01, l.playbackRate ?? 1);
      const localT = timeSec - l.startSec;
      const outSec = l.outSec > 0 ? l.outSec : asset.buffer.duration;
      const barLen = Math.max(0, outSec - l.inSec);
      const offset = l.inSec + localT * rate;
      if (localT < 0 || localT >= barLen || offset >= outSec) continue;
      this.startVoice(voiceId, l, asset, offset);
    }
  }

  /** The decoded buffer for an asset, or undefined until `load` completes.
   *  Used by the offline export mixdown (see audioMixdown). */
  decodedBuffer(assetId: string): AudioBuffer | undefined {
    return this.assets.get(assetId)?.buffer;
  }

  private startVoice(voiceId: string, l: AudioLayerState, asset: LoadedAsset, offset: number): void {
    const ctx = this.ctx!;
    const source = ctx.createBufferSource();
    // Layer-time reverse OR the Backwards effect — same buffer flip. Decided
    // before the graph exists.
    const reversed = l.retimeReverse === true || hasBackwards(l.effects);
    source.buffer = reversed ? reverseBuffer(ctx, asset.buffer) : asset.buffer;
    const rate = Math.max(0.01, l.playbackRate ?? 1);
    if (source.playbackRate) source.playbackRate.value = rate;
    const gain = ctx.createGain();
    // Effects sit BEFORE the gain, so the layer's level (and its automation)
    // has the last word on loudness — a delay's feedback cannot outrun a fade
    // to silence. Built by the same function the offline mixdown calls; see
    // audioEffects.ts for why that is one function and not two.
    const outSec = l.outSec > 0 ? l.outSec : asset.buffer.duration;
    // Remaining BUFFER seconds; wall duration = remaining / rate.
    const remaining = Math.max(0, outSec - offset);
    /*
      TWO offsets, and they are not interchangeable.

      `clipAt` is a position in the CLIP — what the fade curve and the voice
      bookkeeping are expressed in, and what the rest of the engine means by
      "where we are". `readAt` is a position in the BUFFER handed to
      `source.start`, which is the reversed one when Backwards is on.

      Collapsing them is the silent failure `backwardsOffset` documents: a clip
      trimmed to 2–4 s of a ten-second file would play 6–8 s backwards, in time,
      with nothing to indicate it.
    */
    const clipAt = Math.max(0, offset);
    const readAt = reversed
      ? backwardsOffset(asset.buffer.duration, clipAt, remaining)
      : clipAt;
    // Comp time for this buffer offset: invert the rate mapping.
    const resumeCompSec = l.startSec + (clipAt - l.inSec) / rate;
    // Wall-clock length of this voice window.
    const remainingWall = remaining / rate;

    /*
      Built HERE rather than above, because the chain needs the voice window to
      schedule keyframed effect parameters — the same window, from the same
      arithmetic, that the level ramp below uses. Passing it is what makes an
      animated Dry/Wet a curve instead of a value frozen at the voice's start.
    */
    const chain = connectAudioEffects(ctx, source, l.effects, {
      nodeId: l.nodeId,
      startCompSec: resumeCompSec,
      durationSec: remainingWall,
      whenCtx: ctx.currentTime,
    });
    chain.node.connect(gain).connect(this.master ?? ctx.destination);

    // Gain is SCHEDULED on the param, never assigned per frame — see
    // audioParams for why (assignment steps once per render quantum and
    // zippers). An unanimated level yields a single point, so the common case
    // is still one setValueAtTime.
    //
    // The ramp is built from the comp time this voice resumes at, which is
    // `startSec + (offset - inSec)` — NOT `startSec`. Seeking into the middle
    // of a fade has to pick the curve up where the playhead is, or the fade
    // restarts from its beginning every time the transport moves. (Computed
    // above, because the effect chain schedules its own curves from the same
    // window.)
    const ramp = buildParamRamp(l.nodeId, l.levelDb, resumeCompSec, remainingWall, {
      animated: l.levelAnimated === true,
    });
    applyRamp(gain.gain, ramp, ctx.currentTime);

    try {
      // duration is BUFFER seconds; playbackRate stretches wall time.
      source.start(ctx.currentTime, readAt, remaining);
    } catch {
      return;
    }
    /*
      The chain's own oscillators run for exactly this voice's window.

      Started here rather than inside `connectAudioEffects` because the window
      is the caller's knowledge, and stopped explicitly because an oscillator
      with no stop time keeps its whole subgraph reachable for the life of the
      context — one leaked LFO per seek, on every scrub, for the session.
    */
    for (const s of chain.sources) {
      try {
        s.start(ctx.currentTime);
        s.stop(ctx.currentTime + remainingWall);
      } catch {
        /* already started — cannot happen for a freshly built chain */
      }
    }
    this.voices.set(voiceId, {
      source,
      gain,
      sources: chain.sources,
      key: this.voiceKey(l),
      startCtxTime: ctx.currentTime,
      startOffset: clipAt,
    });
  }

  private stopVoice(voiceId: string): void {
    const v = this.voices.get(voiceId);
    if (!v) return;
    try {
      v.source.stop();
    } catch {
      /* already stopped */
    }
    // The chain's oscillators go with it. They carry a scheduled stop already,
    // so this is about stopping them NOW on a seek rather than leaving an LFO
    // running into a disconnected subgraph until its window would have ended.
    for (const s of v.sources ?? []) {
      try {
        s.stop();
      } catch {
        /* already stopped, or never started */
      }
      s.disconnect();
    }
    v.source.disconnect();
    v.gain.disconnect();
    this.voices.delete(voiceId);
  }

  private stopAll(): void {
    for (const voiceId of [...this.voices.keys()]) this.stopVoice(voiceId);
  }
}

/** Process-wide singleton (mirrors defaultSceneGraph / defaultAnimation). */
export const audioEngine = new AudioEngine();
