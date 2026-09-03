/**
 * The footage-preview MECHANICS, shared by the two surfaces that show a clip
 * before it is in the edit: the modal `FootagePreviewDialog` and the docked
 * `SourceMonitorPanel`.
 *
 * This file exists because the second surface arrived. Everything here was
 * private to the dialog, and the honest options were "the source monitor
 * re-implements exact stepping" or "the mechanics move somewhere both can
 * import". The first is how two decoders end up in one app disagreeing about
 * which frame is frame 12 — and this codebase already learned that lesson once
 * (see `FootagePreviewDialog`'s header on the two transports).
 *
 * The DIALOG's header still owns the argument for WHY exact stepping exists at
 * all; this is only where the machinery lives.
 */

import { useEffect, useRef, useState, type RefObject } from 'react';
import { demuxMp4 } from '@core/video/mp4Demuxer';
import { demuxWebm, isWebmMagic } from '@core/video/webmDemuxer';
import { ExactVideoSource } from '@core/video/exactVideoSource';
import type { ImportedAsset } from '@stores/assetStore';

/** The one-line "what is this file" row: display size, length, rate, audio. */
export function factsOf(asset: ImportedAsset): string {
  const m = asset.metadata ?? {};
  const parts: string[] = [];
  const par = asset.interpret?.par ?? 1;
  if (m.width && m.height) parts.push(`${Math.round(m.width * par)}×${m.height}`);
  if (m.duration && m.duration > 0) parts.push(`${m.duration.toFixed(2)}s`);
  // Probed rate only — the browser cannot report one, and printing the comp's
  // rate here would be a lie wearing units. Same rule as the panel footer.
  if (m.fps && m.fps > 0) parts.push(`${m.fps % 1 === 0 ? m.fps : m.fps.toFixed(3)} fps`);
  if (m.hasAudioTrack) parts.push('audio');
  return parts.join(' · ');
}

/** Microseconds → a seconds string with millisecond resolution. */
export const fmtSec = (us: number): string => (us / 1e6).toFixed(3);

export interface ExactStepper {
  mode: 'player' | 'frames';
  note: string | null;
  frameIdx: number;
  frameCount: number;
  timeUs: number;
  canvasRef: RefObject<HTMLCanvasElement>;
  videoRef: RefObject<HTMLVideoElement>;
  enter: () => void;
  exit: () => void;
  step: (by: number) => void;
  /** Jump to the frame containing a SOURCE time (seconds). No-op in player
   *  mode — the `<video>` element owns the playhead there. */
  seekSeconds: (seconds: number) => void;
}

/** The exact-mode machinery for one video asset. Kept as a hook so the modal
 *  body stays a rendering function; the source is built lazily on first use
 *  and closed with the dialog. */
export function useExactStepper(asset: ImportedAsset): ExactStepper {
  const [mode, setMode] = useState<'player' | 'frames'>('player');
  const [note, setNote] = useState<string | null>(null);
  const [frameIdx, setFrameIdx] = useState(0);
  const [frameCount, setFrameCount] = useState(0);
  const [timeUs, setTimeUs] = useState(0);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const sourceRef = useRef<ExactVideoSource | null>(null);
  /** Container rotation of the current source (decoder output is unrotated). */
  const rotationRef = useRef<0 | 90 | 180 | 270>(0);
  /** In-flight guard: a second click while the first fetch+demux is still
   *  resolving must not start a second one — the loser's decoder leaked. */
  const enteringRef = useRef(false);

  useEffect(() => () => {
    sourceRef.current?.close();
    sourceRef.current = null;
  }, []);

  // The modal REPLACES its body when a second asset is previewed under the
  // same modal id — the stepper must not keep serving the previous asset's
  // frames from its cached source. The docked monitor swaps assets the same
  // way, without unmounting.
  useEffect(() => {
    if (!sourceRef.current && mode === 'player') return;
    sourceRef.current?.close();
    sourceRef.current = null;
    enteringRef.current = false;
    setMode('player');
    setNote(null);
    setFrameIdx(0);
    setFrameCount(0);
    setTimeUs(0);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [asset.src]);

  const show = (src: ExactVideoSource, idx: number): void => {
    const clamped = Math.max(0, Math.min(src.frameCount - 1, idx));
    void src.frameAt(clamped).then((frame) => {
      if (sourceRef.current !== src) return; // dialog closed mid-decode
      const canvas = canvasRef.current;
      const ctx = canvas?.getContext('2d');
      if (canvas && ctx) {
        // Cache owns the frame — draw, never close.
        const rot = rotationRef.current;
        if (rot !== 0) {
          const swap = rot === 90 || rot === 270;
          const dw = swap ? canvas.height : canvas.width;
          const dh = swap ? canvas.width : canvas.height;
          ctx.save();
          ctx.translate(canvas.width / 2, canvas.height / 2);
          ctx.rotate((rot * Math.PI) / 180);
          ctx.drawImage(frame as unknown as CanvasImageSource, -dw / 2, -dh / 2, dw, dh);
          ctx.restore();
        } else {
          ctx.drawImage(frame as unknown as CanvasImageSource, 0, 0, canvas.width, canvas.height);
        }
      }
      setFrameIdx(clamped);
      setTimeUs(src.timeUsOf(clamped));
    }).catch((e: unknown) => {
      setNote(`Frame-by-frame failed: ${e instanceof Error ? e.message : String(e)}`);
      setMode('player');
    });
  };

  const enter = (): void => {
    // The player keeps running (with audio) behind the stepper otherwise.
    videoRef.current?.pause();
    const existing = sourceRef.current;
    if (existing) {
      setMode('frames');
      show(existing, frameIdx);
      return;
    }
    if (enteringRef.current) return;
    enteringRef.current = true;
    setNote(null);
    // Promise.resolve first: a platform with no fetch (or one that throws
    // synchronously on an unsupported scheme) must land in the SAME catch as
    // a failed read, not escape the handler.
    void Promise.resolve()
      .then(() => fetch(asset.src))
      .then((r) => {
        if (!r.ok) throw new Error(`source unreadable (${r.status})`);
        return r.arrayBuffer();
      })
      .then((buf) => {
        // Same whole-file-in-memory contract as the render path's loader —
        // and the same ceiling, so a multi-GB clip cannot double into the
        // JS heap from a preview click.
        if (buf.byteLength > 1536 * 1024 * 1024) {
          throw new Error('file too large for frame-by-frame — generate a proxy');
        }
        // WebM and MP4, like the timeline: this dialog was MP4-only, so WebM
        // clips offered the button and always failed even though the renderer
        // decodes them exactly.
        const head = new Uint8Array(buf, 0, Math.min(4, buf.byteLength));
        return isWebmMagic(head) ? demuxWebm(buf) : demuxMp4(buf);
      })
      .then((demuxed) => {
        const src = new ExactVideoSource(demuxed);
        sourceRef.current = src;
        enteringRef.current = false;
        rotationRef.current = demuxed.rotation ?? 0;
        setFrameCount(src.frameCount);
        const canvas = canvasRef.current;
        if (canvas) {
          const swap = rotationRef.current === 90 || rotationRef.current === 270;
          canvas.width = swap ? demuxed.codedHeight : demuxed.codedWidth;
          canvas.height = swap ? demuxed.codedWidth : demuxed.codedHeight;
          // Anamorphic footage: the canvas holds coded (unstretched) pixels,
          // so the PAR correction is display-side, like the facts row does.
          const par = asset.interpret?.par ?? 1;
          if (par !== 1) canvas.style.aspectRatio = `${canvas.width * par} / ${canvas.height}`;
        }
        setMode('frames');
        // Land where the player was paused, not back at 0 — stepping exists
        // to inspect the moment you were just looking at.
        const t = videoRef.current?.currentTime ?? 0;
        // +1µs: frame starts in the index are fractional microseconds, so an
        // integer-µs query at an exact boundary (t = N/fps) lands just below
        // frame N's start and resolves N-1. Same bias as exactVideoFrames.
        show(src, src.frameIndexAt(Math.round(t * 1e6) + 1));
      })
      .catch((e: unknown) => {
        enteringRef.current = false;
        setNote(`Frame-by-frame unavailable: ${e instanceof Error ? e.message : String(e)}`);
        setMode('player');
      });
  };

  const exit = (): void => setMode('player');
  const step = (by: number): void => {
    const src = sourceRef.current;
    if (src) show(src, frameIdx + by);
  };
  const seekSeconds = (seconds: number): void => {
    const src = sourceRef.current;
    // Same +1µs boundary bias as `enter` — see the note there.
    if (src) show(src, src.frameIndexAt(Math.round(Math.max(0, seconds) * 1e6) + 1));
  };

  return { mode, note, frameIdx, frameCount, timeUs, canvasRef, videoRef, enter, exit, step, seekSeconds };
}
