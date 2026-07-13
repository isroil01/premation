/**
 * AudioEngine (Prompt 8) — the app's single Web Audio authority.
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

/** One audio layer's transport-relevant state, derived from the scene. */
export interface AudioLayerState {
  nodeId: string;
  assetId: string;
  src: string;
  /** Layer gain, percent (100 = unity). */
  level: number;
  /** Comp time (seconds) at which the clip starts. */
  startSec: number;
  /** In/out trim within the clip, seconds. */
  inSec: number;
  outSec: number;
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
  private readonly voices = new Map<string, ActiveVoice>();
  private timeSec = 0;
  private readonly listeners = new Set<() => void>();

  private context(): AudioContext | null {
    if (this.ctx) return this.ctx;
    const Ctor =
      typeof window !== 'undefined'
        ? (window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext)
        : undefined;
    if (!Ctor) return null;
    this.ctx = new Ctor();
    return this.ctx;
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
   * Decode an asset into a buffer + waveform (idempotent, cached). Returns null
   * when Web Audio is unavailable or decoding fails.
   */
  async load(assetId: string, src: string): Promise<LoadedAsset | null> {
    const cached = this.assets.get(assetId);
    if (cached) return cached;
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
        return null;
      } finally {
        this.loading.delete(assetId);
      }
    })();
    this.loading.set(assetId, p);
    return p;
  }

  /** Peak amplitude (0..1) across decoded layers at the current playhead. Read
   *  from the envelope (not live analysis) so it works while paused/scrubbing —
   *  which is what drives audio-reactive expressions. */
  currentLevel(): number {
    let max = 0;
    for (const asset of this.assets.values()) {
      const a = amplitudeAt(asset.wave, this.timeSec);
      if (a > max) max = a;
    }
    return max;
  }

  private voiceKey(l: AudioLayerState): string {
    return `${l.assetId}|${l.level}|${l.startSec}|${l.inSec}|${l.outSec}|${l.muted}`;
  }

  /**
   * Reconcile live playback with the transport. Called on every play/pause,
   * seek, or scene edit. Starts voices for audible layers when playing (seeking
   * into each buffer to match the playhead), and stops everything otherwise.
   */
  sync(playing: boolean, timeSec: number, layers: readonly AudioLayerState[]): void {
    this.timeSec = timeSec;
    const ctx = this.context();
    if (!ctx) return;

    // Ensure every referenced asset is (being) decoded.
    for (const l of layers) if (!this.assets.has(l.assetId)) void this.load(l.assetId, l.src);

    if (!playing) {
      this.stopAll();
      return;
    }
    if (ctx.state === 'suspended') void ctx.resume();

    const wanted = new Map(layers.filter((l) => !l.muted).map((l) => [l.nodeId, l] as const));

    // Stop voices whose layer vanished, changed materially, or drifted out of
    // sync with the playhead (a seek or loop-wrap).
    for (const [nodeId, voice] of [...this.voices]) {
      const l = wanted.get(nodeId);
      if (!l || this.voiceKey(l) !== voice.key) {
        this.stopVoice(nodeId);
        continue;
      }
      const predicted = voice.startOffset + (ctx.currentTime - voice.startCtxTime);
      const wanted0 = l.inSec + (timeSec - l.startSec);
      if (Math.abs(wanted0 - predicted) > SEEK_TOLERANCE) this.stopVoice(nodeId);
    }

    // (Re)start voices. A large seek while playing lands here after the stop
    // above and restarts at the new offset.
    for (const [nodeId, l] of wanted) {
      if (this.voices.has(nodeId)) continue;
      const asset = this.assets.get(l.assetId);
      if (!asset) continue; // not decoded yet; a later sync will start it
      const localT = timeSec - l.startSec;
      const offset = l.inSec + localT;
      if (localT < 0 || offset >= l.outSec) continue; // playhead outside the clip
      this.startVoice(nodeId, l, asset, offset);
    }
  }

  private startVoice(nodeId: string, l: AudioLayerState, asset: LoadedAsset, offset: number): void {
    const ctx = this.ctx!;
    const source = ctx.createBufferSource();
    source.buffer = asset.buffer;
    const gain = ctx.createGain();
    gain.gain.value = Math.max(0, l.level / 100);
    source.connect(gain).connect(ctx.destination);
    const remaining = Math.max(0, l.outSec - offset);
    const startAt = Math.max(0, offset);
    try {
      source.start(ctx.currentTime, startAt, remaining);
    } catch {
      return;
    }
    this.voices.set(nodeId, {
      source,
      gain,
      key: this.voiceKey(l),
      startCtxTime: ctx.currentTime,
      startOffset: startAt,
    });
  }

  private stopVoice(nodeId: string): void {
    const v = this.voices.get(nodeId);
    if (!v) return;
    try {
      v.source.stop();
    } catch {
      /* already stopped */
    }
    v.source.disconnect();
    v.gain.disconnect();
    this.voices.delete(nodeId);
  }

  private stopAll(): void {
    for (const nodeId of [...this.voices.keys()]) this.stopVoice(nodeId);
  }
}

/** Process-wide singleton (mirrors defaultSceneGraph / defaultAnimation). */
export const audioEngine = new AudioEngine();
