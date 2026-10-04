/**
 * AudioEngine — the app's single Web Audio authority.
 *
 * Owns one AudioContext and decodes imported audio assets into buffers +
 * {@link WaveformPeaks} envelopes (the panels' waveforms, the audio keyframe
 * bakes) and meters its master bus. PLAYBACK is the engine's (C++ E2: the
 * engine mixes and plays every layer in time with its transport); the page's
 * own voice scheduler, which sampled the page replica's level / pan / effect
 * curves, is gone with it (block 3). {@link currentLevel} answers 0 — the
 * page plays nothing — for the TypeScript engine's `audio` expression
 * accessor, which goes with that engine.
 *
 * Deliberately framework-free (no React, no store imports) so it can be driven
 * from a hook and unit-reasoned about. Decoding degrades gracefully when Web
 * Audio is unavailable (SSR / tests) — the rest of the app keeps working.
 */

import { computePeaks, mixToMono, type WaveformPeaks } from './waveform';
import { rmsPeak, type Levels } from './audioLevels';
import { getAudioHardware, applyOutputDevice } from './audioHardware';
import type { AudioEffect } from './audioEffects';
import { fetchAssetSrc } from '@core/assets/local/localBlobSource';

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
  /**
   * Stereo position, −100 (hard left) … +100 (hard right). Absent or 0 means
   * centred, and a centred voice builds NO panner node at all — so a project
   * that never touched pan has exactly the graph it always had.
   */
  pan?: number;
  /** True when the node carries pan keyframes. */
  panAnimated?: boolean;
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
  const res = await fetchAssetSrc(src);
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
  private readonly listeners = new Set<() => void>();

  // Master metering chain: every voice routes through `master` → destination,
  // and `master` also feeds a splitter → per-channel analysers so the VU meter
  // reads the full stereo mix. Built lazily with the context.
  private master: GainNode | null = null;
  /** Preview mute — the master gain at 0. Voices keep running so unmuting is
   *  instant and stays in sync; nothing about the layers' own mute changes. */
  private masterMuted = false;

  /** Mute or unmute everything the engine plays (the Preview panel's switch). */
  setMasterMuted(muted: boolean): void {
    this.masterMuted = muted;
    if (this.master) this.master.gain.value = muted ? 0 : 1;
  }

  isMasterMuted(): boolean {
    return this.masterMuted;
  }
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
    /*
      The latency hint and the output device are PREFERENCES, read at build
      time (see `audioHardware`). A context cannot change its latency once
      created, so this is the only moment the setting can be honoured — which
      is also why the preferences panel warns that a change takes effect on the
      next playback.
    */
    const { latencySec } = getAudioHardware();
    this.ctx = latencySec > 0 ? new Ctor({ latencyHint: latencySec }) : new Ctor();
    this.buildMasterChain(this.ctx);
    // Routing is async and must not hold up the first sound: the context
    // already plays to the default device, and `setSinkId` moves it mid-stream.
    void applyOutputDevice(this.ctx);
    return this.ctx;
  }

  /** Master gain → destination, plus a stereo splitter → L/R analysers for the
   *  VU meter. Voices connect to `master` (see startVoice). */
  private buildMasterChain(ctx: AudioContext): void {
    const master = ctx.createGain();
    master.gain.value = this.masterMuted ? 0 : 1;
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

  /**
   * The rate the OUTPUT DEVICE is running at, or null before the engine has
   * started. Reported, never chosen: a context's rate comes from the device,
   * and the export mixdown renders at its own fixed rate regardless.
   */
  sampleRate(): number | null {
    return this.ctx?.sampleRate ?? null;
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
    return 0;
  }

  /** The decoded buffer for an asset, or undefined until `load` completes.
   *  Used by the offline export mixdown (see audioMixdown). */
  decodedBuffer(assetId: string): AudioBuffer | undefined {
    return this.assets.get(assetId)?.buffer;
  }
}

/** Process-wide singleton (mirrors defaultSceneGraph / defaultAnimation). */
export const audioEngine = new AudioEngine();
